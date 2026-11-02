/**
 * CREATING AND RETIRING AN ASSISTANT AT RUNTIME (ADR-048, the `manage-assistants` capability).
 *
 * An assistant is an identity (an Amazon Chime SDK `AppInstanceBot`), an Amazon Lex bot of its own, and
 * an assignment record that gives it a role in one classification. ONE PRINCIPAL BUILDS AND RETIRES EVERY ONE OF
 * THEM: the provisioner (`assistant-provisioner-function.ts`), which a deploy's seed asks for the assistants the
 * deployment declares, once, and this function asks for the ones an admin or a team creates in the console
 * (`op: 'build'`) and for every retire (`op: 'remove'`). This function validates, takes the name and writes the
 * directory entry and the assignment record; it holds no identity, Amazon Lex or session-role grant, and proves each
 * request to the provisioner with a claim under the console's path (`lib/provisioner-claim.ts`). Once an
 * assistant exists the console owns it, however it was asked for, and retire is one path for all of them. What
 * it never creates is a boundary: the
 * assistant acts through its classification's one acting role, under that classification's boundary
 * (ADR-054), so a runtime assistant reaches exactly what its role's live assistant reaches.
 *
 * Routes (AWS_IAM, owned by `manage-assistants` in `admin-capabilities.ts`):
 *   - `POST /admin/roster` (admins) creates one. It validates, takes the name, and answers 202; the build
 *     runs asynchronously in this same function (`{ op: 'provision' }`), because building a Lex bot takes
 *     longer than API Gateway waits. The roster (`GET /admin/profiles`) reads the directory entry, so the
 *     console sees `provisioning`, then `active` or `failed`, when it next loads.
 *   - `POST /admin/roster/{assistantId}/retire` (admins) retires one, synchronously.
 *   - `GET` and `POST /admin/teams/{team}/roster` (team members): the same create for a team the caller
 *     is in, owned by that team, in a classification the caller's clearance reaches; the GET answers that
 *     team's runtime assistants and where it may create one. Each route refuses the other role's session,
 *     behind IAM, which grants each role only its own routes.
 *
 * THE NAME IS TAKEN FIRST AND NEVER GIVEN BACK ONCE USED. The directory entry
 * (`{root}/assistant-directory/{id}`) is written with `Overwrite: false`, so it is the lock, and a
 * retired entry stays as a tombstone because analytics and profile history are keyed by the name. The
 * display name is locked the same way, per classification, so two creates in flight cannot both take it.
 *
 * A FAILED BUILD STAYS VISIBLE. It is recorded as `failed` with its reason, so the roster shows why the
 * assistant does not exist. Retiring it removes whatever it left and, because nothing ever answered under
 * the name, releases the name instead of leaving a tombstone.
 *
 * ONE BUILD PER CREATE. The build claims the entry (`buildClaimParamName`, `Overwrite: false`) before
 * asking the provisioner for anything, so a duplicated invoke builds nothing, and the provisioner records each id
 * it creates on the entry as it goes, so a build killed by a timeout leaves the ids that retire needs.
 *
 * THE FIRST VERSION IS A DRAFT SEEDED AT CREATE. When the build finishes it asks `manage-profiles`, the one
 * writer of the profile namespace, to seed a first draft from the starting point the create named
 * (`starting-point.ts`): the classification's defaults, a profile file, or a copy of an assistant in the same
 * classification, with the create's name and models written over it. A file or a copy is checked by
 * `manage-profiles` before the name is taken, so one that cannot land builds nothing. The vend refuses an
 * assistant with no active version, so it does not act until someone reads that draft and activates it. A seed
 * that fails is recorded on the entry (`firstDraftError`) and the console's "new version" seeds the defaults again.
 *
 * OWNERSHIP IS THE `owner-team` TAG. The entry's `ownerTeam` is the team it was created for, which seeds the
 * tag once (`ownerSeedError` records a seed that failed); a team's roster reads the tag through the ownership
 * function (`owned-by`), so moving an assistant moves it between rosters.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  SSMClient,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { TEAM_NAME_PATTERN } from '../../lib/config/profiles.js';
import { getModelCatalog, type BackendModelKey } from '../../lib/config/model-strategy.js';
import { parseJsonBody, callerCanManageAssistants, callerActor, callerPersonArn, consoleSessionOf, respond as authRespond } from './lib/auth.js';
import { ASSISTANT_ID_PATTERN } from './lib/assistant-acting-policy.js';
import { displayNameErrors } from './lib/display-name.js';
import { identityRequestToken, lexBotNameFor } from './lib/assistant-provisioner.js';
import type { BuildAnswer, RemoveAnswer } from './assistant-provisioner-function.js';
import { writeClaim } from './lib/provisioner-claim.js';
import {
  directoryParamName,
  runtimeAssignmentParamName,
  buildClaimParamName,
  displayNameLockParamName,
  withAbandonedBuild,
  readDirectoryEntry,
  listDirectory,
  type DirectoryEntry,
} from './lib/runtime-directory.js';
import type { AssignmentRecord } from './lib/runtime-assistant.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { rosterTargets } from './lib/roster-targets.js';
import { startingPointErrors, startingPointOf, type StartingPoint } from './lib/starting-point.js';
import { DEFAULT_MODEL } from './lib/active-profile.js';
import { displayNameHolder } from './lib/display-names-in-use.js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || '';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const OWNERSHIP_FUNCTION_NAME = process.env.OWNERSHIP_FUNCTION_NAME || '';
/** `manage-profiles`, asked for a created assistant's first draft (it alone writes `/assistant/*`). */
const MANAGE_PROFILES_FUNCTION_NAME = process.env.MANAGE_PROFILES_FUNCTION_NAME || '';
/**
 * THE PROVISIONER (`assistant-provisioner-function.ts`), the one principal that builds and removes every
 * assistant's identity and Amazon Lex bot. This function decides and records; it asks the provisioner for the
 * identity work, and holds no identity, Amazon Lex or session-role grant of its own.
 */
const PROVISIONER_FUNCTION_NAME = process.env.PROVISIONER_FUNCTION_NAME || '';

