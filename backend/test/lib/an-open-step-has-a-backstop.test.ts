/**
 * AN OPEN STEP HAS A BACKSTOP (DESIGN-PROCESSES section 10). The run waits on the typed creator's hand-back, and a creator that stops outside
 * its own failure path hands nothing back, so the step holds its continuation on a wait record with a one-shot schedule, on the
 * scheduler every timed wait uses.
 *
 * What it proves:
 *  - the backstop's record is a wait's record, which the run-wait schedule fires, bounded to a few minutes;
 *  - backstop first: the step goes on its failure edge as `timed-out`, once, and the creator's late hand-back continues nothing;
 *  - hand-back first: the step goes on its success edge, and the backstop that fires later continues nothing;
 *  - the router holds the backstop after asking the creator, and its firing goes on as `timed-out`.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  SHIPPED_EVENT_WORKFLOWS, OPEN_STEP_OPENED, continueAfter, continuationClaim, runEventWorkflow, type EventRunDeps,
} from '../../lambda/src/lib/event-workflow';
import { OPEN_HAND_BACK_MINUTES, OPEN_WAIT_PREFIX, openBackstopWaitId } from '../../lambda/src/lib/held-run';
import { runWaitFiringOf } from '../../lambda/src/lib/event-deadlines';

const TEAM = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/team-ops-team-premium';
const wf = SHIPPED_EVENT_WORKFLOWS['incident-triage'];
const ctx = { event: 'event-received' as const, channelArn: TEAM, values: { label: 'X' } };

function run() {
  const claims = new Map<string, string>();
  const sent: string[] = [];
  const ended: string[] = [];
  const deps: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step, outcome) => { if (claims.has(step)) return false; claims.set(step, outcome); return true; },
    mentionName: async () => '',
    dispatchAgent: async () => true,
    send: async ({ step }) => { sent.push(step); return true; },
    openChild: async () => 'requested',
    wait: async () => 'waiting',
    ended: async (d) => { ended.push(d); },
  };
  return { deps, claims, sent, ended };
}

describe('an open step\'s backstop', () => {
  it('is a wait record the run-wait schedule fires, a few minutes out', () => {
    const id = openBackstopWaitId('run-1', 'open');
    expect(id.startsWith(OPEN_WAIT_PREFIX)).toBe(true);
    expect(runWaitFiringOf({ kind: 'wait', channelArn: TEAM, taskId: id })).toEqual({ kind: 'wait', channelArn: TEAM, taskId: id });
    expect(openBackstopWaitId('run-1', 'open')).toBe(id);
    expect(openBackstopWaitId('run-2', 'open')).not.toBe(id);
    expect(OPEN_HAND_BACK_MINUTES).toBeGreaterThanOrEqual(5);
    expect(OPEN_HAND_BACK_MINUTES).toBeLessThanOrEqual(15);
  });

  it('backstop first: the step takes its failure edge as timed-out, once, and the late hand-back continues nothing', async () => {
    const r = run();
    await runEventWorkflow('incident-triage', wf, ctx, r.deps, { from: 'open', transitions: [] });
    expect(r.claims.get('open')).toBe(OPEN_STEP_OPENED);
    const backstop = await continueAfter('incident-triage', wf, ctx, { step: 'open', outcome: 'timed-out', transitions: [] }, r.deps);
    expect(backstop.ran).toBe(true);
    expect(r.claims.get(continuationClaim('open'))).toBe('timed-out');
    // THE FAILURE EDGE ENDS THE TEAM'S RUN, saying nothing of an incident that was never opened.
    expect(r.sent).toEqual([]);
    expect(r.ended).toEqual(['success']);
    const late = await continueAfter('incident-triage', wf, { ...ctx, values: { ...ctx.values, conversation_link: '?conversation=c' } }, { step: 'open', outcome: OPEN_STEP_OPENED, transitions: [] }, r.deps);
    expect(late.ran).toBe(false);
    expect(r.sent).toEqual([]);
  });

  it('hand-back first: the step goes on, and the backstop that fires later continues nothing', async () => {
    const r = run();
    await runEventWorkflow('incident-triage', wf, ctx, r.deps, { from: 'open', transitions: [] });
    const back = await continueAfter('incident-triage', wf, ctx, { step: 'open', outcome: OPEN_STEP_OPENED, transitions: [] }, r.deps);
    expect(back.ran).toBe(true);
    expect(r.sent).toEqual(['tell']);
    const backstop = await continueAfter('incident-triage', wf, ctx, { step: 'open', outcome: 'timed-out', transitions: [] }, r.deps);
    expect(backstop.ran).toBe(false);
    expect(r.sent).toEqual(['tell']);
    expect(r.claims.get(continuationClaim('open'))).toBe(OPEN_STEP_OPENED);
  });

  it('the router holds the backstop once the creator is asked, and its firing goes on as timed-out', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const open = router.slice(router.indexOf('async function openChildConversation('), router.indexOf('async function scheduleOpenBackstop('));
    expect(open).toMatch(/InvocationType: InvocationType\.Event[\s\S]*await scheduleOpenBackstop\(ctx\.channelArn, args\.runKey, args\.step, continueRun[^)]*\);\n\s*return 'requested';/);
    const backstop = router.slice(router.indexOf('async function scheduleOpenBackstop('), router.indexOf('async function openWorkflowTaskStep('));
    expect(backstop).toMatch(/holdRunWait\(\{ waitId, channelArn, continuation \}\)/);
    expect(backstop).toMatch(/createTaskDeadlineSchedule\(wiring, \{ kind: 'wait', channelArn, taskId: waitId \}, new Date\(Date\.now\(\) \+ OPEN_HAND_BACK_MINUTES \* 60_000\)\)/);
    expect(router).toMatch(/if \(firing\.taskId\.startsWith\(OPEN_WAIT_PREFIX\)\) return handleEventContinuation\(\{ \.\.\.\(held as unknown as EventContinuation\), outcome: 'timed-out' \}\);/);
  });
});
