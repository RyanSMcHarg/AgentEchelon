/**
 * INVITATIONS, FOR CONVERSATIONS (M-10, M-5, B8): a member invites somebody new into a conversation.
 *
 * One function in `Conversations`, the writer of the `invitation` kind in `Tokens` and of no other (A8: its
 * grant carries `dynamodb:LeadingKeys` on `invitation#*` alone). Three person routes on `PersonApi`, behind
 * the edge authorizer, and two operations the admin backend invokes for the console. The record and its
 * states are `lib/invitations.ts`; redemption is the credential exchange's (`lib/invitation-redemption.ts`).
 *
 * ── `POST /invitations` ──────────────────────────────────────────────────────────────────────────
 *
 * An ordinary signed-in person (the edge and `callerPerson` refuse a guest, a one-conversation person and a
 * host assertion). In this order, and nothing later runs when anything earlier refuses:
 *
 *  1. The caller is a member: `DescribeChannel` with the caller as the bearer, so Amazon Chime SDK itself
 *     refuses a conversation they are not in. Not archived.
 *  2. The conversation's type, from its server-side context row (never Metadata), declares invitations
 *     (`invitationPolicyOf`), and the mode asked for is one it declares. A `link` invitation also needs the
 *     conversation's classification in the type's `linkClassifications` and in the `invitation-link` issuer's
 *     declared set (`INVITATION_LINK_REACH`); without that issuer no link is issued.
 *  3. The caller's own clearance reaches the conversation's classification, read from its immutable tag.
 *  4. The invitee is minted by the one minter, on the credential exchange (`mint-invitee`): a fresh
 *     AppInstanceUser with no `Identities` row, named by the display name the inviter gave and expiring
 *     with the invitation. It is added as a DEFAULT member of this one conversation, as the service admin.
 *  5. The invitation record is written, naming the conversation, the inviter and the invitee (K2: never an
 *     address). If it cannot be, the membership is removed again and the invitee lapses at its expiry.
 *  6. When the inviter gave an address, the invitation email goes to it through the one fan-out, handed to
 *     `Notifications` (`lib/transactional-mail.ts`), as the transactional `invitation` kind, in the conversation assistant's words. The address is the delivery
 *     route for that one email and is stored nowhere. With no address, or an email that could not be sent,
 *     the answer carries the link for the inviter to pass on: whoever holds it is the credential.
 *  7. `invitation-sent` is named to the router of the conversation's classification (ADR-061 decision 1), by ids
 *     alone, asynchronously: the router reads the record, verifies it is pending, and runs the workflow the room's
 *     primary declares on the event, if any. The email above is the invitation's one email whether or not a workflow
 *     runs (`workflowSendEmailKind` says why it is never the workflow's).
 *
 * The body may carry `reason`, one line on why the person is invited, recorded on the invitation as member text
 * (`invitation:reason`, ADR-060), and `role`, a participant role the conversation's type declares `invitable`
 * (DESIGN-CONVERSATION-TYPES section 6.1), checked before anything is minted:
 *
 *  - a role the type does not declare invitable is refused for every inviter (`ROLE_NOT_DECLARED`);
 *  - a role that confers `moderator` is recorded only when the inviter holds that role in this conversation or
 *    moderates it (`ROLE_NOT_CONFERRABLE`), so nobody hands on a power they do not have;
 *  - a `holders: 'one'` role somebody already holds is refused (`ROLE_HELD`).
 *
 * The role is recorded on the invitation (`invitation:role`) and, once the record is written, as the invitee's holding
 * on the conversation's channel-context row, origin `invitation`. A role that confers `moderator` makes the invitee a
 * moderator of this one channel, as the service admin, and the holding records the moderation's origin
 * `participantRole:<name>`, so revoking the invitation removes that moderation and no other.
 *
 * ── `GET /invitations?channelArn=` and `POST /invitations/revoke` ────────────────────────────────
 *
 * A member sees the invitations they issued in a conversation; a moderator of it sees all of them. Either
 * revokes what they may see. Revoking marks the record and removes the invitee's membership, redeemed or
 * not; a link session vended before it lives out its own minutes, refused on every channel call.
 *
 * ── THE CONSOLE'S TWO OPERATIONS (`op`), invoked by the admin backend ────────────────────────────
 *
 * `admin-list` and `admin-revoke` are direct invocations, never a gateway request: the admin backend's
 * function is the one principal granted the invoke, behind its own IAM-authorized `AdminApi` routes and its
 * own check of the console session. One revocation, whoever asks for it.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DescribeChannelCommand, DescribeChannelModeratorCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';
import { randomUUID } from 'crypto';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { invitationPolicyOf, type RedemptionMode } from '../../lib/config/conversation-types.js';
import { PARTICIPANT_ROLE_NAME, invitableRoleOf, participantRoleOf } from '../../lib/config/participant-roles.js';
import { isRoleHeldElsewhere, moderationOrigin, parseHoldings, recordHolding, removeHolding } from './lib/participant-roles.js';
import { callerHolderToken, callerPerson } from './lib/auth.js';
import { responder, type HttpResult } from './lib/http-response.js';
import { CLASSIFICATION_TAG, readChannelTags } from './lib/channel-classification.js';
import { appInstanceAdminBearer, chimeMessagingClient } from './lib/chime/clients.js';
import { addInvitedMember, removeInvitedMember, setParticipantRoleModerator } from './lib/channel-creation.js';
import { newPlatformToken, putToken, tokenKey, tokenRecordOf } from './lib/tokens.js';
import {
  INVITATION_CHANNEL_ATTRIBUTE,
  findInvitation,
  invitationLink,
  invitationStatusOf,
  invitationViewOf,
  type InvitationAlias,
  listInvitations,
  markRevoked,
  type InvitationRecord,
} from './lib/invitations.js';
import { invokeTransactionalMail, type TransactionalMail } from './lib/transactional-mail.js';
import { cancelDeadlinesThroughRouter, invitationSentThroughRouter } from './lib/say-through-router.js';
import type { Directory } from './lib/membership-source.js';
import { oneRecipientDirectory } from './lib/one-recipient-directory.js';
import { isPersonOf, personIdFromArn, userArnFor } from './lib/person-arn.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

const http = responder({ origin: { fixed: () => process.env.ALLOWED_ORIGIN || '*' }, allowHeaders: 'Content-Type,Authorization' });

export const CREATE_ROUTE = '/invitations';
export const REVOKE_ROUTE = '/invitations/revoke';

/** The longest display name an inviter may give, which is also the AppInstanceUser `Name`'s cap. */
const NAME_MAX = 100;
/** The longest reason an inviter may give: one line, said to a person, never deciding. */
export const REASON_MAX = 280;
const ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export interface InvitationsDeps {
  doc?: Sender;
  messaging?: Sender;
  lambda?: Sender;
  tokensTable?: string;
  contextTable?: string;
  appInstanceArn?: string;
  /** The credential exchange, which mints the invitee. */
  exchangeFunction?: string;
  /** The origin the landing page is served from: the client `invitationLandingFor` names (`lib/config/app-origins.ts`). */
  landingOrigin?: string;
  /** The classifications the `invitation-link` issuer declares: where a link session may be vended. */
  linkReach?: readonly string[];
  adminBearer?: () => Promise<string>;
  now?: () => number;
  /** The invitation email's hand-off to `Notifications`. Default `invokeTransactionalMail`. */
  mail?: (m: TransactionalMail) => Promise<boolean>;
  addMember?: typeof addInvitedMember;
  removeMember?: typeof removeInvitedMember;
  /** Makes or unmakes a participant role's moderator. Default `setParticipantRoleModerator`. */
  moderate?: typeof setParticipantRoleModerator;
  /** Names `invitation-sent` to the conversation's router. Default `invitationSentThroughRouter`. */
  nameEvent?: (classification: string, channelArn: string, invitationId: string, invitationKey?: string) => Promise<boolean>;
  /** Asks the conversation's router to delete the invitation's deadline schedule. Default `cancelDeadlinesThroughRouter`. */
  cancelDeadline?: (classification: string, cancel: { channelArn: string; invitationId?: string }) => Promise<boolean>;
}

