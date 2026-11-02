/**
 * WHAT AN EMAIL NEEDS BEFORE IT MAY GO (B9, M-8): the recipient's consent, an unsubscribe link for a mail
 * they can stop, and a reply address for a mail about a conversation.
 *
 * Each is a record keyed by the person, never by their address:
 *  - consent is the person's preferences item (`lib/notice-preferences.ts`);
 *  - the unsubscribe link carries an `unsubscribe` token (`lib/tokens.ts`) naming the person and the kind
 *    of notice, so the preference page acts for that person with no sign-in, and for nobody else;
 *  - the reply address carries a `reply` token bound to (conversation, person, notice), accepted for 14
 *    days (`lib/reply-tokens.ts`).
 *
 * The store keeps only each token's SHA-256. The token itself exists in the one email it was minted for.
 *
 * ── WIRING ───────────────────────────────────────────────────────────────────────────────────────
 *
 * `grantEmailFanOut` (`lib/constructs/directory-access.ts`) gives every function that emails these
 * variables and the grants they need, so nothing that sends can be wired without them:
 *  - `NOTICE_PREFERENCES_TABLE`: the user-profile table, read on `<personId>#notices` only;
 *  - `TOKENS_TABLE`: the token store, `PutItem` on `unsubscribe#*` and `reply#*` only;
 *  - `PERSON_API_URL_PARAM`: where the preference page is served (published by the PersonApi stack);
 *  - `REPLY_DOMAIN`: the reply subdomain, when the deployment receives replies. Absent, no mail carries a
 *    reply address.
 *
 * A non-transactional mail whose link cannot be minted is not sent: one without its unsubscribe headers
 * is exactly what B9 refuses.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { readNoticePreferences, type NoticeKind, type NoticePreferences } from './notice-preferences.js';
import { RECLAIM_AFTER_SECONDS, newCaseFreeToken, newPlatformToken, putToken, tokenRecordOf } from './tokens.js';
import { REPLY_TOKEN_TTL_SECONDS, replyAddressFor } from './reply-tokens.js';
import type { EmailCopy } from './email-copy.js';

type Sender = { send(command: unknown): Promise<any> };

/** How long an unsubscribe link is live: it shows and changes the whole set of preferences. Past it, the link still stops its own kind (`UNSUBSCRIBE_MUTE_RETENTION_SECONDS`). */
export const UNSUBSCRIBE_TOKEN_TTL_SECONDS = 60 * 86_400;

/**
 * How long an unsubscribe record is KEPT, from when it is minted: past its live window it still stops its own
 * kind of email (`muteUntil`), and DynamoDB TTL reclaims it only after that (`reclaimAt`). Separate from the live
 * window, which still decides whether the link shows and changes the whole set.
 */
export const UNSUBSCRIBE_MUTE_RETENTION_SECONDS = 365 * 86_400;

/** The path the preference page is served on, on the person API. */
export const PREFERENCES_PATH = '/email/preferences';

/** The preference-page copy an unsubscribe record carries, so the page speaks in the email's voice. */
export const PAGE_COPY_KEYS = [
  'language', 'preferencesTitle', 'preferenceKind', 'stopKind', 'resumeKind', 'stopAll', 'saved', 'linkInvalid',
  'transactionalNote', 'expiredOffer', 'expiredStopped', 'expiredSignIn', 'openPreferences', 'kindConversation', 'kindConversationShared', 'kindBriefing', 'kindAlarm', 'kindTask',
] as const satisfies readonly (keyof EmailCopy)[];

export interface EmailConsent {
  /** The person's preferences, or null when they cannot be read (which refuses a mail they could stop). */
  preferences(personArn: string): Promise<NoticePreferences | null>;
  /** A fresh one-click unsubscribe URL for this person and kind, or null when none can be minted. */
  unsubscribeUrl(args: { personArn: string; kind: NoticeKind; channelArn?: string; copy: EmailCopy }): Promise<string | null>;
  /** A fresh reply address for this person in this conversation, or null when the deployment takes no replies. */
  replyAddress(args: { personArn: string; channelArn: string; noticeId: string; kind: NoticeKind }): Promise<string | null>;
}

