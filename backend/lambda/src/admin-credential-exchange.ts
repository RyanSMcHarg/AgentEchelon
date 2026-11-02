/**
 * THE ADMIN CREDENTIAL EXCHANGE (SPEC-ADMIN-CONSOLE "Temporary, scoped credentials", SPEC-CREDENTIAL-EXCHANGE).
 *
 * Every credential the admin console holds comes from here, and this function exists only with the
 * `admin` capability, in the `AdminServices` stack. A deployment without `admin` has no route, no role and
 * no handler that can issue one.
 *
 * Three requests:
 *  - `POST exchange-credentials` with the person's token and `identity: 'console'`: a short-lived CONSOLE
 *    SESSION on the console role the person's groups name (`admins` or `team-members`), holding exactly
 *    that role's capabilities (`admin-capabilities.ts`).
 *  - `POST exchange-credentials/admin/<capability>`, IAM-authorized and signed with a console session: a
 *    per-conversation credential on the admin plane (the separate `${personId}-admin` identity), with a
 *    stated reason. API Gateway admits the request only because the session's role holds that route, so
 *    who may obtain redact, delete, a message read or an attachment is decided by IAM.
 *  - `POST exchange-credentials/admin/assistants/{assistant}/attachment-read`: a team member's read of one
 *    conversation's assistant deliverables.
 *
 * THE PERSON IS NEVER MINTED HERE. The person credential exchange (`credential-exchange.ts`) is the one
 * minter: a console session resolves the person the token's subject already signs in as, read-only, and
 * refuses a subject with no person yet. A per-capability vend carries the person id in the console
 * session's name, which this function wrote.
 *
 * EVERY ADMIN VEND ASKS THE ISSUER (SPEC-CREDENTIAL-EXCHANGE §4b): a console session asks of the token's
 * account (`refuseInactiveAccount`, lib/vend.ts), and a per-capability or team attachment vend asks of
 * the person the session names, through their subjects at the `admin: true` issuers
 * (`refuseInactivePerson`). An account its issuer reports disabled or gone is refused, and an unreadable
 * directory vends nothing.
 */
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { CreateAppInstanceAdminCommand } from '@aws-sdk/client-chime-sdk-identity';
import { DescribeChannelMembershipForAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { listAssistantIdentities, scopeFor, teamsOfGroups } from './lib/assistant-ownership.js';
import { TEAM_NAME_PATTERN } from '../../lib/config/profiles.js';
import { requireOwnedAssistant, isRefusal as isScopeRefusal } from './lib/assistant-scope.js';
import {
  ADMIN_CAPABILITIES,
  roleIsGranted,
  type AdminRole,
  rolesNeedingAdministrationIdentity,
} from '../../lib/config/admin-capabilities.js';
import { heldWithinIssuer } from '../../lib/config/issuers.js';
import { adminTwinIdFor, userArnFor } from './lib/person-arn.js';
import { identityStateOf } from './lib/person-identity.js';
import { consoleSessionOf } from './lib/auth.js';
import type { HttpResult } from './lib/http-response.js';
import {
  APP_INSTANCE_ARN,
  AWS_REGION,
  CAPABILITY_ACTIONS,
  CHANNEL_PREFIX,
  MAX_REASON_LENGTH,
  MODERATION_CAPS,
  MODERATION_SESSION_SECONDS,
  accessRecorded,
  chimeIdentity,
  chimeMessaging,
  consoleRoleFor,
  cors,
  corsOrigin,
  credentialsOf,
  displayNameOf,
  ensureAppInstanceUser,
  isRefusal,
  literalChannelId,
  refuseInactiveAccount,
  refuseInactivePerson,
  reply,
  sts,
  tokenCallerOf,
  type ExchangeResult,
} from './lib/vend.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

/** The admin PLANE role: pinned to the admin's separate `${personId}-admin` identity, a standing app-instance-admin. */
const EXCHANGE_ROLE_ADMIN_PLANE = process.env.EXCHANGE_ROLE_ADMIN_PLANE || '';
const ADMIN_CONSOLE_ROLE_ARN = process.env.ADMIN_CONSOLE_ROLE_ARN || '';
const TEAM_CONSOLE_ROLE_ARN = process.env.TEAM_CONSOLE_ROLE_ARN || '';
const CONSOLE_SESSION_SECONDS = Number(process.env.CONSOLE_SESSION_SECONDS || '3600');
/**
 * A TEAM SESSION IS SHORTER, because its reach is a snapshot: the assistants it names and the clearance in
 * its name are read once, when it is issued. A reassignment or a lowered clearance reaches a team member
 * within this many seconds, not an hour.
 */
const TEAM_CONSOLE_SESSION_SECONDS = Number(process.env.TEAM_CONSOLE_SESSION_SECONDS || '900');
/** The role-session name a console session carries, from which every admin route reads the person. */
const CONSOLE_SESSION_PREFIX = 'console-';
/** The role a team member's attachment read is assumed on: `generated-docs/*` and nothing else. */
const TEAM_ATTACHMENT_ROLE_ARN = process.env.TEAM_ATTACHMENT_ROLE_ARN || '';
/** `POST exchange-credentials/admin/assistants/{assistant}/attachment-read`, a team's attachment route. */
const TEAM_ATTACHMENT_ROUTE = /\/exchange-credentials\/admin\/assistants\/([^/]+)\/attachment-read\/?$/;
const SESSION_POLICY_LIMIT = 2048;

/**
 * THE ARCHIVE PLANE: a capability maps to the API Gateway resource ARN it authorizes, and the exchange
 * vends a session policy of `execute-api:Invoke` on exactly that resource, completed with the one
 * subject the vend is scoped to (intersected with the admin-plane role boundary, which carries the
 * wildcard). The ARNs are TEMPLATES carrying `{id}`.
 */
const EXECUTE_API_CAPABILITY_RESOURCES: Record<string, string> = {
  'view-messages': process.env.EXCHANGE_EXECUTE_API_MESSAGES_ARN || '',
  // TASKS (ADR-033): reading what work is open and CANCELLING somebody's work are different clearances.
  'tasks-read': process.env.EXCHANGE_EXECUTE_API_TASKS_READ_ARN || '',
  'tasks-manage': process.env.EXCHANGE_EXECUTE_API_TASKS_MANAGE_ARN || '',
  // Two cross-conversation reads, because a task has two principal roles (ADR-024 D8).
  'tasks-read-assignee': process.env.EXCHANGE_EXECUTE_API_TASKS_ASSIGNEE_ARN || '',
  'tasks-read-owned-by': process.env.EXCHANGE_EXECUTE_API_TASKS_OWNED_BY_ARN || '',
  'tasks-reassign-owner': process.env.EXCHANGE_EXECUTE_API_TASKS_REASSIGN_ARN || '',
};

/**
 * Which id completes each capability's resource ARN: the channel id, or the principal id the task mirror
 * keys on. Stated rather than inferred, so adding a route without deciding its scope is visible.
 */
const EXECUTE_API_CAP_SCOPE: Record<string, 'channel' | 'principal'> = {
  'view-messages': 'channel',
  'tasks-read': 'channel',
  'tasks-manage': 'channel',
  // CHANNEL-SCOPED, because a task is keyed by (taskId, channelArn). The person receiving the work is body
  // content, not a scope.
  'tasks-reassign-owner': 'channel',
  'tasks-read-assignee': 'principal',
  'tasks-read-owned-by': 'principal',
};
const EXECUTE_API_CAPS = new Set(Object.keys(EXECUTE_API_CAPABILITY_RESOURCES));

/**
 * THE S3 ATTACHMENT PLANE. S3 ARNs condition on the object-key prefix, so the session policy is
 * `s3:GetObject` on ONLY the named channel's keys:
 *   - attachment-read          -> generated-docs/<channelId>/*  (assistant DELIVERABLES)
 *   - attachment-read-uploads  -> attachments/<channelId>/*     (USER-UPLOADED input, may carry PII)
 */
const S3_ATTACHMENT_CAP_PREFIXES: Record<string, string> = {
  'attachment-read': 'generated-docs',
  'attachment-read-uploads': 'attachments',
};
const S3_ATTACHMENT_CAPS = new Set(Object.keys(S3_ATTACHMENT_CAP_PREFIXES));
/** User-uploaded content is more sensitive than assistant output, and is flagged on its audit record. */
const SENSITIVE_ATTACHMENT_CAPS = new Set(['attachment-read-uploads']);

// The attachments bucket ARN, resolved at cold start from SSM. An absent value means the attachment
// plane is unavailable and its vends 500 (misconfigured), never leak.
const ATTACHMENTS_BUCKET_ARN_PARAM = process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN_PARAM || '';
const ssm = new SSMClient({ region: AWS_REGION });
let attachmentsBucketArn: string | null = null;
async function resolveAttachmentsBucketArn(): Promise<string> {
  if (attachmentsBucketArn !== null) return attachmentsBucketArn;
  if (process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN) {
    attachmentsBucketArn = process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN;
    return attachmentsBucketArn;
  }
  if (!ATTACHMENTS_BUCKET_ARN_PARAM) { attachmentsBucketArn = ''; return ''; }
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: ATTACHMENTS_BUCKET_ARN_PARAM }));
    attachmentsBucketArn = r.Parameter?.Value || '';
  } catch (err) {
    console.error('[AdminCredentialExchange] attachments-bucket-arn SSM resolve failed:', err);
    attachmentsBucketArn = '';
  }
  return attachmentsBucketArn;
}

