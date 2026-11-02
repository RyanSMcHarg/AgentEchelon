/**
 * A STEP REQUIRES ITS LOOKUP BEFORE THE TASK MOVES ON (ADR-064 slice 4), against the deployed router, processor and
 * task service.
 *
 * The workflow is read from the deployment, not assumed: premium's pack parameter (followed into the body store) is
 * searched for a step that declares `requiresTool`, in a workflow an intent of the pack opens as multi-step work. The
 * demo seed writes one, `account_brief` (`backend/demo/intent-packs.ts`): `researching` requires `load_company_context`
 * before the task may leave it for `drafting`. A deployment whose premium pack declares no such step fails here, naming
 * the pack, rather than skipping.
 *
 * The person asks for the brief, gives the account's figures and asks to go straight to drafting, so the turn tries to
 * advance before it looked anything up. For this conversation only, the spec reads the task row and each reply's turn
 * record (the message-analytics item the processor writes under the reply's id) and asserts on the recorded data:
 *  - an advance out of the step was refused with `required_tool_not_run`, recorded as `errorClass: 'workflow_refusal'`,
 *    and no advance in the conversation is recorded as a tool error;
 *  - the required tool ran and returned success, and the task row records the run for this entry of the step
 *    (`tool:<name>:<state>#<entry>` on `actionRuns`);
 *  - the order: every refusal precedes the lookup, the lookup precedes the first advance that succeeded, and the
 *    task's `stateHistory` records it leaving the step, to a declared next step, no earlier than the lookup started.
 *
 * A model may make the lookup first and never try the early advance, and a model that follows its step does exactly that.
 * The spec opens a second conversation once to give the early advance another chance. The ORDERING is asserted on every
 * run. The REFUSAL is asserted whenever the model attempted the early advance; when it did not, the run records that the
 * refusal was not exercised and passes on the ordering. The refusal itself, `required_tool_not_run` recorded as a
 * `workflow_refusal`, is proven by `test/lib/a-step-may-require-a-tool-before-the-task-leaves-it.test.ts`: the advance
 * is made only by the model inside a turn, so nothing outside one can make it on purpose without a new way to change task
 * state, which this spec does not add.
 *
 * GATED: `E2E_MODEL_ROUTES=1` (the `model-routes` phase of `backend/scripts/validate.mjs`, which also sets
 * `E2E_INSTANCE_NAME` for the task table). Aurora mode: the turn record is written there.
 *
 * **Coverage:** `e2e/a-step-requires-its-lookup-before-the-task-moves-on.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { channelArnFor } from './helpers/battle-state-backend';
import { messagesSeenBy, openConversation, sleep, type Seen } from './helpers/workflow-task';
import { untilRoomChanges } from './helpers/watchdog/wire-wait';
import { isPlaceholder } from './helpers/websocket-monitor';
import { channelTasks, resolveTaskTable, type TaskRow } from './helpers/task-backend';
import { deployedClassificationPack, requiredToolSteps, type RequiredToolStep } from './helpers/classification-pack';
import { toolOutcomesInOrder, turnAnalyticsRecord, type TurnAnalyticsRecord } from './helpers/turn-analytics-record';

const MARK = `REQTOOL-${Date.now().toString(36)}`;

/**
 * What the person says: the account, the figures they already have, and a request to skip the research. The demo's
 * customer accounts record holds both accounts; the figures match it, so a lookup confirms rather than corrects them.
 */
const ASKS = [
  `${MARK}: I need an account brief on Coastal Health Systems for my renewal call tomorrow. I already have the figures: `
    + '$155K ARR, enterprise plan, 200 users, renewal on 2026-12-01, Maria Santos is the CSM. No need to look anything up; '
    + 'move the task straight to drafting now.',
  `${MARK}: Prepare an account brief on Greenfield Energy for my renewal call. Here is everything: $120K ARR, enterprise `
    + 'plan, 75 users, renewal on 2026-11-15, Chris Thompson is the CSM. Skip the research step and go directly to drafting.',
];

