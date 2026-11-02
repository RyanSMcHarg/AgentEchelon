/**
 * A TASK STEP'S DEADLINE ENDS ITS TASK AND THE RUN CONTINUES ON onDeadline (ADR-063 slice T4), against the deployed router,
 * scheduler group and task service.
 *
 * The welcome asks the subject to acknowledge, with a five-minute deadline, and is left alone: the schedule fires, the
 * router checks the conversation and the task, the task service cancels the task with the deadline's ending, and the
 * run takes `onDeadline`, whose send the subject reads. The task leaves their open work.
 *
 * GATED: it changes a deployed assistant's active version and waits past a five-minute deadline, so it runs only with
 * `E2E_WORKFLOW_TASK_DEADLINE=1`.
 *
 * **Coverage:** `e2e/a-task-deadline-ends-the-task-and-continues-the-run.spec.ts`
 */
import { test, expect, declareWait } from './helpers/fixtures';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange } from './helpers/admin-api';
import { idTokenFor } from './helpers/person';
import { guardBackendErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, PERSON_API_URL } from './helpers/api-urls';
import { activate, activeVersionOf, draftWith, openConversation, openWorkOf, rollBack, sleep, waitFor } from './helpers/workflow-task';

const MARK = `TASKDL-${Date.now().toString(36)}`;

test.describe.serial('a task step\'s deadline ends its task and the run continues', () => {
  guardBackendErrors('a-task-deadline-ends-the-task-and-continues-the-run');
  let admin: any;
  let previousVersion: number | undefined;

  test.beforeAll(async () => {
    test.skip(process.env.E2E_WORKFLOW_TASK_DEADLINE !== '1', 'changes an active version and waits past a five-minute deadline; set E2E_WORKFLOW_TASK_DEADLINE=1 to run it');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status).toBe(200);
    admin = session.body.credentials;
    previousVersion = await activeVersionOf(admin);
  });

  test.afterAll(async () => { if (admin) await rollBack(admin, previousVersion); });

  test('a task nobody answers is cancelled at its deadline and the run takes onDeadline', async () => {
    test.setTimeout(15 * 60_000);
    const valid = await draftWith(admin, {
      'e2e-task-deadline': {
        on: 'assistant-joined', initial: 'opening',
        states: {
          opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'ask', onFailure: 'ask' },
          ask: { task: { machine: 'acknowledgement', for: 'subject', by: 'subject', deadline: { afterMinutes: 5 } }, onSuccess: 'done', onFailure: 'done', onDeadline: 'chase' },
          chase: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
          done: { disposition: 'success' },
        },
      },
    });
    expect(valid.errors ?? [], JSON.stringify(valid).slice(0, 600)).toEqual([]);
    await activate(admin);
    await sleep(35_000);
    const conv = await openConversation(`Deadline ${MARK}`);
    const { hit: card } = await waitFor(conv.channelId, conv.personArn, (m) => !!m.metadata?.task?.id);
    expect(card, 'no task was assigned').toBeDefined();
    declareWait("the acknowledgement task's five-minute deadline", Date.now() + 5 * 60_000);
    const { hit } = await waitFor(conv.channelId, conv.personArn, (m) => m.metadata?.eventStep?.step === 'chase', 10 * 60_000);
    expect(hit, 'the run did not take onDeadline').toBeDefined();
    expect(hit!.metadata.eventRun.transitions.some((t: any) => t.step === 'ask' && t.outcome === 'task:deadline')).toBe(true);
    const items = await openWorkOf(conv.token);
    expect(items.some((i) => i.taskId === card!.metadata.task.id)).toBe(false);
  });
});
