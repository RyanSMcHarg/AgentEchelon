/**
 * THE ONLY WRITER OF AN ASSISTANT'S `owner-team` TAG (SPEC-ADMIN-CONSOLE FR47, `manage-ownership`).
 *
 * Ownership decides what a team member's console reaches, so it is an ownership record only while
 * nobody it scopes can write it. This function's role is the one grant permitted to tag a bot with
 * `owner-team`; every other `chime:TagResource` grant in the deployment excludes that key, and the
 * deny-test proves it.
 *
 * Two entry points:
 *   - The admin API, `GET /admin/ownership` (who owns what, and which teams exist) and
 *     `POST /admin/ownership` (assign or clear an assistant's team, with a stated reason). Both are
 *     IAM-authorized on their own resource, granted to `admins` only, and refuse a team console session.
 *   - The team route, `POST /admin/assistants/{assistant}/ownership`: a team member moves an assistant
 *     their team owns to another of their own teams, with a reason. Never to a team they are not in,
 *     and never to no team, because an assistant no team owns is an admin's decision.
 *   - A direct invoke, `{ op: 'seed', botArn? }`, from the provisioner when it creates or updates an
 *     assistant and from this stack's deploy. It copies a profile's declared `ownerTeam` (or a runtime
 *     assistant's, from its assignment record) onto a bot that
 *     carries no owner yet, and never overwrites one, so a reassignment made in the console survives
 *     every later deploy.
 *   - A direct invoke, `{ op: 'in-team', personArn, team }`, from the provisioner's team route
 *     (`manage-assistants`), whose own role reads no directory: whether that person's groups name that
 *     team now. It answers yes or no and changes nothing; the provisioner decides what follows.
 *   - Direct invokes `{ op: 'team-exists', team }` and `{ op: 'owned-by', team }`, from the provisioner too:
 *     whether a team's group exists (an admin's create naming an owner), and which assistants the tags
 *     say a team owns (a team's roster). Both read and change nothing.
 *
 * THE TAG IS THE ONE RECORD OF OWNERSHIP. A runtime assistant's directory entry and assignment record keep
 * the team it was created for, which seeds the tag once; after that every reader that asks who owns an
 * assistant (a team's console session, its roster, the listing) reads the tag.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  ChimeSDKIdentityClient,
  ListTagsForResourceCommand,
  TagResourceCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { callerPersonId, callerPersonArn, consoleSessionOf, respond as authRespond } from './lib/auth.js';
import {
  OWNER_TEAM_TAG,
  OWNER_TEAM_CLEARED,
  TEAM_GROUP_PREFIX,
  listAssistantIdentities,
  ownedBy,
  teamsOfGroups,
  type AssistantIdentity,
} from './lib/assistant-ownership.js';
import { requireOwnedAssistant, isRefusal, scopedAssistant } from './lib/assistant-scope.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { TEAM_NAME_PATTERN } from '../../lib/config/profiles.js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { runtimeAssignmentParamName } from './lib/runtime-directory.js';
import type { AssignmentRecord } from './lib/runtime-assistant.js';
import { chimeIdentityClient } from './lib/chime/clients.js';
// The team groups are read through the directory (C4): every trusted issuer whose directory keeps groups.
import { defaultDirectory } from './lib/membership-source.js';
import { appInstanceArnOf, isPersonArn } from './lib/person-arn.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const REGION = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';

const chime = chimeIdentityClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

/**
 * A RUNTIME ASSISTANT'S DECLARED TEAM, from its assignment record (ADR-048). It has no compiled profile
 * to declare one, and the record is written by `manage-assistants` alone, outside `/assistant/*`, so it
 * is the same kind of declaration a compiled `ownerTeam` is. Read from the path the identity's own
 * tags name, and only for a record that says it is this assistant.
 */
async function runtimeOwnerTeam(id: AssistantIdentity): Promise<string | undefined> {
  if (!id.classification || !id.role) return undefined;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: runtimeAssignmentParamName(SSM_ROOT, id.classification, id.role, id.assistant) }));
    const record = JSON.parse(res?.Parameter?.Value || '{}') as AssignmentRecord;
    const team = record.source === 'runtime' && record.assistant === id.assistant && record.botArn === id.botArn ? record.ownerTeam : undefined;
    return team && TEAM_NAME_PATTERN.test(team) ? team : undefined;
  } catch {
    return undefined;
  }
}