let defaultDoc: Sender | null = null;
let defaultMessaging: Sender | null = null;
let defaultLambda: Sender | null = null;
let defaultBearer: (() => Promise<string>) | null = null;
const docOf = (d: InvitationsDeps): Sender => d.doc ?? (defaultDoc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));
const messagingOf = (d: InvitationsDeps): Sender => d.messaging ?? (defaultMessaging ??= chimeMessagingClient({}));
const lambdaOf = (d: InvitationsDeps): Sender => d.lambda ?? (defaultLambda ??= new LambdaClient({}));
const bearerOf = (d: InvitationsDeps): (() => Promise<string>) => d.adminBearer ?? (defaultBearer ??= appInstanceAdminBearer({
  ssm: new SSMClient({}) as never,
  param: process.env.ADMIN_ARN_PARAM || '',
  onFailure: 'retry',
  log: (err) => console.error('[Invitations] the service admin could not be read', { err: (err as Error)?.name }),
}));
const env = (d: InvitationsDeps) => ({
  tokensTable: d.tokensTable ?? process.env.TOKENS_TABLE ?? '',
  contextTable: d.contextTable ?? process.env.CHANNEL_CONTEXT_TABLE ?? '',
  appInstanceArn: d.appInstanceArn ?? process.env.APP_INSTANCE_ARN ?? '',
  exchangeFunction: d.exchangeFunction ?? process.env.CREDENTIAL_EXCHANGE_FUNCTION ?? '',
  landingOrigin: (d.landingOrigin ?? process.env.INVITATION_LANDING_ORIGIN ?? '').replace(/\/$/, ''),
  linkReach: d.linkReach ?? (() => {
    try {
      const parsed = JSON.parse(process.env.INVITATION_LINK_REACH || '[]');
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  })(),
});

const refuse = (status: number, code: string, message: string): HttpResult => http.error(status, message, undefined, code);
const nameOf = (err: unknown): string => (err as { name?: string })?.name || '';
const nowOf = (d: InvitationsDeps): number => Math.floor((d.now ?? Date.now)() / 1000);

function bodyOf(event: any): Record<string, unknown> | null {
  try {
    const raw = event?.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A channel ARN of this app instance, named literally, or null. */
function channelOf(raw: unknown, appInstanceArn: string): string | null {
  const arn = typeof raw === 'string' ? raw : '';
  const prefix = `${appInstanceArn}/channel/`;
  if (!appInstanceArn || !arn.startsWith(prefix)) return null;
  return /^[A-Za-z0-9._-]{1,64}$/.test(arn.slice(prefix.length)) ? arn : null;
}

// ── WHAT A CONVERSATION IS, FROM ITS OWN RECORDS ─────────────────────────────────────────────────

export interface ConversationFacts {
  channelArn: string;
  name: string;
  classification: string;
  archived: boolean;
  /** The type from the server-side context row, or null when it cannot be read. */
  conversationType: string | null;
  /** The `participantRoles` holdings on the same row, as stored. */
  participantRoles?: unknown;
}

/** Thrown with the refusal a caller is answered with. */
class Refused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'Refused';
  }
}

/**
 * The conversation, as the CALLER can see it: `DescribeChannel` bearing the caller, so a conversation they
 * are not a member of is refused by Amazon Chime SDK, not by this code alone. Its classification and archived
 * state from its immutable tags; its type from the server-side context row.
 */
async function conversationFacts(channelArn: string, callerArn: string, d: InvitationsDeps): Promise<ConversationFacts> {
  const messaging = messagingOf(d);
  let name = '';
  try {
    const described = await messaging.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: callerArn }));
    name = String(described?.Channel?.Name || '');
  } catch (err) {
    const n = nameOf(err);
    if (n === 'ForbiddenException' || n === 'NotFoundException' || n === 'BadRequestException') {
      throw new Refused(403, 'NOT_A_MEMBER', 'only a member of a conversation can invite somebody into it');
    }
    throw err;
  }
  return { ...(await conversationRecords(channelArn, d)), name };
}

