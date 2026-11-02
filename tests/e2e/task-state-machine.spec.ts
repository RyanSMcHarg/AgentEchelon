/**
 * Task machine-state persistence e2e (SPEC-TASK-STATE-TRANSITIONS §6/§8 — the #7 deploy gate).
 *
 * Anchors on the SOURCE OF TRUTH, not a response-text heuristic: after driving a report task, it reads
 * the persisted `agent-tasks` row straight from DynamoDB and asserts the machine invariants that the
 * new tool-driven design guarantees —
 *   1. `taskState` is a DECLARED state of the report_generation machine (state is persisted + valid);
 *   2. `stateHistory` (the §6 append-only log), if present, is well-formed — every entry is
 *      tool/system-authored and every edge `from -> to` is an authorized transition;
 *   3. the current `taskState` equals the last recorded transition target (consistency).
 *
 * WHY DynamoDB directly: the analytics API surfaces only `task_status` (the lifecycle), not the machine
 * `taskState`/`stateHistory` — Aurora has no columns for them yet (that ingestion is downstream
 * admin-console-effectiveness work). The `agent-tasks` row is where `advanceTaskStateTo` writes, so it
 * is the faithful anchor.
 *
 * Runs as the TIER USER (not testAdmin) so correlation is clean: the person id the credential exchange
 * names for the page's token is the `user-tasks` partition, so this run's task is the newest
 * report_generation row under that person, created after the run start (rules out legacy rows). Standard and premium only: basic offers no report (see TIERS). A task may persist just its
 * INITIAL state or advance through tool transitions; both shapes satisfy the assertions above.
 *
 * Gated by TASKS_E2E=1 (a validate.mjs phase). Reads DynamoDB + SSM via the AWS CLI (AWS_PROFILE),
 * exactly like helpers/test-credentials.ts. Table names resolve from env (AGENT_TASKS_TABLE /
 * USER_TASKS_TABLE) or SSM (`/<instance>/shared/tables/{agent,user}-tasks-name`, needs E2E_INSTANCE_NAME).
 *
 *   E2E_BASE_URL=<cf> TASKS_E2E=1 E2E_INSTANCE_NAME=<instance> AWS_PROFILE=<p> \
 *     npx playwright test e2e/task-state-machine.spec.ts --config=playwright.config.ts
 */
import { test, expect } from './helpers/fixtures';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import {
  getStandardUser,
  getPremiumUser,
  missingUserReason,
  type TestUser,
} from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { reportPromptForClassification } from './helpers/task-backend';
import { personIdFromIdToken } from './helpers/person';
import { aws } from './helpers/aws';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();

const RUN = process.env.TASKS_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;

// Each tier asks for the report its own classification offers (helpers/task-backend reportPromptForClassification):
// a premium report and a basic one are different work, not one request at two clearances.

// Mirrors DEFAULT_TASK_STATE_MACHINES.report_generation (backend/lambda/src/lib/task-state-machines.ts).
// Inlined so this deploy-gated spec needs no cross-package import; keep in sync if the machine changes.
const REPORT_GEN_EDGES: Record<string, string[]> = {
  collecting_requirements: ['drafting_outline'],
  drafting_outline: ['generating'],
  generating: ['revising'],
  revising: ['generating', 'completed'],
  completed: [],
};
const REPORT_STATES = new Set(Object.keys(REPORT_GEN_EDGES));

// AWS CLI JSON args (--expression-attribute-values, --key) must NOT be inlined as a
// single-quoted string: on Windows execSync runs via cmd.exe, where '...' is not a string
// delimiter, so the inner double-quotes are stripped and the JSON is mangled (ParamValidation:
// "Expected '='"). Write the JSON to a temp file and pass it as file:// — robust on every platform.
let _ddbTmp: string | undefined;
function jsonArg(obj: unknown): string {
  if (!_ddbTmp) _ddbTmp = mkdtempSync(join(tmpdir(), 'ae-ddb-'));
  const f = join(_ddbTmp, `arg-${process.hrtime.bigint()}.json`);
  writeFileSync(f, JSON.stringify(obj), 'utf8');
  return `file://${f.replace(/\\/g, '/')}`;
}