/**
 * THE SESSION POLICY THAT SCOPES A TEAM MEMBER TO THEIR ASSISTANTS AND THEIR TEAMS (DESIGN-ADMIN-CONSOLE 5.2).
 * An assistant's team routes sit under `.../assistants/{assistant}/...`, so one wildcard per owned assistant
 * names all of them. Work on behalf of a team (creating an assistant it will own) sits under
 * `.../teams/{team}/...`, one wildcard per team the person's groups name. The team console role's own
 * grant intersects that with the routes the team holds.
 */
export function teamSessionPolicy(assistants: string[], teams: string[] = []): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Action: 'execute-api:Invoke',
      Resource: [
        ...assistants.map((a) => `arn:aws:execute-api:*:*:*/assistants/${a}/*`),
        ...teams.map((t) => `arn:aws:execute-api:*:*:*/teams/${t}/*`),
      ],
    }],
  });
}

/**
 * THE TEAM SESSION'S MANAGED SESSION POLICIES: following console events (ADR-065), connect and subscribe on the one console
 * events API, as the role's own grant names them. A managed policy rather than a statement in `teamSessionPolicy`, because
 * the inline policy's size bounds how many assistants a team may own, and every character of it is kept for them.
 * Without the policy's ARN the session follows no events, and the console reads on Check again.
 */