/** A conversation's classification, archived state and type, read as this function: no bearer. */
async function conversationRecords(channelArn: string, d: InvitationsDeps): Promise<Omit<ConversationFacts, 'name'>> {
  const tags = await readChannelTags(messagingOf(d) as never, channelArn);
  const tag = tags[CLASSIFICATION_TAG];
  if (!profiles.isKnownClassification(tag)) throw new Refused(403, 'UNCLASSIFIED', 'this conversation carries no classification');
  const { contextTable } = env(d);
  let conversationType: string | null = null;
  let participantRoles: unknown;
  if (contextTable) {
    try {
      const row = await docOf(d).send(new GetCommand({ TableName: contextTable, Key: { channelArn }, ProjectionExpression: 'conversationType, participantRoles' }));
      conversationType = typeof row?.Item?.conversationType === 'string' ? row.Item.conversationType : null;
      participantRoles = row?.Item?.participantRoles;
    } catch (err) {
      console.warn('[Invitations] the conversation\'s context row could not be read; refusing', { err: nameOf(err) });
    }
  }
  return { channelArn, classification: profiles.resolveClassification(tag)!, archived: String(tags.archived) === 'true', conversationType, ...(participantRoles !== undefined ? { participantRoles } : {}) };
}

/** Whether `personArn` moderates the conversation, asked as the service admin. */
async function isModerator(channelArn: string, personArn: string, d: InvitationsDeps): Promise<boolean> {
  const bearer = await bearerOf(d)();
  if (!bearer) return false;
  try {
    await messagingOf(d).send(new DescribeChannelModeratorCommand({ ChannelArn: channelArn, ChannelModeratorArn: personArn, ChimeBearer: bearer }));
    return true;
  } catch (err) {
    if (nameOf(err) === 'NotFoundException' || nameOf(err) === 'ForbiddenException') return false;
    throw err;
  }
}

// ── THE INVITATION EMAIL ─────────────────────────────────────────────────────────────────────────

/**
 * THE ONE ADDRESS THIS EMAIL GOES TO: a directory that answers for the invitee alone, with the address the
 * inviter typed. It finds nobody by that address (K2) and answers nothing about anybody else, so the fan-out
 * resolves its one recipient exactly as it resolves every other.
 */
export const inviteeDirectory = (inviteeArn: string, address: string, name: string): Directory => oneRecipientDirectory(inviteeArn, address, name);

/** The invitation email, handed to `Notifications`, which sends it (`lib/transactional-mail.ts`). */
function sendInvitationEmail(args: { record: InvitationRecord; address: string; link: string }, d: InvitationsDeps): Promise<boolean> {
  const { record, address, link } = args;
  return (d.mail ?? invokeTransactionalMail)({
    mail: 'invitation', personArn: record.personArn, address, name: record.inviteeName, channelArn: record.channelArn, link,
    ...(record.inviterName ? { sender: record.inviterName } : {}),
    ...(record.conversationName ? { title: record.conversationName } : {}),
  });
}

// ── CREATE ───────────────────────────────────────────────────────────────────────────────────────