/** Resolve a shared table name from an explicit env override, else the shared SSM parameter. */
function resolveTableName(kind: 'agent-tasks' | 'user-tasks'): string | null {
  const envKey = kind === 'agent-tasks' ? 'AGENT_TASKS_TABLE' : 'USER_TASKS_TABLE';
  if (process.env[envKey]) return process.env[envKey]!;
  const instance = process.env.E2E_INSTANCE_NAME || process.env.INSTANCE_NAME;
  if (!instance) return null;
  try {
    const r = aws(`ssm get-parameter --name "/${instance}/shared/tables/${kind}-name"`);
    return r?.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}

/** Minimal DynamoDB attribute-value unmarshaller (S/N/BOOL/NULL/L/M) — enough for a Task row. */
function unmarshal(av: any): any {
  if (av == null) return undefined;
  if ('S' in av) return av.S;
  if ('N' in av) return Number(av.N);
  if ('BOOL' in av) return av.BOOL;
  if ('NULL' in av) return null;
  if ('L' in av) return av.L.map(unmarshal);
  if ('M' in av) return Object.fromEntries(Object.entries(av.M).map(([k, v]) => [k, unmarshal(v)]));
  return undefined;
}
function unmarshalItem(item: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, unmarshal(v)]));
}

const TIERS: Array<{
  tier: 'standard' | 'premium';
  classification: string;
  getUser: () => Promise<TestUser>;
  /** The secret entry this tier reads, so a credential gate can name what is missing. */
  secretKey: 'standardUser' | 'premiumUser';
}> = [
  // Basic is not here: it offers no report. It cannot hand over a document (`richProcessor: false`),
// so its intent pack has no `report_generation` and a report request is answered inline
// (guarded by backend/test/lib/intent-pack-extends.test.ts).
  { tier: 'standard', classification: 'Standard', getUser: getStandardUser, secretKey: 'standardUser' },
  { tier: 'premium', classification: 'Premium', getUser: getPremiumUser, secretKey: 'premiumUser' },
];

