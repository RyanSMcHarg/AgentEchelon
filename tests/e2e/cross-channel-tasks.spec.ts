/**
 * CROSS-CHANNEL-TASKS — a task stays pinned to the conversation it was opened in.
 *
 * The guarantee this spec exists for is a NEGATIVE one: an in-flight multi-step task must NOT be
 * resumed by a turn in a different conversation. Every other task e2e drives a single channel, so
 * none of them can see this — a single-channel run passes identically whether the resume lookup is
 * channel-scoped or not. Only a two-channel drive falsifies it.
 *
 * The mechanism under test is `getActiveTask(userSub, type, { channelArn })` in
 * `router-agent-handler.ts` — the resume candidate is filtered by the CURRENT channel. Out-of-channel
 * work reaches the model only as the terse prompt hint built by `buildCrossChannelTasksHint`
 * (assistant-async-processor.ts), never as an auto-resume.
 *
 * What is asserted, in the source of truth rather than the reply text:
 *   1. Conversation A's turn opens a report_generation task pinned to A's channelArn.
 *   2. A bare continuation-shaped answer sent in conversation B — the exact reply shape the
 *      assistant would have solicited in A — leaves A's persisted task row untouched:
 *      same taskState, same status, same updatedAt, same turnsInState.
 *   3. A's taskId does not acquire a row under B's channelArn (the composite key makes a
 *      cross-channel resume write visible as exactly that).
 *
 * The reply text in B is deliberately NOT asserted. A model that simply changes the subject would
 * pass a prose check while the row was being advanced underneath it.
 *
 * Gated like the other task specs — two multi-step turns, several minutes:
 *   E2E_BASE_URL=<cf> TASKS_E2E=1 E2E_INSTANCE_NAME=<instance> AWS_PROFILE=<p> \
 *     npx playwright test e2e/cross-channel-tasks.spec.ts --config=playwright.config.ts
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getStandardUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const RUN = process.env.TASKS_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const REGION = 'us-east-1';

/** Classified report_generation → delivery TASK_MULTI_STEP → createTask (mirrors tasks.spec.ts). */
const REPORT_PROMPT =
  'Please compile a short report analyzing the pros and cons of a monorepo versus multi-repo for a 5-team org.';

/**
 * A bare ANSWER: no subject of its own, no verb asking for anything new. If the resume lookup were
 * not channel-scoped this is precisely the turn that would be absorbed into the report task opened
 * in the other conversation — it reads as the reply to "who is the audience, and what should I
 * focus on?".
 */
const CONTINUATION_PROMPT = 'Engineering leadership, and focus on CI cost.';

function aws(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, AWS_PROFILE },
  }).trim();
  return out ? JSON.parse(out) : null;
}

// See task-state-machine.spec.ts: JSON CLI args must go through file:// — cmd.exe strips the inner
// quotes out of a single-quoted argument and the JSON arrives mangled.
let _ddbTmp: string | undefined;
function jsonArg(obj: unknown): string {
  if (!_ddbTmp) _ddbTmp = mkdtempSync(join(tmpdir(), 'ae-ddb-'));
  const f = join(_ddbTmp, `arg-${process.hrtime.bigint()}.json`);
  writeFileSync(f, JSON.stringify(obj), 'utf8');
  return `file://${f.replace(/\\/g, '/')}`;
}

function resolveTableName(kind: 'agent-tasks' | 'user-tasks'): string | null {
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

function jwtSub(idToken: string): string {
  return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')).sub;
}

/** The fields a resume would necessarily move. Compared as one object so the diff names the field. */
function taskFingerprint(row: Record<string, any>) {
  return {
    taskState: row.taskState,
    status: row.status,
    updatedAt: row.updatedAt,
    turnsInState: row.turnsInState ?? 0,
    stateHistoryLength: Array.isArray(row.stateHistory) ? row.stateHistory.length : 0,
  };
}

/** Capture the create-conversation response so the channel ARN comes from the server, not the DOM. */
async function createAndCaptureArn(page: any, title: string, classification: string): Promise<string> {
  const resp = page.waitForResponse(
    (r: any) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
    { timeout: 30000 },
  );
  await createConversation(page, title, classification);
  const arn: string = (await (await resp).json())?.conversation?.conversationArn || '';
  expect(arn, `channelArn from create-conversation (${title})`).toBeTruthy();
  await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });
  return arn;
}

