/**
 * A RUN WAITS FOR A TIME (ADR-067 decision 2, WT20).
 *
 * What it proves: a wait step is { minutes }, from one minute to the longest a task step's deadline may be; the run holds
 * there once the wait is scheduled, claimed so a redelivered run schedules nothing twice, and a wait that could not be
 * scheduled goes on its failure edge now; when it comes due the run goes on its success edge, once; the schedule carries
 * ids only; and the router holds the continuation on the run's record, reading it back when the schedule fires.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { continueAfter, eventWorkflowErrors, MAX_WAIT_MINUTES, runEventWorkflow, type EventRunDeps, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { runWaitFiringOf } from '../../lambda/src/lib/event-deadlines';
import { childEndWaitId } from '../../lambda/src/lib/held-run';

const WF: EventWorkflow = {
  on: 'person-joined',
  initial: 'hello',
  states: {
    hello: { send: { to: 'joined', template: 'workflow-step-withheld' }, onSuccess: 'pause', onFailure: 'pause' },
    pause: { wait: { minutes: 60 }, onSuccess: 'later', onFailure: 'done' },
    later: { send: { to: 'joined', template: 'workflow-step-withheld' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as EventWorkflow;

const deps = (held: 'waiting' | 'failed') => {
  const sent: string[] = [];
  const waits: number[] = [];
  const claims = new Set<string>();
  const d: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step, outcome) => { const k = step.startsWith('after#') ? step : `${step}:${outcome}`; if (claims.has(k)) return false; claims.add(k); return true; },
    mentionName: async () => '', dispatchAgent: async () => true,
    send: async ({ step }) => { sent.push(step); return true; },
    wait: async (_s, def) => { waits.push(def.minutes!); return held; },
  };
  return { d, sent, waits };
};
const ctx = { event: 'person-joined' as const, channelArn: 'arn:ch', eventPerson: 'arn:x/user/p', values: {} };

describe('a wait step', () => {
  it('is { minutes }, from 1 to the longest a task step\'s deadline may be', () => {
    expect(eventWorkflowErrors('w', WF)).toEqual([]);
    for (const bad of [{ minutes: 0 }, { minutes: MAX_WAIT_MINUTES + 1 }, { minutes: 1.5 }, { minutes: 5, until: 'x' }, {}]) {
      const wf = { ...WF, states: { ...WF.states, pause: { ...WF.states.pause, wait: bad } } } as EventWorkflow;
      expect(eventWorkflowErrors('w', wf).join()).toMatch(/wait is \{ (minutes|until) \}/);
    }
  });

  it('holds the run once scheduled, and goes on its success edge once when it comes due', async () => {
    const { d, sent, waits } = deps('waiting');
    const out = await runEventWorkflow('w', WF, ctx, d);
    expect(waits).toEqual([60]);
    expect(out.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['hello:posted', 'pause:waiting']);
    expect(out.ended).toBeUndefined();
    await continueAfter('w', WF, ctx, { step: 'pause', outcome: 'waited' }, d);
    const again = await continueAfter('w', WF, ctx, { step: 'pause', outcome: 'waited' }, d);
    expect(again.ran).toBe(false);
    expect(sent).toEqual(['hello', 'later']);
  });

  it('a wait that could not be scheduled goes on its failure edge now', async () => {
    const { d, sent } = deps('failed');
    const out = await runEventWorkflow('w', WF, ctx, d);
    expect(out.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['hello:posted', 'pause:failed']);
    expect(out.ended).toBe('success');
    expect(sent).toEqual(['hello']);
  });

  it('its schedule carries ids only, and is read in its own shape', () => {
    expect(runWaitFiringOf({ kind: 'wait', channelArn: 'arn:x/channel/c', taskId: 'wait-abc123' })).toEqual({ kind: 'wait', channelArn: 'arn:x/channel/c', taskId: 'wait-abc123' });
    expect(runWaitFiringOf({ kind: 'wait', channelArn: 'arn:x/channel/c', taskId: 'evt-1' })).toBeNull();
    expect(runWaitFiringOf({ kind: 'task', channelArn: 'arn:x/channel/c', taskId: 'wait-abc' })).toBeNull();
  });

  it('the router holds the run\'s continuation on its record and reads it back when the schedule fires', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/if \(!\(await holdRunWait\(\{ waitId, channelArn: ctx\.channelArn, continuation: runContinuation\(step, transitions\) \}\)\)\.claimed\) return 'failed';/);
    expect(router).toMatch(/createTaskDeadlineSchedule\(wiring, \{ kind: 'wait', channelArn: ctx\.channelArn, taskId: waitId \}/);
    const fired = router.slice(router.indexOf('async function handleRunWaitFired('), router.indexOf('async function handleRunWaitFired(') + 2000);
    expect(fired).toContain('roomRefusal(await readChannelTags(chimeClient, firing.channelArn)');
    expect(fired).toMatch(/return handleEventContinuation\(\{ \.\.\.\(held as unknown as EventContinuation\), outcome: backstop \? childEndedOutcome\('timed-out'\) : WAIT_CAME \}\);/);
    // A WAIT ON THE OPENED CONVERSATION'S END is a wait's record, so its one-shot backstop fires through this same shape.
    expect(runWaitFiringOf({ kind: 'wait', channelArn: 'arn:x/channel/c', taskId: childEndWaitId('arn:x/channel/child') })).not.toBeNull();
    expect(router).toContain("await createTaskDeadlineSchedule(wiring, { kind: 'wait', channelArn: ctx.channelArn, taskId: waitId }, new Date(Date.now() + (MAX_WAIT_MINUTES + 24 * 60) * 60_000))");
  });
});
