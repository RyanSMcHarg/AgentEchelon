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
 * Runs as the TIER USER (not testAdmin) so correlation is clean: the chat AppInstanceUser id == the
 * Cognito `sub` (AE convention, credential-exchange.ts), so this run's task is the newest
 * report_generation row under that sub in `user-tasks`, created after the run start (rules out legacy
 * rows). Basic is lightweight (status-only) — it legitimately persists just the INITIAL state with no
 * tool transitions; standard/premium MAY advance. Both shapes satisfy the assertions above.
 *
 * Gated by TASKS_E2E=1 (a validate.mjs phase). Reads DynamoDB + SSM via the AWS CLI (AWS_PROFILE),
 * exactly like helpers/test-credentials.ts. Table names resolve from env (AGENT_TASKS_TABLE /
 * USER_TASKS_TABLE) or SSM (`/<instance>/shared/tables/{agent,user}-tasks-name`, needs E2E_INSTANCE_NAME).
 *
 *   E2E_BASE_URL=<cf> TASKS_E2E=1 E2E_INSTANCE_NAME=<instance> AWS_PROFILE=<p> \
 *     npx playwright test e2e/task-state-machine.spec.ts --config=playwright.config.ts
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getBasicUser, getStandardUser, getPremiumUser, type TestUser } from './helpers/test-credentials';

const RUN = process.env.TASKS_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const REGION = 'us-east-1';

// A prompt the intent pack classifies as report_generation → delivery TASK_MULTI_STEP → createTask
// (mirrors tasks.spec.ts). "report", "analysis", "compile" are its classifier keywords.
const REPORT_PROMPT =
  'Please compile a short report analyzing the pros and cons of a monorepo versus multi-repo for a 5-team org.';

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

/** Run the AWS CLI (JSON out) with the test AWS_PROFILE, same mechanism as test-credentials.ts. */
function aws(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, AWS_PROFILE },
  }).trim();
  return out ? JSON.parse(out) : null;
}

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

/** Cognito `sub` from the id token's payload — the chat AppInstanceUser id, and the user-tasks PK. */
function jwtSub(idToken: string): string {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
  return payload.sub;
}

const TIERS: Array<{ tier: 'basic' | 'standard' | 'premium'; classification: string; getUser: () => Promise<TestUser> }> = [
  { tier: 'basic', classification: 'Open', getUser: getBasicUser },
  { tier: 'standard', classification: 'Standard', getUser: getStandardUser },
  { tier: 'premium', classification: 'Premium', getUser: getPremiumUser },
];

suite('Task machine state persists to the source of truth (SPEC-TASK-STATE-TRANSITIONS §6)', () => {
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
      if (!user.password) {
        test.skip();
        return;
      }

      const runStart = Date.now() - 60_000; // small skew cushion vs. the row's createdAt

      await signIn(page, user.email, user.password);
      await createConversation(page, `Task-state e2e ${tc.tier} ${Date.now()}`, tc.classification);

      const resp = await sendAndWaitForResponse(page, REPORT_PROMPT, 180_000);
      expect(resp.text && resp.text.length, `[${tc.tier}] the report turn must return a response`).toBeTruthy();

      const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
      expect(idToken, `[${tc.tier}] idToken should be present after sign-in`).toBeTruthy();
      const sub = jwtSub(idToken!);

      // Correlate THIS run's task: the newest report_generation row for this user, created after
      // runStart (a task is created synchronously at send time; a short poll covers write visibility).
      let userRow: Record<string, any> | undefined;
      let runRows: Array<Record<string, any>> = [];
      for (let i = 0; i < 20 && !userRow; i++) {
        const q = aws(
          `dynamodb query --table-name "${userTable}" ` +
            `--key-condition-expression "userSub = :u" ` +
            `--expression-attribute-values ${jsonArg({ ':u': { S: sub } })}`,
        );
        runRows = ((q?.Items ?? []) as Array<Record<string, any>>)
          .map(unmarshalItem)
          .filter((r) => r.taskType === 'report_generation')
          .filter((r) => new Date(r.createdAt || 0).getTime() >= runStart)
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        userRow = runRows[0];
        if (!userRow) await page.waitForTimeout(3000);
      }
      expect(userRow, `[${tc.tier}] a report_generation task row for this run should exist (sub=${sub})`).toBeTruthy();

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
      const history: Array<Record<string, any>> = Array.isArray(task.stateHistory) ? task.stateHistory : [];
      history.forEach((e, i) => {
        expect(REPORT_STATES.has(e.from), `[${tc.tier}] stateHistory[${i}].from '${e.from}' is declared`).toBe(true);
        expect(REPORT_STATES.has(e.to), `[${tc.tier}] stateHistory[${i}].to '${e.to}' is declared`).toBe(true);
        expect(
          REPORT_GEN_EDGES[e.from]?.includes(e.to),
          `[${tc.tier}] stateHistory[${i}] edge ${e.from}->${e.to} is authorized`,
        ).toBe(true);
        expect(['tool', 'system'], `[${tc.tier}] stateHistory[${i}].by`).toContain(e.by);
      });

      // 3) Consistency: current state == the last recorded transition target (when any transition ran).
      if (history.length) {
        expect(task.taskState, `[${tc.tier}] taskState should match the last stateHistory.to`).toBe(
          history[history.length - 1].to,
        );
      }

      // Basic is lightweight (status-only) → typically the initial state with no tool transitions, which
      // is a valid pass. Standard/premium MAY have advanced. Log the observed shape for the shadow burn-in.
      console.log(`[${tc.tier}] taskState=${task.taskState} transitions=${history.length}`);
    });
  }
});