/** The direct-invoke contract. An API Gateway event never carries `op`. */
export interface SeedRequest {
  op: 'seed';
  /** One bot (a provisioner's), or every assistant in the app instance when absent. */
  botArn?: string;
}

/**
 * Whether one person is in one team, for the provisioner's team route. The person is an AppInstanceUser
 * of this app instance, which the provisioner takes from the signed console session, never from a body.
 */
export interface InTeamRequest {
  op: 'in-team';
  personArn: string;
  team: string;
}

export interface InTeamResult {
  inTeam: boolean;
}

/** Whether a team exists: its group is in the directory. For an admin's create naming an owner. */
export interface TeamExistsRequest {
  op: 'team-exists';
  team: string;
}

/**
 * THE ASSISTANTS A TEAM OWNS, read from the `owner-team` tags, for the provisioner's team roster. The tag is
 * the one record of ownership (it is what a team console session is issued from), so a roster read from
 * anything else would keep listing an assistant under the team it was moved away from.
 */
export interface OwnedByRequest {
  op: 'owned-by';
  team: string;
}

export const handler = async (
  event: APIGatewayProxyEvent | SeedRequest | InTeamRequest | TeamExistsRequest | OwnedByRequest,
): Promise<APIGatewayProxyResult | SeedResult | InTeamResult | { exists: boolean } | { assistants: string[] }> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if ((event as SeedRequest).op === 'seed') return seed((event as SeedRequest).botArn);
  if ((event as InTeamRequest).op === 'in-team') return inTeam(event as InTeamRequest);
  if ((event as TeamExistsRequest).op === 'team-exists') {
    const team = (event as TeamExistsRequest).team;
    return { exists: typeof team === 'string' && TEAM_NAME_PATTERN.test(team) && (await teamExists(team)) };
  }
  if ((event as OwnedByRequest).op === 'owned-by') {
    const team = (event as OwnedByRequest).team;
    if (typeof team !== 'string' || !TEAM_NAME_PATTERN.test(team)) return { assistants: [] };
    const identities = await listAssistantIdentities(chime, APP_INSTANCE_ARN);
    return { assistants: ownedBy(identities, [team]) };
  }
  return api(event as APIGatewayProxyEvent);
};

// ── IN TEAM: one person's membership of one team, from their groups ────────────────────────────────

async function inTeam(req: InTeamRequest): Promise<InTeamResult> {
  const { personArn, team } = req;
  // Anything but a team name and a person of this app instance is no member, before any read.
  if (typeof team !== 'string' || !TEAM_NAME_PATTERN.test(team)) return { inTeam: false };
  if (!APP_INSTANCE_ARN || !isPersonArn(personArn) || appInstanceArnOf(personArn) !== APP_INSTANCE_ARN) return { inTeam: false };
  const groups = (await defaultDirectory().groupsFor(personArn)) ?? [];
  return { inTeam: teamsOfGroups(groups).includes(team) };
}

// ── SEED: a profile's declared owner, onto a bot that has none ─────────────────────────────────────

export interface SeedResult {
  seeded: Array<{ botArn: string; assistant: string; team: string }>;
}

async function seed(botArn?: string): Promise<SeedResult> {
  const identities = await listAssistantIdentities(chime, APP_INSTANCE_ARN);
  const targets = botArn ? identities.filter((i) => i.botArn === botArn) : identities;
  const seeded: SeedResult['seeded'] = [];
  for (const id of targets) {
    if (id.ownerRecorded) continue; // decided already, a cleared owner included: the console's decision stands
    // A compiled profile's declaration, or, for a name no compiled profile declares, a runtime record's.
    const compiled = profiles.profileByName(id.assistant);
    const team = compiled ? compiled.ownerTeam : await runtimeOwnerTeam(id);
    if (!team) continue;
    await chime.send(new TagResourceCommand({ ResourceARN: id.botArn, Tags: [{ Key: OWNER_TEAM_TAG, Value: team }] }));
    console.log(JSON.stringify({ event: 'assistant_ownership_seeded', botArn: id.botArn, assistant: id.assistant, team }));
    seeded.push({ botArn: id.botArn, assistant: id.assistant, team });
  }
  return { seeded };
}