const ssm = new SSMClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
/**
 * THE PROVISIONER IS ASKED ONCE PER CLAIM. A claim is spent on its first read (`provisioner-claim.ts`), so an SDK
 * retry of a long build would arrive with no claim, be refused, and have this function undo a build the first
 * invocation is still running. A failed invoke is handled as failed, from the ids the build recorded.
 */
const provisionerClient = new LambdaClient({ region: REGION, maxAttempts: 1 });

export interface CreateRequest {
  assistantId: string;
  classification: string;
  role: string;
  displayName: string;
  /** `classifierModelKey`: the first draft's classifier model, or `'default'` for the platform classifier. */
  descriptor: { modelKey: string; classifierMode: 'keyword' | 'llm'; rateLimitPerHour?: number; classifierModelKey?: string };
  ownerTeam?: string;
  /** What the first draft starts from (`starting-point.ts`). Absent: the classification's defaults. */
  startingPoint?: StartingPoint;
}

/** The asynchronous half of a create: this function, invoked with `InvocationType: Event`. */
export interface ProvisionRequest {
  op: 'provision';
  assistantId: string;
  /**
   * Carried to the first draft in the invoke rather than on the directory entry: a profile file can be larger
   * than a parameter holds, and it is needed once, when the build finishes.
   */
  startingPoint?: StartingPoint;
}

const isNotFound = (err: unknown): boolean => {
  const name = (err as { name?: string })?.name;
  return name === 'ParameterNotFound' || name === 'NotFoundException' || name === 'ResourceNotFoundException';
};

function audit(action: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ _audit: 'manage-assistants', action, at: new Date().toISOString(), ...fields }));
}

async function putJson(name: string, value: unknown, overwrite: boolean): Promise<void> {
  await ssm.send(new PutParameterCommand({ Name: name, Value: JSON.stringify(value), Type: 'String', Overwrite: overwrite }));
}

async function readJson<T>(name: string): Promise<T | null> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name }));
    return res?.Parameter?.Value ? JSON.parse(res.Parameter.Value) as T : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Every assignment record in one classification, paged. */
async function recordsIn(classification: string): Promise<AssignmentRecord[]> {
  const out: AssignmentRecord[] = [];
  let token: string | undefined;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({
      Path: `${SSM_ROOT}/assistant-assignments/${classification}`, Recursive: true, MaxResults: 10, NextToken: token,
    }));
    for (const p of res?.Parameters || []) {
      try { out.push(JSON.parse(p.Value || '{}') as AssignmentRecord); } catch { /* unreadable: names nobody */ }
    }
    token = res?.NextToken;
  } while (token);
  return out;
}

/** The name a person reads beside an assistant's messages, for comparison. */
const displayOf = (r: AssignmentRecord): string =>
  (r.displayName || (r.assistant ? profiles.profileByName(r.assistant)?.displayName : '') || r.assistant || '').trim().toLowerCase();

/**
 * Every reason a create is refused, or none. Read-only: nothing is written until this is empty.
 *
 * The role must be DEPLOYED on the classification, read from the registry row its stack publishes
 * (`rolesFor`): the classification's acting role trusts only deployed roles (ADR-054), so an assistant in
 * any other role would be created and then never act. The display name must be unique in the classification, because `@`
 * resolves an assistant by the name it shows.
 */
export async function createErrors(req: Partial<CreateRequest>): Promise<string[]> {
  const errs: string[] = [];
  const id = typeof req.assistantId === 'string' ? req.assistantId : '';
  const c = typeof req.classification === 'string' ? req.classification : '';
  const role = typeof req.role === 'string' ? req.role : '';
  if (!ASSISTANT_ID_PATTERN.test(id)) errs.push('assistantId must be lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters');
  // The id is the Lex bot's name as it stands (`lexBotNameFor`), and Lex refuses consecutive hyphens.
  // Collapsing them instead would map two ids to one bot name.
  else if (id.includes('--')) errs.push('assistantId must not contain consecutive hyphens');
  else if (profiles.isReservedAssistantName(id)) errs.push(`'${id}' is a classification, a declared assistant, an alt, or a composed role name, and is reserved`);
  if (!profiles.isConversational(c) || profiles.resolveClassification(c) !== c) errs.push(`'${c}' is not a conversational classification`);
  // THE DEPLOYMENT'S OWN CLASSIFICATIONS ONLY: an outside classification is served by the assistant its stack deploys,
  // and a runtime assistant in a visitor's or a customer's conversation is **NOT BUILT**.
  else if (profiles.audienceOf(c) === 'outside') errs.push(`'${c}' is an outside classification, which takes no runtime assistant`);
  else if (!profiles.rolesFor(c).includes(role)) errs.push(`'${role}' is not a role the ${c} classification declares`);
  errs.push(...displayNameErrors(req.displayName, { required: true }));
  const d = req.descriptor;
  const catalog = getModelCatalog(REGION, ACCOUNT_ID);
  if (!d || typeof d.modelKey !== 'string' || !(d.modelKey in catalog)) errs.push('descriptor.modelKey must name a model in the deployment catalog');
  else if (profiles.isConversational(c) && !profiles.selectsModel(c, d.modelKey)) {
    errs.push(`model '${d.modelKey}' is not selected by the ${c} classification`);
  }
  if (d && d.classifierMode !== 'keyword' && d.classifierMode !== 'llm') errs.push("descriptor.classifierMode must be 'keyword' or 'llm'");
  // THE CLASSIFIER MODEL IS A CLASSIFICATION'S MODEL, like the base model, or the platform classifier.
  if (d && d.classifierModelKey !== undefined && d.classifierModelKey !== DEFAULT_MODEL) {
    if (typeof d.classifierModelKey !== 'string' || !(d.classifierModelKey in catalog)) {
      errs.push(`descriptor.classifierModelKey must name a model in the deployment catalog, or '${DEFAULT_MODEL}'`);
    } else if (profiles.isConversational(c) && !profiles.selectsModel(c, d.classifierModelKey)) {
      errs.push(`classifier model '${d.classifierModelKey}' is not selected by the ${c} classification`);
    }
  }
  errs.push(...startingPointErrors(req.startingPoint));
  if (d && d.rateLimitPerHour !== undefined && !(Number.isInteger(d.rateLimitPerHour) && d.rateLimitPerHour > 0)) {
    errs.push('descriptor.rateLimitPerHour must be a positive integer');
  }
  if (req.ownerTeam !== undefined && !(typeof req.ownerTeam === 'string' && TEAM_NAME_PATTERN.test(req.ownerTeam))) {
    errs.push('ownerTeam must be a team name');
  }
  if (errs.length) return errs;

  // Reads, only for a request that is otherwise valid.
  const shown = (req.displayName as string).trim().toLowerCase();
  const taken = (await recordsIn(c)).filter((r) => r.occupancy === 'live' && (r.status === undefined || r.status === 'active'));
  // The records name what each assistant was created or declared as; an active version may have renamed one,
  // which only the names in use read (the same check a rename passes in `manage-profiles`).
  if (taken.some((r) => displayOf(r) === shown) || (await displayNameHolder(ssm, SSM_ROOT, c, req.displayName as string))) {
    errs.push(`an assistant in ${c} already shows the name '${req.displayName}'`);
  }
  return errs;
}

