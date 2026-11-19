/**
 * A RESOLVED INCIDENT NO LONGER HOLDS ITS TEAM CONVERSATION (SPEC-WORKFLOWS-AND-TASKS WT122, WT129; DESIGN-PROCESSES O19, O24).
 *
 * What it proves: an incident's run goes on past its resolve to the investigation and the post-incident review, and its team
 * conversation stops counting it as open at the resolve, not at the run's end. The resolve tells the team's wait the incident
 * succeeded (`moveRunOn`), which goes on and says nothing there, since the incident's `tell-team` step has already said
 * "resolved"; the team's open incidents (`openIncidents`) then leave it out, so a new alarm for the same resource opens a
 * new incident and incidents in review do not fill the room's cap. The run's end, told again, says nothing more. An incident
 * not yet resolved still counts (DENY), and so does one whose wait cannot be read (DENY).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockReadRunWait = jest.fn();
const mockReadEventSteps = jest.fn();
const mockOpenTasks = jest.fn();
const mockReadContext = jest.fn();

jest.mock('../../lambda/src/lib/task-store.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store.js'),
  readRunWait: (...a: unknown[]) => mockReadRunWait(...a),
  readEventSteps: (...a: unknown[]) => mockReadEventSteps(...a),
  openTasksOpenedFrom: (...a: unknown[]) => mockOpenTasks(...a),
}));
jest.mock('../../lambda/src/lib/channel-context-client.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/channel-context-client.js'),
  readChannelContext: (...a: unknown[]) => mockReadContext(...a),
}));

import { openIncidents } from '../../lambda/src/router-agent-handler';
import { childEndWaitId, holdUntilEnded, meetHeldRun, type HeldRunRecords } from '../../lambda/src/lib/held-run';
import { SHIPPED_EVENT_WORKFLOWS, childEndedOutcome, continueAfter, type EventRunContext, type EventRunDeps } from '../../lambda/src/lib/event-workflow';
import { DEV_EVENT_POLICY } from '../../lambda/src/lib/event-policy';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst';
const TEAM = `${APP}/channel/team-ops-team-premium`;
const ALARM = 'arn:aws:cloudwatch:us-east-1:111122223333:alarm:checkout-errors';
const team = SHIPPED_EVENT_WORKFLOWS['incident-triage'];

/** The wait records and step claims, kept as the task service keeps them: each written once. */
let records: Map<string, Record<string, unknown>>;
let claims: Map<string, string>;
let children: Array<{ channelId: string; typeKey: string; openedAt: string }>;
const RECORDS: HeldRunRecords = {
  hold: async ({ waitId, channelArn, continuation }) => {
    const k = `${channelArn}|${waitId}`;
    if (records.has(k)) return { claimed: false, reason: 'already_claimed' };
    records.set(k, continuation);
    return { claimed: true };
  },
  read: async ({ waitId, channelArn }) => records.get(`${channelArn}|${waitId}`) ?? null,
};

/** The team conversation's run for one incident, as the router continues it: its claims are the run's own. */
function teamRun(runKey: string) {
  const sent: string[] = [];
  const ctx: EventRunContext = {
    event: 'event-received', channelArn: TEAM, values: { resource: ALARM, label: 'checkout errors' },
    gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
  };
  const deps: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step, outcome) => {
      const k = `${runKey}|${TEAM}|${step}`;
      if (claims.has(k)) return false;
      claims.set(k, outcome);
      return true;
    },
    mentionName: async () => 'Jordan',
    dispatchAgent: async () => true,
    send: async (msg) => { sent.push(msg.template); return true; },
    openTask: async () => 'opened',
    ended: async () => undefined,
  };
  return { ctx, deps, sent };
}

/** An incident the team's run opened and now waits on, its run held first, as it is once the incident conversation opens. */
async function opened(id: string): Promise<{ child: string; runKey: string }> {
  const child = `${APP}/channel/${id}`;
  const runKey = `team-run-${id}`;
  children.push({ channelId: id, typeKey: 'ops', openedAt: new Date().toISOString() });
  expect(await holdUntilEnded(RECORDS, childEndWaitId(child), TEAM, { runKey, workflow: 'incident-triage', step: 'hold', event: 'event-received', channelArn: TEAM, values: { resource: ALARM } }))
    .toEqual({ held: true });
  return { child, runKey };
}

/**
 * What the incident's run tells its team conversation (`tellOpener`): the ending meets the team's held wait, and the team's run
 * goes on from it through `continueAfter`, as `handleEventContinuation` carries it.
 */
async function tell(child: string, runKey: string, ending: 'success' | 'ended'): Promise<string[]> {
  const outcome = childEndedOutcome(ending);
  const met = await meetHeldRun(RECORDS, childEndWaitId(child), TEAM, outcome);
  const run = teamRun(runKey);
  if ('run' in met) await continueAfter('incident-triage', team, run.ctx, { step: String(met.run.step), outcome }, run.deps);
  return run.sent;
}

