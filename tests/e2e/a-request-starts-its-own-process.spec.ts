/**
 * A REQUEST STARTS ITS OWN PROCESS (SPEC-PROCESSES P1, P2, P8; DESIGN-PROCESSES "A request starts or joins a process"), against
 * the deployed stacks.
 *
 * The unit suites prove the validator, the manifest's requirements and the carriage of the id on the router's and the
 * processor's records (`a-request-started-workflow-starts-or-joins-a-process.test.ts`). What only a deployment proves is a
 * person's request run end to end as one process:
 *  - with Advisor's version declaring `account-briefs` over its request-started `account_brief` workflow (the demo's process,
 *    `demo/portable-assistants/advisor-processes.ts`), a test person asks for an account brief, and the request's own task
 *    carries the intent's run (`intent#...`) and that run's process: the process's name, an id and its edition;
 *  - the brief is written: the task ends on its machine's success, and the run ends with it;
 *  - the process view reads that process id as one process, ended and succeeded, whose one run is the request's
 *    (`account_brief`), with an end and a success, by reference only, and whose labeled step (`Brief`) has a time and a cost.
 *
 * THE RUN OWNS WHAT IT TOUCHES: Advisor's active version, which is returned, and the request's task, which is cancelled through
 * the product's own run cancel where the brief was not written, so a failed run leaves no process that never ends.
 *
 * GATED: it changes a deployed assistant's active version, so it runs only with PROCESS_E2E=1 (the `processes` phase of
 * `backend/scripts/validate.mjs`). The process view reads the Aurora projection, so its assertions need an Aurora deployment.
 *
 * **Coverage:** `e2e/a-request-starts-its-own-process.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { channelArnFor } from './helpers/battle-state-backend';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { adminUrl } from './helpers/api-urls';
import { replacingDraft, draftIdOf } from './helpers/profile-draft';
import { adminSessionOrSkip, discardDraft } from './helpers/model-routes';
import { SERVED_VERSION_TTL_MS } from './helpers/version-under-test';
import { PROFILE, activeVersionOf, openConversation, rollBack, sleep } from './helpers/workflow-task';
import { channelTasks, pollFor, resolveTaskTable } from './helpers/task-backend';
import { noteProgress } from './helpers/watchdog/current';
import { ACCOUNT_BRIEF_PROCESS, ADVISOR_ASSISTANT, advisorBriefProcess, advisorIntentWorkflows } from '../../demo/portable-assistants/advisor-processes';

const RUN = process.env.PROCESS_E2E === '1';
const INTENT = 'account_brief';
const ASK = 'Prepare an account brief on Coastal Health Systems for my renewal call tomorrow.';
const NUDGE = 'Please go ahead and write the brief now.';
type Row = Record<string, unknown>;

/** The request's own task in the conversation, as its row records it. */
const requestTask = (channelArn: string): Record<string, any> | undefined => {
  const table = resolveTaskTable('agent-tasks');
  return table ? channelTasks(table, channelArn).find((t: Record<string, any>) => t.taskType === INTENT) : undefined;
};
const isLive = (t: Record<string, any> | undefined) => !!t && ['pending', 'in_progress'].includes(String(t.status));

