/**
 * A REPLY BY EMAIL, POSTED AS THE PERSON WHO SENT IT (M-8, B10).
 *
 * SES receives mail for the reply subdomain through a receipt rule in the account's active rule set
 * (`notification-stack.ts`): the rule stores the message in the inbound bucket, then invokes this
 * function with SES's verdicts. Whether anything is posted is `decideReply` (`lib/reply-tokens.ts`):
 * a valid `reply` token in the recipient address, DMARC passing with alignment to the From domain, and a
 * From that is the address the person's issuer holds for them now. Anything else posts nothing.
 *
 * ── AS THE PERSON, ON THE PERSON'S OWN PATH ──────────────────────────────────────────────────────
 *
 * An accepted reply is sent with `ChimeBearer` = the person's AppInstanceUser, on a session the
 * credential exchange's one-conversation role would vend them: the `restricted` classification role, assumed with
 * the `person` and `classification` session tags its trust policy requires, so the role pins the bearer
 * to that person (`…/user/${aws:PrincipalTag/person}`), and a session policy narrowed to the one
 * conversation the token names and to `SendChannelMessage`. It is never posted as a service identity or
 * as an assistant. Two layers decide where it can land:
 *  - IAM: the pinned bearer and the one-channel session policy;
 *  - the Amazon Chime SDK: the person must still be a member of the conversation, or the send is refused.
 * The message then passes through the channel flow like any message the person types.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────────────────────────
 *
 * It never throws for a refusal, and never answers the sender: a bounce for a forged reply would make this
 * deployment a source of backscatter. Each outcome is counted (`AgentEchelon/EmailReplies`, one metric
 * per outcome) and logged by reason, with no address in the log. The stored message is deleted once read.
 */
import { createHash } from 'crypto';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { sendChannelMessage } from './lib/chime/send.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { presentBoundedToken } from './lib/tokens.js';
import { decideReply, replyTextOf, type ReceivedMail, type ReplyDecision } from './lib/reply-tokens.js';
import { defaultDirectory, type Directory } from './lib/membership-source.js';
import { personIdFromArn, userArnFor, appInstanceArnOf } from './lib/person-arn.js';
import { emitEmfMetric } from './lib/emf-metrics.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

const REGION = process.env.AWS_REGION || 'us-east-1';

/** The SES receipt event this function is invoked with (Lambda action, `Event` invocation). */
export interface SesReceiptEvent {
  Records?: Array<{
    ses?: {
      mail?: { messageId?: string; commonHeaders?: { from?: string[] } };
      receipt?: {
        recipients?: string[];
        spfVerdict?: { status?: string };
        dkimVerdict?: { status?: string };
        dmarcVerdict?: { status?: string };
        spamVerdict?: { status?: string };
        virusVerdict?: { status?: string };
      };
    };
  }>;
}

export interface EmailReplyDeps {
  replyDomain: string;
  tokensTable: string;
  inboundBucket: string;
  inboundPrefix: string;
  restrictedRoleArn: string;
  doc: Sender;
  s3: Sender;
  directory: Directory;
  /** Post the reply as the person. Returns the message id. */
  postAsPerson(args: { personArn: string; channelArn: string; text: string; idempotencyKey: string }): Promise<string | undefined>;
  now(): number;
}

/** The received mail as `decideReply` reads it. */
export function receivedMailOf(record: NonNullable<SesReceiptEvent['Records']>[number]): ReceivedMail | null {
  const mail = record?.ses?.mail;
  const receipt = record?.ses?.receipt;
  if (!mail?.messageId || !receipt) return null;
  return {
    messageId: mail.messageId,
    recipients: receipt.recipients || [],
    from: (mail.commonHeaders?.from || [])[0] || '',
    verdicts: {
      spf: receipt.spfVerdict?.status,
      dkim: receipt.dkimVerdict?.status,
      dmarc: receipt.dmarcVerdict?.status,
      spam: receipt.spamVerdict?.status,
      virus: receipt.virusVerdict?.status,
    },
  };
}

/** One reply outcome, counted as an EMF line. Exported for the EMF contract test. */
export function countReplyOutcome(outcome: string): void {
  try {
    emitEmfMetric({
      namespace: 'AgentEchelon/EmailReplies',
      metrics: [{ name: outcome, unit: 'Count' }],
      dimensionSets: [[]],
      properties: { [outcome]: 1 },
    });
  } catch {
    // Measurement never costs the reply.
  }
}

async function readStored(deps: EmailReplyDeps, messageId: string): Promise<string> {
  const r = await deps.s3.send(new GetObjectCommand({ Bucket: deps.inboundBucket, Key: `${deps.inboundPrefix}${messageId}` }));
  return r?.Body ? await r.Body.transformToString('utf-8') : '';
}

