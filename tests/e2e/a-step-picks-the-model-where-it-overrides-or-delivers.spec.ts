/**
 * A STEP PICKS THE MODEL WHERE IT OVERRIDES OR DELIVERS (ADR-064 slice 2), against the deployed router, processor and
 * archive.
 *
 * A draft of the premium primary whose `report_generation` and `general` routes name different models (the shipped
 * routes serve both on the base model), with a step override on `collecting_requirements`, is activated for the run:
 *  - the turns that start in `collecting_requirements` run on the override (`model_from: step`);
 *  - a "looks good" turn in the confirming step (`drafting_outline`, which produces text) runs on the general route
 *    (`model_from: route` when it is classified `general`, `general` when it answers through it) while the task stays in
 *    that step;
 *  - the document is written on the report route (`model_from: route`): by a turn that starts in `generating`, or by the
 *    confirming turn once its advance enters `generating`, which moves the rest of that turn onto the report route, so its
 *    row names the report route's model and the step it entered (`task_state`) beside the step it started in;
 *  - every row carries `task_type: report_generation` and the step the turn started in;
 *  - the task records the intent that opened it (`openingIntent`), on its row and on the copy a person's list reads.
 *
 * GATED: it changes the premium primary's active version and returns it, so it runs only with `E2E_MODEL_ROUTES=1`.
 *
 * **Coverage:** `e2e/a-step-picks-the-model-where-it-overrides-or-delivers.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { channelArnFor } from './helpers/battle-state-backend';
import { activate, activeVersionOf, messagesSeenBy, openConversation, rollBack, sleep } from './helpers/workflow-task';
import { untilRoomChanges } from './helpers/watchdog/wire-wait';
import { adminSessionOrSkip, draftModels, modelKeyOf, turnRowsOf } from './helpers/model-routes';
import { channelTasks, resolveTaskTable } from './helpers/task-backend';

const MARK = `STEPMODEL-${Date.now().toString(36)}`;
const MODELS = {
  byIntent: {
    general: { primary: 'haiku' },
    acknowledgment: { primary: 'haiku' },
    report_generation: { primary: 'sonnet', steps: { collecting_requirements: { primary: 'opus' } } },
  },
};

test.describe.serial('a step picks the model where it overrides or delivers', () => {
  guardBackendErrors('a-step-picks-the-model-where-it-overrides-or-delivers');
  let admin: any;
  let idToken = '';
  let previousVersion: number | undefined;

  test.beforeAll(async () => {
    test.skip(process.env.E2E_MODEL_ROUTES !== '1', 'changes the premium primary\'s active version; set E2E_MODEL_ROUTES=1 to run it');
    const s = await adminSessionOrSkip();
    test.skip(!!s.skip, s.skip);
    admin = s.admin;
    idToken = s.idToken!;
    previousVersion = await activeVersionOf(admin);
  });

  test.afterAll(async () => { if (admin) await rollBack(admin, previousVersion); });

  test('the override, the general route and the report route each serve their own turns, and the rows say which', async () => {
    test.setTimeout(20 * 60_000);
    const valid = await draftModels(admin, MODELS);
    expect(valid.errors ?? [], JSON.stringify(valid).slice(0, 600)).toEqual([]);
    await activate(admin);
    await sleep(35_000);

    const conv = await openConversation(`Step models ${MARK}`);
    const say = (text: string) => aws(`chime-sdk-messaging send-channel-message --channel-arn ${channelArnFor(conv.channelId)} --chime-bearer ${conv.personArn} --type STANDARD --persistence PERSISTENT --content "${encodeURIComponent(text)}"`);
    const isFinal = (m: { sender: string; metadata: Record<string, any> }) => m.sender !== conv.personArn && m.metadata?.respPhase === 'final';
    let answered = 0;
    // Send one message and wait until one more final reply than before has landed.
    const next = async (text: string) => {
      say(text);
      const want = ++answered;
      const seen = await untilRoomChanges(conv.channelArn, conv.personArn, () => messagesSeenBy(conv.channelId, conv.personArn), (ms) => ms.filter(isFinal).length >= want, { timeoutMs: 5 * 60_000 });
      if (seen.filter(isFinal).length >= want) return;
      throw new Error(`no final reply to "${text.slice(0, 40)}"`);
    };

    // THE TASK IS DRIVEN BY ITS STATE, not by a fixed count of messages. The requirements step reads back what it took and
    // asks for confirmation, and a model may read them back again before it outlines, so the confirmation is repeated
    // until the task leaves `collecting_requirements`. The subject is one the company's documents cover, so the outline
    // is not held up asking for source material.
    const agentTable = resolveTaskTable('agent-tasks');
    expect(agentTable, 'the agent-tasks table resolves (E2E_INSTANCE_NAME)').toBeTruthy();
    const reportTask = () => channelTasks(agentTable!, conv.channelArn).find((t) => t.taskType === 'report_generation');

    await sleep(15_000);
    await next(`${MARK}: write me a one-page status report on our Q2 ARR performance for the leadership team, with sections on progress, risks and next steps, in plain prose.`);
    for (let i = 0; i < 3 && reportTask()?.taskState === 'collecting_requirements'; i++) {
      await next('Yes, that is all right, and the default format is fine. Please outline it.');
    }
    expect(reportTask()?.taskState, 'the confirmed requirements move the task to the outline').toBe('drafting_outline');
    await next('Looks good.');
    // The approval is repeated only while the task still waits at its outline. Once it moves on, the report is written in
    // that same turn on the report route, so nothing more is sent: a closing thanks is a DIRECT reply through the
    // fulfillment, which carries no phase to count it by.
    for (let i = 0; i < 2 && reportTask()?.taskState === 'drafting_outline'; i++) await next('Yes, the outline is right. Please write it.');
    expect(reportTask()?.taskState, 'the approved outline moves the task on').not.toBe('drafting_outline');

    const rows = await turnRowsOf(idToken, conv.channelArn, answered, 8 * 60_000);
    const task = rows.filter((r) => r.task_type === 'report_generation');
    expect(task.length, `report turns seen: ${JSON.stringify(rows.map((r) => [r.task_type, r.task_step, r.model_from, r.bedrock_model]))}`).toBeGreaterThan(0);

    const gathering = task.filter((r) => r.task_step === 'collecting_requirements');
    expect(gathering.length).toBeGreaterThan(0);
    for (const r of gathering) expect({ from: r.model_from, model: modelKeyOf(r.bedrock_model) }).toEqual({ from: 'step', model: 'opus' });

    const confirming = task.filter((r) => r.task_step === 'drafting_outline');
    expect(confirming.length, 'a turn started in the confirming step').toBeGreaterThan(0);
    // THE MESSAGE'S INTENT DECIDES IN A STEP THAT NEITHER OVERRIDES NOR DELIVERS. "Looks good." is classified as `general`
    // (its own route, `route`) or as an acknowledgment that answers through `general` (`general`); either way the turn
    // runs on the general route's haiku, never on the report route's sonnet or the gathering step's opus. A confirming turn
    // whose advance enters `generating` (the outline's only edge) writes the document on the report route, and its row names
    // the model that wrote the reply and the rule that chose it.
    for (const r of confirming) {
      if (r.task_state && r.task_state !== 'drafting_outline') {
        expect({ from: r.model_from, model: modelKeyOf(r.bedrock_model) }, `the confirming turn that entered ${r.task_state}`).toEqual({ from: 'route', model: 'sonnet' });
        continue;
      }
      expect(modelKeyOf(r.bedrock_model), 'the confirming turn runs on the general route').toBe('haiku');
      expect(['route', 'general'], `model_from ${r.model_from}`).toContain(r.model_from);
    }

    // THE DOCUMENT IS WRITTEN ON THE REPORT ROUTE, by whichever turn writes it. A turn that starts in `generating` is one a
    // person's message started; the assistant taking up its own step (ADR-063) answers no message and has no row in the
    // flow, which lists the turns that answered something.
    const delivered = task.filter((r) => r.task_step === 'generating');
    for (const r of delivered) expect({ from: r.model_from, model: modelKeyOf(r.bedrock_model) }).toEqual({ from: 'route', model: 'sonnet' });
    const enteredDelivery = confirming.filter((r) => r.task_state && r.task_state !== 'drafting_outline');
    expect(delivered.length + enteredDelivery.length, `a turn wrote the document: ${JSON.stringify(task.map((r) => [r.task_step, r.task_state, r.model_from, r.bedrock_model]))}`).toBeGreaterThan(0);

    // THE TASK RECORDS THE INTENT THAT OPENED IT (ADR-064 decision B): a platform machine's turns route and are attributed
    // under it, and a pack intent's task records it the same way.
    const reports = channelTasks(agentTable!, conv.channelArn).filter((t) => t.taskType === 'report_generation');
    expect(reports.length, 'the report task row').toBeGreaterThan(0);
    for (const t of reports) expect(t.openingIntent, `task ${t.taskId}`).toBe('report_generation');
  });
});
