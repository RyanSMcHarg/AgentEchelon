/**
 * Admin Conversations API — backs the admin dashboard Conversations tab
 * (level-3 moderation; see docs/SPEC-MODERATION.md).
 *
 * This handler is READ-ONLY over the ANALYTICS ARCHIVE (Athena over the
 * `conversations` Glue table; the system of record for history). No single bot
 * sees every channel, so live Chime is the wrong source for cross-conversation
 * review. It holds NO Chime bearer.
 *
 * Every live-Chime ACTION (listing members, add-self / add-member, redact,
 * delete) runs CLIENT-SIDE as the admin's OWN `${personId}-admin` identity, vended
 * per-channel by the Credential-Exchange (docs/SPEC-ADMIN-IDENTITY.md,
 * `chimeService.ts`). No server-side component wields a bearer on the admin's
 * behalf.
 *
 * Two read backends by analytics mode, behind one seam (`lib/archive-reader.ts`): Athena
 * over the `conversations` Glue table, or, in Aurora mode, Aurora Postgres via the VPC
 * data-plane Lambda (BUG #21: the Athena archive query takes 15-27s and 502s past API
 * Gateway's 29s cap; Aurora answers the same views sub-second). This handler holds only
 * auth, scope and HTTP; the reader is chosen once per request.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { callerIsAdmin, callerCanReadArchive, callerCanSeeUserIdentity, isAdminIamEnforcedCall, callerPersonId } from './lib/auth.js';
import { scopeForRequest, classificationAllowed, type ClassificationScope } from './lib/caller-scope.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { requireOwnedAssistant, isRefusal } from './lib/assistant-scope.js';
import { listAssistantIdentities } from './lib/assistant-ownership.js';
import { chimeIdentityClient } from './lib/chime/clients.js';
import { membershipPeriods, withinPeriods } from './lib/membership-period.js';
import { archiveReader, type ArchiveReader } from './lib/archive-reader.js';
import { recordAccess, type AccessAuditLine } from './lib/access-log.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
// A14 Scoped: the pool the caller's classification scope is resolved against
// (same stack, so this is always set on the admin-conversations Lambda).
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN);

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,OPTIONS' });

function isAllowedOrigin(origin?: string): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

const respond = http.respond;

function requireAdmin(event: APIGatewayProxyEvent): string | null {
  // Shared, IdP-agnostic admin gate (honors ADMIN_GROUP_NAMES + service mode).
  // Behaves exactly like the legacy `groups.includes('admins')` under the
  // default ae-cognito mode.
  return callerIsAdmin(event) ? null : 'Admin access required';
}

function isValidChannelArn(channelArn: string): boolean {
  if (!channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) return false;
  const channelId = channelArn.slice(`${APP_INSTANCE_ARN}/channel/`.length);
  return /^[a-zA-Z0-9-]+$/.test(channelId);
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === 'OPTIONS') return respond(200, {}, origin);
  if (!isAllowedOrigin(origin)) return respond(403, { error: 'Origin not allowed' }, origin);
  const authError = requireAdmin(event);
  if (authError) return respond(403, { error: authError }, origin);
  // Every endpoint here reads conversation ARCHIVE content, a SEPARABLE authorization from base
  // admin so a future role can be denied archive access. Interim group gate (callerCanReadArchive,
  // default = the admin groups); the IAM-enforceable capability is the tracked follow-up.
  if (!callerCanReadArchive(event)) {
    return respond(403, { error: 'Archive-view permission required' }, origin);
  }

  // The archive this deployment reads, chosen once for the request.
  const archive = await archiveReader();

  // A14 Scoped: under IAM enforcement, narrow the reads to the caller's
  // classification scope (resolved from the verified sub). Full (null) only on a
  // Cognito-JWT call (the default path is unchanged); an enforced call FAILS CLOSED
  // to the floor if the caller cannot be identified (scopeForRequest).
  const callerScope: ClassificationScope = isAdminIamEnforcedCall(event)
    ? await scopeForRequest(event, USER_POOL_ID)
    : null;

  // A TEAM MEMBER'S ROUTE NAMES ONE ASSISTANT (SPEC-ADMIN-CONSOLE FR48): its conversations are the
  // ones that assistant was made a member of, for the list and the lookup alike, and a conversation's
  // messages only from the periods the assistant was in it. The other reads have no scoped route, so a
  // scoped path reaching them is not one this handler serves.
  const scope = await requireOwnedAssistant(event, origin);
  if (isRefusal(scope)) return scope;
  const memberArns = scope ? scope.bots.map((b) => b.botArn) : null;
  // A scope that resolves to no identity reaches no conversation; it is answered here, before any query.
  if (memberArns && memberArns.length === 0) return respond(200, { conversations: [], total: 0 }, origin);

  try {
    const path = event.path;
    const method = event.httpMethod;

    if (scope && method === 'GET' && path.endsWith('/messages')) {
      return teamListMessages(archive, event, origin, callerScope, scope.assistant, memberArns ?? []);
    }
    if (method === 'GET' && path.endsWith('/clean')) {
      return readCleanConversation(archive, event, origin, callerScope, scope ? { assistant: scope.assistant, memberArns: memberArns ?? [] } : null);
    }
    if (scope && !(method === 'GET' && (path.endsWith('/conversations') || path.endsWith('/conversations/find')))) {
      return respond(404, { error: 'Not found' }, origin);
    }
    if (method === 'GET' && path.endsWith('/conversations')) {
      // AN ADMIN'S LIST NARROWED TO ONE ASSISTANT (`?assistant=`, the assistant page's Conversations link): the
      // conversations one of its identities was a member of, read the way a team's route reads them. A narrowing of a
      // list the caller already reads, under the same classification scope, never a widening; the team route is
      // already one assistant's and ignores it.
      const named = !scope ? (event.queryStringParameters?.assistant || '').trim() : '';
      if (named) {
        const bots = (await listAssistantIdentities(chimeIdentityClient({ region: process.env.AWS_REGION || 'us-east-1' }), APP_INSTANCE_ARN))
          .filter((b) => b.assistant === named);
        if (!bots.length) return respond(200, { conversations: [], total: 0 }, origin);
        return listConversations(archive, event, origin, callerScope, null, bots.map((b) => b.botArn));
      }
      return listConversations(archive, event, origin, callerScope, null, memberArns);
    }
    if (method === 'GET' && path.endsWith('/conversations/find')) return findConversation(archive, event, origin, callerScope, memberArns);
    if (method === 'GET' && path.endsWith('/identities')) return resolveIdentities(archive, event, origin, callerScope);
    if (method === 'GET' && path.endsWith('/messages')) return listMessages(archive, event, origin, callerScope);
    if (method === 'GET' && path.endsWith('/membership-history')) return membershipHistory(archive, event, origin, callerScope);

    return respond(404, { error: 'Not found' }, origin);
  } catch (error) {
    console.error('[AdminConversations] Error:', error);
    return respond(500, { error: (error as Error).message }, origin);
  }
};

// ── VIEW: read the archive ───────────────────────────────────────────────────

/**
 * One conversation by the id a person gave an operator (SPEC-ADMIN-CONSOLE FR52).
 *
 * Accepts the bare channel id or the full channel ARN, and answers from the same query as the list
 * under the same classification scope, so a lookup can never reach a conversation the list would not
 * show. A conversation outside the caller's scope and one that does not exist get the same 404: the
 * lookup must not confirm that a conversation exists to someone not permitted to see it.
 */
