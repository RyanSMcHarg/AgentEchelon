/**
 * AN IMAGE EXPERIMENT ATTRIBUTES EVERY STEP TO ITS ARM (ADR-064 slice 6), as premium.
 *
 * An `intent` experiment on `image_generation` with `target: { kind: 'image' }` varies only the route's image model
 * (control `stability_image_core`, treatment `stability_image_ultra`). A conversation enrolled in it runs the whole
 * image task, and every turn of that task (gathering, confirming, revising, whatever each message was classified as)
 * carries the experiment's id and one arm's variant id, because a task's turns count by its type and a task stays on the
 * arm it was opened under while the experiment runs. The request opens incomplete and the brief is completed over a later
 * turn, so the task runs over several turns: gathered, confirmed, then drawn on the turn that confirms it (decision G). A
 * request that carried the complete brief would be drawn in its own turn and leave no later turn on the task to attribute.
 * The task row records that arm (`experimentArm`). Once the
 * experiment is paused, its arms are no longer served, so the task's next turn is served the live version and carries no
 * experiment (decision J). The experiment is deleted in afterAll.
 *
 * GATED: real image calls are billed, so it runs only with `E2E_MODEL_ROUTES=1` and `E2E_IMAGE_STEPS=1`.
 *
 * **Coverage:** `e2e/an-image-experiment-attributes-every-step-to-its-arm.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { channelArnFor } from './helpers/battle-state-backend';
import { signedCall } from './helpers/admin-api';
import { adminUrl } from './helpers/api-urls';
import { messagesSeenBy, openConversation, sleep } from './helpers/workflow-task';
import { adminSessionOrSkip } from './helpers/model-routes';
import { channelTasks, resolveTaskTable } from './helpers/task-backend';

const MARK = `IMGEXP-${Date.now().toString(36)}`;
const EXPERIMENT_ID = `e2e-image-target-${Date.now().toString(36)}`;

test.describe.serial('an image experiment attributes every step to its arm', () => {
  guardBackendErrors('an-image-experiment-attributes-every-step-to-its-arm');
  let admin: any;

  test.beforeAll(async () => {
    test.skip(process.env.E2E_MODEL_ROUTES !== '1' || process.env.E2E_IMAGE_STEPS !== '1', 'bills real image calls; set E2E_MODEL_ROUTES=1 and E2E_IMAGE_STEPS=1');
    const s = await adminSessionOrSkip();
    test.skip(!!s.skip, s.skip);
    admin = s.admin;
  });

  test.afterAll(async () => {
    if (!admin) return;
    await signedCall(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(EXPERIMENT_ID)}/status`), admin, 'POST', { status: 'paused' });
    await signedCall(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(EXPERIMENT_ID)}`), admin, 'DELETE');
  });

  test('every turn of an enrolled image task carries the experiment and its arm', async () => {
    test.setTimeout(20 * 60_000);
    const now = new Date();
    const created = await signedCall(adminUrl('assistant-admin', '/admin/experiments'), admin, 'POST', {
      experimentId: EXPERIMENT_ID, status: 'active', experimentType: 'intent', intent: 'image_generation',
      target: { kind: 'image' }, tiers: ['premium'],
      startDate: now.toISOString(), endDate: new Date(now.getTime() + 2 * 3600_000).toISOString(),
      variants: [
        { variantId: 'control', modelKey: 'stability_image_core', weight: 50 },
        { variantId: 'treatment', modelKey: 'stability_image_ultra', weight: 50 },
      ],
    });
    expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
    await sleep(70_000);

    const conv = await openConversation(`Image experiment ${MARK}`);
    const say = (text: string) => aws(`chime-sdk-messaging send-channel-message --channel-arn ${channelArnFor(conv.channelId)} --chime-bearer ${conv.personArn} --type STANDARD --persistence PERSISTENT --content "${encodeURIComponent(text)}"`);
    // Oldest first: the channel lists its messages newest first, and a reply is read by the turn it answers.
    const finals = () => messagesSeenBy(conv.channelId, conv.personArn).filter((m) => m.sender !== conv.personArn && m.metadata?.respPhase === 'final').reverse();
    let answered = 0;
    const next = async (text: string) => {
      say(text);
      const want = ++answered;
      for (const deadline = Date.now() + 6 * 60_000; Date.now() < deadline; await sleep(5_000)) {
        const f = finals();
        if (f.length >= want) return f[want - 1];
      }
      throw new Error(`no final reply to "${text.slice(0, 40)}"`);
    };
    await sleep(15_000);
    // No subject, no style, no composition: the brief is incomplete, so the task gathers it, confirms it once it is
    // complete, and draws on the turn that confirms it. Each of those turns is on the task, so each carries the arm.
    await next(`${MARK}: I need a picture for our team newsletter.`);
    await next('A lighthouse on a rocky coast at dusk, watercolor style, warm light in the window, no people.');
    const drawn = await next('Yes, that is exactly it. Go ahead.');
    expect(Number(drawn.metadata?.imageCount ?? 0), 'the confirming turn returns the image').toBeGreaterThan(0);

    const taskTurns = finals().filter((m) => m.metadata?.activeTask?.type === 'image_generation');
    expect(taskTurns.length, 'the image task ran over its gathering, confirming and drawing turns').toBe(3);
    const arms = new Set(taskTurns.map((m) => `${m.metadata?.experimentId}/${m.metadata?.variantId}`));
    expect([...arms].length, `every turn carries one arm: ${JSON.stringify([...arms])}`).toBe(1);
    expect([...arms][0]).toMatch(new RegExp(`^${EXPERIMENT_ID}/(control|treatment)$`));

    // THE TASK RECORDS THE ARM IT WAS OPENED UNDER, on its own field (decision J).
    const agentTable = resolveTaskTable('agent-tasks');
    const imageTask = agentTable ? channelTasks(agentTable, channelArnFor(conv.channelId)).find((t) => t.taskType === 'image_generation') : undefined;
    if (agentTable) {
      expect(imageTask, 'the image task row').toBeTruthy();
      expect(`${imageTask!.experimentArm?.experimentId}/${imageTask!.experimentArm?.variantId}`).toBe([...arms][0]);
    }

    // ONCE THE EXPERIMENT STOPS, THE TASK CARRIES ON WITH THE LIVE VERSION (decision J). Paused, its arms are no longer
    // served: the next turn on the task is answered by the live version and attributed to no experiment. The router reads
    // the experiment through a one-minute cache, so the turn is sent after it.
    const paused = await signedCall(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(EXPERIMENT_ID)}/status`), admin, 'POST', { status: 'paused' });
    expect(paused.status, JSON.stringify(paused.body).slice(0, 400)).toBe(200);
    await sleep(70_000);
    await next('Actually, make the lighthouse at night with the beam on.');
    const after = finals().at(-1);
    expect(after?.metadata?.experimentId, `the turn after the pause: ${JSON.stringify(after?.metadata ?? {}).slice(0, 300)}`).toBeFalsy();
  });
});
