/**
 * User Management Lambda
 *
 * The admin console's people: the pool's administration (approve, reject, clearance, enable, membership
 * groups), which is the Cognito reference implementation ADR-021 records, and offboarding, which is not
 * administration and runs by AppInstanceUser for every issuer (ADR-058, `lib/offboarding.ts`).
 *
 * Routes (every one IAM-authorized; `view-users`, `manage-users`, `delete-users`):
 *   GET  /users           - The people: every AppInstanceUser that signs in as somebody, and every pool
 *                           account that has not signed in yet
 *   POST /users/approve   - Approve a pending user
 *   POST /users/reject    - Reject (disable) a user; their next credential exchange is refused
 *   POST /users/tier      - Change a user's clearance
 *   POST /users/enable    - Re-enable a disabled user; their next credential exchange is admitted
 *   POST /users/group     - Add a user to, or remove them from, a membership group (e.g. `ops`)
 *   POST /users/team      - Add a user to, or remove them from, a console team (`team-<name>`), which also keeps
 *                           their `team-members` role group in step with whether they are in any team
 *   POST /users/delete    - Offboard a person (`personArn`), or remove a pool account (`username`)
 *   POST /users/readmit   - Delete an offboarded subject's `revoked` marker, so they may sign in again
 *   POST /users/provision - Pre-assign a subject of a `provisioned-only` issuer (P-13): a `pending` row,
 *                           to a person who exists (`personArn`) or to a new one. Asked of the Identity
 *                           stack's admin subject provisioner, which holds the write; 404 when the registry
 *                           declares no `provisioned-only` issuer.
 */

import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  ListAppInstanceUsersCommand,
  TagResourceCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { isGuestIssuer } from '../../lib/config/issuers.js';
import { issuerById } from './lib/trusted-issuers.js';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { parseJsonBody, callerIsAdmin, callerActor, callerPersonId, callerCanSeeUserIdentity } from './lib/auth.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { adminTwinOwnerId, personIdFromArn, userArnFor } from './lib/person-arn.js';
// THE POOL THIS CONSOLE ADMINISTERS, read through its adapter, and a person's groups through the one
// clearance seam. Writes to the pool (group changes, attributes, enable and delete) stay here: this is
// the pool's administration, not a question about a person.
import type { PoolRecord } from './lib/cognito-pool-directory.js';
import { poolAdapter, poolGroups } from './lib/issuer-seams.js';
import { defaultDirectory } from './lib/membership-source.js';
import { mapBounded } from './lib/bounded-map.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { chimeIdentityClient } from './lib/chime/clients.js';
import { parseIssuerSubjectKey } from './lib/person-identity.js';
import {
  defaultOffboardingDeps,
  poolIssuerIds,
  rowOfPoolSubject,
  rowsOfPerson,
  type OffboardingActor,
} from './lib/offboarding.js';
import type { ConsoleOffboardingAnswer, ConsoleOffboardingRequest } from './lib/offboarding-console.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { TEAM_NAME_PATTERN } from '../../lib/config/profiles.js';
import { ADMIN_ROLE_GROUP } from '../../lib/config/admin-capabilities.js';
import { TEAM_GROUP_PREFIX, teamsOfGroups } from './lib/assistant-ownership.js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const cognitoClient = new CognitoIdentityProviderClient({});
const pool = () => poolAdapter(USER_POOL_ID, cognitoClient);
const clearanceSource = () => poolGroups(USER_POOL_ID, cognitoClient);
const chimeClient = chimeIdentityClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
// Membership-audit Lambda name (trigger #3): re-check a user's memberships after a clearance downgrade.
const MEMBERSHIP_AUDIT_FN_NAME = process.env.MEMBERSHIP_AUDIT_FN_NAME || '';

const USER_POOL_ID = process.env.USER_POOL_ID || '';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN);

// ── THE CLEARANCE GROUPS, FROM THE REGISTRY ─────────────────────────────────────────────────
//
// A person holds exactly one of these, so setting somebody's clearance means removing the others.
// Derived rather than listed: the literal `['basic', 'standard', 'premium']` this replaces was
// deployment config frozen in code, and a deployment declaring a fourth classification could leave a
// person in two groups at once. `clearanceGroups()` also excludes the admin plane, so a clearance edit no
// longer strips `admins` from an administrator as a side effect of the exclusivity sweep.
// Read per request, never while the module loads: the registry is loaded by the handler.
const clearanceGroupNames = (): readonly string[] => profiles.clearanceGroups();
// MEMBERSHIP GROUPS (ProfilesConfig.membershipGroups): `ops` is the group the `ops` conversation types
// take their people from, and its members must ALREADY be cleared for premium. It grants nothing. Adding
// or removing a member is a Cognito group call, which the platform trail delivers to EventBridge, so the
// conversations sourced from the group follow within seconds (DESIGN-CONVERSATION-TYPES §6).
const membershipGroupRequirements = (): Readonly<Record<string, string>> => profiles.membershipGroups();
const membershipGroupNames = (): readonly string[] => Object.keys(membershipGroupRequirements());
type Clearance = string;

