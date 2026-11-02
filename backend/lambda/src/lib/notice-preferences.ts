/**
 * WHAT A PERSON HAS ASKED NOT TO BE SENT (M-7, B9): preferences and consent, per route and kind of notice.
 *
 * ── KEYED BY THE PERSON, NEVER BY AN ADDRESS ─────────────────────────────────────────────────────
 *
 * One item per person in the user-profile table, keyed `<personId>#notices`, where `personId` is the
 * AppInstanceUser id (the last segment of the person's AppInstanceUser ARN, the key every item in that
 * table uses). The item carries the full ARN as `personArn`. No address appears in it: an address is the
 * issuer's, it changes, and two people can hold one over time. A person whose address changes keeps their
 * choices; a new holder of an old address inherits none of them.
 *
 * The key names its owner (tenet D15) and never collides with the person's own profile item or a contact
 * copy (`<personId>#contact#<issuerId>`). Offboarding deletes it with the person (`noticePreferences` in
 * `OFFBOARDED_STORES`).
 *
 * ── THE KINDS, AND THE TRANSACTIONAL SET ─────────────────────────────────────────────────────────
 *
 * `NOTICE_KINDS` is the one list of what the platform emails. A kind is `transactional` when it is the
 * one way a person learns of something they asked for or must act on: an invitation, a registration
 * claim, the receipt for a reply they sent. A transactional notice is sent whatever the person has muted,
 * and carries no unsubscribe headers, because RFC 8058 one-click is for mail a person can stop. Every
 * other kind is sent only with consent for its route and carries `List-Unsubscribe` and
 * `List-Unsubscribe-Post` (`lib/email-message.ts`).
 *
 * ── CONSENT, PER ROUTE ───────────────────────────────────────────────────────────────────────────
 *
 * Email: a member of a deployment receives the notices of the conversations they are in until they mute a
 * kind or every kind (`email:*`). SMS: nothing is sent without a consent record naming the number, the
 * wording shown, the time, the surface and the person (M-7). **NOT BUILT:** no SMS sender is deployed, so
 * an SMS consent record is never written and `mayNotify` refuses every SMS send.
 *
 * A read that fails answers "muted everything" for a non-transactional kind: an unreadable preference must
 * not become an email the person asked not to receive.
 */
import { DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { personIdFromArn } from './person-arn.js';

type Sender = { send(command: unknown): Promise<any> };

/** Every kind of notice the platform sends, and whether a person can stop it. */
export const NOTICE_KINDS = {
  /** A message from an assistant in a conversation, or one that @mentions the person. */
  conversation: { transactional: false },
  /** A person was added to a conversation by someone in it (the share). */
  'conversation-shared': { transactional: false },
  /** The scheduled proactive briefing. */
  briefing: { transactional: false },
  /** An operational alarm, to the people the deployment names for it. */
  alarm: { transactional: false },
  /**
   * A reminder about an invitation the person has not opened, sent when its inviter confirmed the assistant's proposal
   * (ADR-061, `send_nudge`). Not transactional: the invitation itself was, and a reminder is one a person may stop.
   */
  nudge: { transactional: false },
  /**
   * A task a workflow step assigned the person (ADR-063 decision C2). Not transactional, and its own kind, so muting
   * conversation email and muting assigned work are separate choices.
   */
  task: { transactional: false },
  /** An invitation to a conversation (M-10). Its sender is the invitation change's. */
  invitation: { transactional: true },
  /** A registration claim (path B). Its sender is the upgrade change's. */
  claim: { transactional: true },
  /** The receipt for a reply sent by email. **NOT BUILT:** no receipt is sent. */
  'reply-receipt': { transactional: true },
} as const;
export type NoticeKind = keyof typeof NOTICE_KINDS;

/** The routes a notice travels. Only email has a sender today. */
export type NoticeRoute = 'email' | 'sms';

export const isNoticeKind = (v: unknown): v is NoticeKind => typeof v === 'string' && Object.prototype.hasOwnProperty.call(NOTICE_KINDS, v);
export const isTransactional = (kind: NoticeKind): boolean => NOTICE_KINDS[kind].transactional;

/** The kinds a person may mute: every kind outside the transactional set. */
export const MUTABLE_KINDS = (Object.keys(NOTICE_KINDS) as NoticeKind[]).filter((k) => !isTransactional(k));

/** The mute that covers every mutable kind on a route. */
export const ALL_KINDS = '*';

/** What is stored: the mutes, as `<route>:<kind>` or `<route>:*`, each with when it was set. */
export interface NoticePreferences {
  muted: Record<string, string>;
  /** SMS consent records, by number. **NOT BUILT:** never written. */
  smsConsent?: Record<string, unknown>;
}

export const noticePreferencesKey = (personId: string): string => `${personId}#notices`;
const muteKey = (route: NoticeRoute, kind: NoticeKind | typeof ALL_KINDS): string => `${route}:${kind}`;

/** Whether this kind may go to this person over this route. Pure, so the rule is testable whole. */
export function mayNotify(prefs: NoticePreferences | null, route: NoticeRoute, kind: NoticeKind): { ok: true } | { ok: false; reason: 'muted' | 'no-consent' | 'unreadable' } {
  if (isTransactional(kind)) return { ok: true };
  if (route === 'sms') return { ok: false, reason: 'no-consent' };
  if (!prefs) return { ok: false, reason: 'unreadable' };
  if (prefs.muted[muteKey(route, ALL_KINDS)] || prefs.muted[muteKey(route, kind)]) return { ok: false, reason: 'muted' };
  return { ok: true };
}

/** Whether one kind is muted, for the preference page. */
export function isMuted(prefs: NoticePreferences, route: NoticeRoute, kind: NoticeKind | typeof ALL_KINDS): boolean {
  return Boolean(prefs.muted[muteKey(route, kind)]);
}

/**
 * The person's preferences. An item that does not exist is "nothing muted"; a read that throws is `null`,
 * which `mayNotify` refuses on.
 */
export async function readNoticePreferences(doc: Sender, table: string, personArn: string): Promise<NoticePreferences | null> {
  const personId = personIdFromArn(personArn);
  if (!personId || !table) return null;
  try {
    const r = await doc.send(new GetCommand({ TableName: table, Key: { personId: noticePreferencesKey(personId) } }));
    const item = r?.Item as { muted?: unknown; personArn?: unknown } | undefined;
    if (!item) return { muted: {} };
    // An item naming another person is not this person's; it mutes nothing and is reported.
    if (item.personArn !== personArn) {
      console.error('[notice-preferences] a preferences item names another person; treated as unreadable', { personId });
      return null;
    }
    const muted = item.muted && typeof item.muted === 'object' ? (item.muted as Record<string, string>) : {};
    return { muted };
  } catch (err) {
    console.warn('[notice-preferences] preferences could not be read; muting non-transactional mail', { err: (err as Error)?.name });
    return null;
  }
}

/**
 * Mute or unmute one kind, or every kind, on a route. The item is created on first use. Only `muted`,
 * `personArn` and `updatedAt` are written: the unsubscribe handler's grant names these attributes.
 */
export async function setNoticeMute(
  doc: Sender,
  table: string,
  args: { personArn: string; route: NoticeRoute; kind: NoticeKind | typeof ALL_KINDS; muted: boolean; now?: Date },
): Promise<void> {
  const personId = personIdFromArn(args.personArn);
  if (!personId) throw new Error('notice-preferences: not a person ARN');
  if (args.kind !== ALL_KINDS && isTransactional(args.kind)) throw new Error(`notice-preferences: ${args.kind} is transactional and cannot be muted`);
  const at = (args.now ?? new Date()).toISOString();
  const Key = { personId: noticePreferencesKey(personId) };
  // Two writes, because DynamoDB cannot set a path under a map that does not exist yet. The condition
  // keeps an item that names another person from being taken over.
  await doc.send(new UpdateCommand({
    TableName: table,
    Key,
    UpdateExpression: 'SET muted = if_not_exists(muted, :empty), personArn = :p, updatedAt = :at',
    ConditionExpression: 'attribute_not_exists(personArn) OR personArn = :p',
    ExpressionAttributeValues: { ':empty': {}, ':p': args.personArn, ':at': at },
  }));
  await doc.send(new UpdateCommand({
    TableName: table,
    Key,
    UpdateExpression: args.muted ? 'SET muted.#k = :at, updatedAt = :at' : 'REMOVE muted.#k SET updatedAt = :at',
    ConditionExpression: 'personArn = :p',
    ExpressionAttributeNames: { '#k': muteKey(args.route, args.kind) },
    ExpressionAttributeValues: { ':at': at, ':p': args.personArn },
  }));
}

/** Delete the person's preferences. Returns 1 when an item existed. */
export async function eraseNoticePreferences(doc: Sender, table: string, personId: string): Promise<number> {
  const r = await doc.send(new DeleteCommand({ TableName: table, Key: { personId: noticePreferencesKey(personId) }, ReturnValues: 'ALL_OLD' }));
  return r?.Attributes ? 1 : 0;
}