async function findConversation(archive: ArchiveReader, event: APIGatewayProxyEvent, origin?: string, callerScope: ClassificationScope = null, memberArns: string[] | null = null): Promise<APIGatewayProxyResult> {
  const raw = (event.queryStringParameters?.id || '').trim();
  const channelId = raw.includes('/channel/') ? raw.slice(raw.lastIndexOf('/channel/') + '/channel/'.length) : raw;
  const channelArn = channelId ? `${APP_INSTANCE_ARN}/channel/${channelId}` : '';
  if (!channelArn || !isValidChannelArn(channelArn) || (raw.includes('/channel/') && raw !== channelArn)) {
    return respond(400, { error: 'A conversation id is required', code: 'CONVERSATION_ID_INVALID' }, origin);
  }
  return listConversations(archive, event, origin, callerScope, channelArn, memberArns);
}

async function listConversations(
  archive: ArchiveReader,
  event: APIGatewayProxyEvent,
  origin?: string,
  callerScope: ClassificationScope = null,
  only: string | null = null,
  /** A team's assistant identities: only conversations one of them was a member of. */
  memberArns: string[] | null = null,
): Promise<APIGatewayProxyResult> {
  const limit = only ? 1 : Math.min(Number(event.queryStringParameters?.limit || '50'), 200);
  const offset = only ? 0 : Math.max(Number(event.queryStringParameters?.offset || '0'), 0);
  // The lookup answers with the one conversation, or a 404 that does not say whether it exists.
  // Filtered again here, so a data plane that predates the filter can never answer with another row.
  const answer = (conversations: Array<AdminConversationSummaryLike & { channelArn?: string }>, total: number) => {
    if (!only) return respond(200, { conversations, total, limit, offset }, origin);
    const match = conversations.find((c) => c.channelArn === only);
    return match
      ? respond(200, { conversation: match }, origin)
      : respond(404, { error: 'No conversation with that id in your scope', code: 'CONVERSATION_NOT_FOUND' }, origin);
  };
  // A14 Scoped: the classifications the caller's scope grants. Pushed INTO the SQL (below) so
  // server-side LIMIT/OFFSET/total stay consistent for a scoped admin; null = full access (no filter).
  // FROM THE REGISTRY, not a frozen three. An `admin`-classified conversation was never in this
  // list, so the admin notification channel and every other conversation at a newly declared
  // classification was invisible in the console - to a Full-scope caller as much as anyone, because
  // the value could not appear in the allow-list at all.
  const allowed = callerScope === null ? null : profiles.classificationValues().filter((c) => classificationAllowed(c, callerScope));
  // Belt-and-suspenders: also filter the returned page (a no-op once the query filters, but it guards
  // any classification value outside the known set).
  const scope = (list: AdminConversationSummaryLike[]) =>
    callerScope === null ? list : list.filter((c) => classificationAllowed(c?.metadata?.modelTier, callerScope));
  if (memberArns && !archive.projection) {
    return respond(501, { error: 'A team-scoped conversation list needs Aurora analytics mode', code: 'TEAM_SCOPE_NEEDS_AURORA' }, origin);
  }
  try {
    const { conversations, total } = await archive.listConversations({ limit, offset, allowed, only, memberArns });
    return answer(scope(conversations), total);
  } catch (err) {
    console.error(`[AdminConversations] ${archive.kind} list failed:`, err);
    return respond(200, { conversations: [], archiveError: (err as Error).message }, origin);
  }
}