/** Make sure the user is in exactly one clearance group. Idempotent. */
async function syncClearanceGroup(username: string, clearance: Clearance): Promise<void> {
  let existing: string[] = [];
  // Whether `existing` is real. When the read fails it is empty, which must not be read as "in no
  // membership group": the removal below then acts on every membership group rather than on none.
  let groupsKnown = true;
  try {
    existing = await clearanceSource().groupsFor(username);
  } catch (err) {
    groupsKnown = false;
    console.warn('[UserManagement] listGroups failed:', (err as Error).name);
  }

  // Remove from other clearance groups so the user holds exactly one clearance.
  for (const other of clearanceGroupNames()) {
    if (other !== clearance && existing.includes(other)) {
      try {
        await cognitoClient.send(new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: other,
        }));
      } catch (err) {
        console.warn(`[UserManagement] remove ${other} failed:`, (err as Error).name);
      }
    }
  }

  if (!existing.includes(clearance)) {
    await cognitoClient.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: clearance,
    }));
    console.log(`[UserManagement] Added ${username} to ${clearance}`);
  }

  // ── RE-STAMP THE IDENTITY'S CLASSIFICATION TAG ──────────────────────────
  //
  // The clearance now lives on the AppInstanceUser as a `classification` tag, so the same immutable
  // signal the channel side is judged on exists on the principal. A group change - a tier change here,
  // or an approval - is what can make that tag wrong, and a stale tag on a principal is worse than an absent one: a
  // downgraded person would keep reading as cleared for what they just lost.
  //
  // UNCONDITIONAL, not gated on `!existing.includes(clearance)`. The group write above is skipped when
  // the group is already right, but the TAG may still be missing or stale - every identity created
  // before this change has none - so re-stamping on every sync is what repairs them.
  //
  // Best-effort and LOUD on failure. The tag is not the enforcement (the vended role and the channel
  // tag are), so a failure here does not grant anything; it leaves a principal whose recorded
  // clearance disagrees with its groups, which an auditor must be able to see rather than infer.
  // The AppInstanceUser id is the SUB, not the Cognito username - the two differ whenever a pool uses
  // email or a chosen username as the sign-in name, which this one does. `triggerMembershipReeval`
  // below resolves it the same way; building the ARN from `username` would tag a principal that does
  // not exist and fail silently into the catch.
  // ── THE TOKEN, COMPUTED THE WAY THE EXCHANGE COMPUTES IT ────────────────────────────────────
  //
  // NOT `clearance`. That is the CLEARANCE GROUP this call just set, one member of the exclusive set.
  // The credential exchange stamps `profiles.resolveHolderToken(groups)` - the declared classification
  // whose grant set IS the union of what the caller's groups clear for - which returns `admin` for
  // anybody in the admins group.
  //
  // So the two writers disagreed, and the tag FLIP-FLOPPED for every administrator: set an admin's
  // tier to `standard` here and the tag reads `standard`; their next sign-in rewrites it to `admin`.
  // An auditor reading it in between concludes an administrator is cleared only for `standard` - and
  // this tag is the value the design puts forward as the readable one, so a value that oscillates is
  // worse than one that is simply absent.
  //
  // `existing` is the user's real group list read above; the group this call sets is folded in, since
  // the write may not have landed in a fresh read yet.
  const groupsAfter = [...new Set([...existing.filter((g) => !clearanceGroupNames().includes(g)), clearance])];
  // ONE RESOLVER. `clearanceForGroups` - the highest single group - was what this read, and the
  // exchange reads `resolveHolderToken`, so the two writers could name different values for anybody
  // holding more than one clearance and the tag oscillated with whichever ran last. That is the same
  // flip-flop described above, reintroduced by a different pair of functions.
  await restampIdentityTag(username, groupsAfter, { clearance });

  // A MEMBERSHIP GROUP REQUIRES A CLEARANCE, so a clearance that no longer reaches it ends the
  // membership. Otherwise the group would name someone its conversations' classification refuses - the
  // contradiction membership groups exist to rule out. The removal is a Cognito group call, so the
  // conversations sourced from the group follow on the event.
  for (const group of membershipGroupNames()) {
    // An unreadable group list removes from every group the new clearance does not meet: removing someone
    // who was not a member is a no-op, and leaving a member below the requirement is the contradiction.
    if ((existing.includes(group) || !groupsKnown) && !profiles.meetsMembershipRequirement(groupsAfter, group)) {
      try {
        await cognitoClient.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: group }));
        console.log(JSON.stringify({ _auditEvent: 'membership_group_changed', username, group, member: false, reason: 'clearance_below_group', requires: membershipGroupRequirements()[group] }));
      } catch (err) {
        console.error('[UserManagement][SecurityEvent] could not remove a member whose clearance no longer meets the group', { username, group, error: (err as Error).name });
      }
    }
  }

  // Trigger #3 (SPEC-CONVERSATION-SECURITY §11): if this was a DOWNGRADE - the new clearance no
  // longer reaches everything a clearance group the user held reached - re-evaluate their existing channel memberships now. A
  // Cognito-group change emits no Chime membership event, so the audit's event stream (#1) never
  // re-checks them; without this the downgraded member keeps read access to a no-longer-cleared channel
  // until the scheduled sweep (#2) runs. From-nothing (approval) is not a downgrade and never fires.
  //
  // WHAT COUNTS AS A DOWNGRADE IS A SET QUESTION, NOT A RANK ONE. This compared positions in the
  // hardcoded triple, which asks "did they move down the ladder" - and a grant set need not be a rank
  // prefix, so a move that ranks HIGHER can still take something away. Losing `finance` while gaining
  // `premium` reads as a promotion to a rank comparison and as a loss to the member sitting in a
  // finance conversation. The honest test is whether the new reach still covers the old one.
  // `resolveHolderToken` answers `undefined` for a combination this deployment has not declared,
  // and `grantsFor` of nothing is nothing - so an undeclared combination reaches nothing and the
  // comparison below correctly reports everything as lost. That is the right direction: a clearance
  // edit that leaves somebody holding an unnamed combination IS a loss of reach.
  const reachBefore = new Set(profiles.grantsFor(profiles.resolveHolderToken(existing) ?? ''));
  const reachAfter = new Set(profiles.grantsFor(profiles.resolveHolderToken(groupsAfter) ?? ''));
  const lost = [...reachBefore].filter((c) => !reachAfter.has(c));
  // From-nothing (approval) is not a downgrade: an unapproved user held no clearance group, so
  // `reachBefore` is the fail-closed floor and `lost` is empty for any real grant.
  if (lost.length > 0) {
    console.log('[UserManagement] clearance narrowed, re-evaluating memberships', { username, lost });
    await triggerMembershipReeval(username);
  }
}

