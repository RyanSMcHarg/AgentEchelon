/**
 * The task SOURCE OF TRUTH, read (and, where a host integration is absent, written) by the AWS CLI.
 *
 * Task e2e assertions belong on the persisted row, not on model prose: a live turn's wording changes
 * from run to run, while `taskState`, `stateHistory` and `status` are what the machine actually did.
 * Three specs had already grown their own copy of the same DynamoDB plumbing (task-state-machine,
 * cross-channel-tasks, and each new branch spec would have been a fourth), so the readers live here
 * and the specs carry only their assertions.
 *
 * The machine definitions below MIRROR `backend/lambda/src/lib/task-state-machines.ts`
 * (DEFAULT_TASK_STATE_MACHINES). They are inlined rather than imported because these specs run from
 * `tests/` with no build step over the Lambda sources; keep them in sync when a machine changes. A
 * spec asserting against a stale copy fails loudly on the edge that moved, which is the intended
 * failure mode.
 *
 * Reads go through the AWS CLI with the run's AWS_PROFILE, exactly like `helpers/test-credentials.ts`
 * and `helpers/drift-backend.ts`.
 */
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const REGION = process.env.AWS_REGION || 'us-east-1';

// ---------------------------------------------------------------------------
// The machines under test (mirrors of the platform defaults)
// ---------------------------------------------------------------------------

export interface MachineStateDef {
  transitions: string[];
  terminal?: 'success' | 'failure' | 'handoff';
  /** Who the step awaits, as a reference. `awaitsUser?: boolean` is the deprecated spelling the
   *  backend still accepts and normalizes to the same thing. */
  awaits?: { party: 'requester' };
  awaitsUser?: boolean;
  resolvedByOneResponse?: boolean;
  delivers?: boolean;
}

export interface Machine {
  initial: string;
  states: Record<string, MachineStateDef>;
}

/** DEFAULT_TASK_STATE_MACHINES.report_generation. */
export const REPORT_GENERATION: Machine = {
  initial: 'collecting_requirements',
  states: {
    collecting_requirements: { transitions: ['drafting_outline'], awaits: { party: 'requester' } },
    // Awaits the requester: the step ends its turn on a question about the outline, and the person's
    // answer is what releases it. Its absence is what cost the report flow its drift protection.
    drafting_outline: { transitions: ['generating'], awaits: { party: 'requester' } },
    generating: { transitions: ['completed', 'revising'], delivers: true },
    revising: { transitions: ['completed', 'generating'], delivers: true },
    completed: { transitions: [], terminal: 'success' },
  },
};

/** DEFAULT_TASK_STATE_MACHINES.place_item. */
export const PLACE_ITEM: Machine = {
  initial: 'collecting',
  states: {
    collecting: { transitions: ['confirming'] },
    confirming: { transitions: ['placed'], awaits: { party: 'requester' }, resolvedByOneResponse: true },
    placed: { transitions: [], terminal: 'success' },
  },
};

export function isDeclaredState(machine: Machine, state: unknown): boolean {
  return typeof state === 'string' && Boolean(machine.states[state]);
}

export function isAuthorizedEdge(machine: Machine, from: unknown, to: unknown): boolean {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return Boolean(machine.states[from]?.transitions.includes(to));
}

// ---------------------------------------------------------------------------
// AWS CLI plumbing
// ---------------------------------------------------------------------------

/** Run the AWS CLI (JSON out) with the run's AWS_PROFILE. Returns null for an empty response. */
export function aws(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 30_000,
    // PYTHONIOENCODING IS NOT OPTIONAL ON WINDOWS. The AWS CLI is Python, and its default console
    // codec is the system ANSI page - so a row containing any non-ASCII character kills the command
    // rather than the read: a task whose transition reason said "generating -> revising" with a real
    // arrow failed with `'charmap' codec can't encode character '→'`, which reads as a broken
    // helper rather than as an encoding default. The task rows this reads are model-authored text, so
    // non-ASCII in them is ordinary, not exceptional.
    env: { ...process.env, AWS_PROFILE, MSYS_NO_PATHCONV: '1', PYTHONIOENCODING: 'utf-8' },
  }).trim();
  return out ? JSON.parse(out) : null;
}