// ── CREATE: validate, take the name, hand off ──────────────────────────────────────────────────────

async function create(
  req: CreateRequest,
  actor: string,
  respond: (c: number, b: unknown) => APIGatewayProxyResult,
  opts: { checkTeam?: boolean; team?: string } = {},
): Promise<APIGatewayProxyResult> {
  const errors = await createErrors(req);
  if (errors.length) return respond(400, { error: 'invalid assistant', errors });
  // A TEAM COPIES ONLY WHAT IT OWNS: another team's assistant is configuration the team cannot open, and a copy
  // would show it to them.
  const startingPoint = startingPointOf(req.startingPoint);
  if (opts.team && startingPoint.kind === 'copy' && !(await ownedBy(opts.team)).has(startingPoint.from)) {
    return respond(403, { error: `the ${opts.team} team does not own '${startingPoint.from}'`, code: 'COPY_SOURCE_NOT_OWNED' });
  }
  // A FILE OR A COPY IS CHECKED BEFORE THE NAME IS TAKEN, by the function that will land it, so one that cannot land
  // is refused here with its reasons rather than becoming a running assistant with no first draft.
  const startErrors = await startingPointCheck(req, startingPoint);
  if (startErrors.length) return respond(400, { error: 'the starting point cannot be used', code: 'STARTING_POINT_REFUSED', errors: startErrors });
  // AN ADMIN NAMES ANY TEAM, so it must be one: an owner tag naming no group is an assistant nobody can
  // reach but admins, presented as owned. A team route's team was proven when its caller's groups were read.
  if (opts.checkTeam && req.ownerTeam && !(await teamExists(req.ownerTeam))) {
    return respond(400, { error: `no team ${req.ownerTeam} exists`, code: 'TEAM_NOT_FOUND' });
  }
  const entry: DirectoryEntry = {
    classification: req.classification,
    role: req.role,
    status: 'provisioning',
    createdAt: new Date().toISOString(),
    createdBy: actor,
    displayName: req.displayName.trim(),
    descriptor: req.descriptor,
    ...(req.ownerTeam ? { ownerTeam: req.ownerTeam } : {}),
  };
  try {
    await putJson(directoryParamName(SSM_ROOT, req.assistantId), entry, false);
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterAlreadyExists') {
      return respond(409, { error: `'${req.assistantId}' is taken; a name is never reused`, code: 'ASSISTANT_NAME_TAKEN' });
    }
    throw err;
  }
  const releaseId = () => ssm.send(new DeleteParameterCommand({ Name: directoryParamName(SSM_ROOT, req.assistantId) })).catch(() => undefined);
  try {
    await putJson(displayNameLockParamName(SSM_ROOT, req.classification, entry.displayName as string), { assistantId: req.assistantId }, false);
  } catch (err) {
    await releaseId();
    if ((err as { name?: string })?.name === 'ParameterAlreadyExists') {
      return respond(409, { error: `an assistant in ${req.classification} already shows the name '${req.displayName}'`, code: 'ASSISTANT_DISPLAY_NAME_TAKEN' });
    }
    throw err;
  }
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({
        op: 'provision', assistantId: req.assistantId, ...(startingPoint.kind !== 'defaults' ? { startingPoint } : {}),
      } satisfies ProvisionRequest)),
    }));
  } catch (err) {
    // Nothing was built, so both names go back.
    await releaseDisplayName(req.assistantId, entry);
    await releaseId();
    throw err;
  }
  audit('create-requested', {
    actor, assistant: req.assistantId, classification: req.classification, role: req.role, startingPoint: startingPoint.kind,
    ...(startingPoint.kind === 'copy' ? { copiedFrom: startingPoint.from } : {}),
  });
  return respond(202, { assistantId: req.assistantId, status: 'provisioning' });
}

/** Release the entry's display-name lock, if this assistant holds it. */
async function releaseDisplayName(assistantId: string, entry: DirectoryEntry): Promise<void> {
  if (!entry.displayName) return;
  const name = displayNameLockParamName(SSM_ROOT, entry.classification, entry.displayName);
  const lock = await readJson<{ assistantId?: string }>(name).catch(() => null);
  if (lock?.assistantId !== assistantId) return;
  await ssm.send(new DeleteParameterCommand({ Name: name })).catch((err) => {
    console.error('[manage-assistants] could not release the display name; it stays taken', { assistantId, error: (err as Error)?.message });
  });
}

// ── PROVISION: the build, asynchronously ───────────────────────────────────────────────────────────

/** A console-created assistant's Lex bot name (`assistant-provisioner-function.ts`). */
export { lexBotNameFor };

/** The identity create's idempotency token, one per create (`assistant-provisioner.ts`). */
export { identityRequestToken };

/** Claim the build. False when another invoke of the same create already holds it. */
async function claimBuild(assistantId: string): Promise<boolean> {
  try {
    await putJson(buildClaimParamName(SSM_ROOT, assistantId), { at: new Date().toISOString() }, false);
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterAlreadyExists') return false;
    throw err;
  }
}

