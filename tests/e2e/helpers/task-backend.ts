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
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { personIdOf } from './person';
import { aws } from './aws';
import { noteProgress, trackConversation } from './watchdog/current';

export { aws };

// ---------------------------------------------------------------------------
// The machines under test (mirrors of the platform defaults)
// ---------------------------------------------------------------------------

export interface MachineStateDef {
  transitions: string[];
  terminal?: 'success' | 'failure' | 'handoff';
  /** A terminal state's declared reopen targets: where a finished task returns when its requester asks
   *  for changes. */
  reopens?: string[];
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
    // Terminal, and revisable: a change asked for after delivery reopens it into `revising`.
    completed: { transitions: [], terminal: 'success', reopens: ['revising'] },
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

/** A declared reopen: `from` is a terminal state listing `to` in `reopens`. */
export function isReopenEdge(machine: Machine, from: unknown, to: unknown): boolean {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  const def = machine.states[from];
  return Boolean(def && def.transitions.length === 0 && def.reopens?.includes(to));
}

/** An ordinary declared transition, or a declared reopen out of a terminal state. */
export function isAuthorizedEdge(machine: Machine, from: unknown, to: unknown): boolean {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return Boolean(machine.states[from]?.transitions.includes(to)) || isReopenEdge(machine, from, to);
}

// ---------------------------------------------------------------------------
// AWS CLI plumbing
// ---------------------------------------------------------------------------

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

/** Resolve a shared table name from an explicit env override, else the shared SSM parameter. */
/**
 * The report a classification offers its own audience, read from the deployed welcome orientation
 * (`/<instance>/assistant/<classification>/welcome-orientation`, the suggestions a person sees on a new
 * conversation): the example that opens with "Compile", which the intent pack classifies as
 * report_generation.
 *
 * A report task is scoped to the classification it runs in. A premium report draws on context a basic
 * one cannot reach and is written for a different reader, so each classification asks for its own rather than all
 * of them sharing one prompt. The shared one these specs used ("monorepo vs multi-repo") was declined as
 * out of scope by the basic and premium personas, so no task opened and nothing past the opening turn
 * was tested on those classifications.
 *
 * Throws rather than falling back: a deployment without the orientation has not said what its classification
 * offers, and a guessed prompt would test a request nobody there makes.
 *
 * No basic: basic cannot hand over a document (`richProcessor: false`), so it offers no report and
 * its intent pack carries no `report_generation`. Its "Compile ..." suggestion is an inline overview.
 */
export function reportPromptForClassification(classification: 'standard' | 'premium'): string {
  const instance = process.env.E2E_INSTANCE_NAME || process.env.INSTANCE_NAME;
  if (!instance) throw new Error('E2E_INSTANCE_NAME must be set to read the classification welcome orientation');
  const name = `/${instance}/assistant/${classification}/welcome-orientation`;
  const raw = aws(`ssm get-parameter --name "${name}"`)?.Parameter?.Value;
  if (!raw) throw new Error(`${name} is missing: it is where the ${classification} classification states what it offers`);
  const examples: unknown[] = JSON.parse(raw).examples ?? [];
  const prompt = examples.find((e): e is string => typeof e === 'string' && /^compile\b/i.test(e));
  if (!prompt) {
    throw new Error(`${name} offers no "Compile ..." example, so the ${classification} classification names no report: ${JSON.stringify(examples)}`);
  }
  return prompt;
}

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
  /** Set on a declared reopen edge out of a terminal state. */
  reopen?: boolean;
}

/** The source-of-truth row (`agent-tasks`, keyed by taskId + channelArn), or undefined. */
export function readTask(agentTable: string, taskId: string, channelArn: string): TaskRow | undefined {
  const got = aws(
    `dynamodb get-item --table-name "${agentTable}" ` +
      `--key ${jsonArg({ taskId: { S: taskId }, channelArn: { S: channelArn } })}`,
  );
  return got?.Item ? unmarshalItem(got.Item) : undefined;
}