// ── API ─────────────────────────────────────────────────────────────────────────────────────────

/** One assistant, with every bot that serves it, as the console lists it. */
interface AssistantOwnership {
  assistant: string;
  displayName: string;
  classifications: string[];
  /** The owning team when every bot agrees, else null; `mixed` says they disagree. */
  ownerTeam: string | null;
  mixed: boolean;
}

function byAssistant(identities: AssistantIdentity[]): AssistantOwnership[] {
  const names = [...new Set(identities.map((i) => i.assistant))].sort();
  return names.map((assistant) => {
    const bots = identities.filter((i) => i.assistant === assistant);
    const owners = [...new Set(bots.map((b) => b.ownerTeam))];
    return {
      assistant,
      displayName: profiles.displayNameFor(assistant),
      classifications: [...new Set(bots.map((b) => b.classification).filter((c): c is string => !!c))].sort(),
      ownerTeam: owners.length === 1 ? owners[0] : null,
      mixed: owners.length > 1,
    };
  });
}

async function teamNames(): Promise<string[]> {
  // The same reading as a person's teams (`teamsOfGroups`), so the `team-members` role group is never offered as a team.
  return teamsOfGroups(await defaultDirectory().listGroups(TEAM_GROUP_PREFIX)).sort();
}

async function teamExists(team: string): Promise<boolean> {
  if (teamsOfGroups([`${TEAM_GROUP_PREFIX}${team}`]).length === 0) return false;
  return (await defaultDirectory().listGroups(`${TEAM_GROUP_PREFIX}${team}`)).includes(`${TEAM_GROUP_PREFIX}${team}`);
}

async function api(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const origin = event.headers?.origin || event.headers?.Origin;
  const respond = (code: number, body: unknown) => authRespond(code, body, origin);
  if (event.httpMethod === 'OPTIONS') return respond(200, { ok: true });

  // The gateway admitted a session holding `manage-ownership`; the actor is the person it names.
  const actor = await callerPersonId(event);
  if (!actor) return respond(401, { error: 'Unauthorized' });

  // TWO ROUTES, TWO CALLERS. The admin route lists and assigns every assistant; the team route names one
  // assistant the caller's team owns. Each refuses the other's session, behind IAM, which grants each
  // role only its own route.
  const userArn = (event.requestContext?.identity as { userArn?: string | null } | undefined)?.userArn;
  const teamSession = consoleSessionOf(userArn)?.kind === 'team';
  const scoped = scopedAssistant(event);
  if (teamSession && !scoped) {
    return respond(403, { error: 'This route is an administrator\'s; a team assigns on its assistant\'s own route', code: 'ADMIN_ROUTE' });
  }
  if (scoped && !teamSession) {
    return respond(403, { error: 'This route is a team member\'s', code: 'TEAM_ROUTE' });
  }

  try {
    if (scoped) return await teamAssign(event, actor, respond);
    if (event.httpMethod === 'GET') {
      const [identities, teams] = await Promise.all([listAssistantIdentities(chime, APP_INSTANCE_ARN), teamNames()]);
      return respond(200, { assistants: byAssistant(identities), teams });
    }
    if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

    let body: { assistant?: unknown; team?: unknown; reason?: unknown };
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return respond(400, { error: 'Invalid JSON body' });
    }
    const assistant = typeof body.assistant === 'string' ? body.assistant : '';
    const team = body.team === null ? null : typeof body.team === 'string' ? body.team.trim() : undefined;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!assistant) return respond(400, { error: 'assistant is required', code: 'ASSISTANT_REQUIRED' });
    if (team === undefined) return respond(400, { error: 'team is required (null clears it)', code: 'TEAM_REQUIRED' });
    if (!reason) return respond(400, { error: 'a reason is required to change ownership', code: 'REASON_REQUIRED' });
    if (team !== null && !TEAM_NAME_PATTERN.test(team)) return respond(400, { error: 'not a team name', code: 'TEAM_INVALID' });
    if (team !== null && !(await teamExists(team))) {
      return respond(400, { error: `no group ${TEAM_GROUP_PREFIX}${team} exists`, code: 'TEAM_NOT_FOUND' });
    }

    const bots = (await listAssistantIdentities(chime, APP_INSTANCE_ARN)).filter((i) => i.assistant === assistant);
    if (bots.length === 0) return respond(404, { error: 'no such assistant', code: 'ASSISTANT_NOT_FOUND' });
    return await applyOwner(bots, assistant, team, actor, reason, respond);
  } catch (err) {
    console.error('[assistant-ownership] failed:', err);
    return respond(500, { error: (err as Error).message });
  }
}