export async function createInvitation(event: any, d: InvitationsDeps = {}): Promise<HttpResult> {
  const caller = await callerPerson(event);
  if (!caller || caller.source !== 'edge') return refuse(401, 'UNAUTHENTICATED', 'an invitation is issued by a signed-in member');
  const e = env(d);
  if (!e.tokensTable || !e.appInstanceArn || !e.exchangeFunction) return refuse(500, 'SERVER_MISCONFIG', 'invitations are not configured');
  const callerArn = caller.personArn ?? userArnFor(e.appInstanceArn, caller.personId);
  const body = bodyOf(event);
  if (!body) return refuse(400, 'INVITATION_INVALID', 'the body is not JSON');
  const channelArn = channelOf(body.channelArn, e.appInstanceArn);
  if (!channelArn) return refuse(400, 'INVITATION_INVALID', 'channelArn names one conversation of this instance');
  const inviteeName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!inviteeName || inviteeName.length > NAME_MAX) return refuse(400, 'INVITATION_INVALID', `name is the invitee's display name, 1 to ${NAME_MAX} characters`);
  const address = typeof body.email === 'string' ? body.email.trim() : '';
  if (address && !ADDRESS.test(address)) return refuse(400, 'INVITATION_INVALID', 'email is an address the invitation is sent to');
  if (body.mode !== undefined && body.mode !== 'sign-in' && body.mode !== 'link') return refuse(400, 'INVITATION_INVALID', 'mode is sign-in or link');
  if (body.role !== undefined && (typeof body.role !== 'string' || !PARTICIPANT_ROLE_NAME.test(body.role))) {
    return refuse(400, 'INVITATION_INVALID', 'role names one participant role');
  }
  const role = typeof body.role === 'string' ? body.role : undefined;
  const reason = typeof body.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim() : '';
  if ((body.reason !== undefined && typeof body.reason !== 'string') || reason.length > REASON_MAX) {
    return refuse(400, 'INVITATION_INVALID', `reason is one line on why the person is invited, at most ${REASON_MAX} characters`);
  }

  let facts: ConversationFacts;
  try {
    facts = await conversationFacts(channelArn, callerArn, d);
  } catch (err) {
    if (err instanceof Refused) return refuse(err.status, err.code, err.message);
    console.error('[Invitations] the conversation could not be read', { err: nameOf(err) });
    return refuse(503, 'INVITATIONS_UNAVAILABLE', 'the conversation could not be read');
  }
  if (facts.archived) return refuse(409, 'CONVERSATION_ARCHIVED', 'this conversation is archived and is read-only');
  const policy = facts.conversationType ? invitationPolicyOf(facts.conversationType) : null;
  if (!policy) return refuse(403, 'INVITATIONS_NOT_DECLARED', 'nobody can be invited into a conversation of this type');
  const mode: RedemptionMode = (body.mode as RedemptionMode | undefined) ?? policy.default;
  if (!policy.modes.includes(mode)) return refuse(400, 'MODE_NOT_DECLARED', `this conversation's invitations are redeemed by ${policy.modes.join(' or ')}`);
  if (mode === 'link' && !(policy.linkClassifications.includes(facts.classification as never) && e.linkReach.includes(facts.classification))) {
    return refuse(403, 'LINK_NOT_AVAILABLE', 'a link invitation cannot be issued for this conversation');
  }
  const holder = callerHolderToken(event);
  if (!holder || !profiles.grantsFor(holder).includes(facts.classification)) {
    return refuse(403, 'NOT_CLEARED', 'your clearance does not reach this conversation');
  }
  // THE ROLE, BEFORE ANYTHING IS MINTED (DESIGN-CONVERSATION-TYPES section 6.1).
  let roleConfersModerator = false;
  let oneHolder = false;
  if (role) {
    const decl = invitableRoleOf(facts.conversationType, role);
    if (!decl) return refuse(400, 'ROLE_NOT_DECLARED', 'this conversation\'s type does not declare that participant role as one an invitation may record');
    const holdings = parseHoldings(facts.participantRoles, facts.conversationType)[role] ?? {};
    const callerId = personIdFromArn(callerArn) ?? '';
    roleConfersModerator = decl.confers?.moderator === true;
    if (roleConfersModerator && !holdings[callerId]) {
      let moderates = false;
      try {
        moderates = await isModerator(channelArn, callerArn, d);
      } catch (err) {
        console.error('[Invitations] whether the inviter moderates could not be read; refusing the role', { err: nameOf(err) });
      }
      if (!moderates) return refuse(403, 'ROLE_NOT_CONFERRABLE', 'a participant role that makes its holder a moderator is given only by someone who holds it or moderates this conversation');
    }
    oneHolder = decl.holders === 'one';
    if (oneHolder && Object.keys(holdings).length) return refuse(409, 'ROLE_HELD', 'somebody already holds that participant role in this conversation');
  }
  if (!e.landingOrigin) return refuse(503, 'INVITATIONS_UNAVAILABLE', 'this deployment serves no invitation landing page');

  // 4. THE INVITEE, MINTED BY THE ONE MINTER, AND ADDED.
  let inviteeArn: string;
  try {
    const invoked = await lambdaOf(d).send(new InvokeCommand({
      FunctionName: e.exchangeFunction,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify({
        op: 'mint-invitee', name: inviteeName, expirationDays: policy.expiresInDays, classification: facts.classification, inviterArn: callerArn,
      })),
    }));
    const minted = invoked?.FunctionError ? null : JSON.parse(new TextDecoder().decode(invoked?.Payload)) as { ok?: boolean; personArn?: string };
    if (!minted?.ok || !minted.personArn || !isPersonOf(minted.personArn, e.appInstanceArn)) throw new Error('the exchange minted nobody');
    inviteeArn = minted.personArn;
  } catch (err) {
    console.error('[Invitations] the invitee could not be minted', { err: nameOf(err) || (err as Error)?.message });
    return refuse(503, 'INVITATIONS_UNAVAILABLE', 'the invitation could not be made');
  }
  const bearer = await bearerOf(d)();
  if (!bearer) return refuse(503, 'INVITATIONS_UNAVAILABLE', 'the invitation could not be made');
  try {
    await (d.addMember ?? addInvitedMember)({ channelArn, inviteeArn, bearerArn: bearer });
  } catch (err) {
    console.error('[Invitations] the invitee could not be added; it lapses at its expiry', { err: nameOf(err) });
    return refuse(503, 'INVITATIONS_UNAVAILABLE', 'the invitation could not be made');
  }
  const removeInvitee = () => (d.removeMember ?? removeInvitedMember)({ channelArn, inviteeArn, bearerArn: bearer }).catch(() => undefined);

  // A ONE-HOLDER ROLE IS CLAIMED BEFORE THE RECORD IS WRITTEN, by a write conditional on nobody else holding it: the read
  // above refuses the plain case, and this refuses two invitations made at once, of which only one can win the write.
  const inviteeId = personIdFromArn(inviteeArn) ?? '';
  if (role && oneHolder) {
    const { contextTable } = env(d);
    try {
      if (!contextTable || !inviteeId) throw new Error('the conversation\'s row is not configured');
      await recordHolding(docOf(d), contextTable, channelArn, role, inviteeId, { origin: 'invitation' }, { onlyHolder: true });
    } catch (err) {
      await removeInvitee();
      if (isRoleHeldElsewhere(err)) return refuse(409, 'ROLE_HELD', 'somebody already holds that participant role in this conversation');
      console.error('[Invitations] the participant role could not be claimed; removing the invitee again', { err: nameOf(err) });
      return refuse(503, 'INVITATIONS_UNAVAILABLE', 'the invitation could not be made');
    }
  }

  // 5. THE RECORD: the conversation, the inviter and the invitee. Never an address.
  const now = nowOf(d);
  const token = newPlatformToken();
  const record = tokenRecordOf('invitation', token, {
    channelArn,
    personArn: inviteeArn,
    issuer: caller.issuer?.id ?? '',
    expiresAt: now + policy.expiresInDays * 86_400,
    createdAt: new Date(now * 1000).toISOString(),
    invitationId: randomUUID(),
    inviterArn: callerArn,
    inviterName: (caller.contact.name || '').slice(0, NAME_MAX),
    inviteeName,
    mode,
    classification: facts.classification,
    conversationType: facts.conversationType!,
    conversationName: facts.name.slice(0, 256),
    ...(reason ? { reason } : {}),
    ...(role ? { participantRole: role } : {}),
    [INVITATION_CHANNEL_ATTRIBUTE]: channelArn,
  }) as InvitationRecord;
  try {
    await putToken(docOf(d), e.tokensTable, record);
  } catch (err) {
    console.error('[Invitations] the invitation could not be written; removing the invitee again', { err: nameOf(err) });
    await removeInvitee();
    // The role claimed for them goes with them.
    if (role && oneHolder && env(d).contextTable) await removeHolding(docOf(d), env(d).contextTable!, channelArn, role, inviteeId).catch(() => undefined);
    return refuse(503, 'INVITATIONS_UNAVAILABLE', 'the invitation could not be made');
  }
  console.log(JSON.stringify({ _auditEvent: 'invitation_issued', inviterArn: callerArn, inviteeArn, channelArn, mode, invitationId: record.invitationId, ...(role ? { participantRole: role } : {}) }));
  if (role) await recordInvitedHolding({ channelArn, inviteeArn, role, moderator: roleConfersModerator, bearer, invitationId: record.invitationId, claimed: oneHolder }, d);

  // 6. THE EMAIL, OR THE LINK.
  const link = invitationLink(e.landingOrigin, token);
  const emailed = address ? await sendInvitationEmail({ record, address, link }, d) : false;
  if (emailed) {
    await docOf(d).send(new UpdateCommand({
      TableName: e.tokensTable, Key: { pk: record.pk }, UpdateExpression: 'SET emailed = :t', ExpressionAttributeValues: { ':t': true },
    })).catch((err: unknown) => console.warn('[Invitations] could not record the email as sent', { err: nameOf(err) }));
  }
  // 7. THE EVENT, BY IDS AND THE RECORD'S KEY: the router reads the record by that key, strongly consistent, and verifies it
  // before anything runs. The key is the token's hash, never the token.
  await (d.nameEvent ?? invitationSentThroughRouter)(facts.classification, channelArn, record.invitationId, record.pk).catch(() => false);
  return http.respond(201, {
    invitation: invitationViewOf({ ...record, emailed }, now),
    emailed,
    // THE INVITER HOLDS THE CREDENTIAL ONLY WHEN NO EMAIL CARRIED IT: they pass it on themselves.
    ...(emailed ? {} : { link }),
  });
}