const releaseBuildClaim = (assistantId: string) =>
  ssm.send(new DeleteParameterCommand({ Name: buildClaimParamName(SSM_ROOT, assistantId) })).catch(() => undefined);

/** A failed build, with what the provisioner could not remove after it. */
class BuildFailed extends Error {
  constructor(readonly answer: BuildAnswer) { super(answer.error || 'the build failed'); }
}

export async function provision(assistantId: string, startingPoint?: StartingPoint): Promise<void> {
  const entry = await readDirectoryEntry(ssm, SSM_ROOT, assistantId);
  if (!entry || entry.status !== 'provisioning') {
    console.log('[manage-assistants] nothing to provision', { assistantId, status: entry?.status });
    return;
  }
  if (!(await claimBuild(assistantId))) {
    console.log('[manage-assistants] the build is already claimed; this invoke builds nothing', { assistantId });
    return;
  }
  const { classification, role } = entry;
  const built: { lexBotId?: string; botArn?: string; record?: boolean } = {};
  let active: DirectoryEntry;
  let ownerSeedError: string | undefined;
  try {
    // THE PROVISIONER BUILDS IT, the one principal that builds every assistant. It records each id on the entry as
    // it exists, and removes what it built when the build fails.
    const answer = await askProvisioner<BuildAnswer>({ op: 'build', assistantId });
    if (!answer.ok || !answer.botArn) throw new BuildFailed(answer);
    built.lexBotId = answer.lexBotId;
    built.botArn = answer.botArn;
    const botArn = answer.botArn;

    const record: AssignmentRecord & Record<string, unknown> = {
      classification,
      role,
      occupancy: 'live',
      assistant: assistantId,
      botArn,
      lexBotId: built.lexBotId,
      source: 'runtime',
      status: 'active',
      displayName: entry.displayName,
      descriptor: entry.descriptor,
      ...(entry.ownerTeam ? { ownerTeam: entry.ownerTeam } : {}),
      createdBy: entry.createdBy,
      createdAt: entry.createdAt,
    };
    await putJson(runtimeAssignmentParamName(SSM_ROOT, classification, role, assistantId), record, false);
    built.record = true;
    ownerSeedError = entry.ownerTeam ? await seedOwnership(botArn) : undefined;
    active = {
      ...entry, origin: 'console', status: 'active', botArn, lexBotId: built.lexBotId, ...(ownerSeedError ? { ownerSeedError } : {}),
    };
    // THE LAST STEP THAT CAN FAIL THE BUILD. Once the entry is active the assistant is running, and the provisioner
    // refuses to remove an active assistant, so nothing after this write can undo it or mark it failed.
    await putJson(directoryParamName(SSM_ROOT, assistantId), active, true);
  } catch (err) {
    await recordFailedBuild(assistantId, entry, built, err);
    return;
  }
  // AFTER the entry is active: `manage-profiles` knows a runtime assistant only through an active entry. What fails
  // here is a note on a running assistant, never its status.
  const firstDraftError = await seedFirstDraft(assistantId, entry.createdBy, startingPoint);
  if (firstDraftError) {
    await putJson(directoryParamName(SSM_ROOT, assistantId), { ...active, firstDraftError }, true).catch((e) => {
      console.error('[manage-assistants] could not record why the first draft was not seeded; the assistant is active', { assistantId, firstDraftError, error: (e as Error)?.message });
    });
  }
  audit('created', {
    actor: entry.createdBy, assistant: assistantId, classification, role, botArn: active.botArn, lexBotId: active.lexBotId,
    ...(ownerSeedError ? { ownerSeedError } : {}), ...(firstDraftError ? { firstDraftError } : {}),
  });
}

/**
 * RECORD A BUILD THAT FAILED BEFORE ITS ENTRY WENT ACTIVE, and undo what is left of it. The entry is read again
 * first: the provisioner records each id on it as it builds, so a build whose invoke failed (a timeout, a crash) has
 * ids this function never received, and writing from the copy read before the build would lose them and orphan
 * the Amazon Lex bot and the identity. Ids are never dropped from the entry while anything they name remains.
 */
async function recordFailedBuild(
  assistantId: string, entry: DirectoryEntry, built: { lexBotId?: string; botArn?: string; record?: boolean }, err: unknown,
): Promise<void> {
  const { classification, role } = entry;
  const error = (err as Error)?.message || String(err);
  console.error('[manage-assistants] provision failed; undoing what was built', { assistantId, built, error });
  const current = await readDirectoryEntry(ssm, SSM_ROOT, assistantId).catch(() => null);
  const answer = err instanceof BuildFailed ? err.answer : undefined;
  // ONLY AN ANSWER OF FAILURE WAS UNDONE BY THE PROVISIONER. One that says `ok` but names no identity left whatever
  // it built in place, so it is undone here like a failed invoke, from the ids it answered with.
  const failed = answer && !answer.ok ? answer : undefined;
  const ids = {
    lexBotId: failed ? failed.lexBotId : built.lexBotId ?? answer?.lexBotId ?? current?.lexBotId,
    botArn: failed ? failed.botArn : built.botArn ?? answer?.botArn ?? current?.botArn,
  };
  // A build the provisioner answered as failed was undone by it, which says what it could not remove; anything else
  // (a failed invoke, or a step after the build) is undone here, from every id the build recorded.
  const leftover = failed ? failed.leftover ?? [] : await undo(assistantId, classification, role, { ...ids, record: built.record });
  const { lexBotId: _l, botArn: _b, ...base } = current ?? entry;
  void _l; void _b;
  const kept = { ...(ids.lexBotId ? { lexBotId: ids.lexBotId } : {}), ...(ids.botArn ? { botArn: ids.botArn } : {}) };
  // Recorded as `failed` with its reason even when nothing is left, so the roster says why the
  // assistant does not exist. Retiring it releases the name (`retire`).
  await putJson(directoryParamName(SSM_ROOT, assistantId), {
    ...base, status: 'failed', error, leftover, ...(leftover.length ? kept : {}),
  }, true).catch((e) => {
    console.error('[manage-assistants] could not record the failed build; it reads as abandoned after the build deadline', { assistantId, error: (e as Error)?.message });
  });
  audit('create-failed', { actor: entry.createdBy, assistant: assistantId, classification, role, error, leftover });
}