/**
 * Re-stamp the identity's `classification` tag from the groups the person now holds, computed the way the
 * credential exchange computes it (`resolveHolderToken`). Called after ANY group change that can move
 * the token, which is a clearance change (a membership group grants nothing). Best-effort and LOUD on failure - the
 * tag is not the enforcement, but a stale one misleads an auditor.
 */
async function restampIdentityTag(username: string, groupsAfter: string[], detail: Record<string, unknown>): Promise<void> {
  const holderToken = profiles.resolveHolderToken(groupsAfter);
  try {
    const personArn = APP_INSTANCE_ARN ? await personArnOfUsername(username) : null;
    if (personArn) {
      await chimeClient.send(new TagResourceCommand({
        ResourceARN: personArn,
        Tags: [{ Key: 'classification', Value: holderToken }],
      }));
    }
  } catch (err) {
    console.error('[UserManagement][SecurityEvent] could not re-stamp the identity classification tag', {
      username,
      ...detail,
      holderToken,
      error: (err as Error).message,
    });
  }
}

/** Async-invoke the membership audit to re-check ONE user's memberships after a clearance downgrade
 *  (#3). Best-effort: a missing fn name (audit not deployed yet) or an invoke error never blocks the
 *  tier change - the scheduled sweep (#2) is the backstop. */
async function triggerMembershipReeval(username: string): Promise<void> {
  if (!MEMBERSHIP_AUDIT_FN_NAME || !APP_INSTANCE_ARN) return;
  try {
    const userArn = await personArnOfUsername(username);
    if (!userArn) return;
    await lambdaClient.send(new InvokeCommand({
      FunctionName: MEMBERSHIP_AUDIT_FN_NAME,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ type: 'reeval-user', userArn })),
    }));
    console.log('[UserManagement] triggered membership re-eval on downgrade', { userArn });
  } catch (err) {
    console.warn('[UserManagement] membership re-eval trigger failed (non-fatal):', (err as Error).name);
  }
}

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,POST,OPTIONS' });

function isAllowedOrigin(origin?: string): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

const respond = http.respond;

/**
 * One entry in the console's list of people.
 *
 * A PERSON is an AppInstanceUser that somebody signs in as; `personArn` names them, and offboarding takes
 * it. A pool account that has never signed in has no AppInstanceUser yet, so `personArn` is null and only
 * the pool's administration applies to it. `account` says whether this deployment's pool holds an account
 * for the entry (`pool`), or the person signs in through another issuer only (`other`), in which case the
 * pool fields are empty and only offboarding applies.
 */
interface PersonEntry {
  personArn: string | null;
  personId: string | null;
  /** A display name, never an address. Null unless the caller may be told who a person is. */
  displayName: string | null;
  account: 'pool' | 'other';
  /** The pool's username, for the pool's administration. Null for a person of another issuer. */
  username: string | null;
  email: string;
  tier: string;
  approved: string;
  status: string;
  /**
   * Whether the issuer lets this person sign in, read from the issuer's own record now (the pool account,
   * or for a person of another trusted pool `Directory.accountState`). The platform keeps no copy of it.
   */
  enabled: boolean;
  createdAt: string;
  /** The membership groups this user is in (a subset of the deployment's membership groups). */
  membershipGroups: string[];
  /** The console teams this user is in, by team name (their `team-<name>` groups). */
  teams: string[];
  /**
   * THE ISSUERS THIS PERSON SIGNS IN THROUGH (E6), registry ids from their `Identities` rows, never a subject.
   * Empty for a pool account that never became a person.
   */
  issuers: string[];
  /**
   * An unbound visitor: every issuer they sign in through is the guest issuer. The console hides them by
   * default; a visitor bound to an account (path A) holds that account's issuer and is a person like any other.
   */
  guest: boolean;
}

const ssmClient = new SSMClient({});

/**
 * THE GUEST ISSUER'S KILL SWITCH (L16), as the console's Guest panel shows it: whether guest start is paused,
 * who changed it, when and why. `declared: false` when the deployment declares no guest issuer. A switch that
 * cannot be read is said, never shown as running.
 */
async function guestSwitchState(): Promise<Record<string, unknown>> {
  const name = process.env.GUEST_KILL_SWITCH_PARAMETER || '';
  if (!name) return { declared: false };
  try {
    const r = await ssmClient.send(new GetParameterCommand({ Name: name }));
    const v = JSON.parse(r.Parameter?.Value || '{}') as Record<string, unknown>;
    return {
      declared: true,
      paused: v.paused === true,
      changedBy: typeof v.changedBy === 'string' ? v.changedBy : null,
      changedAt: typeof v.changedAt === 'string' ? v.changedAt : null,
      reason: typeof v.reason === 'string' ? v.reason : null,
      // Whether registrations wait for an operator, and so whether the console asks for them.
      registrationApproval: process.env.GUEST_REGISTRATION_APPROVAL === 'admin' ? 'admin' : 'none',
    };
  } catch (err) {
    console.warn('[UserManagement] the guest kill switch could not be read', { err: (err as Error)?.name });
    return { declared: true, unreadable: true };
  }
}