// ── THE INVITEE'S PARTICIPANT ROLE ───────────────────────────────────────────────────────────────

/**
 * THE INVITEE HOLDS THE ROLE FROM NOW, as a member (DESIGN-CONVERSATION-TYPES section 6.1): a moderator of this channel
 * first when the role confers it, as the service admin, then the holding on the channel-context row, naming that
 * moderation's origin only when this call made it. Neither failure takes the invitation back: the role stays on the
 * record, and a holding that could not be written is logged, so the invitee is addressed by nothing for that role.
 */
async function recordInvitedHolding(
  args: { channelArn: string; inviteeArn: string; role: string; moderator: boolean; bearer: string; invitationId: string; claimed?: boolean },
  d: InvitationsDeps,
): Promise<void> {
  const personId = personIdFromArn(args.inviteeArn);
  const { contextTable } = env(d);
  if (!personId || !contextTable) return;
  let moderation: string | undefined;
  if (args.moderator) {
    try {
      await (d.moderate ?? setParticipantRoleModerator)({ channelArn: args.channelArn, personArn: args.inviteeArn, bearerArn: args.bearer, moderator: true });
      moderation = moderationOrigin(args.role);
    } catch (err) {
      console.error('[Invitations] the participant role\'s moderation could not be conferred', { err: nameOf(err), invitationId: args.invitationId });
    }
  }
  // A ONE-HOLDER ROLE WAS CLAIMED ALREADY: its holding is written again only to name the moderation the role conferred.
  if (args.claimed && !moderation) return;
  try {
    await recordHolding(docOf(d), contextTable, args.channelArn, args.role, personId, { origin: 'invitation', ...(moderation ? { moderation } : {}) }, { onlyHolder: args.claimed });
    console.log(JSON.stringify({ _auditEvent: 'participant_role_held', channelArn: args.channelArn, personArn: args.inviteeArn, participantRole: args.role, origin: 'invitation', ...(moderation ? { moderation } : {}) }));
  } catch (err) {
    console.error('[Invitations] the participant role could not be recorded on the conversation', { err: nameOf(err), invitationId: args.invitationId });
  }
}