// Minimal shape the classification scope reads (both readers' summaries carry
// metadata.modelTier = the channel classification).
type AdminConversationSummaryLike = { metadata?: { modelTier?: string } };

// A14 Scoped guard for a SINGLE channel (messages / membership-history take a
// channelArn directly, so the caller could replay an ARN outside their scoped
// list). Resolve the channel's classification and deny if the caller's scope does not grant it.
// Fail-CLOSED: if the classification cannot be determined, deny. Full admins never
// reach the read (short-circuited below).
async function channelClassificationAllowed(archive: ArchiveReader, channelArn: string, callerScope: ClassificationScope): Promise<boolean> {
  if (callerScope === null) return true; // Full
  let cls: string | undefined;
  try {
    cls = await archive.channelClassification(channelArn);
  } catch { cls = undefined; }
  if (cls === undefined) return false; // cannot determine -> fail closed
  return classificationAllowed(cls, callerScope);
}

/**
 * NO PARTICIPANT NAME LEAVES A CONVERSATION READ. RESOLVING ONE IS ITS OWN ROUTE.
 *
 * A conversation read returns participant ARNs and never names, for every caller, because a name is a
 * separate grant (`see-user-identity`) and the route it rides on is not. Being told which human sent
 * which line is resolved by `GET /admin/conversations/identities`, which has its own `execute-api`
 * resource so API Gateway can refuse it.
 *
 * WHY THE PAYLOAD IS EMPTIED RATHER THAN FILTERED PER CALLER. A per-caller field decision has to know
 * every field a name travels in, and that list is longer than it looks: three were missed in one pass -
 * `raw.Sender.Name` nested inside the inspect payload, `invitedBy`, and `moderatedByName`. Worse, a
 * per-caller check on a shared route has no resource behind it, so on an IAM-authorized route it binds
 * nothing and every caller receives every name. A payload with no name in it cannot leak one,
 * whatever a future field is called and whichever branch assembles it.
 *
 * WHAT IT DROPS, and why each is the same disclosure:
 * - `senderName`, `memberName` - the participant, whose Amazon Chime SDK `Name` is their email address.
 * - `invitedBy` - a `sender_name`, so also an email, and the only one with no ARN archived beside it,
 *   which is why a surface omits the clause rather than degrading it to an id.
 * - `moderatedByName` - the OPERATOR who redacted or deleted. A different person, the same disclosure,
 *   and naming the colleague who moderated a conversation is what `view-moderation-audit` is for.
 * - `raw.Sender.Name` and `raw.ModeratedBy.Name` - blanked IN PLACE rather than deleted, because `raw`
 *   is presented as the faithful stored record and a missing key there reads as "the archive has no
 *   sender" instead of "you were not told who it is".
 *
 * WHY IT STRIPS AFTER THE READ rather than asking the data plane not to select the column: the names
 * are what `resolveIdentities` below answers from, so they are read once and used for both. They cross
 * from Aurora into this Lambda, which is the boundary already trusted with the message bodies
 * themselves; the boundary this protects is the browser.
 */