/** Remove what a provision built before it failed, asking the provisioner for the identity. Returns what is left. */
async function undo(
  assistantId: string, classification: string, role: string, built: { lexBotId?: string; botArn?: string; record?: boolean },
): Promise<string[]> {
  const leftover: string[] = [];
  if (built.record) {
    await ssm.send(new DeleteParameterCommand({ Name: runtimeAssignmentParamName(SSM_ROOT, classification, role, assistantId) }))
      .catch((e) => { if (!isNotFound(e)) leftover.push('assignment record'); });
  }
  if (built.botArn || built.lexBotId) leftover.push(...(await removeIdentity(assistantId, built)).leftover);
  return leftover;
}

/**
 * Ask the provisioner to remove an assistant's identity and its Amazon Lex bot. It removes only ids the assistant's
 * own entry or record carries, and never an active assistant's. An unanswered request is a failure, not "gone".
 */
async function removeIdentity(assistantId: string, ids: { botArn?: string; lexBotId?: string }): Promise<RemoveAnswer> {
  try {
    return await askProvisioner<RemoveAnswer>({
      op: 'remove', assistantId, ...(ids.botArn ? { botArn: ids.botArn } : {}), ...(ids.lexBotId ? { lexBotId: ids.lexBotId } : {}),
    });
  } catch (err) {
    console.error('[manage-assistants][SecurityEvent] the provisioner did not remove the identity', { assistantId, error: (err as Error)?.message });
    return {
      identityGone: !ids.botArn,
      leftover: [...(ids.botArn ? [`identity ${ids.botArn}`] : []), ...(ids.lexBotId ? [`Lex bot ${ids.lexBotId}`] : [])],
    };
  }
}

/**
 * ASK THE PROVISIONER, proving the request is the console's: a claim carrying its digest is written under
 * `{root}/provisioner-claims/console/`, which this function's role alone may write (`lib/provisioner-claim.ts`), and
 * released once the provisioner has answered.
 */
async function askProvisioner<T>(payload: Record<string, unknown> & { op: 'build' | 'remove' }): Promise<T> {
  const { request, release } = await writeClaim(ssm, SSM_ROOT, payload);
  try {
    return await ask<T>(PROVISIONER_FUNCTION_NAME, request, provisionerClient);
  } finally {
    await release();
  }
}

/** Invoke a sibling function synchronously and read its JSON answer. A function error throws. */
async function ask<T>(functionName: string, payload: unknown, client: LambdaClient = lambdaClient): Promise<T> {
  const out = await client.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(payload)) }));
  if (out?.FunctionError) throw new Error(out.FunctionError);
  const text = out?.Payload ? Buffer.from(out.Payload).toString('utf8') : '';
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Ask the ownership function to put the record's `ownerTeam` on the identity. This role cannot write
 * `owner-team`. Non-fatal, because an unowned assistant is reachable by admins alone, which is the
 * fail-closed state, but NOT SILENT: the reason is returned and recorded on the entry, so the roster says
 * why the team that created it cannot open it.
 */
async function seedOwnership(botArn: string): Promise<string | undefined> {
  if (!OWNERSHIP_FUNCTION_NAME) return 'no ownership function is configured';
  try {
    const out = await ask<{ seeded?: Array<{ botArn: string }> }>(OWNERSHIP_FUNCTION_NAME, { op: 'seed', botArn });
    if (Array.isArray(out.seeded) && !out.seeded.some((s) => s.botArn === botArn)) return 'the owner tag was not written';
    return undefined;
  } catch (err) {
    console.error('[manage-assistants][SecurityEvent] could not seed the assistant owner; it stays admins-only', { botArn, error: (err as Error)?.message });
    return (err as Error)?.message || 'the owner tag could not be written';
  }
}

/**
 * Ask `manage-profiles` for the assistant's first draft (`seedFirstDraft` there). Returns why it did not
 * seed, or undefined when it did. Non-fatal: the assistant exists and acts on nothing until a version is
 * activated, and the console's "new version" seeds the same draft.
 */
async function seedFirstDraft(assistantId: string, actor: string | undefined, startingPoint?: StartingPoint): Promise<string | undefined> {
  if (!MANAGE_PROFILES_FUNCTION_NAME) return 'no profile function is configured';
  try {
    const out = await ask<{ seeded?: boolean; reason?: string; error?: string }>(
      MANAGE_PROFILES_FUNCTION_NAME, { aeSeedFirstDraft: { assistant: assistantId, actor, ...(startingPoint ? { startingPoint } : {}) } },
    );
    return out.seeded ? undefined : out.error || out.reason || 'no draft was seeded';
  } catch (err) {
    console.error('[manage-assistants] the first draft could not be seeded', { assistantId, error: (err as Error)?.message });
    return (err as Error)?.message || 'the first draft could not be seeded';
  }
}

/**
 * Why a create's starting point cannot land, asked of `manage-profiles`, the function that lands it: the same import
 * checks a version takes, judged for the classification the create names. Fails closed: a check that cannot run
 * refuses the create rather than building an assistant whose first draft is unknown.
 */
async function startingPointCheck(req: CreateRequest, startingPoint: StartingPoint): Promise<string[]> {
  if (startingPoint.kind === 'defaults') return [];
  if (!MANAGE_PROFILES_FUNCTION_NAME) return ['no profile function is configured to check the starting point'];
  const out = await ask<{ errors?: unknown }>(MANAGE_PROFILES_FUNCTION_NAME, {
    aeCheckStartingPoint: {
      assistant: req.assistantId,
      classification: req.classification,
      startingPoint,
      choices: {
        displayName: req.displayName.trim(),
        modelKey: req.descriptor.modelKey,
        ...(req.descriptor.classifierModelKey ? { classifierModelKey: req.descriptor.classifierModelKey } : {}),
      },
    },
  });
  if (!Array.isArray(out.errors)) return ['the starting point could not be checked'];
  return out.errors.filter((e): e is string => typeof e === 'string');
}