/**
 * THE ROLE GOES WITH THE INVITATION: the holding is removed, and the moderation too when the holding names it as the
 * role's (`participantRole:<name>`). A moderation of any other origin is left alone. Best-effort, logged.
 */
async function releaseInvitedHolding(record: InvitationRecord, bearer: string, d: InvitationsDeps): Promise<void> {
  const role = record.participantRole;
  const personId = personIdFromArn(record.personArn);
  const { contextTable } = env(d);
  if (!role || !personId || !contextTable) return;
  try {
    const row = await docOf(d).send(new GetCommand({ TableName: contextTable, Key: { channelArn: record.channelArn }, ProjectionExpression: 'conversationType, participantRoles' }));
    const holding = parseHoldings(row?.Item?.participantRoles, row?.Item?.conversationType)[role]?.[personId];
    if (holding?.moderation === moderationOrigin(role) && participantRoleOf(row?.Item?.conversationType, role)) {
      await (d.moderate ?? setParticipantRoleModerator)({ channelArn: record.channelArn, personArn: record.personArn, bearerArn: bearer, moderator: false });
    }
    await removeHolding(docOf(d), contextTable, record.channelArn, role, personId);
  } catch (err) {
    console.error('[Invitations] the invitee\'s participant role could not be released', { err: nameOf(err), invitationId: record.invitationId });
  }
}

// ── LIST AND REVOKE ──────────────────────────────────────────────────────────────────────────────

/** One revocation, for a member, a moderator and the console alike. */
export async function revokeRecord(record: InvitationRecord, revokedBy: string, d: InvitationsDeps): Promise<InvitationRecord> {
  const e = env(d);
  const now = nowOf(d);
  const revoked = (await markRevoked(docOf(d), e.tokensTable, record.pk, revokedBy, now)) ?? record;
  // THE MEMBERSHIP GOES WHETHER OR NOT IT WAS REDEEMED, and whoever revoked it first: removing it twice is nothing.
  const bearer = await bearerOf(d)();
  if (!bearer) throw new Error('the service admin could not be read');
  await (d.removeMember ?? removeInvitedMember)({ channelArn: record.channelArn, inviteeArn: record.personArn, bearerArn: bearer });
  // DELETING A MEMBERSHIP DOES NOT CLEAR A MODERATION (measured, `membership-reconcile.ts`), so the role's goes here.
  await releaseInvitedHolding(record, bearer, d);
  // A REVOKED INVITATION NEEDS NO DEADLINE (ADR-061 decision 1): the router of its classification deletes the schedule
  // that would chase it. One left behind is harmless, because the router finds the invitation revoked when it fires.
  await (d.cancelDeadline ?? cancelDeadlinesThroughRouter)(record.classification, { channelArn: record.channelArn, invitationId: record.invitationId })
    .catch(() => false);
  console.log(JSON.stringify({ _auditEvent: 'invitation_revoked', revokedBy, inviteeArn: record.personArn, channelArn: record.channelArn, invitationId: record.invitationId }));
  return revoked;
}

async function memberScope(event: any, channelRaw: unknown, d: InvitationsDeps): Promise<{ callerArn: string; channelArn: string; moderator: boolean } | HttpResult> {
  const caller = await callerPerson(event);
  if (!caller || caller.source !== 'edge') return refuse(401, 'UNAUTHENTICATED', 'a signed-in member sees a conversation\'s invitations');
  const e = env(d);
  if (!e.tokensTable || !e.appInstanceArn) return refuse(500, 'SERVER_MISCONFIG', 'invitations are not configured');
  const callerArn = caller.personArn ?? userArnFor(e.appInstanceArn, caller.personId);
  const channelArn = channelOf(channelRaw, e.appInstanceArn);
  if (!channelArn) return refuse(400, 'INVITATION_INVALID', 'channelArn names one conversation of this instance');
  try {
    await conversationFacts(channelArn, callerArn, d);
    return { callerArn, channelArn, moderator: await isModerator(channelArn, callerArn, d) };
  } catch (err) {
    if (err instanceof Refused) return refuse(err.status, err.code, err.message);
    console.error('[Invitations] the conversation could not be read', { err: nameOf(err) });
    return refuse(503, 'INVITATIONS_UNAVAILABLE', 'the conversation could not be read');
  }
}