export function teamSessionPolicyArns(consoleEventsPolicyArn = process.env.CONSOLE_EVENTS_SESSION_POLICY_ARN || ''): Array<{ arn: string }> {
  return consoleEventsPolicyArn ? [{ arn: consoleEventsPolicyArn }] : [];
}

export { consoleRoleFor };

/** The capability keys a console role is granted today, which is what the console renders against. */
export function capabilitiesHeldBy(role: AdminRole): string[] {
  return Object.values(ADMIN_CAPABILITIES).filter((c) => roleIsGranted(role, c)).map((c) => c.key).sort();
}

/**
 * The granted capabilities a console session does NOT carry: the catalog's `exchangeVend` entries. Each is
 * vended by `adminVend` on request, for one literal conversation (or one task owner), with a stated reason
 * recorded on the access log, for `MODERATION_SESSION_SECONDS`. The console states them apart from what the
 * session holds (SPEC-ADMIN-CONSOLE FR0e), read from here rather than from a copy of the catalog.
 */
export function capabilitiesVendedOnRequest(role: AdminRole): string[] {
  return Object.values(ADMIN_CAPABILITIES)
    .filter((c) => roleIsGranted(role, c) && c.enforcement === 'exchangeVend')
    .map((c) => c.key)
    .sort();
}

/**
 * Every admin route and the capability that authorizes it, from the one catalog. The console names the
 * capability a refused call lacked from this (SPEC-ADMIN-CONSOLE FR53).
 */
export function capabilityRoutes(): Array<{ capability: string; api: string; method: string; path: string }> {
  return Object.values(ADMIN_CAPABILITIES)
    .filter((c) => c.wired)
    // A team route's path parameters are wildcards here, which is how the console matches a request URL.
    .flatMap((c) => [...c.resources, ...(c.teamResources ?? [])]
      .map((r) => ({ capability: c.key, api: r.api, method: r.method, path: r.path.replace(/\{[^}]+\}/g, '*') })));
}

const roleNameOf = (arn: string): string => arn.split('/').pop() || '';

/**
 * The person behind an IAM-signed admin vend request, read from their console session.
 *
 * Only this function assumes the console roles (their trust names its own role), and it names each
 * session `console-<personId>`, so the role-session name in the signed caller's ARN is the person,
 * asserted by the exchange rather than by the caller. Anything else gets nothing.
 */
export function consoleSessionCaller(event: any): { sub: string; role: AdminRole } | null {
  const arn: string = event?.requestContext?.identity?.userArn || '';
  const m = /^arn:aws:sts::\d+:assumed-role\/([^/]+)\/(.+)$/.exec(arn);
  if (!m) return null;
  const [, roleName, session] = m;
  const role: AdminRole | null = roleName === roleNameOf(ADMIN_CONSOLE_ROLE_ARN) && ADMIN_CONSOLE_ROLE_ARN
    ? 'admins'
    : roleName === roleNameOf(TEAM_CONSOLE_ROLE_ARN) && TEAM_CONSOLE_ROLE_ARN ? 'team-members' : null;
  if (!role || !session.startsWith(CONSOLE_SESSION_PREFIX)) return null;
  // A team session carries the person's clearance after the id (`console-<personId>@<clearance>`).
  const parsed = consoleSessionOf(arn);
  if (!parsed) return null;
  return { sub: parsed.personId, role };
}