// AWS CLI JSON arguments (--item, --key, --expression-attribute-values) must NOT be inlined as a
// single-quoted string: on Windows execSync runs via cmd.exe, where '...' is not a string delimiter,
// so the inner double quotes are stripped and the JSON arrives mangled ("Expected '='"). Writing the
// JSON to a temp file and passing it as file:// is robust on every platform.
let _tmpDir: string | undefined;
export function jsonArg(obj: unknown): string {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'ae-task-'));
  const f = join(_tmpDir, `arg-${process.hrtime.bigint()}.json`);
  writeFileSync(f, JSON.stringify(obj), 'utf8');
  return `file://${f.replace(/\\/g, '/')}`;
}

/** Minimal DynamoDB attribute-value unmarshaller (S/N/BOOL/NULL/L/M), enough for a task row. */
export function unmarshal(av: any): any {
  if (av == null) return undefined;
  if ('S' in av) return av.S;
  if ('N' in av) return Number(av.N);
  if ('BOOL' in av) return av.BOOL;
  if ('NULL' in av) return null;
  if ('L' in av) return av.L.map(unmarshal);
  if ('M' in av) return Object.fromEntries(Object.entries(av.M).map(([k, v]) => [k, unmarshal(v)]));
  return undefined;
}

export function unmarshalItem(item: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, unmarshal(v)]));
}

/** Cognito `sub` from an id token, which is also the chat AppInstanceUser id (AE convention). */
export function jwtSub(idToken: string): string {
  return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')).sub;
}

/** The AppInstanceUser ARN for a person in the app instance that owns `channelArn`. */
export function userArnForChannel(channelArn: string, sub: string): string {
  return `${channelArn.replace(/\/channel\/.*$/, '')}/user/${sub}`;
}

