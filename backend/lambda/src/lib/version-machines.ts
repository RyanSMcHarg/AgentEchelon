/**
 * THE MACHINES A VERSION RUNS, AND THE MACHINE A TASK FOLLOWS (ADR-066 decisions 1, 2 and 5).
 *
 * A version's intent pack may declare `machines`, keyed by intent. What a version runs is:
 *  - the platform's machines (`PLATFORM_MACHINE_KEYS`), always from `DEFAULT_TASK_STATE_MACHINES`, never from a version;
 *  - the machines the version declares, for every other key it declares;
 *  - the classification's and platform's set (`taskStateMachines()`) for every key the version does not declare, so an
 *    event's own machine (`incident_first_look`) and a reference workflow the version did not copy keep resolving.
 * A version that declares none runs `taskStateMachines()` exactly, which is every version stored before ADR-066.
 *
 * A TASK FOLLOWS THE VERSION IT STARTED ON. A task records that version's `configId` (`Task.originConfigId`), and every
 * reader resolves its machine through `machinesForTask`, so an edit or a rollback never strands a task in a state the new
 * machine lacks. A task with no origin (a row written before ADR-066, a queue task, a workflow step's task) follows
 * `taskStateMachines()`.
 *
 * Versions are immutable by `configId`, so a version's resolved set is cached per `configId` for the container.
 */
import {
  DEFAULT_TASK_STATE_MACHINES,
  PLATFORM_MACHINE_KEYS,
  isPlatformMachineKey,
  type TaskStateMachine,
} from './task-state-machines.js';
import { taskStateMachines } from './intent-pack.js';
import { bodyBucket, bodyKey, getBody, type BodyStoreDeps } from './profile-bodies.js';
import { contentHash12 } from './canonical-json.js';

export type Machines = Record<string, TaskStateMachine>;

/** A version as a machine reader needs it: its id and its pack's `machines`. */
export interface VersionMachinesSource {
  configId?: string;
  intentPack?: { machines?: Record<string, TaskStateMachine> } | null;
}

/** The configId that names no stored version: the compiled seed, which declares no machines. */
const SEED_CONFIG_ID = 'seed';

/** The machines a version's pack declares under its own keys, platform keys left out; undefined when it declares none. */
export function versionDeclaredMachines(pack: VersionMachinesSource['intentPack']): Machines | undefined {
  const declared = pack?.machines;
  if (!declared || typeof declared !== 'object') return undefined;
  const own = Object.entries(declared).filter(([k]) => !isPlatformMachineKey(k));
  return own.length ? Object.fromEntries(own) : undefined;
}

/**
 * The set a version runs over a given base: the version's own machines over the base, then the platform's machines over
 * both. The platform layer is last, so no version and no pack shadows a platform key at runtime.
 */
export function withVersionMachines(base: Readonly<Machines>, pack: VersionMachinesSource['intentPack']): Machines {
  const own = versionDeclaredMachines(pack);
  if (!own) return { ...base };
  const platform = Object.fromEntries(
    PLATFORM_MACHINE_KEYS.filter((k) => DEFAULT_TASK_STATE_MACHINES[k]).map((k) => [k, DEFAULT_TASK_STATE_MACHINES[k]]),
  );
  return { ...base, ...own, ...platform };
}

/** Resolved sets by configId; `null` records a version that declares none, which runs `taskStateMachines()`. */
const byConfigId = new Map<string, Machines | null>();

/**
 * THE MACHINES A VERSION RUNS. `taskStateMachines()` when it declares none; otherwise `withVersionMachines` over it,
 * cached by `configId`. Resolving a version also records it, so a task that started on it resolves through it later.
 */
export function machinesForVersion(version: VersionMachinesSource | null | undefined): Machines {
  const configId = version?.configId && version.configId !== SEED_CONFIG_ID ? version.configId : undefined;
  const own = versionDeclaredMachines(version?.intentPack);
  if (!own) {
    if (configId && !byConfigId.has(configId)) byConfigId.set(configId, null);
    return taskStateMachines();
  }
  const cached = configId ? byConfigId.get(configId) : undefined;
  if (cached) return cached;
  const resolved = withVersionMachines(taskStateMachines(), version?.intentPack);
  if (configId) byConfigId.set(configId, resolved);
  return resolved;
}

/** Record a version this container read, so a task that started on it resolves without another read. */
export function rememberVersionMachines(version: VersionMachinesSource | null | undefined): void {
  if (version?.configId) machinesForVersion(version);
}

/** The configId a task opened on this version records (`Task.originConfigId`); undefined for the compiled seed. */
export function originConfigIdOf(version: { configId?: string } | null | undefined): string | undefined {
  const id = version?.configId;
  return id && id !== SEED_CONFIG_ID ? id : undefined;
}