/** Who the console's caller is, for the offboarding record: their AppInstanceUser ARN, never an address. */
async function offboardingActor(event: APIGatewayProxyEvent): Promise<OffboardingActor> {
  const id = await callerPersonId(event);
  return { arn: id ? userArnFor(APP_INSTANCE_ARN, id) : 'iam-principal' };
}

// ── OFFBOARDING IS THE IDENTITY STACK'S (ADR-058, D9) ───────────────────────────────────────────
//
// A delete, a re-admission and an export are asked of the one `OffboardingFunction`
// (`offboarding-events.ts`), which runs them on the one role that holds offboarding's grants. This handler
// holds none of them: it administers the pool and relays offboarding's answer.
type OffboardingInvoker = (req: ConsoleOffboardingRequest) => Promise<ConsoleOffboardingAnswer>;

async function invokeOffboardingFunction(req: ConsoleOffboardingRequest): Promise<ConsoleOffboardingAnswer> {
  const FunctionName = process.env.OFFBOARDING_FUNCTION_NAME || '';
  if (!FunctionName) throw new Error('user-management: OFFBOARDING_FUNCTION_NAME is not set');
  const out = await lambdaClient.send(new InvokeCommand({
    FunctionName,
    InvocationType: InvocationType.RequestResponse,
    Payload: new TextEncoder().encode(JSON.stringify(req)),
  }));
  const text = out.Payload ? new TextDecoder().decode(out.Payload) : '';
  if (out.FunctionError) throw new Error(`user-management: offboarding failed (${out.FunctionError})`);
  const answer = JSON.parse(text || '{}') as ConsoleOffboardingAnswer;
  if (typeof answer?.status !== 'number') throw new Error('user-management: offboarding returned no status');
  return answer;
}

let offboard: OffboardingInvoker = invokeOffboardingFunction;

/** Test seam: run offboarding's console requests in-process. `null` restores the invoke. */
export function __setOffboardingInvokerForTests(fn: OffboardingInvoker | null): void {
  offboard = fn ?? invokeOffboardingFunction;
}

// ── PROVISIONING IS THE IDENTITY STACK'S TOO (P-13) ─────────────────────────────────────────────
//
// A subject of a `provisioned-only` issuer is pre-assigned by the admin subject provisioner
// (`provision-subject.ts`), the one function this role may invoke for it. This handler holds no write on
// `Identities`; it names the administrator and relays the answer.
type ProvisionInvoker = (req: Record<string, unknown>) => Promise<Record<string, unknown>>;

async function invokeProvisioner(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const FunctionName = process.env.PROVISION_FUNCTION_NAME || '';
  if (!FunctionName) throw new Error('user-management: PROVISION_FUNCTION_NAME is not set');
  const out = await lambdaClient.send(new InvokeCommand({
    FunctionName,
    InvocationType: InvocationType.RequestResponse,
    Payload: new TextEncoder().encode(JSON.stringify(req)),
  }));
  if (out.FunctionError) throw new Error(`user-management: provisioning failed (${out.FunctionError})`);
  return JSON.parse(out.Payload ? new TextDecoder().decode(out.Payload) : '{}') as Record<string, unknown>;
}

let provision: ProvisionInvoker = invokeProvisioner;

/** Test seam: run the provisioner in-process. `null` restores the invoke. */
export function __setProvisionerForTests(fn: ProvisionInvoker | null): void {
  provision = fn ?? invokeProvisioner;
}

const PROVISION_STATUS: Record<string, number> = { INVALID_REQUEST: 400, ISSUER_NOT_PROVISIONABLE: 400, UNKNOWN_PERSON: 404, NOT_THIS_CALLER: 403 };


