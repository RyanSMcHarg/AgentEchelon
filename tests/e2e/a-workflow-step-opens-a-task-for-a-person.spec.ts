/**
 * A WORKFLOW STEP OPENS A TASK FOR A PERSON, WHO COMPLETES IT ON THE CARD (ADR-063 slices T1, T2 and T3), against the
 * deployed profile API, router, task service and person API.
 *
 * T1: a version whose welcome runs a task step validates and activates; one naming one of the turn queue's own machines,
 * a deadline out of bounds, or a task:state the machine does not end in is refused with each reason.
 * T2: the welcome opens an `approval` task for the conversation's subject; it is in their open work, and they are told
 * privately, with the task card on the message's Metadata.
 * T3: the subject approves on the card; the run takes the `approved` edge and posts its next send; a second press is
 * refused as settled.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with `E2E_WORKFLOW_TASKS=1`.
 *
 * **Coverage:** `e2e/a-workflow-step-opens-a-task-for-a-person.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange } from './helpers/admin-api';
import { idTokenFor } from './helpers/person';
import { guardBackendErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, PERSON_API_URL } from './helpers/api-urls';
import { activate, activeVersionOf, draftWith, openConversation, openWorkOf, pressCard, rollBack, sleep, waitFor } from './helpers/workflow-task';

const MARK = `TASK-${Date.now().toString(36)}`;
const WORKFLOW = 'e2e-task-welcome';

const welcome = (over: Record<string, unknown> = {}) => ({
  [WORKFLOW]: {
    on: 'assistant-joined', initial: 'opening',
    states: {
      opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'review', onFailure: 'review' },
      review: {
        task: { machine: 'approval', for: 'subject', by: 'subject', visibility: 'private', deadline: { afterMinutes: 60 } },
        onSuccess: [{ to: 'thanks', when: { 'task:state': 'approved' } }, { to: 'done' }],
        onFailure: 'done',
      },
      thanks: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
    ...over,
  },
});

test.describe.serial('a workflow step opens a task for a person, who completes it on the card', () => {
  guardBackendErrors('a-workflow-step-opens-a-task-for-a-person');
  let admin: any;
  let previousVersion: number | undefined;
  let conv: Awaited<ReturnType<typeof openConversation>> | undefined;
  let card: { id: string; state: string; choices: string[] } | undefined;

  test.beforeAll(async () => {
    test.skip(process.env.E2E_WORKFLOW_TASKS !== '1', 'changes a deployed assistant\'s active version; set E2E_WORKFLOW_TASKS=1 to run it');
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

  test('T1: each refusal names its reason', async () => {
    test.setTimeout(180_000);
    const queueMachine = await draftWith(admin, welcome({ states: { ...welcome()[WORKFLOW].states, review: { ...welcome()[WORKFLOW].states.review, task: { machine: 'queued_request', for: 'subject', deadline: { afterMinutes: 60 } } } } }));
    expect(JSON.stringify(queueMachine.errors)).toContain('one of the turn queue\'s own machines');
    const shortDeadline = await draftWith(admin, welcome({ states: { ...welcome()[WORKFLOW].states, review: { ...welcome()[WORKFLOW].states.review, task: { machine: 'approval', for: 'subject', by: 'subject', deadline: { afterMinutes: 1 } } } } }));
    expect(JSON.stringify(shortDeadline.errors)).toContain('every task a workflow assigns has an end');
    const badState = await draftWith(admin, welcome({ states: { ...welcome()[WORKFLOW].states, review: { ...welcome()[WORKFLOW].states.review, onSuccess: [{ to: 'thanks', when: { 'task:state': 'maybe' } }, { to: 'done' }] } } }));
    expect(JSON.stringify(badState.errors)).toContain('task:state');
  });

  test('T1: a version whose welcome runs a task step validates and activates', async () => {
    test.setTimeout(120_000);
    const valid = await draftWith(admin, welcome());
    expect(valid.errors ?? [], JSON.stringify(valid).slice(0, 600)).toEqual([]);
    await activate(admin);
  });

  test('T2: the welcome opens an approval for the subject, who is told privately with the card, and owns it', async () => {
    test.setTimeout(240_000);
    await sleep(35_000); // the served version is cached for 30 seconds
    conv = await openConversation(`Tasks ${MARK}`);
    const { hit, seen } = await waitFor(conv.channelId, conv.personArn, (m) => !!m.metadata?.task?.id);
    expect(hit, `no task card; seen ${JSON.stringify(seen.slice(0, 5).map((m) => m.metadata))}`).toBeDefined();
    expect(hit!.target).toEqual([conv.personArn]);
    expect(hit!.metadata.task).toMatchObject({ state: 'deciding', choices: ['approved', 'declined'] });
    expect(hit!.metadata.notifyKind).toBe('task');
    card = hit!.metadata.task;
    const items = await openWorkOf(conv.token);
    expect(items.some((i) => i.taskId === card!.id), JSON.stringify(items).slice(0, 400)).toBe(true);
  });

  test('T3: the subject approves on the card, the run takes the approved edge, and a second press is refused', async () => {
    test.setTimeout(240_000);
    test.skip(!conv || !card, 'no card was posted');
    const pressed = await pressCard(conv!.token, { channelArn: conv!.channelArn, taskId: card!.id, state: card!.state, choice: 'approved' });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    expect(pressed.body.state).toBe('approved');
    const { hit } = await waitFor(conv!.channelId, conv!.personArn, (m) => m.metadata?.eventStep?.step === 'thanks');
    expect(hit, 'the run did not take the approved edge').toBeDefined();
    const again = await pressCard(conv!.token, { channelArn: conv!.channelArn, taskId: card!.id, state: card!.state, choice: 'approved' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SETTLED');
    const items = await openWorkOf(conv!.token);
    expect(items.some((i) => i.taskId === card!.id)).toBe(false);
  });
});