suite('Task machine state persists to the source of truth (SPEC-TASK-STATE-TRANSITIONS §6)', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('task-state-machine');

  let agentTable: string | null = null;
  let userTable: string | null = null;

  test.beforeAll(() => {
    agentTable = resolveTableName('agent-tasks');
    userTable = resolveTableName('user-tasks');
    expect(agentTable, 'AgentTasks table must resolve — set AGENT_TASKS_TABLE or E2E_INSTANCE_NAME').toBeTruthy();
    expect(userTable, 'UserTasks table must resolve — set USER_TASKS_TABLE or E2E_INSTANCE_NAME').toBeTruthy();
  });

  for (const tc of TIERS) {
    test(`[${tc.tier}] report task persists a valid taskState + well-formed stateHistory`, async ({ page }) => {
      test.setTimeout(300_000); // TASK_MULTI_STEP turn (up to 180s) + correlation poll

      const user = await tc.getUser();
      test.skip(!user.password, missingUserReason(tc.secretKey));

      const runStart = Date.now() - 60_000; // small skew cushion vs. the row's createdAt

      await signIn(page, user.email, user.password);
      const createResp = page.waitForResponse(
        (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await createConversation(page, `Task-state e2e ${tc.tier} ${Date.now()}`, tc.classification);
      // THIS CONVERSATION'S TASKS ONLY. Another spec in the same phase signs in as the same user and asks
      // for the same report a minute earlier, so a per-user time window counted its task as a duplicate.
      const thisChannel = ((await (await createResp).json())?.conversation?.conversationArn as string) || '';
      expect(thisChannel, `[${tc.tier}] the create-conversation response names the conversation`).toBeTruthy();

      const resp = await sendAndWaitForResponse(page, reportPromptForClassification(tc.tier), 180_000);
      expect(resp.text && resp.text.length, `[${tc.tier}] the report turn must return a response`).toBeTruthy();

      const idToken = await idTokenOf(page);
      expect(idToken, `[${tc.tier}] idToken should be present after sign-in`).toBeTruthy();
      const personId = await personIdFromIdToken(idToken!);

      // Correlate THIS run's task: the newest report_generation row for this user, created after
      // runStart (a task is created synchronously at send time; a short poll covers write visibility).
      let userRow: Record<string, any> | undefined;
      let runRows: Array<Record<string, any>> = [];
      for (let i = 0; i < 20 && !userRow; i++) {
        const q = aws(
          `dynamodb query --table-name "${userTable}" ` +
            `--key-condition-expression "principalId = :u" ` +
            `--expression-attribute-values ${jsonArg({ ':u': { S: personId } })}`,
        );
        runRows = ((q?.Items ?? []) as Array<Record<string, any>>)
          .map(unmarshalItem)
          .filter((r) => r.taskType === 'report_generation')
          .filter((r) => r.channelArn === thisChannel)
          .filter((r) => new Date(r.createdAt || 0).getTime() >= runStart)
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        userRow = runRows[0];
        if (!userRow) await page.waitForTimeout(3000);
      }
      expect(userRow, `[${tc.tier}] a report_generation task row for this run should exist (personId=${personId})`).toBeTruthy();

      // NO DUPLICATE TASKS at the SOURCE OF TRUTH (T1): this single ask, by this user, in this window must
      // have created EXACTLY ONE report_generation task row — not a duplicate from the getActiveTask
      // eventual-consistency race. Stronger than the analytics-side check (reads user-tasks directly).
      expect(
        runRows.length,
        `[${tc.tier}] exactly ONE report_generation task should exist for this run (no duplicate tasks per ask), found ${runRows.length}`,
      ).toBe(1);

      // Read the source-of-truth agent-tasks row (keyed by taskId + channelArn).
      const got = aws(
        `dynamodb get-item --table-name "${agentTable}" ` +
          `--key ${jsonArg({ taskId: { S: userRow!.taskId }, channelArn: { S: userRow!.channelArn } })}`,
      );
      expect(got?.Item, `[${tc.tier}] agent-tasks row for ${userRow!.taskId} should exist`).toBeTruthy();
      const task = unmarshalItem(got.Item);

      // 1) Persisted machine state is a DECLARED state (proves state is persisted + valid — not a heuristic).
      expect(
        REPORT_STATES.has(task.taskState),
        `[${tc.tier}] persisted taskState '${task.taskState}' is a declared report_generation state`,
      ).toBe(true);

      // 2) The §6 transition log, if present, is well-formed: declared endpoints, an AUTHORIZED edge,
      //    and tool/system-authored (never a silent mutation).
      //
      //    ONLY THE GRAPH EDGES ARE EDGES. The log carries three kinds of entry and two of them name
      //    no state: `reassignTask` appends ownership entries (`ownerFrom`/`ownerTo`, ADR-024 D3) and
      //    `updateTaskStatus` appends the lifecycle ending (`terminal`). Reading every entry as an
      //    edge reports a healthy task as malformed - and a report task crosses an `awaits`
      //    boundary the moment it leaves its first step, so that is not a rare shape.
      const history: Array<Record<string, any>> = Array.isArray(task.stateHistory) ? task.stateHistory : [];
      const edges = history.filter((e) => typeof e.from === 'string' && typeof e.to === 'string');
      edges.forEach((e, i) => {
        expect(REPORT_STATES.has(e.from), `[${tc.tier}] stateHistory edge[${i}].from '${e.from}' is declared`).toBe(true);
        expect(REPORT_STATES.has(e.to), `[${tc.tier}] stateHistory edge[${i}].to '${e.to}' is declared`).toBe(true);
        expect(
          REPORT_GEN_EDGES[e.from]?.includes(e.to),
          `[${tc.tier}] stateHistory edge[${i}] ${e.from}->${e.to} is authorized`,
        ).toBe(true);
      });
      // Authorship holds for EVERY entry, whichever kind it is: nothing writes this log but the tool
      // dispatch and the runtime.
      history.forEach((e, i) => {
        expect(['tool', 'system'], `[${tc.tier}] stateHistory[${i}].by`).toContain(e.by);
      });

      // 3) Consistency: current state == the last recorded transition target (when any transition ran).
      if (edges.length) {
        expect(task.taskState, `[${tc.tier}] taskState should match the last recorded edge's target`).toBe(
          edges[edges.length - 1].to,
        );
      }

      // Basic runs the full task loop too, but on Haiku it typically stays at the initial state with no
      // tool transitions, which is a valid pass. Standard/premium MAY have advanced. Log the observed shape.
      console.log(`[${tc.tier}] taskState=${task.taskState} edges=${edges.length} entries=${history.length}`);
    });
  }
});