export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = event.headers?.origin || event.headers?.Origin;
  const path = event.path;
  const method = event.httpMethod;

  console.log('[UserManagement]', method, path);

  if (!isAllowedOrigin(origin)) {
    return respond(403, { error: 'Origin not allowed' }, origin);
  }

  try {
    // Gate on the admins group, not custom:tier — a paying tier is not admin
    // permission. Per CLAUDE.md, Cognito groups are authoritative.
    // Shared, IdP-agnostic check (honors ADMIN_GROUP_NAMES + service mode).
    if (!callerIsAdmin(event)) {
      return respond(403, { error: 'Admin access required' }, origin);
    }

    // GET /users: the people
    if (method === 'GET' && path.endsWith('/users')) {
      return respond(200, await listPeople(callerCanSeeUserIdentity(event)), origin);
    }

    // GET /users/guest: the guest issuer's kill switch, and who changed it (E6, L16). The starts and refusals
    // beside it are the funnel's, read from the archive by the analytics query.
    if (method === 'GET' && path.endsWith('/users/guest')) {
      return respond(200, await guestSwitchState(), origin);
    }

    // 400 on malformed JSON instead of 500.
    const parsed = parseJsonBody<{
      username?: string; tier?: string; group?: string; team?: string; member?: boolean;
      personArn?: string; issuer?: string; subject?: string;
    }>(event, origin);
    if ('statusCode' in parsed) return parsed;
    const body = parsed.body;

    // POST /users/delete: OFFBOARDING, by AppInstanceUser for every issuer (ADR-058). A pool account
    // that never became a person is named by its username instead.
    if (method === 'POST' && path.endsWith('/delete')) {
      const answer = await offboard({ console: 'delete', personArn: body.personArn, username: body.username, actor: await offboardingActor(event) });
      return respond(answer.status, answer.body, origin);
    }

    // POST /users/export: EVERYTHING KEPT ABOUT ONE APPINSTANCEUSER (B13, GDPR Articles 15 and 20), read by
    // offboarding's function from the inventory an erasure walks, as one archive. Nothing is changed.
    if (method === 'POST' && path.endsWith('/export')) {
      if (!body.personArn) return respond(400, { error: 'personArn is required', code: 'PERSON_REQUIRED' }, origin);
      const answer = await offboard({ console: 'export', personArn: body.personArn, actor: await offboardingActor(event) });
      return respond(answer.status, answer.body, origin);
    }

    // POST /users/provision: pre-assign a provisioned-only issuer's subject (P-13).
    if (method === 'POST' && path.endsWith('/provision')) {
      if (!process.env.PROVISION_FUNCTION_NAME) {
        return respond(404, { error: 'this deployment declares no provisioned-only issuer', code: 'NO_PROVISIONED_ISSUER' }, origin);
      }
      const actor = await offboardingActor(event);
      const answer = await provision({
        op: 'provisionSubject',
        issuer: body.issuer,
        subject: body.subject,
        ...(body.personArn ? { appInstanceUserArn: body.personArn } : {}),
        actor: actor.arn,
      });
      if (answer.ok !== true) return respond(PROVISION_STATUS[String(answer.code)] ?? 400, { error: answer.error, code: answer.code }, origin);
      return respond(answer.state === 'provisioned' ? 201 : 409, answer, origin);
    }

    // POST /users/readmit: let an offboarded subject sign in again, as a first sign-in.
    if (method === 'POST' && path.endsWith('/readmit')) {
      const answer = await offboard({ console: 'readmit', username: body.username, issuer: body.issuer, subject: body.subject, actor: await offboardingActor(event) });
      return respond(answer.status, answer.body, origin);
    }

    const { username } = body;
    if (!username) {
      return respond(400, { error: 'username is required' }, origin);
    }

    // POST /users/approve
    if (method === 'POST' && path.endsWith('/approve')) {
      // An approval that names no clearance lands on the deployment's FLOOR. This defaulted to a
      // literal 'basic', which is the floor only for a deployment that happens to call it that - and
      // it was spelled twice, so the value approved and the value reported back could diverge.
      // NO DEFAULT CLASSIFICATION TO APPROVE SOMEBODY AT. It used to fall to the
      // deployment's floor, which quietly granted a clearance nobody chose; between peers there is no
      // floor to fall to and the approver has to say which one.
      //
      // VALIDATED AGAINST THE CLEARANCE GROUPS, NOT THE CLASSIFICATION VALUES, because that is what
      // `approveUser` below actually requires and the two are not the same vocabulary: the group is
      // `admins` while the classification is `admin`. Checking the classification here let `admin`
      // pass this guard and then throw inside `approveUser` - a 400 turning into a 500 for the one
      // value an operator is most likely to try (review, 2026-09-17).
      const requested = typeof body.tier === 'string' ? body.tier : '';
      if (!clearanceGroupNames().includes(requested)) {
        return respond(400, {
          error: `approval must name a clearance group: ${clearanceGroupNames().join(', ')}`,
          code: 'CLEARANCE_REQUIRED',
        }, origin);
      }
      await approveUser(username, requested);
      return respond(200, { message: `User ${username} approved`, tier: requested }, origin);
    }

    // POST /users/reject. The pool's disable is the whole of it: the credential exchange asks the pool at
    // every vend, so the person's next sign-in or refresh is refused (SPEC-CREDENTIAL-EXCHANGE §4b).
    if (method === 'POST' && path.endsWith('/reject')) {
      await rejectUser(username);
      return respond(200, { message: `User ${username} disabled` }, origin);
    }

    // POST /users/tier  (wire field stays `tier`; it is the user's clearance)
    if (method === 'POST' && path.endsWith('/tier')) {
      const { tier: clearance } = body;
      // THE DEPLOYMENT'S OWN GROUPS, and the error names them. This listed the triple twice - once as
      // the check and once as English in the message - so a deployment declaring a fourth
      // classification could not set anybody to it, and the 400 said why in terms of a config that
      // was no longer the config.
      if (!clearance || !clearanceGroupNames().includes(clearance)) {
        return respond(400, { error: `tier must be one of: ${clearanceGroupNames().join(', ')}` }, origin);
      }
      await changeClearance(username, clearance);
      return respond(200, { message: `User ${username} tier changed to ${clearance}` }, origin);
    }

    // POST /users/group - a membership group, and only a membership group. A clearance group is set
    // through /tier, which keeps a person in exactly one; this route can never touch one.
    if (method === 'POST' && path.endsWith('/group')) {
      const { group, member } = body;
      if (!group || !membershipGroupNames().includes(group)) {
        return respond(400, { error: `group must be one of: ${membershipGroupNames().join(', ') || '(none declared)'}`, code: 'NOT_A_MEMBERSHIP_GROUP' }, origin);
      }
      if (typeof member !== 'boolean') {
        return respond(400, { error: 'member must be true or false', code: 'MEMBER_REQUIRED' }, origin);
      }
      const refusal = await setMembershipGroup(username, group, member);
      if (refusal) return respond(409, refusal, origin);
      const caller = (await callerActor(event)) || undefined;
      console.log(JSON.stringify({ _auditEvent: 'membership_group_changed', caller, username, group, member }));
      return respond(200, { message: `User ${username} ${member ? 'added to' : 'removed from'} ${group}` }, origin);
    }

    // POST /users/team - a console team, and only a team: `team-<name>` for a team that exists. The route never
    // touches `admins`, a clearance group or a membership group.
    if (method === 'POST' && path.endsWith('/team')) {
      const { team, member } = body;
      const existingTeams = await teamNames();
      if (typeof team !== 'string' || !TEAM_NAME_PATTERN.test(team) || !existingTeams.includes(team)) {
        return respond(400, { error: `team must be one of: ${existingTeams.join(', ') || '(none exist)'}`, code: 'NOT_A_TEAM' }, origin);
      }
      if (typeof member !== 'boolean') {
        return respond(400, { error: 'member must be true or false', code: 'MEMBER_REQUIRED' }, origin);
      }
      const outcome = await setTeam(username, team, member);
      if ('error' in outcome) return respond(409, outcome, origin);
      const caller = (await callerActor(event)) || undefined;
      console.log(JSON.stringify({ _auditEvent: 'team_changed', caller, username, team, member, consoleRole: outcome.consoleRole }));
      return respond(200, { message: `User ${username} ${member ? 'added to' : 'removed from'} team ${team}`, ...outcome }, origin);
    }

    // POST /users/enable
    if (method === 'POST' && path.endsWith('/enable')) {
      await enableUser(username);
      return respond(200, { message: `User ${username} re-enabled` }, origin);
    }

    return respond(404, { error: 'Not found' }, origin);

  } catch (error) {
    // Don't echo raw error.message to client. The log carries it, bounded: a name alone ("Error") left a
    // failed export with no cause anyone could read.
    const e = error as Error | undefined;
    console.error('[UserManagement] Error:', { name: e?.name || 'error', message: String(e?.message ?? '').slice(0, 300) });
    return respond(500, { error: 'Internal error' }, origin);
  }
};