/** Whether a team's group exists, asked of the ownership function (this role reads no directory). */
async function teamExists(team: string): Promise<boolean> {
  if (!OWNERSHIP_FUNCTION_NAME || !TEAM_NAME_PATTERN.test(team)) return false;
  return (await ask<{ exists?: unknown }>(OWNERSHIP_FUNCTION_NAME, { op: 'team-exists', team })).exists === true;
}

/** The assistants the `owner-team` tags say a team owns, asked of the ownership function. */
async function ownedBy(team: string): Promise<Set<string>> {
  if (!OWNERSHIP_FUNCTION_NAME) return new Set();
  const out = await ask<{ assistants?: unknown }>(OWNERSHIP_FUNCTION_NAME, { op: 'owned-by', team });
  return new Set(Array.isArray(out.assistants) ? out.assistants.filter((a): a is string => typeof a === 'string') : []);
}

// ── RETIRE ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Retire in the order that stops it acting first:
 *   1. directory and record → `retiring`, which every reader treats as absent within its 60s cache;
 *   2. the identity is deleted, which is the hard stop: a vended session lives up to an hour but cannot
 *      bear a deleted bot;
 *   3. the Lex bot and the assignment record are deleted;
 *   4. the directory entry becomes a `retired` tombstone. Profile versions are kept as evidence.
 *
 * Channel memberships of the deleted identity remain (DESIGN-SEPARATE-ASSISTANTS section 3.6).
 *
 * A BUILD THAT NEVER FINISHED (`failed`, or `provisioning` past the build deadline) is removed the same
 * way, from the ids the build recorded as it went. When it leaves nothing behind, the name and the
 * display name are released rather than tombstoned: nothing ever answered under them.
 *
 * ONE PATH FOR EVERY ASSISTANT WITH A DIRECTORY ENTRY, declared or created in the console (ADR-048, amended
 * 2026-10-23): a declared assistant's retire is a tombstone its next deploy respects, so a seed never
 * recreates it. Two guards keep a room answerable, and neither reads how the assistant was asked for:
 *   - a classification's primary is refused (`ASSISTANT_IS_PRIMARY`): every room has one, and it is what a
 *     conversation is created for; the admin assistant is the admin plane's primary;
 *   - a duel's alt is refused (`ASSISTANT_IS_ALT`): it exists while its classification wires the duel.
 */
async function retire(assistantId: string, actor: string, reason: string, respond: (c: number, b: unknown) => APIGatewayProxyResult): Promise<APIGatewayProxyResult> {
  if (!ASSISTANT_ID_PATTERN.test(assistantId)) return respond(400, { error: 'invalid assistantId' });
  if (profiles.classificationFor(assistantId)) {
    return respond(409, {
      error: `'${assistantId}' is the ${profiles.classificationFor(assistantId)} classification's primary; a primary is replaced by declaring another, not retired`,
      code: 'ASSISTANT_IS_PRIMARY',
    });
  }
  const stored = await readDirectoryEntry(ssm, SSM_ROOT, assistantId);
  if (profiles.roleOfAlt(assistantId) || stored?.occupancy === 'alt') {
    return respond(409, { error: `'${assistantId}' is a battle's challenger; it is removed with its classification's battle`, code: 'ASSISTANT_IS_ALT' });
  }
  if (!stored) return respond(404, { error: `'${assistantId}' has no directory entry; a declared assistant has one once a deploy seeds it` });
  const entry = withAbandonedBuild(stored);
  if (entry.status === 'retired') return respond(200, { assistantId, status: 'retired', already: true });
  if (entry.status === 'provisioning') return respond(409, { error: `'${assistantId}' is still being created`, code: 'ASSISTANT_PROVISIONING' });
  // Carried across a retire that stopped partway, so finishing it still releases the name.
  const neverAnswered = entry.status === 'failed' || entry.neverAnswered === true;

  const { classification, role } = entry;
  const recordName = runtimeAssignmentParamName(SSM_ROOT, classification, role, assistantId);
  await putJson(directoryParamName(SSM_ROOT, assistantId), { ...entry, status: 'retiring', ...(neverAnswered ? { neverAnswered: true } : {}) }, true);
  const record = await readJson<AssignmentRecord>(recordName);
  if (record) await putJson(recordName, { ...record, status: 'retiring' }, true);

  const botArn = record?.botArn || entry.botArn;
  const lexBotId = record?.lexBotId || entry.lexBotId;
  // THE PROVISIONER REMOVES THE IDENTITY, then the Amazon Lex bot, and stops at an identity it could not remove.
  const removed = botArn || lexBotId ? await removeIdentity(assistantId, { botArn, lexBotId }) : { identityGone: true, leftover: [] };
  if (!removed.identityGone) {
    audit('retire-incomplete', { actor, assistant: assistantId, classification, role, botArn });
    return respond(500, { error: 'the identity could not be deleted; the assistant is retiring and admits no turns', status: 'retiring' });
  }
  // The identity is gone, so a Lex bot left behind serves nobody; it is still recorded on the tombstone
  // rather than passed off as a clean retire.
  const leftover: string[] = [...removed.leftover];
  await ssm.send(new DeleteParameterCommand({ Name: recordName })).catch((err) => { if (!isNotFound(err)) throw err; });
  // The display name is free once the assistant no longer shows it, whichever way it ends.
  await releaseDisplayName(assistantId, entry);
  if (neverAnswered && leftover.length === 0) {
    await releaseBuildClaim(assistantId);
    await ssm.send(new DeleteParameterCommand({ Name: directoryParamName(SSM_ROOT, assistantId) })).catch((err) => { if (!isNotFound(err)) throw err; });
    audit('released', { actor, assistant: assistantId, classification, role, botArn, lexBotId, reason, error: entry.error });
    return respond(200, { assistantId, status: 'released' });
  }
  const retiredAt = new Date().toISOString();
  await putJson(directoryParamName(SSM_ROOT, assistantId), {
    ...entry, status: 'retired', retiredAt, retiredBy: actor, ...(reason ? { reason } : {}), leftover,
  }, true);
  audit('retired', { actor, assistant: assistantId, classification, role, botArn, lexBotId, reason, leftover });
  return respond(200, { assistantId, status: 'retired', retiredAt, ...(leftover.length ? { leftover } : {}) });
}