type IdentityBearing = {
  senderName?: string | null;
  memberName?: string;
  invitedBy?: string;
  moderatedByName?: string;
  raw?: Record<string, unknown>;
};

function withoutIdentity<T extends IdentityBearing>(rows: T[]): T[] {
  return rows.map((row) => {
    const { senderName, memberName, invitedBy, moderatedByName, ...rest } = row;
    if (rest.raw) rest.raw = scrubRawIdentity(rest.raw);
    // Every dropped field is optional on the shared types, so a row without them still satisfies T.
    // The cast states that; `Omit` would widen the return type and push the same cast onto the callers.
    return rest as unknown as T;
  });
}

/**
 * WHO the participants of one conversation are (`see-user-identity`).
 *
 * Scoped to a conversation rather than taking a list of ARNs, so the classification scope applies to
 * the same subject the other reads check, and so the query string cannot grow past a gateway limit on a
 * busy channel. Returns a map, because the caller already holds the ARNs and needs only the half it was
 * refused.
 *
 * The group check stays as a second layer and is what binds on a Cognito-JWT deployment. Under IAM
 * enforcement the gateway is the layer that binds, and satisfying an IAM-signed caller directly is sound
 * HERE, unlike on the shared conversation route: reaching this resource proves the capability, because
 * this resource authorizes nothing else.
 */
