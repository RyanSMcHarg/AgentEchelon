/**
 * AN IDLE ASSISTANT TAKES UP ITS OWN WORK (ADR-063 slice T5), against the deployed router, processor, turn lock and task
 * service.
 *
 * The welcome assigns the assistant itself a `guided_troubleshooting` task's working step, with nobody writing in the
 * room: its first step awaits the requester, so the subject is asked. That step is `presented`: the turn that reads the
 * subject's answer says back what it is taking and asks them to confirm, and only their confirmation moves the task on
 * (`opening_step_must_be_presented`, `task-tools.ts`). So the subject answers, waits for that answer's final reply, and
 * confirms; the turn that reads the confirmation advances to `diagnosing`, ends with nothing queued, and the assistant
 * takes up the step it now holds as a `task_step` turn with no further message. A turn of that kind appears, declared on
 * its Metadata.
 *
 * Needs the turn queue on (`-c turnQueue=true`): where it is off an idle assistant takes up only a task's first step
 * (ADR-063 decision H1), and this spec skips.
 *
 * GATED: it changes a deployed assistant's active version, so it runs only with `E2E_WORKFLOW_TASK_PICKUP=1`, and with
 * `E2E_TURN_QUEUE=1` saying the deployment's turn queue is on.
 *
 * **Coverage:** `e2e/an-idle-assistant-takes-up-its-own-work.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange } from './helpers/admin-api';
import { idTokenFor } from './helpers/person';
import { guardBackendErrors } from './helpers/turn-guards';
import { ADMIN_API_URL, PERSON_API_URL } from './helpers/api-urls';
import { channelArnFor } from './helpers/battle-state-backend';
import { aws } from './helpers/aws';
import { activate, activeVersionOf, draftWith, openConversation, rollBack, sleep, waitFor } from './helpers/workflow-task';

const MARK = `PICKUP-${Date.now().toString(36)}`;

test.describe.serial('an idle assistant takes up its own work', () => {
  guardBackendErrors('an-idle-assistant-takes-up-its-own-work');
  let admin: any;
  let previousVersion: number | undefined;

  test.beforeAll(async () => {
    test.skip(process.env.E2E_WORKFLOW_TASK_PICKUP !== '1', 'changes a deployed assistant\'s active version; set E2E_WORKFLOW_TASK_PICKUP=1 to run it');
    test.skip(process.env.E2E_TURN_QUEUE !== '1', 'an idle assistant takes up work only where the turn queue is on; set E2E_TURN_QUEUE=1 on such a deployment');
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

  test('after the person answers, the assistant works the step it holds with no further message', async () => {
    test.setTimeout(12 * 60_000);
    const valid = await draftWith(admin, {
      'e2e-task-pickup': {
        on: 'assistant-joined', initial: 'opening',
        states: {
          opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'work', onFailure: 'work' },
          work: { task: { machine: 'guided_troubleshooting', for: 'subject', visibility: 'conversation', priority: 'high', deadline: { afterMinutes: 60 } }, onSuccess: 'done', onFailure: 'done' },
          done: { disposition: 'success' },
        },
      },
    });
    expect(valid.errors ?? [], JSON.stringify(valid).slice(0, 600)).toEqual([]);
    await activate(admin);
    await sleep(35_000);
    const conv = await openConversation(`Pickup ${MARK}`);
    const say = (text: string) => aws(`chime-sdk-messaging send-channel-message --channel-arn ${channelArnFor(conv.channelId)} --chime-bearer ${conv.personArn} --type STANDARD --persistence PERSISTENT --content "${encodeURIComponent(text)}"`);
    const pickedUp = (m: { metadata: Record<string, any> }) => m.metadata?.turnKind === 'task_step';
    const finalTaskReply = (m: { sender: string; metadata: Record<string, any> }) => m.sender !== conv.personArn
      && m.metadata?.respPhase === 'final' && m.metadata?.activeTask?.type === 'guided_troubleshooting';
    // The task's first step awaits the person it is for; they answer it in the conversation.
    await sleep(20_000);
    say(`${MARK}: the export job fails with a timeout since this morning, nothing changed on our side, and retrying did not help.`);
    // The step is presented: the reply to the answer says back what it is taking, and the subject confirms it.
    const played = await waitFor(conv.channelId, conv.personArn, (m) => pickedUp(m) || finalTaskReply(m), 3 * 60_000);
    expect(played.hit, `no reply to the answer; seen ${JSON.stringify(played.seen.map((m) => m.metadata?.turnKind ?? m.metadata?.respPhase).filter(Boolean))}`).toBeDefined();
    if (!pickedUp(played.hit!)) say(`${MARK}: yes, that is all correct and there is nothing to add. Please go ahead and diagnose it.`);
    const { hit, seen } = await waitFor(conv.channelId, conv.personArn, pickedUp, 6 * 60_000);
    expect(hit, `no pickup turn; kinds seen ${JSON.stringify(seen.map((m) => m.metadata?.turnKind).filter(Boolean))}`).toBeDefined();
    expect(hit!.metadata.taskStep?.taskType).toBe('guided_troubleshooting');
  });
});