// ── HANDLER ────────────────────────────────────────────────────────────────────────────────────────

// ── A TEAM'S OWN ROUTE: create for the team, and list what it has created ──────────────────────────

/**
 * Whether the person the signed session names is in the team, asked of the ownership function, which
 * holds the directory reads this role does not. Only this role and the provisioner hold an invoke grant
 * on it (a gateway event never carries `op`), the person comes from the session and never from the body,
 * and the answer is a yes or no that changes nothing. An unanswered question throws, so an outage is a failure rather than a refusal that blames
 * the caller.
 */
async function personIsInTeam(personArn: string, team: string): Promise<boolean> {
  if (!OWNERSHIP_FUNCTION_NAME) return false;
  const out = await lambdaClient.send(new InvokeCommand({
    FunctionName: OWNERSHIP_FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify({ op: 'in-team', personArn, team })),
  }));
  if (out.FunctionError) throw new Error(`the team check failed: ${out.FunctionError}`);
  const answer = JSON.parse(Buffer.from(out.Payload ?? new Uint8Array()).toString() || '{}') as { inTeam?: unknown };
  return answer.inTeam === true;
}

/**
 * `GET`/`POST /admin/teams/{team}/roster`, for a team console session.
 *
 * The session policy names only the caller's own teams; this re-reads their groups, so a session issued
 * before they left a team is caught here. The groups are read by the ownership function
 * (`personIsInTeam`), because this function's own role reads no directory. A create is owned by the
 * route's team whatever the body says (a body naming another team is refused rather than redirected),
 * and lands only in a classification the clearance the exchange named the session with reaches: owning
 * an assistant never raises clearance. The listing is this function's own directory entries for the team,
 * so it reads no identity either.
 */