test.describe.serial('a request starts its own process (P2)', () => {
  guardBackendErrors('a-request-starts-its-own-process');

  let admin: VendedCredentials | undefined;
  let adminIdToken = '';
  let previous: number | undefined;
  let activated = false;
  let conv: Awaited<ReturnType<typeof openConversation>> | undefined;
  let processId = '';

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set PROCESS_E2E=1 to run it');
    expect(PROFILE, 'the premium primary is the demo process\'s owner').toBe(ADVISOR_ASSISTANT);
    const s = await adminSessionOrSkip();
    test.skip(!!s.skip, s.skip);
    admin = s.admin;
    adminIdToken = s.idToken!;
    await discardDraft(admin).catch(() => undefined);
    previous = await activeVersionOf(admin);
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    const tryTo = async (what: string, fn: () => unknown) => {
      try { await fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    // A REQUEST WHOSE BRIEF WAS NOT WRITTEN IS CANCELLED THROUGH THE PRODUCT'S OWN RUN CANCEL, so its process ends.
    const open = conv ? requestTask(conv.channelArn) : undefined;
    if (admin && conv && isLive(open)) await tryTo('cancel the request\'s run', async () => {
      const vend = await exchange(adminIdToken, { identity: 'admin', capabilities: ['tasks-manage'], channelArn: conv!.channelArn, reason: 'end-to-end cleanup of the request this spec made' });
      if (vend.status !== 200) throw new Error(`no task grant (${vend.status})`);
      await signedCall(adminUrl('admin-conversations', `/admin/tasks/channel/${conv!.channelId}/cancel`), vend.body.credentials, 'POST', { taskId: open!.taskId, run: true });
    });
    if (admin) await tryTo('discard a draft this spec left', () => discardDraft(admin));
    if (admin && activated) await tryTo(`return ${PROFILE} to version ${previous}`, () => rollBack(admin, previous));
  });

  test('Advisor\'s version declares account briefs over its request-started account_brief workflow', async () => {
    test.setTimeout(240_000);
    const created = await replacingDraft((b) => signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin!, 'POST', b), { profileName: PROFILE });
    expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
    // THE DRAFT DECLARES EVERY MULTI-STEP INTENT'S WORKFLOW; the brief's is the one the demo's process links.
    const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin!, 'POST', { profileName: PROFILE, draft: true });
    const body = (exported.body?.manifest?.body ?? {}) as { intentWorkflows?: Record<string, unknown> };
    const patch = { intentWorkflows: { ...(body.intentWorkflows ?? {}), ...advisorIntentWorkflows() }, processes: advisorBriefProcess() };
    const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin!, 'POST', { profileName: PROFILE, patch, configId: draftIdOf(created) });
    expect(edited.status, JSON.stringify(edited.body).slice(0, 400)).toBe(200);
    const valid = await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin!, 'POST', { profileName: PROFILE });
    expect(valid.body?.errors ?? [], JSON.stringify(valid.body).slice(0, 600)).toEqual([]);
    const done = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin!, 'POST', { profileName: PROFILE, configId: draftIdOf(edited) });
    expect(done.status, JSON.stringify(done.body).slice(0, 400)).toBe(200);
    activated = true;
  });

  test('a person\'s request for a brief opens its task on the intent\'s run, which carries the process, and the brief is written', async () => {
    test.setTimeout(10 * 60_000);
    expect(activated, 'the version declaring the process was activated').toBe(true);
    await sleep(SERVED_VERSION_TTL_MS);
    conv = await openConversation(`Account brief process ${Date.now().toString(36)}`);
    await sleep(15_000);
    const say = (text: string) => aws(`chime-sdk-messaging send-channel-message --channel-arn ${channelArnFor(conv!.channelId)} --chime-bearer ${conv!.personArn} --type STANDARD --persistence PERSISTENT --content "${encodeURIComponent(text)}"`);
    say(ASK);

    // THE REQUEST'S OWN TASK, opened by the intent's run, carrying the run and its process.
    const task = await pollFor(() => Promise.resolve(requestTask(conv!.channelArn)), (t) => !!t?.workflowRun, { timeoutMs: 3 * 60_000, intervalMs: 5_000 });
    expect(task, `an ${INTENT} task opened for "${ASK.slice(0, 40)}"`).toBeTruthy();
    expect(String(task!.workflowRun.runKey), 'the task is the intent run\'s own').toMatch(/^intent#/);
    expect(task!.workflowRun.workflow).toBe(INTENT);
    const proc = task!.workflowRun.process as { id?: string; name?: string; edition?: string } | undefined;
    expect(proc?.name, 'the request\'s run started the process its version links').toBe(ACCOUNT_BRIEF_PROCESS);
    expect(String(proc?.id)).toMatch(/^[a-f0-9]{12}$/);
    expect(String(proc?.edition)).toMatch(/^[a-f0-9]{12}$/);
    processId = proc!.id!;

    // THE BRIEF IS WRITTEN: the task ends on its machine's success. Where a step waits for a message, the person says go on.
    let settled = await pollFor(() => Promise.resolve(requestTask(conv!.channelArn)), (t) => !isLive(t), { timeoutMs: 3 * 60_000, intervalMs: 10_000 }).catch(() => undefined);
    for (let nudge = 1; nudge <= 1 && isLive(settled ?? requestTask(conv!.channelArn)); nudge += 1) {
      noteProgress('harness', `the brief is not written yet; the person says go on (${nudge})`);
      say(NUDGE);
      settled = await pollFor(() => Promise.resolve(requestTask(conv!.channelArn)), (t) => !isLive(t), { timeoutMs: 2.5 * 60_000, intervalMs: 10_000 }).catch(() => undefined);
    }
    const ended = settled ?? requestTask(conv!.channelArn);
    expect(isLive(ended), `the brief was written: the task ended (${String(ended?.taskState)})`).toBe(false);
    expect(ended!.taskState, 'on its machine\'s success').toBe('completed');
    expect(ended!.workflowRun?.process?.id, 'the settled task still names the process').toBe(processId);
  });

  test('the process view reads the request\'s process as one process, ended and succeeded, whose one run is the request\'s', async () => {
    test.setTimeout(420_000);
    expect(processId, 'the request started a process').not.toBe('');
    const read = () => signedCall(adminUrl('analytics', '/'), admin!, 'POST', { queryType: 'process_runs', process: ACCOUNT_BRIEF_PROCESS, processId });
    const first = await read();
    expect(first.status, JSON.stringify(first.body ?? {}).slice(0, 300)).toBe(200);
    test.skip(!!first.body?.unsupported, 'process analytics needs Aurora mode');
    const view = async () => {
      const rows = ((await read()).body?.data ?? []) as Row[];
      return { row: rows.find((r) => r.dimension === 'process' && r.process === ACCOUNT_BRIEF_PROCESS), runs: rows.filter((r) => r.dimension === 'run' && r.process_id === processId), rows };
    };
    const settled = await pollFor(view, (v) => Number(v.row?.ended) === 1, { timeoutMs: 360_000, intervalMs: 15_000 });
    expect(settled.row, 'the process view has a row for the request\'s process id').toBeTruthy();
    expect(Number(settled.row!.runs), 'one process').toBe(1);
    expect(Number(settled.row!.ended), `the process reads ended: ${JSON.stringify(settled.runs.map((r) => [r.workflow, r.ended_at]))}`).toBe(1);
    expect(Number(settled.row!.succeeded), 'and succeeded').toBe(1);
    // ITS ONE RUN IS THE REQUEST'S: the intent's workflow, with an end and a success, and its messages carried the process.
    expect(settled.runs.map((r) => r.workflow)).toEqual([INTENT]);
    expect(settled.runs[0].ended_at, 'the request\'s run has an end').toBeTruthy();
    expect(settled.runs[0].disposition).toBe('success');
    expect(Number(settled.runs[0].started_at), 'the run started at its first message, before its end').toBeLessThan(Number(settled.runs[0].ended_at));
    // THE BRIEF IS THE PROCESS'S STAGE: its labeled step has a time, the turn's first message, and a cost of more than nothing.
    const times = (settled.runs[0].step_times ?? []) as Array<{ step: string; at: number }>;
    expect(times.map((t) => t.step), `the request's step has a time: ${JSON.stringify(times)}`).toContain('work');
    const costs = (settled.runs[0].step_costs ?? []) as Array<{ step: string; usd: number | null }>;
    const work = costs.find((c) => c.step === 'work');
    expect(work?.usd ?? 0, `the brief's step is priced: ${JSON.stringify(costs)}`).toBeGreaterThan(0);
    for (const r of settled.rows) expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['content', 'message', 'text']));
  });
});
