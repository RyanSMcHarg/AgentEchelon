/**
 * AN IMAGE IS ASKED FOR, CONFIRMED WHERE THE REQUEST IS INCOMPLETE, DRAWN AND REVISED (ADR-064 slice 3 and decision G),
 * as premium (the one shipped classification that selects an image model) on a Bedrock image model with a guardrail in
 * its region.
 *
 * `image_generation` is a multi-step task: the gathering and confirming turns run on a text model; the turn that
 * confirms the brief enters `generate`, whose `generate_image` action draws the recorded brief on the route's image
 * model, so that turn's reply carries the image and the task is done; a revision reopens it and draws again. The rows
 * show text turns in `gather`, `confirm` and `done`, each with a cost, and the reply that carries the image reports how
 * many it drew.
 *
 * A request that already carries the complete brief (the subject, the style and the composition) goes from `gather`
 * straight to `generate` in its own turn: its first reply carries the image, and no turn starts in `confirm`.
 *
 * GATED: real image calls are billed, so it runs only with `E2E_MODEL_ROUTES=1` and `E2E_IMAGE_STEPS=1`.
 *
 * **Coverage:** `e2e/an-image-is-asked-for-confirmed-drawn-and-revised.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { channelArnFor } from './helpers/battle-state-backend';
import { messagesSeenBy, openConversation, sleep } from './helpers/workflow-task';
import { adminSessionOrSkip, turnRowsOf } from './helpers/model-routes';

const MARK = `IMAGESTEP-${Date.now().toString(36)}`;

/** A conversation and a way to say something in it and read the reply to that message, oldest first. */
async function imageConversation(title: string) {
  const conv = await openConversation(title);
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
  return { conv, next };
}

test.describe.serial('an image is asked for, confirmed where the request is incomplete, drawn and revised', () => {
  guardBackendErrors('an-image-is-asked-for-confirmed-drawn-and-revised');
  let idToken = '';

  test.beforeAll(async () => {
    test.skip(process.env.E2E_MODEL_ROUTES !== '1' || process.env.E2E_IMAGE_STEPS !== '1', 'bills real image calls; set E2E_MODEL_ROUTES=1 and E2E_IMAGE_STEPS=1');
    const s = await adminSessionOrSkip();
    test.skip(!!s.skip, s.skip);
    idToken = s.idToken!;
  });

  test('an incomplete request is gathered and confirmed on text, the confirming turn returns the image, a revision draws again', async () => {
    test.setTimeout(20 * 60_000);
    const { conv, next } = await imageConversation(`Image steps ${MARK}`);

    await sleep(15_000);
    // No subject, no style, no composition: the brief is incomplete, so the assistant gathers it.
    const asked = await next(`${MARK}: I need a picture for our team newsletter.`);
    expect(asked.metadata?.activeTask?.type, 'the request opened an image task').toBe('image_generation');
    expect(Number(asked.metadata?.imageCount ?? 0), 'nothing is drawn from an incomplete request').toBe(0);
    // The brief completed over a later turn is confirmed, never drawn on the spot.
    const confirming = await next('A lighthouse on a rocky coast at dusk, watercolor style, warm light in the window, no people.');
    expect(Number(confirming.metadata?.imageCount ?? 0), 'no image is drawn before the brief is confirmed').toBe(0);
    const drawn = await next('Yes, that is exactly it. Go ahead.');
    expect(Number(drawn.metadata?.imageCount ?? 0), 'the confirming turn returns the image').toBeGreaterThan(0);
    const revised = await next('Make the sky a deeper purple, everything else the same.');
    expect(Number(revised.metadata?.imageCount ?? 0), 'a revision draws again').toBeGreaterThan(0);

    const rows = (await turnRowsOf(idToken, conv.channelArn, 4, 8 * 60_000)).filter((r) => r.task_type === 'image_generation');
    const steps = new Set(rows.map((r) => r.task_step));
    // The revision starts on the finished task, which it reopens into `revise`.
    for (const s of ['gather', 'confirm', 'done']) expect(steps.has(s), `a turn started in ${s}: ${JSON.stringify([...steps])}`).toBe(true);
    for (const r of rows) {
      expect(r.model_kind, `row ${r.message_id}`).toBe('text');
      expect(Number(r.cost_usd ?? 0), `row ${r.message_id} is priced`).toBeGreaterThan(0);
    }
  });

  test('a complete brief is drawn in the turn that asks for it, with no question and no confirmation', async () => {
    test.setTimeout(15 * 60_000);
    const { conv, next } = await imageConversation(`Image direct ${MARK}`);

    await sleep(15_000);
    const drawn = await next(`${MARK}: generate a watercolor of a red fox in snow at dusk, square framing with the fox centered, no text.`);
    expect(Number(drawn.metadata?.imageCount ?? 0), 'the first reply carries the image').toBeGreaterThan(0);

    const rows = (await turnRowsOf(idToken, conv.channelArn, 1, 8 * 60_000)).filter((r) => r.task_type === 'image_generation');
    expect(rows.length, 'one turn served the whole request').toBe(1);
    expect(rows[0].task_step, 'the turn started in gather and went straight to generate').toBe('gather');
    expect(rows[0].model_kind).toBe('text');
    expect(Number(rows[0].cost_usd ?? 0), 'the turn is priced, the image step included').toBeGreaterThan(0);
  });
});