/** One received message: decided, posted or refused, and its stored copy deleted. */
export async function handleReceived(mail: ReceivedMail, deps: EmailReplyDeps): Promise<ReplyDecision> {
  let decision: ReplyDecision;
  try {
    decision = await decideReply(mail, {
      replyDomain: deps.replyDomain,
      now: Math.floor(deps.now() / 1000),
      token: async (token) => {
        const r = await presentBoundedToken(deps.doc, deps.tokensTable, 'reply', token, Math.floor(deps.now() / 1000));
        if (!r.ok) return { ok: false, reason: r.reason };
        return { ok: true, record: { channelArn: String(r.record.channelArn), personArn: String(r.record.personArn), expiresAt: r.record.expiresAt, ...(r.record.noticeId ? { noticeId: String(r.record.noticeId) } : {}) } };
      },
      contactOf: async (personArn) => (await deps.directory.contactFor(personArn, 'email'))?.address ?? null,
      text: async () => replyTextOf(await readStored(deps, mail.messageId)),
    });
  } catch (err) {
    console.error('[email-reply] a reply could not be decided; nothing was posted', { err: (err as Error)?.name || String(err) });
    countReplyOutcome('Errored');
    return { post: false, reason: 'token-unknown' };
  }

  if (!decision.post) {
    console.log('[email-reply] refused; nothing was posted', { reason: decision.reason });
    countReplyOutcome(`Refused_${decision.reason}`);
  } else {
    try {
      // One post per received message, whatever SES retries: the key is the message's own id.
      const idempotencyKey = createHash('sha256').update(mail.messageId).digest('hex').slice(0, 64);
      await deps.postAsPerson({ personArn: decision.personArn, channelArn: decision.channelArn, text: decision.text, idempotencyKey });
      console.log('[email-reply] posted as the person', { channelArn: decision.channelArn, personId: personIdFromArn(decision.personArn) });
      countReplyOutcome('Posted');
    } catch (err) {
      // A person no longer in the conversation is refused by the Amazon Chime SDK here.
      console.warn('[email-reply] the reply was accepted and could not be posted', { err: (err as Error)?.name || String(err) });
      countReplyOutcome('PostFailed');
    }
  }
  try {
    await deps.s3.send(new DeleteObjectCommand({ Bucket: deps.inboundBucket, Key: `${deps.inboundPrefix}${mail.messageId}` }));
  } catch (err) {
    // The bucket's lifecycle expires what this leaves.
    console.warn('[email-reply] the stored message could not be deleted', { err: (err as Error)?.name });
  }
  return decision;
}

/**
 * THE PERSON'S OWN SESSION, NARROWED TO ONE CONVERSATION: the restricted classification role, its `person` tag
 * pinning the bearer, and a session policy allowing `SendChannelMessage` on the channel and the person.
 */
export function pinnedPoster(restrictedRoleArn: string, sts: Sender = new STSClient({ region: REGION })) {
  return async (args: { personArn: string; channelArn: string; text: string; idempotencyKey: string }): Promise<string | undefined> => {
    const personId = personIdFromArn(args.personArn);
    const app = appInstanceArnOf(args.personArn);
    if (!personId || !app || appInstanceArnOf(args.channelArn) !== app) throw new Error('the reply names no person and conversation of one app instance');
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: restrictedRoleArn,
      RoleSessionName: `reply-${personId}`.slice(0, 64),
      DurationSeconds: 900,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Sid: 'OneConversationReply', Effect: 'Allow', Action: ['chime:SendChannelMessage'], Resource: [args.channelArn, userArnFor(app, personId)] }],
      }),
      Tags: [
        { Key: 'person', Value: personId },
        { Key: 'classification', Value: 'restricted' },
      ],
    }));
    const c = assumed?.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('no session was vended for the person');
    // The person's own session: the client is built on the vended credentials, never on this function's role.
    const chime = chimeMessagingClient({
      region: REGION,
      credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
    });
    const r = await sendChannelMessage(chime, {
      ChannelArn: args.channelArn,
      ChimeBearer: args.personArn,
      Content: args.text,
      ClientRequestToken: args.idempotencyKey,
    });
    return r?.MessageId;
  };
}

let defaults: EmailReplyDeps | null = null;
function defaultDeps(): EmailReplyDeps {
  if (defaults) return defaults;
  defaults = {
    replyDomain: process.env.REPLY_DOMAIN || '',
    tokensTable: process.env.TOKENS_TABLE || '',
    inboundBucket: process.env.INBOUND_BUCKET || '',
    inboundPrefix: process.env.INBOUND_PREFIX || '',
    restrictedRoleArn: process.env.RESTRICTED_ROLE_ARN || '',
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
    s3: new S3Client({ region: REGION }),
    directory: defaultDirectory(),
    postAsPerson: pinnedPoster(process.env.RESTRICTED_ROLE_ARN || ''),
    now: () => Date.now(),
  };
  return defaults;
}

/** Test seam. `null` restores the deployment's wiring. */
export function __setEmailReplyDepsForTests(d: EmailReplyDeps | null): void {
  defaults = d;
}

export const handler = async (event: SesReceiptEvent): Promise<void> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const deps = defaultDeps();
  for (const record of event?.Records || []) {
    const mail = receivedMailOf(record);
    if (!mail) {
      countReplyOutcome('Unreadable');
      continue;
    }
    await handleReceived(mail, deps);
  }
};