export async function listForMember(event: any, d: InvitationsDeps = {}): Promise<HttpResult> {
  const scope = await memberScope(event, event?.queryStringParameters?.channelArn, d);
  if ('statusCode' in scope) return scope;
  const now = nowOf(d);
  const records = await listInvitations(docOf(d), env(d).tokensTable, scope.channelArn);
  const visible = scope.moderator ? records : records.filter((r) => r.inviterArn === scope.callerArn);
  return http.respond(200, { invitations: visible.map((r) => invitationViewOf(r, now)), moderator: scope.moderator });
}

export async function revokeForMember(event: any, d: InvitationsDeps = {}): Promise<HttpResult> {
  const body = bodyOf(event);
  if (!body) return refuse(400, 'INVITATION_INVALID', 'the body is not JSON');
  const scope = await memberScope(event, body.channelArn, d);
  if ('statusCode' in scope) return scope;
  const id = typeof body.invitationId === 'string' ? body.invitationId : '';
  const record = await findInvitation(docOf(d), env(d).tokensTable, scope.channelArn, id);
  if (!record) return refuse(404, 'INVITATION_UNKNOWN', 'no such invitation in this conversation');
  if (record.inviterArn !== scope.callerArn && !scope.moderator) {
    return refuse(403, 'NOT_YOURS', 'an invitation is revoked by the member who issued it or a moderator');
  }
  try {
    const revoked = await revokeRecord(record, scope.callerArn, d);
    return http.respond(200, { invitation: invitationViewOf(revoked, nowOf(d)) });
  } catch (err) {
    console.error('[Invitations] the revocation could not complete', { err: nameOf(err) });
    return refuse(503, 'INVITATIONS_UNAVAILABLE', 'the invitation could not be revoked');
  }
}

// ── THE CONSOLE'S OPERATIONS ─────────────────────────────────────────────────────────────────────

/** What the admin backend asks: `admin-list` a conversation's invitations, or `admin-revoke` one. */
export interface AdminOperation {
  op: 'admin-list' | 'admin-revoke';
  channelArn: string;
  invitationId?: string;
  /** The administrator's person id, recorded as who revoked it. */
  actor?: string;
}

export async function adminOperation(input: AdminOperation, d: InvitationsDeps = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const e = env(d);
  const channelArn = channelOf(input.channelArn, e.appInstanceArn);
  if (!channelArn || !e.tokensTable) return { ok: false, status: 400, body: { error: 'channelArn names one conversation of this instance', code: 'INVITATION_INVALID' } };
  const now = nowOf(d);
  if (input.op === 'admin-list') {
    const records = await listInvitations(docOf(d), e.tokensTable, channelArn);
    return { ok: true, status: 200, body: { invitations: records.map((r) => invitationViewOf(r, now)) } };
  }
  const actor = typeof input.actor === 'string' && input.actor ? input.actor : '';
  if (!actor || !personIdFromArn(userArnFor(e.appInstanceArn, actor))) {
    return { ok: false, status: 400, body: { error: 'a revocation names who asked for it', code: 'INVITATION_INVALID' } };
  }
  const record = await findInvitation(docOf(d), e.tokensTable, channelArn, String(input.invitationId || ''));
  if (!record) return { ok: false, status: 404, body: { error: 'no such invitation in this conversation', code: 'INVITATION_UNKNOWN' } };
  const revoked = await revokeRecord(record, `admin:${actor}`, d);
  return { ok: true, status: 200, body: { invitation: invitationViewOf(revoked, now) } };
}

// ── THE REMINDER AN INVITER CONFIRMED (ADR-061, `send_nudge`) ────────────────────────────────────

/**
 * What the apply endpoint (`proposals-api.ts`) asks once the inviter applied a `send_nudge` proposal: remind the
 * invitee, at the address the inviter typed when they confirmed it, with the note the proposal drafted.
 */
export interface NudgeOperation {
  op: 'nudge';
  channelArn: string;
  invitationId: string;
  /** The person who applied the proposal, as the apply endpoint authorized them. Must be the invitation's inviter. */
  confirmedBy: string;
  /** Where this one email goes. Used for it and stored nowhere (K2). */
  address: string;
  note?: string;
}

/**
 * REMIND THE INVITEE, ONCE (ADR-061 decision 8, rule 6; "at most one nudge per person per invitation"). In this order,
 * and nothing later runs when anything earlier refuses:
 *
 *  1. The invitation is one of this conversation's, still pending, and the person who confirmed is its inviter.
 *  2. A SECOND LINK, BESIDE THE FIRST, in one transaction: an alias record under a new token's hash naming the
 *     invitation's record (`InvitationAlias`), and `nudgedAt` set on that record on condition it is still pending and
 *     was never nudged. The store keeps only hashes, so the first link cannot be sent again; both now redeem the one
 *     record, so redeeming either spends both and revoking it ends both. A second nudge is refused by that condition.
 *  3. The reminder goes to the address typed, as the `nudge` kind: sent only while the invitee has not stopped it, with
 *     the one-click unsubscribe, through `Notifications`.
 */