/** Resolve a shared table name from an explicit env override, else the shared SSM parameter. */
export function resolveTaskTable(kind: 'agent-tasks' | 'user-tasks'): string | null {
  const envKey = kind === 'agent-tasks' ? 'AGENT_TASKS_TABLE' : 'USER_TASKS_TABLE';
  if (process.env[envKey]) return process.env[envKey]!;
  const instance = process.env.E2E_INSTANCE_NAME || process.env.INSTANCE_NAME;
  if (!instance) return null;
  try {
    return aws(`ssm get-parameter --name "/${instance}/shared/tables/${kind}-name"`)?.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}

/**
 * The server-only Channel Context store, resolved by name so a spec is not pinned to one deployment.
 * Null when it is absent.
 */
export function resolveChannelContextTable(): string | null {
  try {
    const names = aws(
      'dynamodb list-tables --query "TableNames[?contains(@, \'ChannelContextTable\')]"',
    ) as string[] | null;
    return names?.[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading a task
// ---------------------------------------------------------------------------

/** A task row as persisted, loosely typed: the assertions name the fields they read. */
export type TaskRow = Record<string, any>;

/** One entry of the append-only transition log. */
export interface HistoryEntry {
  from?: string;
  to?: string;
  at?: string;
  by?: string;
  reason?: string;
  owner?: string;
  ownerFrom?: string;
  ownerTo?: string;
  terminal?: string;
}

/** The source-of-truth row (`agent-tasks`, keyed by taskId + channelArn), or undefined. */
export function readTask(agentTable: string, taskId: string, channelArn: string): TaskRow | undefined {
  const got = aws(
    `dynamodb get-item --table-name "${agentTable}" ` +
      `--key ${jsonArg({ taskId: { S: taskId }, channelArn: { S: channelArn } })}`,
  );
  return got?.Item ? unmarshalItem(got.Item) : undefined;
}

/** The mirror rows in this person's partition, newest first. */
export function readUserTasks(userTable: string, sub: string): TaskRow[] {
  const q = aws(
    `dynamodb query --table-name "${userTable}" ` +
      '--key-condition-expression "userSub = :u" ' +
      `--expression-attribute-values ${jsonArg({ ':u': { S: sub } })}`,
  );
  return ((q?.Items ?? []) as Array<Record<string, any>>)
    .map(unmarshalItem)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

/** Mirror rows of one type opened in one conversation during this run, newest first. */
export function runTasksFor(
  userTable: string,
  sub: string,
  opts: { taskType: string; channelArn?: string; since: number },
): TaskRow[] {
  return readUserTasks(userTable, sub)
    .filter((r) => r.taskType === opts.taskType)
    .filter((r) => (opts.channelArn ? r.channelArn === opts.channelArn : true))
    .filter((r) => new Date(r.createdAt || 0).getTime() >= opts.since);
}

/** The transition log as stored: graph edges, ownership entries and the lifecycle ending together. */
export function historyOf(task: TaskRow | undefined): HistoryEntry[] {
  return Array.isArray(task?.stateHistory) ? (task!.stateHistory as HistoryEntry[]) : [];
}

/**
 * The GRAPH edges only.
 *
 * The log holds three kinds of entry and only one of them is an edge: `reassignTask` appends
 * ownership entries (`ownerFrom`/`ownerTo`, no `from`/`to`) and `updateTaskStatus` appends the
 * lifecycle ending (`terminal`, no `from`/`to`). Reading every entry as an edge is the mistake
 * ADR-024 D3 calls out, and it reports a working task as malformed.
 */
export function graphEdges(task: TaskRow | undefined): HistoryEntry[] {
  return historyOf(task).filter((e) => typeof e.from === 'string' && typeof e.to === 'string');
}

/** Edges rendered as `from->to`, for a failure message that shows the whole path taken. */
export function edgePath(task: TaskRow | undefined): string {
  const edges = graphEdges(task);
  return edges.length ? edges.map((e) => `${e.from}->${e.to}`).join(', ') : '(none)';
}

export function hasEdge(task: TaskRow | undefined, from: string, to: string): boolean {
  return graphEdges(task).some((e) => e.from === from && e.to === to);
}

/** The lifecycle ending entries (`terminal` set), which are not graph edges. */
export function terminalEntries(task: TaskRow | undefined): HistoryEntry[] {
  return historyOf(task).filter((e) => typeof e.terminal === 'string');
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Poll `read` until `done` accepts its value, then return that value; return the LAST value read on
 * timeout so the caller can assert on it and report what it actually saw.
 *
 * A single sample is the defect class this suite has been bitten by: a guard that reads once, while
 * the turn is still an interim placeholder, passes without exercising its intent.
 */
export async function pollFor<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  for (;;) {
    if (done(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await read();
  }
}

// ---------------------------------------------------------------------------
// Writing: the host-side setup a stock AE deployment has no other way to produce
// ---------------------------------------------------------------------------

/**
 * Stamp a plan (title + work items) into the SERVER-ONLY Channel Context store.
 *
 * `domainContext` is written there by `federated-create-conversation`, which is gated on a
 * `federatedUserPoolId` this deployment does not set (the same gap `bilingual-conversations.spec.ts`
 * works around for `userLanguage`). Everything downstream of the store is untouched production code:
 * `assembleHostGrounding` reads it, the router forwards it, and the processor registers the
 * work-item tools on the strength of it (`enableEditTools`).
 */
export function putPlanContext(
  table: string,
  channelArn: string,
  plan: { title: string; items: Array<{ id: string; title: string; status?: string; start?: string; end?: string }> },
): void {
  const items = plan.items.map((it) => ({
    M: {
      id: { S: it.id },
      title: { S: it.title },
      status: { S: it.status ?? 'open' },
      ...(it.start ? { start: { S: it.start } } : {}),
      ...(it.end ? { end: { S: it.end } } : {}),
    },
  }));
  // UPDATE, not PUT. A conversation's context row already exists by the time a test writes to it
  // (creation records the participant shape there), and a whole-item put would silently drop those
  // fields - grounding the turn on a roster the test never meant to change.
  aws(
    `dynamodb update-item --table-name "${table}" ` +
      `--key ${jsonArg({ channelArn: { S: channelArn } })} ` +
      '--update-expression "SET domainContext = :dc, updatedAt = :ts" ' +
      `--expression-attribute-values ${jsonArg({
        ':dc': { M: { title: { S: plan.title }, items: { L: items } } },
        ':ts': { S: new Date().toISOString() },
      })}`,
  );
}

/** Remove only the stamped plan, leaving the rest of the conversation's context row as it was. */
export function clearPlanContext(table: string, channelArn: string): void {
  try {
    aws(
      `dynamodb update-item --table-name "${table}" ` +
        `--key ${jsonArg({ channelArn: { S: channelArn } })} ` +
        '--update-expression "REMOVE domainContext"',
    );
  } catch {
    /* best effort: a leftover plan expires with the conversation and grounds nothing else */
  }
}

export interface SeededTask {
  taskId: string;
  channelArn: string;
  sub: string;
}

/**
 * Open a `place_item` task the way `createTask` would.
 *
 * WHY A SEED RATHER THAN A PROMPT. `place_item` is reached only when the classifier emits a
 * `place_item` intent, which a deployment declares in its intent pack; the platform default pack
 * (the one this deployment runs) declares the five enterprise intents and no work-item ones. The
 * MACHINE is a platform default all the same, and every runtime path that drives it is deployed:
 * the router's resume loop walks `Object.keys(taskStateMachines())`, so it finds this row, and the
 * proposal coupling and the one-response confirm are the shipped code under test.
 *
 * The row mirrors `createTask` + `putMirrorRow` exactly: source of truth keyed by taskId+channelArn,
 * mirror partitioned by the OWNER, which for a machine whose initial state does not await anyone is
 * the requester. No `assistantId`, so the turn is not handed to another assistant.
 */
export function seedPlaceItemTask(args: {
  agentTable: string;
  userTable: string;
  channelArn: string;
  sub: string;
  contextId: string;
  requestExcerpt: string;
}): SeededTask {
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  const userArn = userArnForChannel(args.channelArn, args.sub);

  aws(
    `dynamodb put-item --table-name "${args.agentTable}" --item ${jsonArg({
      taskId: { S: taskId },
      channelArn: { S: args.channelArn },
      userArn: { S: userArn },
      requestExcerpt: { S: args.requestExcerpt },
      status: { S: 'in_progress' },
      deliveryOption: { S: 'TASK_MULTI_STEP' },
      taskType: { S: 'place_item' },
      taskState: { S: PLACE_ITEM.initial },
      details: { M: {} },
      contextId: { S: args.contextId },
      createdAt: { S: now },
      updatedAt: { S: now },
      ttl: { N: String(ttl) },
      ownerId: { S: args.sub },
      ownerType: { S: 'user' },
    })}`,
  );

  aws(
    `dynamodb put-item --table-name "${args.userTable}" --item ${jsonArg({
      userSub: { S: args.sub },
      ownerType: { S: 'user' },
      taskId: { S: taskId },
      taskType: { S: 'place_item' },
      channelArn: { S: args.channelArn },
      status: { S: 'in_progress' },
      taskState: { S: PLACE_ITEM.initial },
      details: { M: {} },
      contextId: { S: args.contextId },
      createdAt: { S: now },
      updatedAt: { S: now },
      ttl: { N: String(ttl) },
    })}`,
  );

  return { taskId, channelArn: args.channelArn, sub: args.sub };
}

/** Remove a seeded task and its mirror row, so a later run's queue reads clean. */
export function deleteSeededTask(
  agentTable: string,
  userTable: string,
  seeded: SeededTask,
): void {
  try {
    aws(
      `dynamodb delete-item --table-name "${agentTable}" ` +
        `--key ${jsonArg({ taskId: { S: seeded.taskId }, channelArn: { S: seeded.channelArn } })}`,
    );
  } catch {
    /* best effort */
  }
  try {
    aws(
      `dynamodb delete-item --table-name "${userTable}" ` +
        `--key ${jsonArg({ userSub: { S: seeded.sub }, taskId: { S: seeded.taskId } })}`,
    );
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Work-item proposals on the wire
// ---------------------------------------------------------------------------

/** The marker the processor emits beside a proposed plan edit (`proposalMarker`). */
const PROPOSAL_MARKER = /<!--proposal:([A-Za-z0-9+/=]+)-->/g;

export interface ProposalPayload {
  op: string;
  args: Record<string, unknown>;
  summary?: string;
}

/**
 * Every work-item proposal carried by a message, decoded.
 *
 * The proposal is the structured signal the `collecting -> confirming` transition couples to, so a
 * spec that wants to know whether the assistant PROPOSED something reads this rather than the prose
 * around it. The chat client renders no confirm card (the widget that does belongs to a host app),
 * which is why this reads the channel wire rather than the DOM.
 */
export function proposalsIn(content: string): ProposalPayload[] {
  const out: ProposalPayload[] = [];
  for (const m of content.matchAll(PROPOSAL_MARKER)) {
    try {
      out.push(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as ProposalPayload);
    } catch {
      /* an undecodable marker is reported by the caller's count, not swallowed into a parse error */
    }
  }
  return out;
}