/**
 * A TEAM MEMBER MOVES AN ASSISTANT THEIR TEAM OWNS TO ANOTHER OF THEIR OWN TEAMS.
 *
 * The session names only owned assistants; this re-reads ownership (`requireOwnedAssistant`) and the
 * caller's groups, and refuses a team they are not in and a cleared owner.
 */
async function teamAssign(
  event: APIGatewayProxyEvent,
  actor: string,
  respond: (code: number, body: unknown) => APIGatewayProxyResult,
): Promise<APIGatewayProxyResult> {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  const origin = event.headers?.origin || event.headers?.Origin;
  const scope = await requireOwnedAssistant(event, origin);
  if (!scope || isRefusal(scope)) return scope ?? respond(403, { error: 'no assistant named', code: 'ASSISTANT_NOT_OWNED' });
  let body: { assistant?: unknown; team?: unknown; reason?: unknown };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }
  if (typeof body.assistant === 'string' && body.assistant !== scope.assistant) {
    return respond(403, { error: 'This route changes only the assistant it names', code: 'ASSISTANT_MISMATCH' });
  }
  const team = typeof body.team === 'string' ? body.team.trim() : null;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!team) return respond(403, { error: 'a team member assigns an assistant to one of their own teams; only an administrator clears an owner', code: 'TEAM_REQUIRED' });
  if (!reason) return respond(400, { error: 'a reason is required to change ownership', code: 'REASON_REQUIRED' });
  const personArn = await callerPersonArn(event, APP_INSTANCE_ARN);
  const groups = personArn ? (await defaultDirectory().groupsFor(personArn)) ?? [] : [];
  if (!teamsOfGroups(groups).includes(team)) {
    return respond(403, { error: `you are not in team ${team}; a team member assigns only to their own teams`, code: 'TEAM_NOT_YOURS' });
  }
  return applyOwner(scope.bots, scope.assistant, team, actor, reason, respond);
}

/** Write the owner on every bot of the assistant, read it back, and record the change. */
async function applyOwner(
  bots: AssistantIdentity[],
  assistant: string,
  team: string | null,
  actor: string,
  reason: string,
  respond: (code: number, body: unknown) => APIGatewayProxyResult,
): Promise<APIGatewayProxyResult> {
  for (const bot of bots) {
    // Clearing records "no team" rather than removing the tag, so the next deploy's seed does not
    // hand the assistant back to the team its profile declares.
    await chime.send(new TagResourceCommand({ ResourceARN: bot.botArn, Tags: [{ Key: OWNER_TEAM_TAG, Value: team ?? OWNER_TEAM_CLEARED }] }));
  }
  // Read back rather than assume: what a team reaches is what the tags say, not what was asked.
  const after = await Promise.all(bots.map(async (b) => {
    const tags = (await chime.send(new ListTagsForResourceCommand({ ResourceARN: b.botArn }))).Tags || [];
    return tags.find((t) => t.Key === OWNER_TEAM_TAG)?.Value ?? null;
  }));
  const applied = after.every((v) => v === (team ?? OWNER_TEAM_CLEARED));
  console.log(JSON.stringify({
    event: 'assistant_ownership_changed',
    actor,
    assistant,
    from: [...new Set(bots.map((b) => b.ownerTeam))],
    to: team,
    reason,
    applied,
  }));
  if (!applied) return respond(500, { error: 'ownership did not apply to every bot', code: 'OWNERSHIP_PARTIAL' });
  return respond(200, { assistant, ownerTeam: team });
}
