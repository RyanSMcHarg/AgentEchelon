/**
 * WHAT THE PROVISIONER DOES WITH A DEPLOY'S DECLARATION (ADR-048, amended 2026-10-24).
 *
 * A stack that declares assistants holds one seed custom resource, whose properties are the declaration: the
 * classification, the roles deployed on it, and each declared assistant. The seed is a thin CloudFormation adapter
 * (`seed-declared-assistants.ts`) that invokes the provisioner (`assistant-provisioner-function.ts`, `op:
 * 'seed-declared'`), and the provisioner runs this, on the session of its classification, so the one principal that
 * builds and retires every assistant is the one that builds the declared ones.
 *
 * SEED ONCE. The directory entry (`{root}/assistant-directory/{assistantId}`, `origin: 'declared'`) is the
 * durable record of a seed. A declared assistant with no entry is built; one with an `active` entry is left
 * alone (the console owns it: rename, owner, retire), apart from its declared display name, which the seed carries
 * onto it when the declaration changes it (the lock, the identity's Name unless a profile version named it, and
 * the entry); one `retired` in the console is left retired and
 * reported, so a console retire sticks; one created in the console under the same name, or placed at another
 * classification or role, fails the deploy rather than being taken over; a build that died is removed and built
 * again.
 *
 * A ROLE AND THE ASSISTANTS FILLING IT ARE SEPARATE. A role is infrastructure; an assistant filling it is data. So
 * withdrawing a role removes no assistant: an update that withdraws a role is REFUSED while any assistant
 * (declared or created in the console) still fills it, and the refusal names them and says to retire them in the
 * console first. Once none does, the withdrawal RELEASES each declared assistant of that role that was retired in
 * the console: its tombstone is deleted (with anything its retire left), so declaring the role again seeds a fresh
 * one under the same name. A duel's alt is infrastructure of the duel, not an assistant a person retires, so one
 * whose duel is no longer wired is removed with it.
 *
 * A ROLLBACK IS NOT A WITHDRAWAL. When CloudFormation undoes an update that added a role, the seed says so
 * (`rollback`, read from its stack's status), and the assistants that update built in the role are removed rather
 * than the rollback refused.
 *
 * REMOVING A CLASSIFICATION (the seed's delete) removes every assistant its declaration names, and never fails:
 * what it cannot remove, and any console-created assistant still active in the classification, is logged and
 * reported for the teardown's sweep. The deploy refuses, before anything is deleted, a configuration that drops a
 * classification the console's assistants are still active in.
 *
 * WHAT IT ANSWERS: `PrimaryBotArn`, the identity of the declaration's primary, which the stack publishes as
 * `/assistant/{classification}/bot-arn` (and the admin plane as the admin channel's owner). An ARN read at
 * deploy from the provisioner's answer, never a resource the stack owns.
 */
import { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import {
  directoryParamName,
  runtimeAssignmentParamName,
  buildClaimParamName,
  displayNameLockParamName,
  withAbandonedBuild,
  readDirectoryEntry,
  listDirectory,
  type DirectoryEntry,
} from './runtime-directory.js';
import { buildIdentity, removeBuilt, renameIdentity, type Built, type ProvisionerClients } from './assistant-provisioner.js';
import { assistantsFilling, consoleAssistantsIn } from './role-filling.js';
import { ASSISTANT_ID_PATTERN } from './assistant-acting-policy.js';

/** One declared assistant, as the stack writes it into the seed's properties. */
export interface DeclaredAssistant {
  assistantId: string;
  role: string;
  /** `alt` for a duel's challenger. */
  occupancy: 'live' | 'alt';
  /** The name the identity shows until a version names it otherwise. */
  displayName: string;
  /** False for an identity that stays silent when it joins (an alt, the admin assistant). */
  welcome: boolean;
}

/** The seed's properties. */
export interface Declaration {
  classification: string;
  /** The roles deployed on the classification. */
  roles: string[];
  assistants: DeclaredAssistant[];
}

/** What the seed found or did for one declared assistant. */
export type SeedState = 'built' | 'present' | 'renamed' | 'retired-in-console' | 'rebuilt';

export interface SeedConfig {
  ssm: Pick<SSMClient, 'send'>;
  /** The provisioner's session clients at this declaration's classification. */
  clients: ProvisionerClients;
  /** Seed the declared owner onto a built identity; absent when the assistant declares none. */
  invokeOwnership?: (assistantId: string, botArn: string) => Promise<void>;
  ssmRoot: string;
  region: string;
  account: string;
  appInstanceArn: string;
  classification: string;
  /** The function that fulfills the declared assistants' Amazon Lex turns. */
  fulfillmentArn: string;
  /** The role Amazon Lex runs every assistant's bot as: the provisioner's one Lex bot role. */
  lexBotRoleArn: string;
  logGroupArn?: string;
  /** Prefixes each Amazon Lex bot's name, so two instances in one account never collide. */
  lexBotNamePrefix: string;
  now?: () => Date;
}

/** One CloudFormation event, as the seed's adapter hands it to the provisioner. */
export interface SeedRequest {
  requestType: 'Create' | 'Update' | 'Delete';
  logicalResourceId: string;
  physicalResourceId?: string;
  declaration: Declaration;
  /** The declaration before an update. */
  oldDeclaration?: Declaration;
  /** True when this update is CloudFormation rolling back the one that wrote `oldDeclaration`. */
  rollback?: boolean;
}

export interface SeedResult {
  PhysicalResourceId: string;
  Data: { PrimaryBotArn: string; Summary: string };
}

const isNotFound = (err: unknown): boolean => (err as { name?: string })?.name === 'ParameterNotFound';

/** Check a declaration's shape against the classification it is for. Throws on anything malformed. */
export function checkDeclaration(parsed: unknown, classification: string): Declaration {
  const d = parsed as Declaration;
  if (!d || typeof d !== 'object' || d.classification !== classification) {
    throw new Error(`seed: the declaration names classification '${d?.classification}', and this seed serves '${classification}'`);
  }
  if (!Array.isArray(d.roles) || !Array.isArray(d.assistants) || d.roles.some((r) => typeof r !== 'string')) {
    throw new Error('seed: the declaration needs roles and assistants');
  }
  const seen = new Set<string>();
  for (const a of d.assistants) {
    if (!a || typeof a.assistantId !== 'string' || !ASSISTANT_ID_PATTERN.test(a.assistantId) || a.assistantId.includes('--')) {
      throw new Error(`seed: '${a?.assistantId}' is not an assistant id`);
    }
    if (seen.has(a.assistantId)) throw new Error(`seed: '${a.assistantId}' is declared twice`);
    seen.add(a.assistantId);
    if (!d.roles.includes(a.role)) throw new Error(`seed: '${a.assistantId}' holds role '${a.role}', which ${classification} does not deploy`);
    if (a.occupancy !== 'live' && a.occupancy !== 'alt') throw new Error(`seed: '${a.assistantId}' has occupancy '${a.occupancy}'`);
    if (typeof a.displayName !== 'string' || typeof a.welcome !== 'boolean') throw new Error(`seed: '${a.assistantId}' needs a displayName and welcome`);
  }
  return d;
}

/** The record a declared assistant answers through: a live assistant's own, or its role's alt record. */
export function recordNameOf(ssmRoot: string, classification: string, a: Pick<DeclaredAssistant, 'assistantId' | 'role' | 'occupancy'>): string {
  return a.occupancy === 'alt'
    ? `${ssmRoot}/assistant-assignments/${classification}/${a.role}/alt`
    : runtimeAssignmentParamName(ssmRoot, classification, a.role, a.assistantId);
}

/** An Amazon Lex bot name: letters, digits and single hyphens, at most 100 characters. */
export function lexBotNameOf(prefix: string, assistantId: string, at: Date): string {
  const clean = `${prefix}-${assistantId}`.replace(/[^0-9A-Za-z-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${clean.slice(0, 88)}-${at.getTime().toString(36)}`;
}

async function putJson(cfg: SeedConfig, name: string, value: unknown, overwrite: boolean): Promise<void> {
  await cfg.ssm.send(new PutParameterCommand({ Name: name, Value: JSON.stringify(value), Type: 'String', Overwrite: overwrite }));
}

async function readJson<T>(cfg: SeedConfig, name: string): Promise<T | null> {
  try {
    const res = await cfg.ssm.send(new GetParameterCommand({ Name: name }));
    return res?.Parameter?.Value ? JSON.parse(res.Parameter.Value) as T : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

const deleteParam = async (cfg: SeedConfig, name: string): Promise<void> => {
  await cfg.ssm.send(new DeleteParameterCommand({ Name: name })).catch((err) => { if (!isNotFound(err)) throw err; });
};

/**
 * Remove one declared assistant entirely: its identity, its Amazon Lex bot, its record, its display-name lock and
 * its directory entry. Only an entry this declaration owns (`origin: 'declared'`, this classification). For a
 * tombstone (retired in the console) the identity and Lex bot are already gone, so this releases the name. Returns
 * what could not be removed; never throws for a removal it could not finish.
 */
export async function removeDeclared(cfg: SeedConfig, a: Pick<DeclaredAssistant, 'assistantId' | 'role' | 'occupancy'>): Promise<string[]> {
  const entry = await readDirectoryEntry(cfg.ssm as SSMClient, cfg.ssmRoot, a.assistantId).catch(() => null);
  if (!entry || entry.origin !== 'declared' || entry.classification !== cfg.classification) return [];
  // A RETIRED ENTRY'S IDENTITY AND LEX BOT WERE REMOVED AT RETIRE, apart from what the retire recorded as leftover,
  // so the release retries only that. A removed resource carries no tags, and the provisioner's tag-scoped grant
  // answers a request for it as not authorized rather than not found, so a second delete cannot confirm it gone.
  const retiredLeft = entry.status === 'retired' ? (entry.leftover ?? []) : undefined;
  const leftover = await removeBuilt(cfg.clients, cfg.appInstanceArn, retiredLeft
    ? {
      ...(retiredLeft.some((l) => l.startsWith('identity ')) ? { botArn: entry.botArn } : {}),
      ...(retiredLeft.some((l) => l.startsWith('Lex bot ')) ? { lexBotId: entry.lexBotId } : {}),
    }
    : { botArn: entry.botArn, lexBotId: entry.lexBotId });
  const recordName = recordNameOf(cfg.ssmRoot, cfg.classification, { ...a, occupancy: entry.occupancy ?? a.occupancy });
  try {
    const record = await readJson<{ botArn?: string }>(cfg, recordName);
    // An alt's record is shared with an experiment's writes; it is this identity's only while it names it.
    if (record && (!entry.botArn || !record.botArn || record.botArn === entry.botArn)) await deleteParam(cfg, recordName);
    if (entry.displayName) {
      const lockName = displayNameLockParamName(cfg.ssmRoot, cfg.classification, entry.displayName);
      const lock = await readJson<{ assistantId?: string }>(cfg, lockName);
      if (lock?.assistantId === a.assistantId) await deleteParam(cfg, lockName);
    }
    await deleteParam(cfg, buildClaimParamName(cfg.ssmRoot, a.assistantId));
    if (leftover.length) {
      // What could not be removed stays on the entry, so the console says what is left and retire can finish it.
      await putJson(cfg, directoryParamName(cfg.ssmRoot, a.assistantId), { ...entry, status: 'failed', error: 'removed with its declaration', leftover }, true);
    } else {
      await deleteParam(cfg, directoryParamName(cfg.ssmRoot, a.assistantId));
    }
  } catch (err) {
    leftover.push(`records (${(err as Error)?.message || err})`);
  }
  console.log(JSON.stringify({ _audit: 'seed-declared-assistants', action: entry.status === 'retired' ? 'released' : 'removed', assistant: a.assistantId, classification: cfg.classification, leftover }));
  return leftover;
}

/** Build one declared assistant from nothing. Removes what it built and throws when the build fails. */
async function build(cfg: SeedConfig, a: DeclaredAssistant): Promise<DirectoryEntry> {
  const at = (cfg.now ?? (() => new Date()))();
  const entry: DirectoryEntry = {
    classification: cfg.classification,
    role: a.role,
    origin: 'declared',
    ...(a.occupancy === 'alt' ? { occupancy: 'alt' as const } : {}),
    status: 'provisioning',
    createdAt: at.toISOString(),
    createdBy: 'deploy',
    displayName: a.displayName,
  };
  const name = directoryParamName(cfg.ssmRoot, a.assistantId);
  // THE NAME IS TAKEN FIRST, as the console's create takes it, so a console create racing this seed loses.
  await putJson(cfg, name, entry, false);
  const built: Built = {};
  const checkpoint = () => putJson(cfg, name, { ...entry, ...built }, true);
  try {
    await buildIdentity(cfg.clients, {
      assistantId: a.assistantId,
      classification: cfg.classification,
      role: a.role,
      displayName: a.displayName,
      createdAt: entry.createdAt,
      lexBotName: lexBotNameOf(cfg.lexBotNamePrefix, a.assistantId, at),
      description: `Declared assistant ${a.assistantId} (${cfg.classification}, ${a.role}${a.occupancy === 'alt' ? ', alt' : ''})`,
      lexBotRoleArn: cfg.lexBotRoleArn,
      fulfillmentArn: cfg.fulfillmentArn,
      logGroupArn: cfg.logGroupArn,
      appInstanceArn: cfg.appInstanceArn,
      region: cfg.region,
      account: cfg.account,
      welcome: a.welcome,
    }, built, checkpoint);
    const record = a.occupancy === 'alt'
      ? {
        // NO ASSISTANT BETWEEN BATTLES: an experiment names the alt as the occupant for its life and clears it
        // after (`admin-experiments.ts`), keeping every other field. The vend serves no session for a record with
        // no assistant.
        classification: cfg.classification, role: a.role, occupancy: 'alt', assistant: null,
        botArn: built.botArn, lexBotId: built.lexBotId, source: 'declared',
      }
      : {
        classification: cfg.classification, role: a.role, occupancy: 'live', assistant: a.assistantId,
        botArn: built.botArn, lexBotId: built.lexBotId, source: 'declared', status: 'active', displayName: a.displayName,
      };
    await putJson(cfg, recordNameOf(cfg.ssmRoot, cfg.classification, a), record, true);
    // The display name a live assistant shows is locked in its classification, as a console create locks it.
    if (a.occupancy === 'live' && a.displayName) {
      await putJson(cfg, displayNameLockParamName(cfg.ssmRoot, cfg.classification, a.displayName), { assistantId: a.assistantId }, false)
        .catch((err) => {
          console.warn('[seed-declared-assistants] the display name is already locked; the declaration keeps it', {
            assistant: a.assistantId, error: (err as Error)?.name,
          });
        });
    }
    // Its declared owner, from the deployment's profile, onto the identity. Non-fatal: an unowned assistant is
    // reachable by admins alone, which is the fail-closed state, and the admin backend's deploy seeds owners again.
    if (cfg.invokeOwnership && built.botArn) await cfg.invokeOwnership(a.assistantId, built.botArn).catch(() => undefined);
    const active: DirectoryEntry = { ...entry, status: 'active', botArn: built.botArn, lexBotId: built.lexBotId };
    await putJson(cfg, name, active, true);
    return active;
  } catch (err) {
    const leftover = await removeBuilt(cfg.clients, cfg.appInstanceArn, built);
    if (leftover.length) {
      await putJson(cfg, name, { ...entry, ...built, status: 'failed', error: (err as Error)?.message, leftover }, true).catch(() => undefined);
    } else {
      await deleteParam(cfg, name).catch(() => undefined);
    }
    throw new Error(`seed: '${a.assistantId}' could not be built: ${(err as Error)?.message || err}${leftover.length ? `; left: ${leftover.join(', ')}` : ''}`);
  }
}

/**
 * Carry a declaration's new display name onto an active declared assistant: the name lock, the identity's Name
 * and the directory entry. The new name is locked first, so a name another assistant shows in the classification
 * is refused before anything changes. The Amazon Lex bot, the record and the role are what they were. Every step
 * reads what is there before it writes, so a seed that stopped partway finishes on the next.
 */
async function reconcileDisplayName(cfg: SeedConfig, a: DeclaredAssistant, entry: DirectoryEntry): Promise<DirectoryEntry> {
  const from = entry.displayName ?? '';
  const oldLock = from ? displayNameLockParamName(cfg.ssmRoot, cfg.classification, from) : undefined;
  const newLock = displayNameLockParamName(cfg.ssmRoot, cfg.classification, a.displayName);
  const locks = a.occupancy === 'live' && newLock !== oldLock;
  let tookLock = false;
  if (locks) {
    tookLock = await putJson(cfg, displayNameLockParamName(cfg.ssmRoot, cfg.classification, a.displayName), { assistantId: a.assistantId }, false).then(() => true, (err) => {
      if ((err as { name?: string })?.name === 'ParameterAlreadyExists') return false;
      throw err;
    });
    const holder = tookLock ? a.assistantId : (await readJson<{ assistantId?: string }>(cfg, newLock))?.assistantId;
    if (holder !== a.assistantId) {
      throw new Error(`seed: '${a.assistantId}' is declared as '${a.displayName}', which ${holder ?? 'another assistant'} shows in ${cfg.classification}; declare another name`);
    }
  }
  let identity: Awaited<ReturnType<typeof renameIdentity>> = 'unchanged';
  const renamed: DirectoryEntry = { ...entry, displayName: a.displayName };
  try {
    if (entry.botArn) identity = await renameIdentity(cfg.clients, entry.botArn, from || a.assistantId, a.displayName);
    await putJson(cfg, directoryParamName(cfg.ssmRoot, a.assistantId), renamed, true);
  } catch (err) {
    // A rename that did not land releases the name this run locked, so the stack's rollback leaves it free.
    if (tookLock) await deleteParam(cfg, newLock).catch(() => undefined);
    throw new Error(`seed: '${a.assistantId}' could not be renamed to '${a.displayName}': ${(err as Error)?.message || err}`);
  }
  if (locks && oldLock) {
    const held = await readJson<{ assistantId?: string }>(cfg, oldLock);
    if (held?.assistantId === a.assistantId) await deleteParam(cfg, oldLock);
  }
  console.log(JSON.stringify({ _audit: 'seed-declared-assistants', action: 'renamed', assistant: a.assistantId, classification: cfg.classification, from, to: a.displayName, identity }));
  return renamed;
}

/** Seed one declared assistant: build it, leave it, carry a new display name onto it, or report it retired. */
export async function seedOne(cfg: SeedConfig, a: DeclaredAssistant): Promise<{ state: SeedState; entry: DirectoryEntry }> {
  const stored = await readDirectoryEntry(cfg.ssm as SSMClient, cfg.ssmRoot, a.assistantId);
  if (!stored) return { state: 'built', entry: await build(cfg, a) };
  if (stored.origin !== 'declared') {
    throw new Error(`seed: '${a.assistantId}' is an assistant created in the console; a declaration cannot take its name. Declare another name, or retire it and choose another`);
  }
  if (stored.classification !== cfg.classification || stored.role !== a.role || (stored.occupancy ?? 'live') !== a.occupancy) {
    throw new Error(`seed: '${a.assistantId}' is seeded at ${stored.classification}/${stored.role}${stored.occupancy === 'alt' ? '/alt' : ''}, and declared at ${cfg.classification}/${a.role}${a.occupancy === 'alt' ? '/alt' : ''}; withdraw its old role first`);
  }
  const entry = withAbandonedBuild(stored, (cfg.now ?? (() => new Date()))().getTime());
  if (entry.status === 'active') {
    if (!a.displayName || a.displayName === entry.displayName) return { state: 'present', entry };
    return { state: 'renamed', entry: await reconcileDisplayName(cfg, a, entry) };
  }
  if (entry.status === 'retired' || entry.status === 'retiring') return { state: 'retired-in-console', entry };
  if (entry.status === 'provisioning') throw new Error(`seed: '${a.assistantId}' is still being built by an earlier seed`);
  // A BUILD THAT DIED: remove what it recorded, then build again.
  const leftover = await removeDeclared(cfg, a);
  if (leftover.length) throw new Error(`seed: '${a.assistantId}' failed earlier and what it left could not be removed: ${leftover.join(', ')}`);
  return { state: 'rebuilt', entry: await build(cfg, a) };
}

/** The roles an update withdraws: deployed before, and not now. */
export function withdrawnRoles(before: Declaration | undefined, after: Declaration): string[] {
  if (!before) return [];
  return before.roles.filter((r) => !after.roles.includes(r));
}

/** A duel's alts an update withdraws with the duel: declared before, and their role's duel no longer wired. */
export function withdrawnAlts(before: Declaration | undefined, after: Declaration): DeclaredAssistant[] {
  if (!before) return [];
  const altRoles = new Set(after.assistants.filter((a) => a.occupancy === 'alt').map((a) => a.role));
  const now = new Set(after.assistants.map((a) => a.assistantId));
  return before.assistants.filter((a) => a.occupancy === 'alt' && !now.has(a.assistantId) && !altRoles.has(a.role));
}

/** Who still fills a role, and which console-created assistants are active in a classification: one rule, shared with `add-assistant-role`. */
export { assistantsFilling, consoleAssistantsIn };

/** The refusal of a role withdrawal, naming who still fills it, or null when nobody does. */
export function roleWithdrawalRefusal(classification: string, role: string, fillers: string[]): string | null {
  if (!fillers.length) return null;
  return `seed: the ${role} role cannot be withdrawn from ${classification} while ${fillers.length === 1 ? 'an assistant fills' : 'assistants fill'} it: `
    + `${fillers.join(', ')}. A role and the assistants filling it are separate: retire ${fillers.length === 1 ? 'it' : 'them'} in the console first `
    + '(Assistants, Retire on the row, with a reason), then withdraw the role again';
}

/**
 * A DELETE: the classification is being removed (or the create that seeded it rolled back), or, for a declaration of
 * alts alone, the duel is withdrawn. It NEVER FAILS: a stack being deleted must be able to finish, so every declared
 * assistant is removed that can be, and what cannot (and any console-created assistant still active in the
 * classification, which no seed removes) is logged and reported, for the teardown's sweep to remove. Refusing a
 * classification's removal while the console's assistants are active in it is the deploy's check, before anything
 * is deleted (`scripts/lib/declared-assistants.cjs`), never this one's.
 */
async function seedDelete(cfg: SeedConfig, declaration: Declaration, physicalId: string): Promise<SeedResult> {
  const unremoved: Record<string, string[]> = {};
  for (const a of declaration.assistants) {
    try {
      const leftover = await removeDeclared(cfg, a);
      if (leftover.length) unremoved[a.assistantId] = leftover;
    } catch (err) {
      unremoved[a.assistantId] = [(err as Error)?.message || String(err)];
    }
  }
  let consoleLeft: string[] = [];
  if (declaration.assistants.some((a) => a.occupancy === 'live')) {
    consoleLeft = await listDirectory(cfg.ssm as SSMClient, cfg.ssmRoot)
      .then((d) => consoleAssistantsIn(d, cfg.classification))
      .catch((err) => [`the directory could not be read (${(err as Error)?.message || err})`]);
  }
  if (Object.keys(unremoved).length || consoleLeft.length) {
    console.error('[seed-declared-assistants] the classification is removed with assistants left; the teardown sweep removes them', {
      classification: cfg.classification, unremoved, consoleCreatedStillActive: consoleLeft,
    });
  }
  console.log(JSON.stringify({ _audit: 'seed-declared-assistants', action: 'removed-declaration', classification: cfg.classification, unremoved, consoleLeft }));
  return { PhysicalResourceId: physicalId, Data: { PrimaryBotArn: '', Summary: JSON.stringify({ unremoved, consoleCreatedStillActive: consoleLeft }) } };
}

/** The seed's whole run for one CloudFormation event. */
export async function seed(cfg: SeedConfig, req: SeedRequest): Promise<SeedResult | Record<string, never>> {
  // STABLE FOR THE RESOURCE'S LIFE, so an update never reads as a replacement (which would delete the old one and
  // with it every assistant it declared), and distinct per declaration on the same seed.
  const physicalId = req.physicalResourceId || `declared-assistants-${cfg.classification}-${req.logicalResourceId}`;
  const declaration = checkDeclaration(req.declaration, cfg.classification);
  if (req.requestType === 'Delete') return seedDelete(cfg, declaration, physicalId);
  const before = req.requestType === 'Update' && req.oldDeclaration
    ? (() => { try { return checkDeclaration(req.oldDeclaration, cfg.classification); } catch { return undefined; } })()
    : undefined;

  // A ROLE IS WITHDRAWN ONLY ONCE NO ASSISTANT FILLS IT, checked before anything is built or removed. A ROLLBACK is
  // not a withdrawal: CloudFormation is undoing the update that added the role, so the assistants that update built
  // are removed below rather than refused, and the rollback completes.
  const withdrawn = withdrawnRoles(before, declaration);
  if (withdrawn.length) {
    const directory = await listDirectory(cfg.ssm as SSMClient, cfg.ssmRoot);
    const at = (cfg.now ?? (() => new Date()))().getTime();
    if (req.rollback) {
      const consoleFilling = withdrawn.flatMap((r) => assistantsFilling(directory, cfg.classification, r, at))
        .filter((n) => directory.get(n)?.origin !== 'declared');
      if (consoleFilling.length) {
        console.error('[seed-declared-assistants] a rollback withdraws a role assistants created in the console fill; they are left for an admin to retire', {
          classification: cfg.classification, roles: withdrawn, assistants: consoleFilling,
        });
      }
    } else {
      const refusals = withdrawn.map((r) => roleWithdrawalRefusal(cfg.classification, r, assistantsFilling(directory, cfg.classification, r, at)))
        .filter((m): m is string => !!m);
      if (refusals.length) throw new Error(refusals.join('; '));
    }
  }

  const states: Record<string, SeedState> = {};
  const builtThisRun: DeclaredAssistant[] = [];
  let primaryBotArn = '';
  try {
    for (const a of declaration.assistants) {
      const { state, entry } = await seedOne(cfg, a);
      states[a.assistantId] = state;
      if (state === 'built' || state === 'rebuilt') builtThisRun.push(a);
      if (a.occupancy === 'live' && a.role === 'primary') {
        if (!entry.botArn || entry.status !== 'active') throw new Error(`seed: the primary '${a.assistantId}' has no active identity`);
        primaryBotArn = entry.botArn;
      }
    }
  } catch (err) {
    // A FAILED SEED REMOVES WHAT THIS RUN BUILT, so the rollback leaves no identity nothing declares.
    for (const a of builtThisRun) await removeDeclared(cfg, a).catch(() => undefined);
    throw err;
  }
  // A WITHDRAWN ROLE RELEASES its declared assistants that were retired in the console (no active one is left: that
  // was refused above), so declaring the role again seeds a fresh one under the same name. In a rollback the active
  // ones go too: they are what the update being undone built.
  const released = (before?.assistants ?? []).filter((a) => a.occupancy === 'live' && withdrawn.includes(a.role));
  for (const a of [...released, ...withdrawnAlts(before, declaration)]) {
    const leftover = await removeDeclared(cfg, a);
    if (leftover.length) console.error('[seed-declared-assistants] a withdrawn assistant could not be removed whole', { assistant: a.assistantId, leftover });
  }
  const retired = Object.entries(states).filter(([, s]) => s === 'retired-in-console').map(([n]) => n);
  for (const n of retired) console.log(`[seed-declared-assistants] ${n} is declared, but retired in the console; a deploy does not recreate it`);
  console.log(JSON.stringify({ _audit: 'seed-declared-assistants', action: 'seeded', classification: cfg.classification, states }));
  return { PhysicalResourceId: physicalId, Data: { PrimaryBotArn: primaryBotArn, Summary: JSON.stringify(states) } };
}