async function resolveIdentities(archive: ArchiveReader, event: APIGatewayProxyEvent, origin?: string, callerScope: ClassificationScope = null): Promise<APIGatewayProxyResult> {
  if (!callerCanSeeUserIdentity(event)) {
    return respond(403, { error: 'Identity-view permission required' }, origin);
  }
  const channelArn = event.queryStringParameters?.channelArn || '';
  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'Valid channelArn query parameter required' }, origin);
  }
  if (!(await channelClassificationAllowed(archive, channelArn, callerScope))) {
    return respond(403, { error: 'Conversation is outside your classification scope' }, origin);
  }

  // Read the same rows the conversation views read (`participants` answers from the membership
  // timeline and the messages the other routes return), and keep only the pairing they had stripped.
  const identities: Record<string, string> = {};
  const note = (arn?: string | null, name?: string | null) => {
    if (arn && name && !identities[arn]) identities[arn] = name;
  };

  try {
    for (const p of await archive.participants(channelArn)) note(p.arn, p.name);
  } catch (err) {
    console.error('[AdminConversations] identity resolve failed:', err);
    return respond(200, { identities: {}, archiveError: (err as Error).message }, origin);
  }

  return respond(200, { identities }, origin);
}

/** `WITHHELD` rather than a deletion, so the drawer shows that a field exists and was not disclosed. */
const WITHHELD = '(identity withheld)';

function scrubRawIdentity(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const key of ['Sender', 'ModeratedBy'] as const) {
    const holder = out[key];
    if (holder && typeof holder === 'object' && 'Name' in (holder as Record<string, unknown>)) {
      // The ARN in the same object stays: it identifies the actor without naming them.
      out[key] = { ...(holder as Record<string, unknown>), Name: WITHHELD };
    }
  }
  return out;
}

async function listMessages(archive: ArchiveReader, event: APIGatewayProxyEvent, origin?: string, callerScope: ClassificationScope = null): Promise<APIGatewayProxyResult> {
  // FROM THE PATH, because that is what the credential was scoped to. An execute-api ARN carries no
  // query string, so while the conversation arrived as `?channelArn=` the session policy could pin
  // only the route - and this route reads customer MESSAGE CONTENT. The id is rebuilt into an ARN
  // here rather than carried as one: a path segment cannot hold an ARN's unencoded slashes, and
  // encoded ones are matched inconsistently between the gateway and IAM.
  //
  // `membershipHistory` below still takes the query string; it was not part of this change.
  const channelId = event.pathParameters?.channelId || '';
  const channelArn = channelId ? `${APP_INSTANCE_ARN}/channel/${channelId}` : '';
  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'A conversation id path segment is required' }, origin);
  }
  if (!(await channelClassificationAllowed(archive, channelArn, callerScope))) {
    return respond(403, { error: 'Conversation is outside your classification scope' }, origin);
  }
  // The reader returns each sender's name, and `withoutIdentity` removes it, because
  // `resolveIdentities` answers from the same rows. Nothing on this route returns it.
  try {
    return respond(200, { messages: withoutIdentity(await archive.messages(channelArn)) }, origin);
  } catch (err) {
    console.error(`[AdminConversations] ${archive.kind} messages failed:`, err);
    return respond(200, { messages: [], archiveError: (err as Error).message }, origin);
  }
}

/** The longest reason a read records. A reason is a sentence, not a document. */
const MAX_REASON_LENGTH = 500;

/**
 * A READ OF A CONVERSATION IS IN THE ACCESS LOG BEFORE ITS CONTENT IS RETURNED (ADR-052, owner 2026-10-26).
 *
 * An admin's read arrives on a credential the exchange vended for one conversation, and the exchange
 * recorded it. A team member's read, and the de-identified copy, arrive on the console session itself, so
 * no vend records them: their audit line reached CloudWatch only, and the console's Access Log could not
 * show who on a team read which conversation, or why. They are recorded here, under the exchange's rule:
 * a read whose record cannot be written is refused, not served unrecorded. The CloudWatch line stays.
 *
 * Returns the refusal to send, or null when the record was written.
 */