/** Register an app-instance-user (by id) as an app-instance-admin. Idempotent. */
async function ensureAppInstanceAdmin(userId: string): Promise<void> {
  try {
    await chimeIdentity.send(new CreateAppInstanceAdminCommand({
      AppInstanceArn: APP_INSTANCE_ARN,
      AppInstanceAdminArn: userArnFor(APP_INSTANCE_ARN, userId),
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConflictException') throw err;
  }
}

/**
 * Provision a console admin's SEPARATE admin identity `${personId}-admin` and register it as an
 * app-instance-admin. This is the elevated identity used ONLY for channel-scoped, audited admin actions,
 * never the chat identity, so its standing elevation never attaches to a broad chat credential.
 * De-provisioned on demotion by the admin-conversation sync. Idempotent.
 *
 * THIS EXCHANGE IS ITS ONLY CREATOR, and it tags the twin with its owner's AppInstanceUser ARN (`owner`),
 * so analytics, audit and erasure find the human a twin belongs to. Its classification is the admin
 * plane's, from the registry, never the person's clearance.
 */
async function ensureAdminIdentity(personId: string, displayName: string): Promise<string> {
  const adminUserId = adminTwinIdFor(personId);
  await ensureAppInstanceUser(
    adminUserId, `${displayName} (admin)`.slice(0, 100), profiles.adminPlaneValues()[0], undefined,
    userArnFor(APP_INSTANCE_ARN, personId),
  );
  await ensureAppInstanceAdmin(adminUserId);
  return adminUserId;
}

/**
 * A TEAM MEMBER OPENS AN ASSISTANT DELIVERABLE (`attachment-read`, SPEC-ADMIN-CONSOLE FR48).
 *
 * Only in a conversation one of the path's assistant's identities is a member of now, for an assistant
 * the caller's team owns within their clearance, with a stated reason. The credential is `s3:GetObject`
 * on that one conversation's deliverables, on a role whose boundary is deliverables alone, so a team never
 * reaches a user upload. Every refusal names nothing about whether the conversation exists.
 */
async function teamAttachmentVend(event: any, assistant: string): Promise<HttpResult> {
  const deny = (statusCode: number, error: string, code?: string) => reply(event, statusCode, code ? { error, code } : { error });
  const caller = consoleSessionCaller(event);
  if (!caller || caller.role !== 'team-members' || !roleIsGranted('team-members', ADMIN_CAPABILITIES['attachment-read'])) {
    return deny(403, 'a team attachment is requested with a team console session');
  }
  let channelArn = '';
  let reason = '';
  try {
    const body = event?.body ? JSON.parse(event.body) : {};
    if (typeof body?.channelArn === 'string') channelArn = body.channelArn;
    if (typeof body?.reason === 'string') reason = body.reason.trim().slice(0, MAX_REASON_LENGTH);
  } catch {
    /* malformed body: refused below for want of a conversation */
  }
  const channelId = channelArn.startsWith(CHANNEL_PREFIX) ? channelArn.slice(CHANNEL_PREFIX.length) : '';
  if (!/^[A-Za-z0-9-]+$/.test(channelId)) return deny(400, 'channelArn must name a single conversation', 'CHANNEL_NOT_LITERAL');
  if (!reason) return deny(400, 'a reason is required for this credential', 'REASON_REQUIRED');
  // THE ISSUER IS ASKED AGAIN, not the session: an account disabled since the session was issued vends nothing.
  const inactive = await refuseInactivePerson(event, userArnFor(APP_INSTANCE_ARN, caller.sub));
  if (inactive) return inactive;
  if (!TEAM_ATTACHMENT_ROLE_ARN) {
    console.error('[AdminCredentialExchange] TEAM_ATTACHMENT_ROLE_ARN is not configured');
    return deny(500, 'Attachment vend misconfigured');
  }
  // Owned by the caller's team and within their clearance, read again now (assistant-scope.ts).
  const scope = await requireOwnedAssistant({ ...event, pathParameters: { ...(event.pathParameters || {}), assistant } }, corsOrigin(event));
  if (isScopeRefusal(scope) || !scope) return deny(403, 'This assistant is not owned by your team', 'ASSISTANT_NOT_OWNED');
  // A MEMBER NOW: asked of the Amazon Chime SDK as the assistant's own identity, which may describe its
  // own membership. An identity that is not a member is refused there, and so is the vend.
  let member: (typeof scope.bots)[number] | null = null;
  for (const bot of scope.bots) {
    try {
      await chimeMessaging.send(new DescribeChannelMembershipForAppInstanceUserCommand({
        ChannelArn: channelArn, AppInstanceUserArn: bot.botArn, ChimeBearer: bot.botArn,
      }));
      member = bot;
      break;
    } catch {
      /* not a member, or no such conversation: indistinguishable on purpose */
    }
  }
  if (!member || !member.classification) return deny(404, 'No conversation with that id in your scope', 'CONVERSATION_NOT_FOUND');
  const bucketArn = await resolveAttachmentsBucketArn();
  if (!bucketArn) return deny(500, 'Attachment vend misconfigured');
  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: TEAM_ATTACHMENT_ROLE_ARN,
    RoleSessionName: `team-attach-${caller.sub}`.slice(0, 64),
    DurationSeconds: MODERATION_SESSION_SECONDS,
    Tags: [
      { Key: 'person', Value: caller.sub },
      { Key: 'classification', Value: member.classification },
      { Key: 'assistant', Value: assistant },
    ],
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Sid: 'DeliverableGet', Effect: 'Allow', Action: ['s3:GetObject'], Resource: [`${bucketArn}/generated-docs/${channelId}/*`] }],
    }),
  }));
  const credentials = credentialsOf(assumed);
  const unrecorded = await accessRecorded(event, {
    _auditEvent: 'team_scoped_credential_vend',
    timestamp: new Date().toISOString(),
    personId: caller.sub,
    assistant,
    channelArn,
    capabilities: ['attachment-read'],
    plane: 's3-attachment',
    reason,
    ttlSeconds: MODERATION_SESSION_SECONDS,
  });
  if (unrecorded) return unrecorded;
  const result: ExchangeResult = {
    credentials,
    userArn: userArnFor(APP_INSTANCE_ARN, caller.sub),
    tier: 'team',
    identity: 'admin',
    scopedTo: channelArn,
    bucket: bucketArn.replace(/^arn:aws:s3:::/, ''),
    region: AWS_REGION,
  };
  return reply(event, 200, result);
}