suite('A task does not resume in another conversation (CROSS-CHANNEL-TASKS)', () => {
  guardBackendErrors('cross-channel-tasks');

  let agentTable: string | null = null;
  let userTable: string | null = null;

  test.beforeAll(() => {
    agentTable = resolveTableName('agent-tasks');
    userTable = resolveTableName('user-tasks');
    expect(agentTable, 'AgentTasks table must resolve — set AGENT_TASKS_TABLE or E2E_INSTANCE_NAME').toBeTruthy();
    expect(userTable, 'UserTasks table must resolve — set USER_TASKS_TABLE or E2E_INSTANCE_NAME').toBeTruthy();
  });

  test('a continuation-shaped turn in conversation B leaves conversation A\'s task untouched', async ({ page }) => {
    test.setTimeout(600_000); // two TASK_MULTI_STEP turns (up to 180s each) + correlation polls

    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));

    const runStart = Date.now() - 60_000; // skew cushion vs. the row's createdAt

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    const stamp = Date.now();

    // --- Conversation A: open the multi-step task -------------------------------------------
    const arnA = await createAndCaptureArn(page, `Cross-channel A ${stamp}`, 'Standard');
    const respA = await sendAndWaitForResponse(page, REPORT_PROMPT, 180_000);
    expect(respA.text && respA.text.length, 'the report turn in A must return a response').toBeTruthy();

    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'idToken should be present after sign-in').toBeTruthy();
    const sub = jwtSub(idToken!);

    // Correlate THIS run's task in A. A task is created synchronously at send time; the short poll
    // covers write visibility only.
    let rowA: Record<string, any> | undefined;
    for (let i = 0; i < 20 && !rowA; i++) {
      const q = aws(
        `dynamodb query --table-name "${userTable}" --key-condition-expression "userSub = :u" ` +
          `--expression-attribute-values ${jsonArg({ ':u': { S: sub } })}`,
      );
      rowA = ((q?.Items ?? []) as Array<Record<string, any>>)
        .map(unmarshalItem)
        .filter((r) => r.taskType === 'report_generation')
        .filter((r) => r.channelArn === arnA)
        .filter((r) => new Date(r.createdAt || 0).getTime() >= runStart)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
      if (!rowA) await page.waitForTimeout(3000);
    }
    expect(rowA, `a report_generation task pinned to conversation A should exist (sub=${sub})`).toBeTruthy();
    const taskId: string = rowA!.taskId;
    console.log(`\n--- task ${taskId} pinned to ---\n${arnA}`);

    const readAgentRow = (arn: string) =>
      aws(
        `dynamodb get-item --table-name "${agentTable}" ` +
          `--key ${jsonArg({ taskId: { S: taskId }, channelArn: { S: arn } })}`,
      );

    // ARRANGE the precondition rather than hoping for it. `getActiveTask` only ever considers
    // status `pending` or `in_progress`, so a completed task is unresumable from ANY channel and
    // this test would pass vacuously. Whether the model leaves a task open is its own decision and
    // varies run to run — a first run of this spec saw the report finish inside a single turn — so
    // depending on it would make a regression gate intermittently meaningless. What is under test
    // is the SCOPING of the resume lookup, not the model's task management, so the open task is
    // arranged directly in the source of truth. Both tables are written: `getActiveTask` reads
    // user-tasks, and the fingerprint is read from agent-tasks.
    let beforeItem = readAgentRow(arnA)?.Item;
    expect(beforeItem, `agent-tasks row (${taskId}, A) should exist before the B turn`).toBeTruthy();

    if (!['pending', 'in_progress'].includes(String(unmarshalItem(beforeItem).status))) {
      console.log(`--- reopening task (was ${unmarshalItem(beforeItem).status}) so a resume is possible ---`);
      for (const [table, key] of [
        [userTable!, { userSub: { S: sub }, taskId: { S: taskId } }],
        [agentTable!, { taskId: { S: taskId }, channelArn: { S: arnA } }],
      ] as const) {
        aws(
          `dynamodb update-item --table-name "${table}" --key ${jsonArg(key)} ` +
            `--update-expression "SET #s = :s" ` +
            `--expression-attribute-names ${jsonArg({ '#s': 'status' })} ` +
            `--expression-attribute-values ${jsonArg({ ':s': { S: 'in_progress' } })}`,
        );
      }
      beforeItem = readAgentRow(arnA)?.Item;
    }

    const before = taskFingerprint(unmarshalItem(beforeItem));
    expect(
      ['pending', 'in_progress'],
      `the task must be open for a resume to be possible (status=${before.status})`,
    ).toContain(String(before.status));

    // --- Conversation B: the turn that must NOT be absorbed ----------------------------------
    const arnB = await createAndCaptureArn(page, `Cross-channel B ${stamp}`, 'Standard');
    expect(arnB, 'conversation B must be a different channel').not.toBe(arnA);

    const respB = await sendAndWaitForResponse(page, CONTINUATION_PROMPT, 180_000);
    expect(respB.text && respB.text.length, 'the continuation turn in B must return a response').toBeTruthy();

    // --- The guarantee ------------------------------------------------------------------------
    // 1) A's task is byte-for-byte where it was. A resume writes updatedAt on every path it takes,
    //    so an unchanged fingerprint is evidence no write reached this row.
    const afterItem = readAgentRow(arnA)?.Item;
    expect(afterItem, `agent-tasks row (${taskId}, A) should still exist after the B turn`).toBeTruthy();
    expect(
      taskFingerprint(unmarshalItem(afterItem)),
      "conversation B's turn must not advance the task that lives in conversation A",
    ).toEqual(before);

    // 2) The composite key is (taskId, channelArn) — a cross-channel resume would surface as A's
    //    taskId acquiring a row under B. There must be none.
    expect(
      readAgentRow(arnB)?.Item,
      `task ${taskId} must not exist under conversation B's channelArn`,
    ).toBeFalsy();

    // Close the arranged task. Leaving a re-opened report task active for this shared test user
    // would let it leak into a later run's resume lookup in the conversation it belongs to.
    for (const [table, key] of [
      [userTable!, { userSub: { S: sub }, taskId: { S: taskId } }],
      [agentTable!, { taskId: { S: taskId }, channelArn: { S: arnA } }],
    ] as const) {
      aws(
        `dynamodb update-item --table-name "${table}" --key ${jsonArg(key)} ` +
          `--update-expression "SET #s = :s" ` +
          `--expression-attribute-names ${jsonArg({ '#s': 'status' })} ` +
          `--expression-attribute-values ${jsonArg({ ':s': { S: 'completed' } })}`,
      );
    }
  });
});