/** The consent of a deployment, from the variables `grantEmailFanOut` sets. */
export function deployedEmailConsent(env: NodeJS.ProcessEnv = process.env, clients?: { doc?: Sender; ssm?: Sender; now?: () => number }): EmailConsent {
  const region = env.AWS_REGION || 'us-east-1';
  const doc = clients?.doc ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const ssm = clients?.ssm ?? new SSMClient({ region });
  const now = clients?.now ?? (() => Date.now());
  const prefsTable = env.NOTICE_PREFERENCES_TABLE || '';
  const tokensTable = env.TOKENS_TABLE || '';
  const replyDomain = (env.REPLY_DOMAIN || '').trim().toLowerCase();
  let apiUrl: Promise<string> | null = null;
  const personApiUrl = (): Promise<string> => {
    if (env.PERSON_API_URL) return Promise.resolve(env.PERSON_API_URL.replace(/\/$/, ''));
    if (!env.PERSON_API_URL_PARAM) return Promise.resolve('');
    apiUrl ??= ssm.send(new GetParameterCommand({ Name: env.PERSON_API_URL_PARAM }))
      .then((r: { Parameter?: { Value?: string } }) => (r?.Parameter?.Value || '').replace(/\/$/, ''))
      .catch((err: unknown) => {
        apiUrl = null;
        console.warn('[email-consent] the person API URL could not be read', { err: (err as Error)?.name });
        return '';
      });
    return apiUrl;
  };
  return {
    preferences: (personArn) => readNoticePreferences(doc, prefsTable, personArn),
    async unsubscribeUrl({ personArn, kind, channelArn, copy }) {
      const base = await personApiUrl();
      if (!base || !tokensTable) return null;
      const token = newPlatformToken();
      const at = Math.floor(now() / 1000);
      const page = Object.fromEntries(PAGE_COPY_KEYS.map((k) => [k, copy[k]]));
      const muteUntil = at + UNSUBSCRIBE_MUTE_RETENTION_SECONDS;
      try {
        await putToken(doc, tokensTable, {
          ...tokenRecordOf('unsubscribe', token, {
            channelArn: channelArn || '', personArn, issuer: '', expiresAt: at + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
            createdAt: new Date(now()).toISOString(), noticeKind: kind, page, muteUntil,
          }),
          // TTL would reclaim the record 7 days after the live window; it is kept until its mute ends instead.
          reclaimAt: muteUntil + RECLAIM_AFTER_SECONDS,
        });
      } catch (err) {
        console.warn('[email-consent] an unsubscribe link could not be minted', { err: (err as Error)?.name });
        return null;
      }
      return `${base}${PREFERENCES_PATH}?t=${encodeURIComponent(token)}`;
    },
    async replyAddress({ personArn, channelArn, noticeId, kind }) {
      if (!replyDomain || !tokensTable || !channelArn) return null;
      const token = newCaseFreeToken();
      const at = Math.floor(now() / 1000);
      try {
        await putToken(doc, tokensTable, tokenRecordOf('reply', token, {
          channelArn, personArn, issuer: '', expiresAt: at + REPLY_TOKEN_TTL_SECONDS,
          createdAt: new Date(now()).toISOString(), noticeId, noticeKind: kind,
        }));
      } catch (err) {
        console.warn('[email-consent] a reply address could not be minted; sending without one', { err: (err as Error)?.name });
        return null;
      }
      return replyAddressFor(token, replyDomain);
    },
  };
}

let deployed: EmailConsent | null = null;
/** The deployment's consent, built once per container. */
export function defaultEmailConsent(): EmailConsent {
  deployed ??= deployedEmailConsent();
  return deployed;
}