/**
 * THE CONSOLE SESSION: a short-lived session on the console role the person's groups name.
 *
 * Requested with the person's token, answered with credentials on the `admins` or `team-members` console
 * role and the list of capabilities that role holds, which is what the console opens on and renders
 * against (FR44, FR0e). A person whose groups name neither role holds no admin capability and is told so.
 */
async function consoleSession(event: any): Promise<HttpResult> {
  const caller = tokenCallerOf(event);
  if (isRefusal(caller)) return caller;
  const { issuer, subject, claims, groups, roleKey } = caller;
  let identity: unknown;
  try {
    identity = event?.body ? JSON.parse(event.body)?.identity : undefined;
  } catch {
    return reply(event, 400, { error: 'Malformed body' });
  }
  if (identity !== 'console') {
    return reply(event, 400, { error: 'this route issues console sessions only: send identity "console"', code: 'CONSOLE_SESSION_ONLY' });
  }
  // ADMIN ACCESS IS THE ISSUER'S `admin: true` AND ITS ADMIN GROUPS, never the chat token: holding the admin plane
  // classification clears a chat identity for admin conversations and grants no console (SPEC-ADMIN-IDENTITY FR1).
  // An issuer that does not declare `admin: true` has no admin (A6), whatever its tokens' groups say.
  const role = consoleRoleFor(issuer, groups);
  // An administrator's session carries the admin plane's value; a team member's carries their own clearance,
  // which bounds what their console reads (`caller-scope.ts`).
  const sessionClassification = role === 'admins' ? profiles.adminPlaneValues()[0] : roleKey;
  if (!role || !sessionClassification) {
    return reply(event, 403, { error: 'no admin capability is held by this sign-in', code: 'NO_ADMIN_CAPABILITY' });
  }
  const consoleRoleArn = role === 'admins' ? ADMIN_CONSOLE_ROLE_ARN : TEAM_CONSOLE_ROLE_ARN;
  if (!consoleRoleArn) {
    console.error('[AdminCredentialExchange] No console role ARN configured for', role);
    return reply(event, 500, { error: 'Exchange misconfigured' });
  }
  // THE PERSON THIS SUBJECT SIGNS IN AS, read and never minted: the person exchange is the one minter.
  // Read beside the issuer's answer on the account, which refuses before the row is looked at.
  let personId: string;
  try {
    const [inactive, state] = await Promise.all([
      refuseInactiveAccount(event, caller),
      identityStateOf(issuer.id, subject),
    ]);
    if (inactive) return inactive;
    if (state.state === 'refused') return reply(event, 403, { error: 'this sign-in is not active', code: 'PERSON_NOT_ACTIVE' });
    if (state.state === 'unbound') {
      return reply(event, 409, {
        error: 'this sign-in has no person yet; sign in through the credential exchange first',
        code: 'PERSON_NOT_SIGNED_IN',
      });
    }
    personId = state.personArn.split('/').pop() || '';
  } catch (err) {
    console.error('[AdminCredentialExchange] could not resolve the person:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
  // A TEAM MEMBER'S REACH IS THE ASSISTANTS THEIR TEAM OWNS, within their own clearance, read from the
  // ownership tags now: a reassignment takes effect on the next session with no deploy.
  let teamAssistants: string[] | undefined;
  // AND THE TEAMS THEMSELVES, so a team that owns nothing yet can create the assistant it will own.
  let teams: string[] | undefined;
  let owners: Record<string, string> | undefined;
  if (role === 'team-members') {
    teams = teamsOfGroups(groups).filter((t) => TEAM_NAME_PATTERN.test(t)).sort();
    // In `team-members` with no team group: no team to act for and no assistant to reach (acceptance criterion (c)).
    if (teams.length === 0) {
      return reply(event, 403, { error: 'you are in no team, so this console reaches nothing for you', code: 'NO_TEAM' });
    }
    try {
      const identities = await listAssistantIdentities(chimeIdentity, APP_INSTANCE_ARN);
      // THE ISSUER'S CLASSIFICATIONS BIND THE TEAM SCOPE TOO: a team owning an assistant outside them reaches nothing of it.
      teamAssistants = scopeFor(identities, groups, (h, t) => profiles.reaches(h, t),
        (g) => heldWithinIssuer(issuer, profiles.clearancesForGroups(g), profiles));
      // Which of the person's teams owns each one, so the console says who they are by their team.
      owners = Object.fromEntries(teamAssistants.map((name) => [name, identities.find((i) => i.assistant === name)?.ownerTeam ?? '']));
    } catch (err) {
      console.error('[AdminCredentialExchange] could not read assistant ownership:', err);
      return reply(event, 500, { error: 'Credential exchange failed' });
    }
    // A TEAM THAT OWNS NOTHING YET STILL GETS A SESSION: it names the person's teams alone, which reach
    // the team's create route and nothing that reads an assistant.
    if (teamSessionPolicy(teamAssistants, teams).length > SESSION_POLICY_LIMIT) {
      console.error('[AdminCredentialExchange] team scope exceeds the session-policy limit', { personId, count: teamAssistants.length });
      return reply(event, 409, { error: 'your team owns more assistants than one console session can name', code: 'TEAM_SCOPE_TOO_LARGE' });
    }
  }
  try {
    // The administration identity is held by a role granted a capability that needs it, decided by the
    // catalog, and provisioned here, where the person's real name is known.
    if (rolesNeedingAdministrationIdentity().includes(role)) {
      await ensureAdminIdentity(personId, displayNameOf(claims, personId).slice(0, 100));
    }
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: consoleRoleArn,
      // A TEAM SESSION CARRIES THE PERSON'S CLEARANCE IN ITS NAME, because the handlers that bound its
      // reads by classification read the caller from its ARN and nothing else. Only this function assumes
      // the console roles, so the name is asserted by the exchange; `caller-scope.ts` reads it.
      RoleSessionName: role === 'team-members' && /^[a-z0-9-]+$/.test(sessionClassification)
        ? `${CONSOLE_SESSION_PREFIX}${personId}@${sessionClassification}`.slice(0, 64)
        : `${CONSOLE_SESSION_PREFIX}${personId}`.slice(0, 64),
      DurationSeconds: role === 'team-members' ? TEAM_CONSOLE_SESSION_SECONDS : CONSOLE_SESSION_SECONDS,
      Tags: [
        { Key: 'person', Value: personId },
        { Key: 'classification', Value: sessionClassification },
      ],
      ...(teamAssistants ? { Policy: teamSessionPolicy(teamAssistants, teams), PolicyArns: teamSessionPolicyArns() } : {}),
    }));
    const credentials = credentialsOf(assumed);
    const capabilities = capabilitiesHeldBy(role);
    const unrecorded = await accessRecorded(event, {
      _auditEvent: 'admin_console_session_vend',
      timestamp: new Date().toISOString(),
      personId,
      role,
      capabilities,
      ...(teamAssistants ? { assistants: teamAssistants, teams } : {}),
      ttlSeconds: role === 'team-members' ? TEAM_CONSOLE_SESSION_SECONDS : CONSOLE_SESSION_SECONDS,
    });
    if (unrecorded) return unrecorded;
    return reply(event, 200, {
      credentials,
      identity: 'console',
      role,
      capabilities,
      routes: capabilityRoutes(),
      // WHICH OF THOSE ARE GRANTED ON REQUEST rather than held by this session, and how long one such
      // credential lasts, so the console states the operator's reach as the exchange enforces it (FR0e).
      onRequest: { capabilities: capabilitiesVendedOnRequest(role), ttlSeconds: MODERATION_SESSION_SECONDS },
      // The assistants a team session reaches, which the console scopes every view to.
      ...(teamAssistants ? { assistants: teamAssistants, teams, owners } : {}),
    });
  } catch (err) {
    console.error('[AdminCredentialExchange] console session vend failed:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
}

/**
 * A PER-CONVERSATION ADMIN CREDENTIAL, on the capability's own IAM-authorized route.
 *
 * THE ROUTE NAMES THE CAPABILITY, not the body: a session admitted to the redact route is vended redact
 * and nothing else. The person is the console session's, never the body's. Every vend is narrowed to one
 * subject, short-lived, and recorded with the operator's reason before it is returned.
 */
async function adminVend(event: any, capabilityKey: string): Promise<HttpResult> {
  const caller = consoleSessionCaller(event);
  if (!caller) return reply(event, 403, { error: 'an admin credential is requested with an admin console session' });
  const cap = ADMIN_CAPABILITIES[capabilityKey];
  if (!cap || cap.enforcement !== 'exchangeVend' || !cap.wired || !cap.vends?.length) {
    return reply(event, 404, { error: `unknown admin capability: ${capabilityKey}` });
  }
  // The second layer. The gateway has already refused a role without this route; a role reaching here
  // without the capability means the grant and the catalog disagree, which is refused, not trusted.
  if (!roleIsGranted(caller.role, cap)) {
    console.error('[AdminCredentialExchange][SecurityEvent] a console session reached a vend route its role does not hold', {
      role: caller.role, capability: cap.key,
    });
    return reply(event, 403, { error: `this role does not hold ${cap.key}` });
  }
  // The admin plane is the deployment's declared admin-plane classification, never a literal.
  const accessClass = profiles.adminPlaneValues()[0];
  if (caller.role !== 'admins' || !accessClass) {
    return reply(event, 403, { error: 'admin plane requires the admins group' });
  }
  const personId = caller.sub;
  const requestedCaps = [...(cap.vends ?? [])];

  let scopeChannelArn = '';
  // The owner a cross-channel task read is narrowed to: a principal id, the value the mirror table keys on.
  let scopeOwnerId = '';
  // WHY THIS CREDENTIAL IS BEING ISSUED, in the operator's words (SPEC-ADMIN-CONSOLE FR51).
  let reason = '';
  try {
    const body = event?.body ? JSON.parse(event.body) : {};
    if (typeof body?.channelArn === 'string' && body.channelArn) scopeChannelArn = body.channelArn;
    if (typeof body?.principalId === 'string' && body.principalId) scopeOwnerId = body.principalId;
    else if (typeof body?.ownerId === 'string' && body.ownerId) scopeOwnerId = body.ownerId;
    if (typeof body?.reason === 'string') reason = body.reason.trim().slice(0, MAX_REASON_LENGTH);
  } catch {
    /* malformed body: refused below for want of a reason or a scope */
  }
  if (!reason) return reply(event, 400, { error: 'a reason is required for this credential', code: 'REASON_REQUIRED' });
  if (scopeChannelArn && !scopeChannelArn.startsWith(CHANNEL_PREFIX)) {
    return reply(event, 400, { error: 'channelArn must be a channel of this app instance' });
  }
  if (scopeChannelArn && !literalChannelId(scopeChannelArn)) {
    return reply(event, 400, { error: 'channelArn must name a single conversation', code: 'CHANNEL_NOT_LITERAL' });
  }
  const archiveCaps = requestedCaps.filter((c) => EXECUTE_API_CAPS.has(c));
  const chimeCaps = requestedCaps.filter((c) => c in CAPABILITY_ACTIONS);
  const s3Caps = requestedCaps.filter((c) => S3_ATTACHMENT_CAPS.has(c));
  // Each plane needs a DIFFERENT session policy, so one request is exactly one plane.
  if ([archiveCaps.length > 0, chimeCaps.length > 0, s3Caps.length > 0].filter(Boolean).length !== 1) {
    console.error('[AdminCredentialExchange] a catalog capability vends no plane, or more than one', { capability: cap.key });
    return reply(event, 500, { error: 'Exchange misconfigured' });
  }
  // ONE SCOPE OR THE OTHER, never neither: a conversation for the channel-shaped capabilities, an owner
  // for the cross-channel task read.
  const ownerScoped = requestedCaps.some((c) => EXECUTE_API_CAP_SCOPE[c] === 'principal');
  if (ownerScoped && !scopeOwnerId) return reply(event, 400, { error: 'this capability requires an ownerId scope' });
  if (!ownerScoped && !scopeChannelArn) return reply(event, 400, { error: 'admin plane requires a channelArn scope' });
  // THE ISSUER IS ASKED AGAIN, not the session: an account disabled since the session was issued vends nothing.
  const inactive = await refuseInactivePerson(event, userArnFor(APP_INSTANCE_ARN, personId));
  if (inactive) return inactive;
  if (!EXCHANGE_ROLE_ADMIN_PLANE) {
    console.error('[AdminCredentialExchange] No exchange role ARN configured for admin-plane');
    return reply(event, 500, { error: 'Exchange misconfigured' });
  }
  const adminArn = userArnFor(APP_INSTANCE_ARN, adminTwinIdFor(personId));
  const scopedChannelId = scopeChannelArn.slice(CHANNEL_PREFIX.length);

  try {
    // ── THE ARCHIVE PLANE (execute-api) ──────────────────────────────────────────────────────────
    if (archiveCaps.length) {
      // THE ID IS A LITERAL OR IT IS REFUSED. `encodeURIComponent` leaves `*` untouched, and a wildcard
      // would complete the template to the role's own boundary.
      if (scopeOwnerId && !/^[A-Za-z0-9._-]+$/.test(scopeOwnerId)) {
        return reply(event, 400, { error: 'principalId must name a single subject' });
      }
      const resources = archiveCaps.map((c) => {
        const template = EXECUTE_API_CAPABILITY_RESOURCES[c];
        const scope = EXECUTE_API_CAP_SCOPE[c];
        if (!template || !scope) return template;
        const id = scope === 'principal' ? scopeOwnerId : scopedChannelId;
        return id ? template.replace('{id}', encodeURIComponent(id)) : '';
      });
      if (resources.some((r) => !r)) {
        console.error('[AdminCredentialExchange] No execute-api resource ARN configured for', archiveCaps);
        return reply(event, 500, { error: 'Archive vend misconfigured' });
      }
      const assumed = await sts.send(new AssumeRoleCommand({
        RoleArn: EXCHANGE_ROLE_ADMIN_PLANE,
        RoleSessionName: `archive-${personId}`.slice(0, 64),
        DurationSeconds: MODERATION_SESSION_SECONDS,
        // Both assertions, on every plane: the admin-plane role's trust requires them.
        Tags: [
          { Key: 'person', Value: personId },
          { Key: 'classification', Value: accessClass },
        ],
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Sid: 'ArchiveApiInvoke', Effect: 'Allow', Action: ['execute-api:Invoke'], Resource: resources }],
        }),
      }));
      const credentials = credentialsOf(assumed);
      const unrecorded = await accessRecorded(event, {
        _auditEvent: 'admin_scoped_credential_vend',
        timestamp: new Date().toISOString(),
        adminPersonId: personId,
        adminIdentity: adminArn,
        channelArn: scopeChannelArn || null,
        ownerId: scopeOwnerId || null,
        capabilities: archiveCaps,
        plane: 'archive',
        reason,
        ttlSeconds: MODERATION_SESSION_SECONDS,
      });
      if (unrecorded) return unrecorded;
      return reply(event, 200, {
        credentials, userArn: adminArn, tier: 'admin', identity: 'admin', scopedTo: scopeChannelArn || null,
      } satisfies ExchangeResult);
    }

    // ── THE S3 ATTACHMENT PLANE ──────────────────────────────────────────────────────────────────
    if (s3Caps.length) {
      const bucketArn = await resolveAttachmentsBucketArn();
      if (!bucketArn) {
        console.error('[AdminCredentialExchange] attachments bucket ARN unresolved (SSM param missing)');
        return reply(event, 500, { error: 'Attachment vend misconfigured' });
      }
      if (!/^[a-zA-Z0-9-]+$/.test(scopedChannelId)) {
        return reply(event, 400, { error: 'channelArn is not a valid channel of this app instance' });
      }
      const resources = s3Caps.map((c) => `${bucketArn}/${S3_ATTACHMENT_CAP_PREFIXES[c]}/${scopedChannelId}/*`);
      const assumed = await sts.send(new AssumeRoleCommand({
        RoleArn: EXCHANGE_ROLE_ADMIN_PLANE,
        RoleSessionName: `attach-${personId}`.slice(0, 64),
        DurationSeconds: MODERATION_SESSION_SECONDS,
        // Both assertions, on every plane: the admin-plane role's trust requires them.
        Tags: [
          { Key: 'person', Value: personId },
          { Key: 'classification', Value: accessClass },
        ],
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Sid: 'AttachmentGet', Effect: 'Allow', Action: ['s3:GetObject'], Resource: resources }],
        }),
      }));
      const credentials = credentialsOf(assumed);
      const unrecorded = await accessRecorded(event, {
        _auditEvent: 'admin_scoped_credential_vend',
        timestamp: new Date().toISOString(),
        adminPersonId: personId,
        adminIdentity: adminArn,
        channelArn: scopeChannelArn,
        capabilities: s3Caps,
        plane: 's3-attachment',
        reason,
        sensitive: s3Caps.some((c) => SENSITIVE_ATTACHMENT_CAPS.has(c)),
        ttlSeconds: MODERATION_SESSION_SECONDS,
      });
      if (unrecorded) return unrecorded;
      return reply(event, 200, {
        credentials,
        userArn: adminArn,
        tier: 'admin',
        identity: 'admin',
        scopedTo: scopeChannelArn || null,
        bucket: bucketArn.replace(/^arn:aws:s3:::/, ''),
        region: AWS_REGION,
      } satisfies ExchangeResult);
    }

    // ── THE AMAZON CHIME SDK PLANE: the standing-elevated `${personId}-admin`, one channel ─────────────
    //
    // Membership is gated in IAM by capability, channel and classification; the TARGET of a membership
    // call is not gateable here (measured against the live service, deny-test-assistant-membership.mjs),
    // so that axis is enforced where the target is visible (`conversation-management.ts` refuses a bot)
    // and reconciled by the membership audit.
    const bearerUserId = await ensureAdminIdentity(personId, personId);
    const bearerArn = userArnFor(APP_INSTANCE_ARN, bearerUserId);
    const requestedActions = [...new Set(chimeCaps.flatMap((c) => CAPABILITY_ACTIONS[c]))];
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: EXCHANGE_ROLE_ADMIN_PLANE,
      RoleSessionName: `chime-${bearerUserId}`.slice(0, 64),
      DurationSeconds: MODERATION_SESSION_SECONDS,
      // Both assertions, on every plane: the admin-plane role's trust requires them.
        Tags: [
          { Key: 'person', Value: personId },
          { Key: 'classification', Value: accessClass },
        ],
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Sid: 'SessionAndConnect', Effect: 'Allow', Action: ['chime:GetMessagingSessionEndpoint', 'chime:Connect'], Resource: '*' },
          { Sid: 'RequestedActions', Effect: 'Allow', Action: requestedActions, Resource: [scopeChannelArn, bearerArn] },
        ],
      }),
    }));
    const credentials = credentialsOf(assumed);
    const unrecorded = await accessRecorded(event, {
      _auditEvent: 'admin_scoped_credential_vend',
      timestamp: new Date().toISOString(),
      adminPersonId: personId,
      adminIdentity: bearerArn,
      channelArn: scopeChannelArn,
      capabilities: chimeCaps,
      moderation: chimeCaps.some((c) => MODERATION_CAPS.has(c)),
      reason,
      ttlSeconds: MODERATION_SESSION_SECONDS,
    });
    if (unrecorded) return unrecorded;
    return reply(event, 200, {
      credentials, userArn: bearerArn, tier: accessClass, identity: 'admin', scopedTo: scopeChannelArn,
    } satisfies ExchangeResult);
  } catch (err) {
    console.error('[AdminCredentialExchange] failed:', err);
    return reply(event, 500, { error: 'Credential exchange failed' });
  }
}

export const handler = async (event: any): Promise<HttpResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (event?.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(event), body: '' };
  const path: string = event?.path || '';
  const teamAttachment = TEAM_ATTACHMENT_ROUTE.exec(path);
  if (teamAttachment) return teamAttachmentVend(event, decodeURIComponent(teamAttachment[1]));
  const vendMatch = /\/exchange-credentials\/admin\/([a-z-]+)\/?$/.exec(path);
  if (vendMatch) return adminVend(event, vendMatch[1]);
  return consoleSession(event);
};