export async function nudgeOperation(input: NudgeOperation, d: InvitationsDeps = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const e = env(d);
  const no = (status: number, code: string, error: string) => ({ ok: false, status, body: { error, code } });
  const channelArn = channelOf(input.channelArn, e.appInstanceArn);
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  if (!channelArn || !e.tokensTable || typeof input.invitationId !== 'string' || typeof input.confirmedBy !== 'string') return no(400, 'INVITATION_INVALID', 'a reminder names one invitation of one conversation and who confirmed it');
  if (!ADDRESS.test(address)) return no(400, 'ADDRESS_INVALID', 'a reminder goes to one email address');
  if (!e.landingOrigin) return no(503, 'INVITATIONS_UNAVAILABLE', 'no landing page is configured, so no link can be sent');
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 1000) : '';
  const now = nowOf(d);
  const record = await findInvitation(docOf(d), e.tokensTable, channelArn, input.invitationId);
  if (!record) return no(404, 'INVITATION_UNKNOWN', 'no such invitation in this conversation');
  if (record.inviterArn !== input.confirmedBy) {
    console.warn('[Invitations][SecurityEvent] a reminder was confirmed by someone other than the inviter; refused', { channelArn });
    return no(403, 'NOT_YOURS', 'a reminder is confirmed by the member who issued the invitation');
  }
  if (invitationStatusOf(record, now) !== 'pending') return no(409, 'INVITATION_NOT_PENDING', 'the invitation was redeemed, revoked or has expired');
  const token = newPlatformToken();
  const alias: InvitationAlias = {
    pk: tokenKey('invitation', token), kind: 'invitation', aliasOf: record.pk, channelArn, personArn: record.personArn,
    inviterArn: record.inviterArn, issuer: record.issuer, redemption: 'single-use', expiresAt: record.expiresAt,
    reclaimAt: record.reclaimAt, createdAt: new Date(now * 1000).toISOString(),
  };
  try {
    await docOf(d).send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: e.tokensTable, Item: alias, ConditionExpression: 'attribute_not_exists(pk)' } },
        {
          Update: {
            TableName: e.tokensTable,
            Key: { pk: record.pk },
            UpdateExpression: 'SET nudgedAt = :now',
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(consumedAt) AND attribute_not_exists(revokedAt) AND attribute_not_exists(nudgedAt) AND expiresAt > :now',
            ExpressionAttributeValues: { ':now': now },
          },
        },
      ],
    }));
  } catch (err) {
    if (nameOf(err) === 'TransactionCanceledException') return no(409, 'ALREADY_NUDGED', 'this invitation was already reminded, or is no longer pending');
    throw err;
  }
  const sent = await (d.mail ?? invokeTransactionalMail)({
    mail: 'nudge', personArn: record.personArn, address, name: record.inviteeName, channelArn, link: invitationLink(e.landingOrigin, token),
    ...(record.inviterName ? { sender: record.inviterName } : {}),
    ...(record.conversationName ? { title: record.conversationName } : {}),
    ...(note ? { note } : {}),
  });
  console.log(JSON.stringify({ _auditEvent: 'invitation_nudged', confirmedBy: input.confirmedBy, channelArn, invitationId: record.invitationId, sent }));
  return { ok: true, status: 200, body: { sent } };
}

// ── THE HANDLER ──────────────────────────────────────────────────────────────────────────────────

/** A direct invocation: no gateway request context, an operation named. Only an IAM-granted principal can send one. */
const isOperation = (event: any): event is AdminOperation => !!event && typeof event === 'object' && !event.requestContext
  && !event.httpMethod && (event.op === 'admin-list' || event.op === 'admin-revoke');
const isNudge = (event: any): event is NudgeOperation => !!event && typeof event === 'object' && !event.requestContext
  && !event.httpMethod && event.op === 'nudge';

export const handler = async (event: any): Promise<HttpResult | { ok: boolean; status: number; body: unknown }> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (isNudge(event)) {
    try {
      return await nudgeOperation(event);
    } catch (err) {
      console.error('[Invitations] a reminder could not be sent', { err: nameOf(err) });
      return { ok: false, status: 503, body: { error: 'the reminder could not be sent', code: 'INVITATIONS_UNAVAILABLE' } };
    }
  }
  if (isOperation(event)) {
    try {
      return await adminOperation(event);
    } catch (err) {
      console.error('[Invitations] a console operation failed', { op: event.op, err: nameOf(err) });
      return { ok: false, status: 503, body: { error: 'the invitations could not be read or changed', code: 'INVITATIONS_UNAVAILABLE' } };
    }
  }
  if (event?.httpMethod === 'OPTIONS') return http.empty(204);
  const route = String(event?.resource || event?.path || '');
  const method = String(event?.httpMethod || '');
  if (route === CREATE_ROUTE && method === 'POST') return createInvitation(event);
  if (route === CREATE_ROUTE && method === 'GET') return listForMember(event);
  if (route === REVOKE_ROUTE && method === 'POST') return revokeForMember(event);
  return refuse(404, 'NOT_FOUND', 'no such route');
};