beforeEach(() => {
  records = new Map();
  claims = new Map();
  children = [];
  mockReadRunWait.mockReset().mockImplementation((input: { waitId: string; channelArn: string }) => RECORDS.read(input));
  mockReadEventSteps.mockReset().mockImplementation(async ({ runKey, channelArn, steps }: { runKey: string; channelArn: string; steps: string[] }) =>
    Object.fromEntries(steps.filter((s) => claims.has(`${runKey}|${channelArn}|${s}`)).map((s) => [s, claims.get(`${runKey}|${channelArn}|${s}`)])));
  // THE LEAD'S OWNERSHIP TASK SETTLED AT THE RESOLVE, so no open ownership task names the incident; its wait is what counts.
  mockOpenTasks.mockReset().mockResolvedValue([]);
  mockReadContext.mockReset().mockImplementation(async () => ({ channelArn: TEAM, children }));
});

describe('the resolve, not the run\'s end, frees the team conversation', () => {
  it('an incident counts as open until its resolve, and not after it, while its run goes on to the review', async () => {
    const a = await opened('incident-a');
    expect((await openIncidents(TEAM, 'ops'))?.map((e) => e.resource)).toEqual([ALARM]);
    // THE RESOLVE: the team's wait goes on and says nothing; "resolved" was the incident run's own `tell-team`.
    expect(await tell(a.child, a.runKey, 'success')).toEqual([]);
    expect(await openIncidents(TEAM, 'ops')).toEqual([]);
  });

  it('after a resolve, a new alarm for the same resource is not refused as one already open', async () => {
    const a = await opened('incident-a');
    await tell(a.child, a.runKey, 'success');
    const open = (await openIncidents(TEAM, 'ops'))!;
    // THE REFUSAL `handleRuleEvent` makes for the same resource finds nothing, so the alarm opens a new incident.
    expect(open.find((e) => e.resource === ALARM)).toBeUndefined();
    expect(open.length).toBeLessThan(DEV_EVENT_POLICY.maxOpenIncidentsPerRoom);
  });

  it('incidents in review do not count toward the room\'s cap', async () => {
    const cap = DEV_EVENT_POLICY.maxOpenIncidentsPerRoom;
    for (let i = 0; i < cap; i += 1) {
      const x = await opened(`incident-${i}`);
      await tell(x.child, x.runKey, 'success');
    }
    expect((await openIncidents(TEAM, 'ops'))!.length).toBe(0);
  });

  it('one resolved before the team\'s run reached its wait is not counted either', async () => {
    const child = `${APP}/channel/incident-early`;
    children.push({ channelId: 'incident-early', typeKey: 'ops', openedAt: new Date().toISOString() });
    expect(await meetHeldRun(RECORDS, childEndWaitId(child), TEAM, childEndedOutcome('success'))).toEqual({ recorded: true });
    expect(await openIncidents(TEAM, 'ops')).toEqual([]);
  });

  it('the run\'s end, told after the resolve, says nothing more in the team conversation, however it ended', async () => {
    const a = await opened('incident-a');
    await tell(a.child, a.runKey, 'success');
    expect(await tell(a.child, a.runKey, 'ended')).toEqual([]);
    expect(await tell(a.child, a.runKey, 'success')).toEqual([]);
  });

  it('DENY: an incident not yet resolved still holds the room, and the same resource is refused', async () => {
    await opened('incident-a');
    const cap = DEV_EVENT_POLICY.maxOpenIncidentsPerRoom;
    for (let i = 1; i < cap; i += 1) await opened(`incident-${i}`);
    const open = (await openIncidents(TEAM, 'ops'))!;
    expect(open.find((e) => e.resource === ALARM)).toBeDefined();
    expect(open.length).toBe(cap);
  });

  it('DENY: a wait whose going on cannot be read counts as held, so the cap never opens on a failure', async () => {
    const a = await opened('incident-a');
    await tell(a.child, a.runKey, 'success');
    mockReadEventSteps.mockResolvedValue(null);
    expect((await openIncidents(TEAM, 'ops'))?.length).toBe(1);
    mockReadEventSteps.mockRejectedValue(new Error('throttled'));
    expect((await openIncidents(TEAM, 'ops'))?.length).toBe(1);
  });

  it('the resolve tells the conversation that opened the incident, once the run has moved on, and only a workflow-opened one', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const fn = router.slice(router.indexOf('async function moveRunOn('), router.indexOf('async function standingOf('));
    expect(fn.indexOf('await continueRunOn(')).toBeGreaterThan(-1);
    expect(fn.indexOf('await continueRunOn(')).toBeLessThan(fn.indexOf("await tellOpener(channelArn, 'success')"));
    expect(fn).toContain("if (run.event === 'conversation-opened' && run.values?.openedBy === 'workflow') await tellOpener(channelArn, 'success');");
  });
});