/**
 * The machine a version declares for a task type it is opening, for the task service to start the task in that
 * machine's initial state. Undefined when the version declares none for that type, so the service resolves it as it
 * always has.
 */
export function declaredMachineFor(version: VersionMachinesSource | null | undefined, taskType: string | undefined): Machines | undefined {
  if (!taskType) return undefined;
  const machine = versionDeclaredMachines(version?.intentPack)?.[taskType];
  return machine ? { [taskType]: machine } : undefined;
}

/**
 * THE MACHINES A TASK FOLLOWS: its origin version's, from what this container has resolved. A task with no origin
 * follows `taskStateMachines()`. A task whose origin this container has not read follows `fallback` (the turn's own
 * version) where the caller has one; `resolveTaskMachines` reads the origin first.
 */
export function machinesForTask(task: TaskWithOrigin | null | undefined, fallback?: Readonly<Machines>): Machines {
  if (task?.originMachine && task.taskType) return machinesOfTask(task, taskStateMachines());
  const origin = task?.originConfigId;
  if (!origin) return taskStateMachines();
  if (byConfigId.has(origin)) return byConfigId.get(origin) ?? taskStateMachines();
  return fallback ? { ...fallback } : taskStateMachines();
}

/** What a reader needs of a task to resolve its machine: its type, its origin, and the machine it started on. */
export interface TaskWithOrigin { taskType?: string; originConfigId?: string; originMachine?: TaskStateMachine }

/**
 * THE MACHINES A TASK MOVES ON, from its own row (ADR-067 stage 2): `base` with the machine the task started on in place
 * of its type's, when its row carries one (`Task.originMachine`). A task with none moves on `base`. The one reader the
 * task service, `/tasks/mine` and the router share, so a card press, a deadline and a continuation read the same steps.
 */
export function machinesOfTask(task: TaskWithOrigin | null | undefined, base: Readonly<Machines>): Machines {
  if (!task?.originMachine || !task.taskType) return { ...base };
  return { ...base, [task.taskType]: task.originMachine };
}

/** Reads a stored version's pack body, the profile body store's `intentPack` under its configId. */
export type VersionPackReader = (profileName: string, configId: string) => Promise<{ found: boolean; pack?: VersionMachinesSource['intentPack'] }>;

/**
 * The stored pack of `profileName`'s version `configId`, from the profile body store. A store that holds no pack body
 * for the version means the version carried none, so it declares no machines. With no store wired the answer is unknown.
 */
export const readStoredVersionPack: VersionPackReader = async (profileName, configId) => {
  const bucket = bodyBucket();
  if (!bucket) return { found: false };
  const raw = await getBody({ key: bodyKey(profileName, configId, 'intentPack'), configId }, configId, { bucket } as BodyStoreDeps);
  if (raw === undefined) return { found: true, pack: undefined };
  return { found: true, pack: JSON.parse(raw) as VersionMachinesSource['intentPack'] };
};

/**
 * THE MACHINES A TASK FOLLOWS, reading its origin version when this container has not: from the profile body store,
 * under the profile that serves the task. A read that fails or cannot answer leaves the task on `fallback`, logged.
 */
export async function resolveTaskMachines(
  task: (TaskWithOrigin & { taskId?: string }) | null | undefined,
  opts: { profileName?: string; fallback?: Readonly<Machines>; read?: VersionPackReader } = {},
): Promise<Machines> {
  if (task?.originMachine && task.taskType) return machinesOfTask(task, opts.fallback ?? taskStateMachines());
  const origin = task?.originConfigId;
  if (origin && !byConfigId.has(origin) && opts.profileName) {
    try {
      const got = await (opts.read ?? readStoredVersionPack)(opts.profileName, origin);
      if (got.found) machinesForVersion({ configId: origin, intentPack: got.pack });
    } catch (err) {
      console.warn("[version-machines] the task's origin version could not be read; it follows the turn's version", {
        taskId: task?.taskId, originConfigId: origin, errName: (err as Error)?.name,
      });
    }
  }
  return machinesForTask(task, opts.fallback);
}

/**
 * THE CONTENT HASH OF THE MACHINE A TASK STARTS ON (ADR-066, "intents in analytics"): the same canonical JSON and hash a
 * version's `configId` is computed with (`contentHash12`), over the machine alone. A version edit that leaves the machine
 * as it was keeps the hash; an edit to the machine changes it, so a workflow change is measured by what each task ran.
 */
export function machineHashOf(machine: TaskStateMachine | undefined): string | undefined {
  return machine ? contentHash12(machine) : undefined;
}

/** Test seam: forget every version this container resolved. */
export function __clearVersionMachines(): void {
  byConfigId.clear();
}