/**
 * THE PEOPLE, FROM THE APPINSTANCEUSERS (ADR-058). Every AppInstanceUser that a subject signs in as is a
 * person, whichever issuer that is; a pool account with no AppInstanceUser yet is listed after them, so
 * a sign-up awaiting approval is still found. Admin-plane twins and the service admin are not people.
 *
 * NAMES ARE THE DIRECTORY'S (`displayNameFor`), and only for a caller who may be told who a person is
 * (`callerCanSeeUserIdentity`), the same rule as the conversation identities read. The admin console's
 * leaderboard names its senders from this list.
 */
/** How many people's reads one page of the list keeps in flight. */
const LIST_CONCURRENCY = 10;

async function listPeople(withNames: boolean): Promise<{
  users: PersonEntry[];
  membershipGroups: Array<{ name: string; requires: string }>;
  /** The clearance groups an approval or a clearance change may name, each with the classification it clears for. */
  clearanceGroups: Array<{ name: string; clears: string }>;
  /** The console teams this deployment has (its `team-<name>` groups), by name. */
  teams: string[];
}> {
  const accounts = new Map<string, PoolRecord>();
  let paginationToken: string | undefined;
  do {
    const page = await pool().listPage(paginationToken);
    for (const account of page.users) accounts.set(account.subject, account);
    paginationToken = page.next;
  } while (paginationToken);

  // One listing per membership group rather than one group lookup per user: there are a handful of
  // membership groups and any number of users.
  const groupsByUsername = new Map<string, string[]>();
  for (const group of membershipGroupNames()) {
    for (const m of await pool().usersInGroup(group)) groupsByUsername.set(m.username, [...(groupsByUsername.get(m.username) || []), group]);
  }
  // The teams, the same way: one listing per team group.
  const teams = await teamNames();
  const teamsByUsername = new Map<string, string[]>();
  const memberships = await Promise.all(teams.map(async (team) => ({ team, members: await pool().usersInGroup(`${TEAM_GROUP_PREFIX}${team}`) })));
  for (const { team, members } of memberships) {
    for (const m of members) teamsByUsername.set(m.username, [...(teamsByUsername.get(m.username) || []), team]);
  }

  const deps = defaultOffboardingDeps();
  const serviceAdmin = await deps.adminBearer().catch(() => '');
  const directory = defaultDirectory();
  const listed = new Set<string>();
  const users: PersonEntry[] = [];
  const entryOf = (account: PoolRecord | undefined, extra: Partial<PersonEntry>): PersonEntry => ({
    personArn: null,
    personId: null,
    displayName: null,
    account: account ? 'pool' : 'other',
    username: account?.username ?? null,
    email: account?.email || '',
    tier: account?.attributes['custom:tier'] || 'none',
    approved: account?.attributes['custom:approved'] || 'false',
    status: account?.status || '',
    enabled: account ? account.enabled : true,
    createdAt: account?.createdAt || '',
    membershipGroups: account ? groupsByUsername.get(account.username) || [] : [],
    teams: account ? teamsByUsername.get(account.username) || [] : [],
    issuers: account ? [deps.primary.issuer] : [],
    guest: false,
    ...extra,
  });

  let NextToken: string | undefined;
  do {
    const page = await chimeClient.send(new ListAppInstanceUsersCommand({ AppInstanceArn: APP_INSTANCE_ARN, MaxResults: 50, NextToken }));
    // EACH PERSON'S READS (their Identities rows, their name) RUN CONCURRENTLY, a page at a time and at
    // most `LIST_CONCURRENCY` in flight, rather than one person after another. The entries keep the
    // page's order, so the list is the one a sequential walk produced.
    const entries = await mapBounded(page.AppInstanceUsers || [], LIST_CONCURRENCY, async (summary): Promise<PersonEntry | null> => {
      const arn = summary.AppInstanceUserArn || '';
      const id = personIdFromArn(arn);
      if (!id || arn === serviceAdmin || adminTwinOwnerId(id, personIdFromArn(serviceAdmin) || undefined)) return null;
      // Nobody signs in as an AppInstanceUser with no Identities row: it is a service principal.
      const rows = await rowsOfPerson(arn, deps);
      if (!rows.length) return null;
      const poolRow = rows.find((r) => poolIssuerIds(deps.primary).includes(parseIssuerSubjectKey(r.issuerSubject)?.issuer ?? ''));
      const account = poolRow ? accounts.get(parseIssuerSubjectKey(poolRow.issuerSubject)!.subject) : undefined;
      if (account) listed.add(account.subject);
      const [displayName, enabled] = await Promise.all([
        withNames ? directory.displayNameFor(arn).then((n) => n ?? account?.name ?? null) : Promise.resolve(null),
        account ? Promise.resolve(account.enabled) : enabledAtIssuers(rows, directory),
      ]);
      const issuers = [...new Set(rows.map((r) => parseIssuerSubjectKey(r.issuerSubject)?.issuer).filter((x): x is string => Boolean(x)))];
      return entryOf(account, {
        personArn: arn,
        personId: id,
        displayName,
        enabled,
        issuers,
        guest: issuers.length > 0 && issuers.every((i) => isGuestIssuer(issuerById(i))),
      });
    });
    for (const entry of entries) if (entry) users.push(entry);
    NextToken = page.NextToken;
  } while (NextToken);

  for (const account of accounts.values()) {
    if (!listed.has(account.subject)) users.push(entryOf(account, {}));
  }

  // The declared membership groups travel with the list, with the clearance each requires, so the
  // console offers exactly these and can say what joining one needs.
  return {
    users,
    membershipGroups: membershipGroupNames().map((name) => ({ name, requires: membershipGroupRequirements()[name] })),
    teams,
    clearanceGroups: clearanceGroupNames().flatMap((name) => {
      const clears = profiles.resolveHolderToken([name]);
      return clears ? [{ name, clears }] : [];
    }),
  };
}