async function teamRoster(
  api: APIGatewayProxyEvent,
  team: string,
  clearance: string | null,
  actor: string,
  respond: (c: number, b: unknown) => APIGatewayProxyResult,
): Promise<APIGatewayProxyResult> {
  const notYours = () => respond(403, { error: `you are not in team ${team}; a team member creates only for their own teams`, code: 'TEAM_NOT_YOURS' });
  if (!TEAM_NAME_PATTERN.test(team)) return notYours();
  const personArn = await callerPersonArn(api, APP_INSTANCE_ARN);
  if (!personArn || !(await personIsInTeam(personArn, team))) return notYours();
  const cleared = (c: string) => !!clearance && profiles.reaches(clearance, c);

  if (api.httpMethod === 'GET') {
    const [directory, owned] = await Promise.all([listDirectory(ssm, SSM_ROOT), ownedBy(team)]);
    // WHO OWNS AN ASSISTANT IS ITS TAG. An entry whose identity is live is listed by the tag, so an assistant
    // moved to another team leaves this roster; one with no live identity (being built, failed, retired)
    // has no tag to read and is listed under the team it was created for.
    const runtimeAssistants = [...directory]
      .map(([assistant, stored]) => ({ assistant, e: withAbandonedBuild(stored) }))
      // A duel's alt is not on a team's roster: it has no owner and is removed with the duel.
      .filter(({ e }) => e.occupancy !== 'alt')
      .filter(({ assistant, e }) => (e.status === 'active' || e.status === 'retiring' ? owned.has(assistant) : e.ownerTeam === team))
      .map(({ assistant, e }) => ({
        assistant, classification: e.classification, role: e.role, status: e.status,
        origin: e.origin ?? 'console',
        ...(e.displayName ? { displayName: e.displayName } : {}),
        ownerTeam: team,
        ...(e.error ? { error: e.error } : {}),
        ...(e.leftover?.length ? { leftover: e.leftover } : {}),
        ...(e.ownerSeedError ? { ownerSeedError: e.ownerSeedError } : {}),
        ...(e.firstDraftError ? { firstDraftError: e.firstDraftError } : {}),
      }));
    // The same create targets the admin listing offers (`lib/roster-targets.ts`), narrowed to the session's
    // clearance: owning an assistant never raises it.
    return respond(200, { team, runtimeAssistants, rosterTargets: rosterTargets(cleared) });
  }
  if (api.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
  const parsed = parseJsonBody<Record<string, unknown>>(api, api.headers?.origin || api.headers?.Origin);
  if ('statusCode' in parsed) return parsed;
  const body = parsed.body as Partial<CreateRequest>;
  if (body.ownerTeam !== undefined && body.ownerTeam !== team) return notYours();
  if (typeof body.classification === 'string' && !cleared(body.classification)) {
    return respond(403, { error: `your clearance does not reach ${body.classification}`, code: 'CLASSIFICATION_NOT_CLEARED' });
  }
  return create({ ...(body as CreateRequest), ownerTeam: team }, actor, respond, { team });
}

/**
 * `POST /admin/roster/{assistantId}/limits` (admins) and `POST /admin/teams/{team}/roster/{assistantId}/limits`
 * (a team member, for an assistant their team owns): a console-created assistant's turns per hour.
 *
 * The router reads the limit from the assignment record's descriptor (`runtimeSeedFor`), so this writes the
 * record and the directory entry the console lists. A declared assistant's limit is `rateLimitPerHour` in
 * `deploy.config.json` and moves with a deploy; this refuses it. `rateLimitPerHour: null` removes the limit.
 * The team route re-reads the caller's groups and the entry's owner, behind the session policy that names
 * only their own teams (two layers).
 */
async function setTurnLimit(
  api: APIGatewayProxyEvent,
  assistantId: string,
  body: Record<string, unknown>,
  actor: string,
  respond: (c: number, b: unknown) => APIGatewayProxyResult,
  team?: string,
): Promise<APIGatewayProxyResult> {
  if (!ASSISTANT_ID_PATTERN.test(assistantId)) return respond(400, { error: 'invalid assistantId' });
  const limit = body.rateLimitPerHour;
  if (limit !== null && !(typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 100_000)) {
    return respond(400, { error: 'rateLimitPerHour must be a positive integer, or null for no limit', code: 'INVALID_TURN_LIMIT' });
  }
  if (team !== undefined) {
    const personArn = await callerPersonArn(api, APP_INSTANCE_ARN);
    if (!TEAM_NAME_PATTERN.test(team) || !personArn || !(await personIsInTeam(personArn, team))) {
      return respond(403, { error: `you are not in team ${team}`, code: 'TEAM_NOT_YOURS' });
    }
  }
  const entry = await readDirectoryEntry(ssm, SSM_ROOT, assistantId);
  // A DECLARED ASSISTANT'S LIMIT IS ITS PROFILE'S, which the router reads from the registry; a record's
  // descriptor is read for a console-created assistant only (`runtimeSeedFor`), so a write here would be inert.
  if (!entry || entry.origin === 'declared') {
    return respond(409, {
      error: `'${assistantId}' is declared in deploy.config.json; its turns per hour change with a deploy`,
      code: 'TURN_LIMIT_IS_DEPLOYED',
    });
  }
  // Owned by its tag (`ownedBy`), the one record of ownership, not the team it was created for.
  if (team !== undefined && !(await ownedBy(team)).has(assistantId)) {
    return respond(403, { error: `'${assistantId}' is not owned by team ${team}`, code: 'ASSISTANT_NOT_OWNED' });
  }
  if (entry.status !== 'active') return respond(409, { error: `'${assistantId}' is ${entry.status}`, code: 'ASSISTANT_NOT_ACTIVE' });
  const { rateLimitPerHour: _previous, ...rest } = entry.descriptor ?? {};
  void _previous;
  const descriptor = { ...rest, ...(limit !== null ? { rateLimitPerHour: limit as number } : {}) };
  const recordName = runtimeAssignmentParamName(SSM_ROOT, entry.classification, entry.role, assistantId);
  const record = await readJson<AssignmentRecord>(recordName);
  if (!record) return respond(409, { error: `'${assistantId}' has no assignment record`, code: 'ASSISTANT_NOT_ACTIVE' });
  // The record first: it is what the router reads, so a failure between the two leaves the listing stale
  // rather than the limit unenforced.
  await putJson(recordName, { ...record, descriptor }, true);
  await putJson(directoryParamName(SSM_ROOT, assistantId), { ...entry, descriptor }, true);
  audit('turn-limit-changed', { actor, assistant: assistantId, rateLimitPerHour: limit, ...(team ? { team } : {}) });
  return respond(200, { assistantId, rateLimitPerHour: limit });
}

export const handler = async (event: APIGatewayProxyEvent | ProvisionRequest): Promise<APIGatewayProxyResult | void> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if ((event as ProvisionRequest).op === 'provision') {
    return provision((event as ProvisionRequest).assistantId, (event as ProvisionRequest).startingPoint);
  }

  const api = event as APIGatewayProxyEvent;
  const origin = api.headers?.origin || api.headers?.Origin;
  const respond = (code: number, body: unknown) => authRespond(code, body, origin);
  if (api.httpMethod === 'OPTIONS') return respond(200, { ok: true });
  const actor = await callerActor(api);
  if (!actor) return respond(401, { error: 'Unauthorized' });
  if (!callerCanManageAssistants(api)) {
    console.warn('[manage-assistants] caller lacks manage-assistants capability', { actor });
    return respond(403, { error: 'manage-assistants capability required' });
  }
  const path = api.path || '';
  const teamSession = consoleSessionOf((api.requestContext?.identity as { userArn?: string | null } | undefined)?.userArn);
  const teamOfRoute = /\/admin\/teams\/([^/]+)\/roster$/.exec(path);
  const teamLimits = /\/admin\/teams\/([^/]+)\/roster\/([^/]+)\/limits$/.exec(path);
  if (teamLimits) {
    if (teamSession?.kind !== 'team') return respond(403, { error: 'This route is a team member\'s', code: 'TEAM_ROUTE' });
    if (api.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });
    const parsedLimits = parseJsonBody<Record<string, unknown>>(api, origin);
    if ('statusCode' in parsedLimits) return parsedLimits;
    try {
      return await setTurnLimit(api, decodeURIComponent(teamLimits[2]), parsedLimits.body, actor, respond, decodeURIComponent(teamLimits[1]));
    } catch (err) {
      console.error('[manage-assistants] team limit change failed', { path, error: (err as Error)?.message });
      return respond(500, { error: 'manage-assistants failed' });
    }
  }
  if (teamOfRoute || teamSession?.kind === 'team') {
    if (!teamOfRoute || teamSession?.kind !== 'team') {
      return respond(403, teamOfRoute
        ? { error: 'This route is a team member\'s', code: 'TEAM_ROUTE' }
        : { error: 'This route is an administrator\'s; a team creates on its own team route', code: 'ADMIN_ROUTE' });
    }
    try {
      return await teamRoster(api, decodeURIComponent(teamOfRoute[1]), teamSession.clearance, actor, respond);
    } catch (err) {
      console.error('[manage-assistants] team request failed', { path, error: (err as Error)?.message });
      return respond(500, { error: 'manage-assistants failed' });
    }
  }
  if (api.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const parsed = parseJsonBody<Record<string, unknown>>(api, origin);
  if ('statusCode' in parsed) return parsed;
  try {
    const retiring = /\/admin\/roster\/([^/]+)\/retire$/.exec(path);
    if (retiring) {
      const reason = typeof parsed.body.reason === 'string' ? parsed.body.reason.slice(0, 500) : '';
      return await retire(decodeURIComponent(retiring[1]), actor, reason, respond);
    }
    if (/\/admin\/roster$/.test(path)) return await create(parsed.body as unknown as CreateRequest, actor, respond, { checkTeam: true });
    const limits = /\/admin\/roster\/([^/]+)\/limits$/.exec(path);
    if (limits) return await setTurnLimit(api, decodeURIComponent(limits[1]), parsed.body, actor, respond);
    return respond(404, { error: 'Not found' });
  } catch (err) {
    console.error('[manage-assistants] request failed', { path, error: (err as Error)?.message });
    return respond(500, { error: 'manage-assistants failed' });
  }
};