/**
 * Every task row in one conversation, open or not, from the source-of-truth table's channel index
 * (`channelArn-updatedAt-index`, the index `task-tracking.ts` lists a conversation's tasks by).
 *
 * The authority for "which task is this assistant running here": a row names its `assistantId`. A
 * message's Metadata is not, because `activeTask` is shed first under the Chime Metadata cap when the
 * reply also carries an attachment.
 */
export function channelTasks(agentTable: string, channelArn: string): TaskRow[] {
  const q = aws(
    `dynamodb query --table-name "${agentTable}" --index-name channelArn-updatedAt-index `
      + '--key-condition-expression "channelArn = :c" '
      + `--expression-attribute-values ${jsonArg({ ':c': { S: channelArn } })}`,
  );
  return ((q?.Items ?? []) as Array<Record<string, any>>).map(unmarshalItem);
}

/** The mirror rows in this person's partition, newest first. */
export function readUserTasks(userTable: string, personId: string): TaskRow[] {
  const q = aws(
    `dynamodb query --table-name "${userTable}" ` +
      '--key-condition-expression "principalId = :u" ' +
      `--expression-attribute-values ${jsonArg({ ':u': { S: personId } })}`,
  );
  return ((q?.Items ?? []) as Array<Record<string, any>>)
    .map(unmarshalItem)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

/** Mirror rows of one type opened in one conversation during this run, newest first. */
export function runTasksFor(
  userTable: string,
  personId: string,
  opts: { taskType: string; channelArn?: string; since: number },
): TaskRow[] {
  return readUserTasks(userTable, personId)
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

/** A comparable form of a read's answer, to tell a changed answer from a repeated one. */
function fingerprint(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Name every conversation a read mentions, so the backend lines about it count as the test's progress. */
function trackChannelsIn(text: string): void {
  for (const arn of new Set(text.match(/arn:aws:chime:[^"\\\s]+?\/channel\/[0-9a-f-]+/g) ?? [])) trackConversation(arn);
}

/**
 * Poll `read` until `done` accepts its value, then return that value; return the LAST value read on
 * timeout so the caller can assert on it and report what it actually saw.
 *
 * A single sample is the defect class this suite has been bitten by: a guard that reads once, while
 * the turn is still an interim placeholder, passes without exercising its intent.
 *
 * FOR STATE WITH NO EVENT THE RUNNER CAN SUBSCRIBE TO: a task row, a schedule, an archive projection. A wait on a
 * room's messages has one, and takes `roomMessagesUntil` (`event-run-messages.ts`) instead.
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
  let seen = fingerprint(last);
  trackChannelsIn(seen);
  for (;;) {
    if (done(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await read();
    // A read whose answer CHANGED is progress, and tells the stall detector so; one that keeps answering the
    // same is a wait, which the detector is right to end once its window passes with nothing else heard.
    const now = fingerprint(last);
    if (now !== seen) {
      noteProgress('harness', `pollFor read changed: ${now.slice(0, 100)}`);
      trackChannelsIn(now);
    }
    seen = now;
  }
}

// ---------------------------------------------------------------------------
// Writing: the host-side setup a stock AE deployment has no other way to produce
// ---------------------------------------------------------------------------

/**
 * Stamp a plan (title + work items) into the SERVER-ONLY Channel Context store.
 *
 * `domainContext` is written there by the context create, which a one-conversation issuer's people
 * reach and this deployment's trusted-issuer registry does not declare (the same gap `bilingual-conversations.spec.ts`
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
  personId: string;
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
  /** The requester's AppInstanceUser, from `helpers/person.ts`. */
  personArn: string;
  contextId: string;
  requestExcerpt: string;
}): SeededTask {
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  const userArn = args.personArn;
  const personId = personIdOf(userArn);

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
      ownerId: { S: personId },
      ownerType: { S: 'user' },
      ownerPersonId: { S: personId },
    })}`,
  );

  aws(
    `dynamodb put-item --table-name "${args.userTable}" --item ${jsonArg({
      principalId: { S: personId },
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

  return { taskId, channelArn: args.channelArn, personId };
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
        `--key ${jsonArg({ principalId: { S: seeded.personId }, taskId: { S: seeded.taskId } })}`,
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