/**
 * WHETHER A PERSON OF ANOTHER ISSUER MAY SIGN IN, from their issuers' own records now: enabled when any of
 * their sign-ins is active at its issuer (`Directory.accountState`). An issuer with no account state (an
 * `oidc` token) answers active. A read that fails throws, and the list fails with it rather than show a
 * person as enabled on a read nobody made.
 */
async function enabledAtIssuers(rows: Array<{ issuerSubject: string; status?: string }>, directory: ReturnType<typeof defaultDirectory>): Promise<boolean> {
  const subjects = rows
    .filter((r) => !r.status || r.status === 'active')
    .map((r) => parseIssuerSubjectKey(r.issuerSubject))
    .filter((s): s is { issuer: string; subject: string } => Boolean(s));
  if (!subjects.length) return true;
  const states = await Promise.all(subjects.map((s) => directory.accountState(s.issuer, s.subject)));
  return states.includes('active');
}

/**
 * Join or leave a membership group.
 *
 * A membership group grants nothing, so JOINING requires that the person already holds the clearance the
 * group requires (`meetsMembershipRequirement`, the same token the credential exchange vends), and is
 * approved and enabled. A person who falls short is refused rather than added, so the group can never
 * name someone its conversations' classification would refuse. LEAVING changes nobody's clearance, so it
 * needs no re-stamp and no re-check; the group reconcile removes them from the group's conversations.
 *
 * Returns a refusal body, or null when the change was made.
 */
async function setMembershipGroup(
  username: string, group: string, member: boolean,
): Promise<{ error: string; code: string; requires?: string } | null> {
  if (member) {
    const existing = await clearanceSource().groupsFor(username);
    const user = await pool().record(username);
    const approved = user?.attributes['custom:approved'] === 'true';
    // A CLEARANCE GROUP, not only a token that reaches the requirement. An admins-only person resolves to
    // `admin`, which reaches premium, but holds no clearance a /tier change maintains - so losing `admins`
    // would leave them in the group with no clearance at all, and nothing would take them out.
    const holdsClearance = existing.some((g) => clearanceGroupNames().includes(g));
    if (!user || !user.enabled || !approved || !holdsClearance || !profiles.meetsMembershipRequirement(existing, group)) {
      return {
        error: `Only an approved, enabled user already cleared for ${membershipGroupRequirements()[group]} can be added to ${group}. Change their clearance first.`,
        code: 'CLEARANCE_BELOW_GROUP',
        requires: membershipGroupRequirements()[group],
      };
    }
  }
  const input = { UserPoolId: USER_POOL_ID, Username: username, GroupName: group };
  await cognitoClient.send(member ? new AdminAddUserToGroupCommand(input) : new AdminRemoveUserFromGroupCommand(input));
  return null;
}

/** The console teams that exist: the pool's `team-<name>` groups, without the `team-members` role group. */
async function teamNames(): Promise<string[]> {
  return teamsOfGroups(await pool().groupNames(TEAM_GROUP_PREFIX)).sort();
}

/**
 * ADD A PERSON TO A TEAM, OR TAKE THEM OUT, AND KEEP THEIR CONSOLE ROLE IN STEP.
 *
 * A team is a `team-<name>` group; the console admits a team member only on the `team-members` role group, so a
 * team with no role behind it would give the person nothing. Joining a first team adds the role and leaving the
 * last one removes it, so the two never disagree. An administrator is left alone: `admins` already reaches every
 * assistant, and is never added or removed here. Only an approved, enabled account joins a team.
 */