async function readRecorded(origin: string | undefined, line: AccessAuditLine): Promise<APIGatewayProxyResult | null> {
  console.log(JSON.stringify(line));
  try {
    await recordAccess(line);
    return null;
  } catch (err) {
    console.error('[AdminConversations] the read could not be recorded; refusing it:', (err as Error)?.message);
    return respond(503, { error: 'Access cannot be recorded right now, so it is not granted', code: 'ACCESS_LOG_UNAVAILABLE' }, origin);
  }
}

/**
 * A TEAM MEMBER READS A CONVERSATION'S MESSAGES (`view-messages`, SPEC-ADMIN-CONSOLE "Membership period").
 *
 * Only a conversation the path's assistant was a member of, and only the turns from the periods it was
 * there, read from the archived membership timeline. A conversation it was never in answers as not found,
 * whether or not it exists. Like the admin read, it requires a stated reason, recorded on an audit line
 * beside what was reached and the periods it was bounded to.
 */
async function teamListMessages(
  archive: ArchiveReader,
  event: APIGatewayProxyEvent,
  origin: string | undefined,
  callerScope: ClassificationScope,
  assistant: string,
  memberArns: string[],
): Promise<APIGatewayProxyResult> {
  const notFound = () => respond(404, { error: 'No conversation with that id in your scope', code: 'CONVERSATION_NOT_FOUND' }, origin);
  const channelId = event.pathParameters?.channelId || '';
  const channelArn = channelId ? `${APP_INSTANCE_ARN}/channel/${channelId}` : '';
  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'A conversation id path segment is required' }, origin);
  }
  const reason = (event.queryStringParameters?.reason || '').trim().slice(0, MAX_REASON_LENGTH);
  if (!reason) return respond(400, { error: 'a reason is required to read a conversation', code: 'REASON_REQUIRED' }, origin);
  if (!archive.projection) {
    return respond(501, { error: 'A team-scoped conversation read needs Aurora analytics mode', code: 'TEAM_SCOPE_NEEDS_AURORA' }, origin);
  }
  if (!(await channelClassificationAllowed(archive, channelArn, callerScope))) return notFound();
  let periods;
  try {
    periods = membershipPeriods(await archive.membership(channelArn), memberArns);
  } catch (err) {
    console.error('[AdminConversations] team membership read failed:', err);
    return respond(200, { messages: [], periods: [], archiveError: (err as Error).message }, origin);
  }
  if (periods.length === 0) return notFound();
  let messages;
  try {
    messages = (await archive.messages(channelArn))
      .filter((m) => withinPeriods(m.timestamp, periods))
      .map((m) => {
        // AN EDIT IS SAID WHEN IT IS MADE. A version made after the assistant left is outside what
        // this team may read, so it keeps only the versions inside the periods and shows the latest
        // of them, rather than the message's latest text.
        if (!m.versions) return m;
        const kept = m.versions.filter((v) => withinPeriods(v.at, periods));
        return { ...m, content: kept[kept.length - 1]?.content ?? m.content, versions: kept.length > 1 ? kept : undefined };
      });
  } catch (err) {
    console.error('[AdminConversations] Aurora messages failed:', err);
    return respond(200, { messages: [], periods, archiveError: (err as Error).message }, origin);
  }
  const unrecorded = await readRecorded(origin, {
    _auditEvent: 'team_conversation_read',
    timestamp: new Date().toISOString(),
    personId: (await callerPersonId(event)) || undefined,
    assistant,
    channelArn,
    capabilities: ['view-messages'],
    periods,
    messages: messages.length,
    reason,
  });
  if (unrecorded) return unrecorded;
  return respond(200, { messages: withoutIdentity(messages), periods }, origin);
}

