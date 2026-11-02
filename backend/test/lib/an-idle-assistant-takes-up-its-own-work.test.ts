/**
 * AN IDLE ASSISTANT TAKES UP ITS OWN WORK (ADR-063 slice T5, decision 5; ADR-033 "then one task at a time").
 *
 * What it proves: ready, blocked and waiting are read from machine and task data alone (`pickupReadiness`); ready work
 * is taken in one total order, priority then age then id; at a turn's exit with nothing queued the lock is handed to a
 * pickup turn for the first ready task in one conditional write, or released only while no task was named ready
 * meanwhile, so a naming that lands between the read and the release is found on a second look; a step is taken up
 * once per entry; the pickup turn is declared `task_step` and spends the owner's budget only for a queued request;
 * the router takes the lock for a task named ready, records it on the turn record when the lock is held, and with the
 * turn queue off dispatches only a task's first step.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { orderForPickup, pickupBudget, pickupClaimState, pickupCorrelationId, pickupReadiness } from '../../lambda/src/lib/workflow-task';
import { handOverToPickup } from '../../lambda/src/lib/turn-handover';
import { TURN_KINDS } from '../../lambda/src/lib/turn-declaration';
import { ANSWERS_NO_MESSAGE_KINDS } from '../../lambda/src/lib/interaction-kinds';
import type { Task } from '../../lambda/src/lib/task-tracking';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const M = DEFAULT_TASK_STATE_MACHINES;
const BOT = 'opsbot';
const CH = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';

const task = (over: Partial<Task> = {}): Task => ({
  taskId: 't1', channelArn: CH, userArn: '', status: 'pending', deliveryOption: 'TASK_MULTI_STEP' as never,
  taskType: 'queued_request', taskState: 'accepted', assigneeId: BOT, assigneeType: 'assistant',
  createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', ttl: 0, ...over,
});

describe('ready, blocked and waiting, from data alone (decision 5)', () => {
  it('a step the assistant holds that awaits nobody is ready', () => {
    expect(pickupReadiness(task(), M, BOT)).toEqual({ ready: true });
    expect(pickupReadiness(task({ taskType: 'guided_troubleshooting', taskState: 'diagnosing' }), M, BOT)).toEqual({ ready: true });
  });

  it('requires waiting: a terminal state, a state awaiting another party, a resting state', () => {
    expect(pickupReadiness(task({ taskState: 'completed' }), M, BOT)).toMatchObject({ hold: 'terminal' });
    expect(pickupReadiness(task({ taskState: 'proposed' }), M, BOT)).toMatchObject({ hold: 'awaits-another' });
    expect(pickupReadiness(task({ taskType: 'incident_first_look', taskState: 'findings_shared' }), M, BOT)).toMatchObject({ hold: 'rests' });
    expect(pickupReadiness(task({ taskType: 'queue_drain', taskState: 'waiting' }), M, BOT)).toMatchObject({ hold: 'rests' });
  });

  it('a state awaiting the worker is ready only when the worker is this assistant', () => {
    const t = task({ taskType: 'approval', taskState: 'deciding', workerId: BOT, workerType: 'assistant' });
    expect(pickupReadiness(t, M, BOT)).toEqual({ ready: true });
    expect(pickupReadiness({ ...t, workerId: 'other', workerType: 'assistant' }, M, BOT)).toMatchObject({ hold: 'awaits-another' });
  });

  it('blocked: not this assistant\'s, not live, an action the platform runs, taken up already, or worked in this entry', () => {
    expect(pickupReadiness(task({ assigneeId: 'p1', assigneeType: 'user' }), M, BOT)).toMatchObject({ hold: 'not-assigned' });
    expect(pickupReadiness(task({ status: 'abandoned' }), M, BOT)).toMatchObject({ hold: 'not-live' });
    const withAction = { ...M, flow: { initial: 'a', states: { a: { transitions: ['b'], action: { tool: 'x' }, onSuccess: 'b' }, b: { transitions: [], terminal: 'success' as const } } } };
    expect(pickupReadiness(task({ taskType: 'flow', taskState: 'a' }), withAction as never, BOT)).toMatchObject({ hold: 'runs-an-action' });
    expect(pickupReadiness(task({ actionRuns: [`${pickupClaimState('accepted')}#0`] }), M, BOT)).toMatchObject({ hold: 'taken-up' });
    expect(pickupReadiness(task({ turnsInState: 1 }), M, BOT)).toMatchObject({ hold: 'worked-this-entry' });
  });

  it('a state entered again is a new entry, ready once more', () => {
    const again = task({ actionRuns: [`${pickupClaimState('accepted')}#0`], stateHistory: [{ from: 'proposed', to: 'accepted' } as never] });
    expect(pickupReadiness(again, M, BOT)).toEqual({ ready: true });
  });
});

describe('the order and the budget (decisions 5 and I3)', () => {
  it('high, then normal, then low; the oldest first within one; then by id', () => {
    const tasks = [
      task({ taskId: 'c', priority: 'low', createdAt: '2026-01-01' }),
      task({ taskId: 'b', createdAt: '2026-03-01' }),
      task({ taskId: 'a', createdAt: '2026-02-01' }),
      task({ taskId: 'z', priority: 'high', createdAt: '2026-04-01' }),
      task({ taskId: 'y', createdAt: '2026-02-01' }),
    ];
    expect(orderForPickup(tasks).map((t) => t.taskId)).toEqual(['z', 'a', 'y', 'b', 'c']);
  });

  it('a queued request spends its owner\'s budget; every other pickup the global one', () => {
    expect(pickupBudget(task({ ownerPersonId: 'p1' }))).toEqual({ owner: 'p1' });
    expect(pickupBudget(task({ taskType: 'approval', ownerPersonId: 'p1' }))).toBe('machineWritten');
    expect(pickupBudget(task())).toBe('machineWritten');
  });

  it('one correlation per task, state and entry, so two namings collapse into one turn', () => {
    expect(pickupCorrelationId(task())).toBe(pickupCorrelationId(task()));
    expect(pickupCorrelationId(task())).not.toBe(pickupCorrelationId(task({ stateHistory: [{ to: 'accepted' } as never] })));
    expect(pickupCorrelationId(task())).toMatch(/^pickup-[0-9a-f]{32}$/);
  });
});

describe('at a turn\'s exit with nothing queued (the first event)', () => {
  const args = { channelArn: CH, botArn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/opsbot', correlationId: 'turn-1', classification: 'standard' };
  const deps = (over: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      d: {
        takePending: async () => { calls.push('take'); return []; },
        ready: async () => [] as Task[],
        handOver: async ({ to }: { to: string }) => { calls.push(`handover:${to.slice(0, 7)}`); return true; },
        release: async () => { calls.push('release'); return 'released' as const; },
        releaseHeld: async () => { calls.push('release-held'); return true; },
        dispatch: async () => { calls.push('dispatch'); return true; },
        ...over,
      } as never,
    };
  };

  it('hands the lock to a pickup turn for the first ready task, in pickup order, and dispatches it', async () => {
    let asked: Record<string, unknown> = {};
    const { d, calls } = deps({ ready: async (q: Record<string, unknown>) => { asked = q; return [task({ taskId: 'next' })]; } });
    expect(await handOverToPickup(args, d)).toBe(true);
    expect(asked).toEqual({ channelArn: CH, assistantId: 'opsbot' });
    expect(calls).toEqual(['take', 'handover:pickup-', 'dispatch']);
  });

  it('with nothing ready it releases, conditionally', async () => {
    const { d, calls } = deps();
    expect(await handOverToPickup(args, d)).toBe(true);
    expect(calls).toEqual(['take', 'release']);
  });

  it('a task named ready between the read and the release is found on a second look (the race)', async () => {
    let looks = 0;
    const { d, calls } = deps({
      ready: async () => (looks++ === 0 ? [] : [task({ taskId: 'late' })]),
      release: async () => { calls.push('release'); return 'pending' as const; },
    });
    expect(await handOverToPickup(args, d)).toBe(true);
    expect(calls).toEqual(['take', 'release', 'take', 'handover:pickup-', 'dispatch']);
  });

  it('a hand-off the router cannot be told of gives the lock back up', async () => {
    const { d, calls } = deps({ ready: async () => [task()], dispatch: async () => false });
    expect(await handOverToPickup(args, d)).toBe(true);
    expect(calls).toEqual(['take', 'handover:pickup-', 'release-held']);
  });

  it('a lost handover leaves the caller to release as it always did', async () => {
    const { d } = deps({ ready: async () => [task()], handOver: async () => false });
    expect(await handOverToPickup(args, d)).toBe(false);
  });
});

describe('the pickup is an ordinary task turn (one path)', () => {
  const processor = read('assistant-async-processor.ts');
  const core = read('lib/async-processor-core.ts');
  const router = read('router-agent-handler.ts');
  const dispatch = router.slice(router.indexOf('async function dispatchTaskPickup('), router.indexOf('export async function handleEventContinuation('));
  const payload = dispatch.slice(dispatch.indexOf('await invokeAsync(processorArn, {'), dispatch.indexOf('console.log(\'[Router][pickup]'));
  // The ordinary task-continuation dispatch, whose task fields a pickup carries the same way.
  const ordinaryTask = router.slice(router.indexOf('const [dispatched] = await Promise.all([invokeAsync(asyncProcessorArn, {'), router.indexOf('if (dispatched) lockToRelease = null;'));

  it('the processor has no branch of its own for it: the turn runs the ordinary pipeline, so delivery, step actions, splitting and attribution are the ordinary turn\'s', () => {
    expect(processor).not.toMatch(/event\.taskPickup/);
    // The task loop the ordinary path builds from the dispatch's task id: what runs a delivering step's document
    // (`declaredDocument`) and a newly entered state's declared action (`runStepActions`).
    expect(processor).toMatch(/const taskContext = await buildTaskLoopContext\(\{\n\s+taskId: event\.taskId,\n\s+taskType: event\.taskType,/);
    expect(core).toMatch(/await runStepActions\(taskContext, actionEnv\)/);
    // The only reader of the pickup in the processor is the one builder of the answer's metadata.
    const builder = core.slice(core.indexOf('export function declaredTurnKind('), core.indexOf('export async function finalizePlaceholderResponse('));
    expect([...core.matchAll(/event\.taskPickup/g)].length).toBe([...builder.matchAll(/event\.taskPickup/g)].length);
    expect(core).toMatch(/\.\.\.declaredTurnKind\(event\),/);
  });

  it('the router dispatches it with the ordinary task turn\'s fields, on an acknowledgment mapped to its correlation, declared task_step', () => {
    for (const field of ['channelArn', 'correlationId', 'userMessage', 'classification', 'botArn', 'taskId', 'taskType', 'taskCreated', 'isTaskContinuation', 'deliveryOption']) {
      const named = new RegExp(`^\\s+${field}[,:]`, 'm');
      expect(ordinaryTask).toMatch(named);
      expect(payload).toMatch(named);
    }
    expect(payload).toMatch(/placeholderMessageId,/);
    expect(payload).toMatch(/trigger: 'task_step'/);
    expect(dispatch).toMatch(/withTurnDeclaration\(`\$\{placeholder\} <!--corr:\$\{correlationId\}-->`, \{ kind: 'task_step' \}\)/);
    expect(dispatch).toMatch(/claimPlaceholderMapping\(correlationId, placeholderMessageId\)/);
    // Claimed once per entry BEFORE anything is posted, and metered before that.
    expect(dispatch.indexOf('evaluateAbuseGate(')).toBeLessThan(dispatch.indexOf('claimPickup('));
    expect(dispatch.indexOf('claimPickup(')).toBeLessThan(dispatch.indexOf('sendChannelMessage('));
    // A private task's acknowledgment, and so its answer, are its owner's alone.
    expect(dispatch).toMatch(/\.\.\.\(privately \? \{ Target: \[\{ MemberArn: ownerArn \}\] \} : \{\}\)/);
    expect(TURN_KINDS).toContain('task_step');
    expect(ANSWERS_NO_MESSAGE_KINDS).toContain('task_step');
  });

  it('the answer\'s metadata is the ordinary turn\'s, with the kind it declares', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { declaredTurnKind } = require('../../lambda/src/lib/async-processor-core');
    expect(declaredTurnKind({ taskPickup: { taskId: 't', state: 'accepted' }, taskType: 'queued_request' })).toEqual({ turnKind: 'task_step', taskStep: { taskType: 'queued_request', state: 'accepted' } });
    expect(declaredTurnKind({ triage: { ids: ['a', 'b'], pass: 1 } as never })).toEqual({ turnKind: 'reading', queueRead: 2, queuePass: 1 });
    expect(declaredTurnKind({})).toEqual({});
  });

  it('the router takes the lock for a task named ready, records it when held, and with the queue off runs only a first step', () => {
    const ready = router.slice(router.indexOf('async function handleTaskReady('), router.indexOf('export async function handleTaskPickup('));
    expect(ready).toMatch(/claimLockForPickup\(/);
    expect(ready).toMatch(/notePickupPending\(/);
    expect(ready).toMatch(/if \(!turnQueueEnabled\(\)\) \{\n\s+if \(taskHasBeenGivenATurn\(task\)\)/);
    const dispatch = router.slice(router.indexOf('async function dispatchTaskPickup('));
    expect(dispatch.indexOf('evaluateAbuseGate(')).toBeLessThan(dispatch.indexOf('invokeAsync('));
  });

  it('the exit reads ready work only through the task service, and releases conditionally on nothing named meanwhile', () => {
    const handover = read('lib/turn-handover.ts');
    expect(handover).toMatch(/from '\.\/task-store\.js'/);
    expect(handover).not.toMatch(/from '\.\/task-tracking\.js'.*readyTasks/);
    expect(read('lib/turn-lock.ts')).toMatch(/ConditionExpression: 'holder = :me AND attribute_not_exists\(pickupPending\)'/);
  });
});