async function setTeam(
  username: string, team: string, member: boolean,
): Promise<{ consoleRole: 'added' | 'removed' | 'unchanged' } | { error: string; code: string }> {
  if (member) {
    const user = await pool().record(username);
    if (!user || !user.enabled || user.attributes['custom:approved'] !== 'true') {
      return { error: `Only an approved, enabled user can join the ${team} team. Approve them first.`, code: 'NOT_APPROVED' };
    }
  }
  const input = { UserPoolId: USER_POOL_ID, Username: username, GroupName: `${TEAM_GROUP_PREFIX}${team}` };
  await cognitoClient.send(member ? new AdminAddUserToGroupCommand(input) : new AdminRemoveUserFromGroupCommand(input));
  // THE ROLE IS DECIDED FROM THE GROUPS AS THEY ARE NOW, read again after the change: two changes for one person
  // in flight would otherwise each decide from the groups before either, and could leave a team with no role.
  const after = await clearanceSource().groupsFor(username);
  const isAdmin = after.includes(ADMIN_ROLE_GROUP.admins);
  const hasRole = after.includes(ADMIN_ROLE_GROUP['team-members']);
  const teamsAfter = new Set(teamsOfGroups(after));
  const role = { UserPoolId: USER_POOL_ID, Username: username, GroupName: ADMIN_ROLE_GROUP['team-members'] };
  if (!isAdmin && teamsAfter.size > 0 && !hasRole) {
    await cognitoClient.send(new AdminAddUserToGroupCommand(role));
    return { consoleRole: 'added' };
  }
  if (!isAdmin && teamsAfter.size === 0 && hasRole) {
    await cognitoClient.send(new AdminRemoveUserFromGroupCommand(role));
    return { consoleRole: 'removed' };
  }
  return { consoleRole: 'unchanged' };
}

async function approveUser(username: string, clearance: string): Promise<void> {
  // An approval naming a clearance this deployment does not declare lands on the FLOOR, which is the
  // registry's declared classifications rather than a literal 'basic'.
  // An unrecognized clearance is not the floor, because there is none. The caller is refused rather
  // than silently given the least-privileged one.
  if (!clearanceGroupNames().includes(clearance)) {
    throw new Error(`user-management: '${clearance}' is not a declared clearance group`);
  }
  const effectiveClearance = clearance as Clearance;

  // Set approved + clearance
  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'custom:approved', Value: 'true' },
      { Name: 'custom:tier', Value: effectiveClearance },
    ],
  }));

  // Mirror into Cognito group so authorization checks trust it
  await syncClearanceGroup(username, effectiveClearance);

  // Enable the user if disabled
  await cognitoClient.send(new AdminEnableUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));

  // NO AppInstanceUser IS CREATED HERE. Only the credential exchange creates a person (lib/person-identity.ts),
  // at their first sign-in, and that is also where their memberships are first evaluated: approval is a
  // Cognito decision about whether they may sign in, not the moment they become a principal.
}

async function rejectUser(username: string): Promise<void> {
  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'custom:approved', Value: 'false' },
    ],
  }));

  await cognitoClient.send(new AdminDisableUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
}

async function enableUser(username: string): Promise<void> {
  await cognitoClient.send(new AdminEnableUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));

  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'custom:approved', Value: 'true' },
    ],
  }));
}

async function changeClearance(username: string, clearance: string): Promise<void> {
  if (!clearanceGroupNames().includes(clearance)) {
    throw new Error(`Invalid clearance: ${clearance}`);
  }
  await cognitoClient.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
    UserAttributes: [
      { Name: 'custom:tier', Value: clearance },
    ],
  }));
  await syncClearanceGroup(username, clearance as Clearance);
}

/**
 * The person a pool username signs in as, WHATEVER THE STATUS OF THEIR SIGN-IN: the username's subject's
 * `Identities` row read directly (`rowOfSubject`), not resolved like a sign-in. Null for a user who has
 * never signed in, who has no AppInstanceUser to tag or re-audit.
 *
 * ADMIN LIFECYCLE ONLY (the identity tag re-stamp and the membership re-evaluation). `resolvePerson`
 * refuses a row that is not `active`, which is right for a request and wrong here: a clearance narrowed
 * for a person must still re-stamp their tag and re-audit their rooms whatever their row's status, or
 * they hold memberships their clearance does not reach. Nothing here grants access.
 */
async function personArnOfUsername(username: string): Promise<string | null> {
  const sub = await getUserSub(username);
  if (!sub) return null;
  const deps = defaultOffboardingDeps();
  const row = await rowOfPoolSubject(deps.primary, sub, deps);
  return row && personIdFromArn(row.personArn) ? row.personArn : null;
}

async function getUserSub(username: string): Promise<string | null> {
  // Cognito filter language has limited grammar but accepts quoted strings;
  // an embedded `"` breaks parsing
  // (silently DoSing this lookup) and some shapes risk filter injection
  // across attributes. Validate before interpolating + reject anything
  // that isn't a plain Cognito username (email or sub UUID).
  if (typeof username !== 'string' || username.length === 0 || username.length > 256) {
    return null;
  }
  // Reject double quotes, control chars, backslashes — these can confuse
  // the Cognito filter parser. Allow @ + . for emails and - for UUIDs.
  if (/[\\"\x00-\x1f]/.test(username)) {
    console.warn('[user-management] rejected unsafe username for filter', { len: username.length });
    return null;
  }
  return (await pool().byUsername(username))?.subject || null;
}