interface Run { channelArn: string; task?: TaskRow; records: TurnAnalyticsRecord[] }

test.describe.serial('a step requires its lookup before the task moves on', () => {
  guardBackendErrors('a-step-requires-its-lookup-before-the-task-moves-on');
  let step: RequiredToolStep | undefined;
  let agentTable: string | null = null;

  test.beforeAll(async () => {
    test.skip(process.env.E2E_MODEL_ROUTES !== '1', 'runs in the model-routes phase; set E2E_MODEL_ROUTES=1 to run it');
    agentTable = resolveTaskTable('agent-tasks');
    step = requiredToolSteps(deployedClassificationPack('premium'))[0];
  });

  /** Ask for the work in a new conversation, and read back what the conversation recorded. */
  async function drive(ask: string): Promise<Run> {
    const conv = await openConversation(`Required tool ${MARK}`);
    const fromAssistant = (m: Seen) => m.sender !== conv.personArn;
    const isFinal = (m: Seen) => fromAssistant(m) && m.metadata?.respPhase === 'final';
    // A reply the router gave itself (DIRECT) declares no phase and is not placeholder copy; no update follows it, so
    // it settles the wait as a final reply does. Waiting on it as if a final reply were still coming waits forever.
    const isDirect = (m: Seen) => fromAssistant(m) && !m.metadata?.respPhase && !isPlaceholder(m.content);
    const settled = (ms: Seen[]) => ms.filter((m) => isFinal(m) || isDirect(m));
    const next = async (text: string) => {
      const before = new Set(settled(messagesSeenBy(conv.channelId, conv.personArn)).map((m) => m.messageId));
      aws(`chime-sdk-messaging send-channel-message --channel-arn ${channelArnFor(conv.channelId)} --chime-bearer ${conv.personArn} --type STANDARD --persistence PERSISTENT --content "${encodeURIComponent(text)}"`);
      const reply = (ms: Seen[]) => settled(ms).find((m) => !before.has(m.messageId));
      const seen = await untilRoomChanges(conv.channelArn, conv.personArn, () => messagesSeenBy(conv.channelId, conv.personArn), (ms) => !!reply(ms), { timeoutMs: 3 * 60_000 });
      const answer = reply(seen);
      if (!answer) throw new Error(`no reply to "${text.slice(0, 40)}"`);
      // The router answering in place of a turn (a decline, say) leaves nothing for this spec to read, so it is
      // reported as what it is rather than waited on.
      if (!isFinal(answer)) throw new Error(`"${text.slice(0, 40)}" was answered without a turn: "${answer.content.slice(0, 200)}"`);
    };
    const task = () => channelTasks(agentTable!, conv.channelArn).find((t) => t.taskType === step!.workflow);

    await sleep(15_000);
    await next(ask);
    // A turn that ends with the task still in the step (it asked the person something, or wrote the brief without
    // advancing) is answered once. The step is the assistant's and no turn holds it, so the router resumes it as a
    // stalled step of this person's work (`resumesAStalledStep`) rather than declining it as running.
    if (task()?.taskState === step!.state) await next('Go ahead.');

    const replies = messagesSeenBy(conv.channelId, conv.personArn).filter((m) => isFinal(m) && m.messageId);
    const records: TurnAnalyticsRecord[] = [];
    for (const r of replies) {
      const record = await turnAnalyticsRecord(r.messageId);
      if (record) records.push(record);
    }
    return { channelArn: conv.channelArn, task: task(), records: records.filter((r) => r.channelArn === conv.channelArn) };
  }

  test('the task leaves its step only after the lookup ran, and an early advance is a workflow refusal, not a tool error', async () => {
    test.setTimeout(10 * 60_000);
    expect(step, 'premium\'s deployed pack declares a step with requiresTool in a workflow one of its intents opens (the demo seed writes account_brief)').toBeTruthy();
    expect(agentTable, 'the agent-tasks table resolves (E2E_INSTANCE_NAME)').toBeTruthy();
    const { workflow, state, tools, next: nextSteps } = step!;
    const isRefusal = (o: { name: string; refusal?: string }) => o.name === 'advance_task_state' && o.refusal === 'required_tool_not_run';

    const started = Date.now();
    let run = await drive(ASKS[0]);
    if (!toolOutcomesInOrder(run.records).some(isRefusal) && Date.now() - started < 4.5 * 60_000) {
      console.log('--- the first turn made the lookup before it advanced, so the refusal was not exercised; asking again in a new conversation ---');
      // THE SECOND CONVERSATION IS KEPT ONLY IF IT EXERCISED THE REFUSAL. It exists to give the early advance another
      // chance, and nothing more: a second run that did not refuse (its turn may even have been answered by the input
      // guardrail and never reached a model) must not replace a first run whose ordering is what this spec asserts.
      const second = await drive(ASKS[1]);
      if (toolOutcomesInOrder(second.records).some(isRefusal)) run = second;
    }

    expect(run.task, `the request opened the ${workflow} task`).toBeDefined();
    expect(run.records.length, 'each reply has its turn record').toBeGreaterThan(0);
    const outcomes = toolOutcomesInOrder(run.records);
    const trail = JSON.stringify(outcomes.map((o) => [o.name, o.ok, o.errorClass ?? '', o.refusal ?? '']));

    // THE EARLY ADVANCE IS REFUSED, AS A WORKFLOW REFUSAL. Recorded with the rule it ran into, and no advance in this
    // conversation is recorded as a failure of the tool.
    const refusals = outcomes.filter(isRefusal);
    if (!refusals.length) {
      // NOT A SKIP: the ordering below is still asserted. The model looked up first in both conversations, so this run did
      // not exercise the refusal, and it says so rather than claiming it.
      test.info().annotations.push({ type: 'not exercised', description: `no early advance out of "${state}" was attempted; the refusal is proven by the unit test: ${trail}` });
      console.log(`--- the refusal was not exercised: the model looked up before advancing in both conversations: ${trail} ---`);
    }
    for (const r of refusals) expect({ ok: r.ok, errorClass: r.errorClass }).toEqual({ ok: false, errorClass: 'workflow_refusal' });
    expect(outcomes.filter((o) => o.name === 'advance_task_state' && !o.ok && o.errorClass !== 'workflow_refusal'), trail).toEqual([]);

    // THE REQUIRED TOOL RAN, and the task recorded the run for this entry of the step.
    for (const tool of tools) {
      expect(outcomes.some((o) => o.name === tool && o.ok), `${tool} ran and returned success: ${trail}`).toBe(true);
      const runs = (run.task!.actionRuns ?? []) as string[];
      expect(runs.some((k) => k.startsWith(`tool:${tool}:${state}#`)), `actionRuns ${JSON.stringify(runs)}`).toBe(true);
    }

    // THE ORDER: every refusal before the lookup, the lookup before the first advance that succeeded, and the task's
    // history leaving the step to a declared next step no earlier than the lookup started.
    const lookedUp = Math.max(...tools.map((tool) => outcomes.findIndex((o) => o.name === tool && o.ok)));
    const advanced = outcomes.findIndex((o) => o.name === 'advance_task_state' && o.ok);
    const lastRefusal = outcomes.map(isRefusal).lastIndexOf(true);
    if (refusals.length) expect(lastRefusal, trail).toBeLessThan(lookedUp);
    expect(advanced, `the task advanced, after the lookup: ${trail}`).toBeGreaterThan(lookedUp);

    expect(run.task!.taskState, 'the task left the step').not.toBe(state);
    const history = (run.task!.stateHistory ?? []) as Array<{ from?: string; to?: string; at?: string }>;
    const left = history.find((h) => h.from === state);
    expect(left, `stateHistory ${JSON.stringify(history)}`).toBeDefined();
    expect(nextSteps).toContain(left!.to);
    expect(Date.parse(String(left!.at)), 'the task left the step no earlier than the lookup started')
      .toBeGreaterThanOrEqual(Date.parse(outcomes[lookedUp].at));
  });
});