/**
 * THE DE-IDENTIFIED COPY OF ONE CONVERSATION (`view-clean-conversations`, SPEC-ADMIN-CONSOLE FR54).
 *
 * What was said with every participant a pseudonym and personal data described rather than shown; a
 * message removed in the archive shows as removed even before the next run re-derives it. Requires a
 * stated reason, like a raw read, until the detector's recall on this deployment's own conversations
 * says otherwise (DESIGN-ADMIN-CONSOLE 5.3). A team member reads only a conversation its assistant was
 * in, and only the part from the periods it was there.
 *
 * Never for an incident: the copy can be a day old, so a breach is read in the archive (SPEC 1.2).
 */
async function readCleanConversation(
  archive: ArchiveReader,
  event: APIGatewayProxyEvent,
  origin: string | undefined,
  callerScope: ClassificationScope,
  team: { assistant: string; memberArns: string[] } | null,
): Promise<APIGatewayProxyResult> {
  const notFound = () => respond(404, { error: 'No conversation with that id in your scope', code: 'CONVERSATION_NOT_FOUND' }, origin);
  const channelId = event.pathParameters?.channelId || '';
  const channelArn = channelId ? `${APP_INSTANCE_ARN}/channel/${channelId}` : '';
  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'A conversation id path segment is required' }, origin);
  }
  const reason = (event.queryStringParameters?.reason || '').trim().slice(0, MAX_REASON_LENGTH);
  if (!reason) return respond(400, { error: 'a reason is required to read a conversation', code: 'REASON_REQUIRED' }, origin);
  if (!archive.projection) {
    return respond(501, { error: 'The de-identified copy needs Aurora analytics mode', code: 'CLEAN_COPY_NEEDS_AURORA' }, origin);
  }
  if (!(await channelClassificationAllowed(archive, channelArn, callerScope))) {
    return team ? notFound() : respond(403, { error: 'Conversation is outside your classification scope' }, origin);
  }
  let periods: ReturnType<typeof membershipPeriods> | null = null;
  if (team) {
    periods = membershipPeriods(await archive.membership(channelArn), team.memberArns);
    if (periods.length === 0) return notFound();
  }
  const copy = await archive.cleanConversation(channelArn);
  const rows = periods ? copy.rows.filter((r) => withinPeriods(r.occurredAt, periods!)) : copy.rows;
  const unrecorded = await readRecorded(origin, {
    _auditEvent: 'clean_conversation_read',
    timestamp: new Date().toISOString(),
    personId: (await callerPersonId(event)) || undefined,
    assistant: team?.assistant ?? null,
    channelArn,
    capabilities: ['view-clean-conversations'],
    rows: rows.length,
    derivedAt: copy.derivedAt,
    reason,
  });
  if (unrecorded) return unrecorded;
  return respond(200, { rows, derivedAt: copy.derivedAt, ...(periods ? { periods } : {}) }, origin);
}

// Membership HISTORY (audit): joins, leaves and moderator grants from the ARCHIVE.
// Amazon Chime SDK has no membership-history API; the archive captures CREATE/DELETE
// channel-membership and moderator events, so this is the system of record for
// "who joined/left when". Required for audits.
async function membershipHistory(archive: ArchiveReader, event: APIGatewayProxyEvent, origin?: string, callerScope: ClassificationScope = null): Promise<APIGatewayProxyResult> {
  const channelArn = event.queryStringParameters?.channelArn || '';
  if (!channelArn || !isValidChannelArn(channelArn)) {
    return respond(400, { error: 'Valid channelArn query parameter required' }, origin);
  }
  if (!(await channelClassificationAllowed(archive, channelArn, callerScope))) {
    return respond(403, { error: 'Conversation is outside your classification scope' }, origin);
  }
  try {
    return respond(200, { history: withoutIdentity(await archive.membership(channelArn)) }, origin);
  } catch (err) {
    console.error(`[AdminConversations] ${archive.kind} membership history failed:`, err);
    return respond(200, { history: [], archiveError: (err as Error).message }, origin);
  }
}
