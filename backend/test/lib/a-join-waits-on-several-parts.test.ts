/**
 * A JOIN WAITS ON SEVERAL PARTS A RUN STARTED IN PARALLEL (`wait: { join }`, SPEC-PROCESSES P14).
 *
 * What it proves, on two example workflows declared here (not shipped):
 *  - `all` goes on once every part that started has ended, whichever order they end in, and whether a part ended before the
 *    join was reached or after; a part whose step the run never reached is recorded as skipped and holds nothing;
 *  - `any` goes on at the first part to end, and a later part's ending continues nothing;
 *  - the edge is the success edge only where every part counted succeeded, and the failure edge reads why the first that did not
 *    succeed ended (`task:outcome`); the deadline takes `onDeadline`;
 *  - each part's hand-back is claimed once, and the join goes on once, so a redelivered hand-back continues nothing;
 *  - the outcome names every part, how it ended and which part the join waited on last, and reads back;
 *  - the validator refuses a join that names too few or too many parts, a part twice, a step of another kind or none at all, a
 *    part another join already names, and a join on an opened conversation the workflow also waits on with `wait: { child }`;
 *  - the shipped workflows declare no join, so the shipped incident response runs as it did.
 */
import {
  SHIPPED_EVENT_WORKFLOWS, JOIN_PART, OPEN_STEP_OPENED, WAIT_CAME, childEndedOutcome, continueAfter, continuationClaim, eventWorkflowErrors, joinDecision,
  joinOutcome, joinOutcomeOf, joinPartClaim, runEventWorkflow,
  type EventRunContext, type EventRunDeps, type EventTransition, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { alongsideEndWaitId, holdUntilEnded, joinPartWaitId, meetHeldRun, type HeldRunRecords } from '../../lambda/src/lib/held-run';
import { versionProcessesErrors } from '../../lambda/src/lib/event-workflow';
import { JOIN_E2E_PARTS, JOIN_E2E_STEP, JOIN_E2E_WORKFLOW, joinE2eProcess, joinE2eWorkflow } from '../../../tests/e2e/helpers/join-workflow';
import * as fs from 'fs';
import * as path from 'path';

const TEAM = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/team-ops-team-premium';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** TWO TASKS BESIDE THE WORK AND AN OPENED CONVERSATION, JOINED WITH `all`: a release goes out once all three are in. */
const RELEASE: EventWorkflow = {
  on: 'event-received',
  types: ['ops-team'],
  initial: 'security-review',
  states: {
    'security-review': {
      label: 'Security review', task: { machine: 'acknowledgement', by: { participantRole: 'on-call:ops' }, continue: 'alongside', assigned: { template: 'incident-investigation' }, deadline: { afterMinutes: 1440 } },
      onSuccess: 'docs-review', onFailure: 'docs-review',
    },
    'docs-review': {
      label: 'Docs review', task: { machine: 'acknowledgement', by: { participantRole: 'on-call:ops' }, continue: 'alongside', assigned: { template: 'incident-investigation' }, deadline: { afterMinutes: 1440 } },
      onSuccess: 'open-rollout', onFailure: 'open-rollout',
    },
    'open-rollout': { open: { type: 'ops', for: { typeRole: 'on-call:ops' } }, onSuccess: 'all-in', onFailure: 'all-in' },
    'all-in': {
      label: 'Everything is in', wait: { join: { of: ['security-review', 'docs-review', 'open-rollout'], when: 'all', minutes: 1440 } },
      onSuccess: 'ship', onFailure: [{ to: 'late', when: { 'task:outcome': 'timed-out' } }, { to: 'held-back' }], onDeadline: 'late',
    },
    ship: { send: { template: 'incident-declared', to: 'room', mention: { lead: 'participantRole:on-call:ops' } }, onSuccess: 'done', onFailure: 'done' },
    late: { send: { template: 'incident-timed-out', to: 'room' }, onSuccess: 'done', onFailure: 'done' },
    'held-back': { send: { template: 'incident-ended-unresolved', to: 'room' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
};

/** AN OPENED CONVERSATION AND A TASK BESIDE IT, JOINED WITH `any`: the first to come back with an answer decides. */
const FIRST_ANSWER: EventWorkflow = {
  on: 'event-received',
  types: ['ops-team'],
  initial: 'ask-team',
  states: {
    'ask-team': {
      label: 'Ask the team', task: { machine: 'acknowledgement', by: { participantRole: 'on-call:ops' }, continue: 'alongside', assigned: { template: 'incident-investigation' }, deadline: { afterMinutes: 1440 } },
      onSuccess: 'open-desk', onFailure: 'open-desk',
    },
    'open-desk': { open: { type: 'ops', for: { typeRole: 'on-call:ops' } }, onSuccess: 'first', onFailure: 'first' },
    first: { label: 'First answer', wait: { join: { of: ['ask-team', 'open-desk'], when: 'any' } }, onSuccess: 'answered', onFailure: 'done' },
    answered: { send: { template: 'incident-declared', to: 'room', mention: { lead: 'participantRole:on-call:ops' } }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
};

/** The run records the task service holds, in memory: written once, read back. */
function memoryRecords(): HeldRunRecords {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    hold: async ({ waitId, continuation }) => {
      if (rows.has(waitId)) return { claimed: false, reason: 'already_claimed' };
      rows.set(waitId, continuation);
      return { claimed: true };
    },
    read: async ({ waitId }) => rows.get(waitId) ?? null,
  };
}

/**
 * A run's dependencies with its claims and held records in memory, as the router keeps them: a part's record is named by the
 * part, its continuation marked with the part, and the part's ending meets it from the other side (`end`).
 */
function joinRun(wf: EventWorkflow) {
  const claims = new Map<string, string>();
  const records = memoryRecords();
  const sent: string[] = [];
  const ended: string[] = [];
  const deadlines: string[] = [];
  const deps: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step, outcome) => { if (claims.has(step)) return false; claims.set(step, outcome); return true; },
    mentionName: async () => 'Jordan',
    dispatchAgent: async () => true,
    send: async ({ step }) => { sent.push(step); return true; },
    openTask: async () => 'opened',
    // THE CREATOR HANDS THE RUN BACK LATER: the open step waits for it (`requested`).
    openChild: async () => 'requested',
    holdJoinPart: async (step, part, _kind, transitions) => {
      const met = await holdUntilEnded(records, part, TEAM, { runKey: 'r', step, transitions: [...transitions, { step: part, outcome: JOIN_PART }] });
      return 'came' in met ? { came: met.came } : 'held' in met ? 'held' : 'failed';
    },
    joinDeadline: async (step) => { deadlines.push(step); return true; },
    readClaims: async (names) => Object.fromEntries(names.filter((n) => claims.has(n)).map((n) => [n, claims.get(n)!])),
    ended: async (d) => { ended.push(d); },
  };
  const ctx: EventRunContext = {
    event: 'event-received', channelArn: TEAM, values: { label: 'X' },
    gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
  };
  /** Run from the start, then hand back the open step's conversation as the creator does. */
  const start = async (opts: { from?: string } = {}) => {
    const first = await runEventWorkflow('w', wf, ctx, deps, opts.from ? { from: opts.from, transitions: [] } : undefined);
    const openStep = Object.keys(wf.states).find((k) => wf.states[k].open);
    if (openStep && claims.has(openStep)) {
      const t: EventTransition[] = [...first.steps.map((s) => ({ step: s.step, outcome: s.outcome as string }))];
      await continueAfter('w', wf, ctx, { step: openStep, outcome: OPEN_STEP_OPENED, transitions: t }, deps);
    }
  };
  /** A part ends: its ending meets its record, and where the run was there first, the run is handed back with it. */
  const end = async (part: string, outcome: string) => {
    const met = await meetHeldRun(records, part, TEAM, outcome);
    if (!('run' in met)) return { ran: false };
    const held = met.run as { step: string; transitions: EventTransition[] };
    return continueAfter('w', wf, ctx, { step: held.step, outcome, transitions: held.transitions }, deps);
  };
  const deadline = (step: string) => continueAfter('w', wf, ctx, { step, outcome: WAIT_CAME, transitions: [{ step, outcome: 'waiting' }] }, deps);
  return { deps, claims, sent, ended, deadlines, start, end, deadline };
}

const DONE = 'task:success:acknowledged';
const CANCELLED = 'task:failure:cancelled';

describe('the example workflows validate, and the shipped ones declare no join', () => {
  it('both examples are valid workflows', () => {
    expect(eventWorkflowErrors('release', RELEASE)).toEqual([]);
    expect(eventWorkflowErrors('first-answer', FIRST_ANSWER)).toEqual([]);
  });

  it('the shipped incident response declares no join, so it runs as it did', () => {
    for (const wf of Object.values(SHIPPED_EVENT_WORKFLOWS)) expect(JSON.stringify(wf)).not.toContain('"join"');
  });
});

describe('the workflow the join e2e installs (two checks beside each other, joined with all)', () => {
  it('is a valid workflow, and its process links it', () => {
    expect(eventWorkflowErrors(JOIN_E2E_WORKFLOW, joinE2eWorkflow())).toEqual([]);
    expect(versionProcessesErrors(joinE2eProcess(), { [JOIN_E2E_WORKFLOW]: joinE2eWorkflow() })).toEqual([]);
  });

  it('holds after the first check, goes on once at the second, and its outcome names both parts and the last', async () => {
    const run = joinRun(joinE2eWorkflow());
    await run.start();
    const [first, second] = JOIN_E2E_PARTS;
    expect(run.claims.get(JOIN_E2E_STEP)).toBe('waiting');
    await run.end(first, DONE);
    expect(run.claims.has(continuationClaim(JOIN_E2E_STEP))).toBe(false);
    await run.end(second, DONE);
    const outcome = joinOutcomeOf(run.claims.get(continuationClaim(JOIN_E2E_STEP)) ?? '');
    expect(outcome).toEqual({ edge: 'success', last: second, parts: { [first]: 'success', [second]: 'success' } });
    expect(run.ended).toHaveLength(1);
  });
});

describe('a join on all of its parts', () => {
  it('holds until the last part ends, in any order, then goes on its success edge once', async () => {
    const run = joinRun(RELEASE);
    await run.start();
    // THE JOIN HOLDS ON ALL THREE, and schedules its deadline.
    expect(run.claims.get('all-in')).toBe('waiting');
    expect(run.deadlines).toEqual(['all-in']);
    expect(run.sent).toEqual([]);
    await run.end('open-rollout', WAIT_CAME);
    await run.end('security-review', DONE);
    expect(run.sent).toEqual([]);
    await run.end('docs-review', DONE);
    expect(run.sent).toEqual(['ship']);
    expect(run.ended).toEqual(['success']);
    const outcome = run.claims.get(continuationClaim('all-in'))!;
    expect(joinOutcomeOf(outcome)).toEqual({ edge: 'success', last: 'docs-review', parts: { 'security-review': 'success', 'docs-review': 'success', 'open-rollout': 'success' } });
    // A REDELIVERED HAND-BACK CONTINUES NOTHING: the part's claim is taken.
    expect((await continueAfter('w', RELEASE, { event: 'event-received', channelArn: TEAM, values: {} },
      { step: 'all-in', outcome: DONE, transitions: [{ step: 'docs-review', outcome: JOIN_PART }] }, run.deps)).ran).toBe(false);
    expect(run.sent).toEqual(['ship']);
  });

  it('counts a part that ended before the join was reached, and goes on at once where every part already ended', async () => {
    // EVERY PART ENDS BEFORE THE RUN REACHES THE JOIN: each record holds how it ended, and nothing is continued yet.
    const early = joinRun(RELEASE);
    expect((await early.end('security-review', DONE)).ran).toBe(false);
    await early.end('docs-review', DONE);
    await early.end('open-rollout', WAIT_CAME);
    await early.start();
    expect(early.sent).toEqual(['ship']);
    expect(joinOutcomeOf(early.claims.get(continuationClaim('all-in'))!)?.edge).toBe('success');
    // NO DEADLINE IS SCHEDULED for a join its parts already decided.
    expect(early.deadlines).toEqual([]);
    // ONE PART BEFORE, THE OTHERS AFTER: the one that came first is counted when the join is reached.
    const mixed = joinRun(RELEASE);
    await mixed.end('docs-review', DONE);
    await mixed.start();
    expect(mixed.claims.get(joinPartClaim('all-in', 'docs-review'))).toBe(DONE);
    await mixed.end('security-review', DONE);
    expect(mixed.sent).toEqual([]);
    await mixed.end('open-rollout', WAIT_CAME);
    expect(mixed.sent).toEqual(['ship']);
  });

  it('a part that ended without succeeding takes the failure edge, whose conditions read why', async () => {
    const run = joinRun(RELEASE);
    await run.start();
    await run.end('security-review', DONE);
    await run.end('open-rollout', childEndedOutcome('ended'));
    await run.end('docs-review', DONE);
    expect(run.sent).toEqual(['held-back']);
    expect(joinOutcomeOf(run.claims.get(continuationClaim('all-in'))!)).toMatchObject({ edge: 'failure', parts: { 'open-rollout': 'ended' } });
  });

  it('a part whose step the run never reached holds nothing, and is recorded as skipped', async () => {
    const run = joinRun(RELEASE);
    // THE RUN STARTS PAST THE SECURITY REVIEW, so its step is never claimed.
    await run.start({ from: 'docs-review' });
    await run.end('docs-review', DONE);
    expect(run.sent).toEqual([]);
    await run.end('open-rollout', WAIT_CAME);
    expect(run.sent).toEqual(['ship']);
    expect(joinOutcomeOf(run.claims.get(continuationClaim('all-in'))!)?.parts['security-review']).toBe('skipped');
  });

  it('its deadline goes on its deadline edge with each part as it stands, and a part ending after it continues nothing', async () => {
    const run = joinRun(RELEASE);
    await run.start();
    await run.end('security-review', DONE);
    await run.deadline('all-in');
    expect(run.sent).toEqual(['late']);
    expect(joinOutcomeOf(run.claims.get(continuationClaim('all-in'))!)).toEqual({
      edge: 'deadline', parts: { 'security-review': 'success', 'docs-review': 'open', 'open-rollout': 'open' },
    });
    await run.end('docs-review', DONE);
    await run.end('open-rollout', WAIT_CAME);
    expect(run.sent).toEqual(['late']);
    expect(run.ended).toEqual(['success']);
  });

  it('an open step whose conversation could not be opened is a part that ended as it failed', async () => {
    const run = joinRun(RELEASE);
    run.deps.openChild = async () => 'failed';
    await run.start();
    await run.end('security-review', DONE);
    await run.end('docs-review', DONE);
    expect(run.sent).toEqual(['held-back']);
    expect(joinOutcomeOf(run.claims.get(continuationClaim('all-in'))!)?.parts['open-rollout']).toBe('failed');
  });

  it('a part that cannot be held fails the join now, on its failure edge', async () => {
    const run = joinRun(RELEASE);
    run.deps.holdJoinPart = async () => 'failed';
    await run.start();
    expect(run.sent).toEqual(['held-back']);
    expect(run.claims.get(continuationClaim('all-in'))).toBe('failed');
  });
});

describe('a join on any of its parts', () => {
  it('goes on at the first part to end, and a later part continues nothing', async () => {
    const run = joinRun(FIRST_ANSWER);
    await run.start();
    expect(run.sent).toEqual([]);
    await run.end('open-desk', WAIT_CAME);
    expect(run.sent).toEqual(['answered']);
    expect(joinOutcomeOf(run.claims.get(continuationClaim('first'))!)).toEqual({ edge: 'success', last: 'open-desk', parts: { 'ask-team': 'open', 'open-desk': 'success' } });
    await run.end('ask-team', DONE);
    expect(run.sent).toEqual(['answered']);
    // THE LATER PART'S ENDING IS STILL CLAIMED ONCE, for the record.
    expect(run.claims.get(joinPartClaim('first', 'ask-team'))).toBe(DONE);
  });

  it('a first part that did not succeed takes the failure edge', async () => {
    const run = joinRun(FIRST_ANSWER);
    await run.start();
    await run.end('ask-team', CANCELLED);
    expect(run.sent).toEqual([]);
    expect(joinOutcomeOf(run.claims.get(continuationClaim('first'))!)).toMatchObject({ edge: 'failure', last: 'ask-team', parts: { 'ask-team': 'ended' } });
  });
});

describe('the join\'s outcome and decision', () => {
  it('reads back what it wrote, and refuses anything else', () => {
    const o = joinOutcome('failure', 'b', { a: 'success', b: 'timed-out', c: 'skipped' });
    expect(o).toBe('joined:failure:b:a=success,b=timed-out,c=skipped');
    expect(joinOutcomeOf(o)).toEqual({ edge: 'failure', last: 'b', parts: { a: 'success', b: 'timed-out', c: 'skipped' } });
    expect(joinOutcomeOf('waited')).toBeUndefined();
    expect(joinOutcomeOf('joined:success:-:a=maybe')).toBeUndefined();
  });

  it('all: holds while a started part runs; every part skipped goes on at once; any: the first ended', () => {
    expect(joinDecision({ of: ['a', 'b'], when: 'all' }, { a: 'success', b: 'open' })).toBeUndefined();
    expect(joinDecision({ of: ['a', 'b'], when: 'all' }, { a: 'success', b: 'skipped' })).toBe('joined:success:a:a=success,b=skipped');
    expect(joinDecision({ of: ['a', 'b'], when: 'all' }, { a: 'skipped', b: 'skipped' })).toBe('joined:success:-:a=skipped,b=skipped');
    expect(joinDecision({ of: ['a', 'b'], when: 'any' }, { a: 'open', b: 'open' })).toBeUndefined();
    expect(joinDecision({ of: ['a', 'b'], when: 'any' }, { a: 'open', b: 'failed' }, 'b')).toBe('joined:failure:b:a=open,b=failed');
  });
});

describe('the router holds each part where its ending meets it', () => {
  const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

  it('an opened conversation on the record its run\'s end meets, a task on its own join record, each continuation marked with the part', () => {
    const hold = router.slice(router.indexOf('holdJoinPart: async'), router.indexOf('joinDeadline: async'));
    expect(hold).toMatch(/childEndWaitId\(child\)/);
    expect(hold).toMatch(/openedConversationOf\(ctx\.values\[openedLinkValue\(part\)\], ctx\.channelArn\)/);
    expect(hold).toMatch(/joinPartWaitId\(eventTaskId\(runKey, part\)\)/);
    expect(hold).toMatch(/runContinuation\(step, \[\.\.\.transitions, \{ step: part, outcome: JOIN_PART \}\]\)/);
    expect(joinPartWaitId('t-1')).not.toBe(alongsideEndWaitId('t-1'));
  });

  it('a joined task\'s settlement meets its join record beside its end\'s, and an opened step keeps its link by step', () => {
    expect(router).toMatch(/own && ownOutcome && own\.holdsEnd && own\.joined \? meetJoin\(task\.taskId, r\.channelArn, ownOutcome\) : undefined/);
    expect(router).toMatch(/\.\.\.\(def\.continue === 'alongside' && args\.joined \? \{ joined: true as const \} : \{\}\)/);
    expect(router).toMatch(/joinedSteps\(wf\)\.includes\(str\(req\.step\)\)\) values\[openedLinkValue\(str\(req\.step\)\)\] = values\[CHILD_LINK_VALUE\]/);
  });
});

describe('DENY: a join the validator refuses', () => {
  const refused = (mutate: (wf: EventWorkflow) => void, pattern: RegExp) => {
    const wf = clone(RELEASE);
    mutate(wf);
    expect(eventWorkflowErrors('release', wf).join('\n')).toMatch(pattern);
  };
  const join = (wf: EventWorkflow) => wf.states['all-in'].wait!.join!;

  it('fewer than two parts, or more than eight', () => {
    refused((wf) => { join(wf).of = ['security-review']; }, /names 2 to 8 steps of this workflow/);
    refused((wf) => { join(wf).of = Array.from({ length: 9 }, () => 'docs-review'); }, /names 2 to 8 steps/);
  });

  it('a part named twice', () => {
    refused((wf) => { join(wf).of = ['docs-review', 'docs-review']; }, /names docs-review more than once/);
  });

  it('a step that is not in the workflow, or of another kind', () => {
    refused((wf) => { join(wf).of = ['security-review', 'nowhere']; }, /names nowhere, which is not a step of this workflow/);
    refused((wf) => { join(wf).of = ['security-review', 'ship']; }, /names ship, which is neither an open step that opens a conversation nor a task step that declares continue: alongside/);
    refused((wf) => { delete wf.states['docs-review'].task!.continue; }, /names docs-review, which is neither/);
  });

  it('a when other than all or any, a deadline out of range, or another key', () => {
    refused((wf) => { (join(wf) as { when: string }).when = 'most'; }, /\.when is all or any/);
    refused((wf) => { join(wf).minutes = 0; }, /\.minutes is a whole number of minutes/);
    refused((wf) => { (wf.states['all-in'].wait as Record<string, unknown>).minutes = 5; }, /\.wait is \{ join \} where it waits on several parts/);
  });

  it('a part another join already names, and an opened conversation the workflow also waits on with wait: { child }', () => {
    refused((wf) => {
      wf.states['again'] = { wait: { join: { of: ['docs-review', 'security-review'], when: 'any' } }, onSuccess: 'done', onFailure: 'done' };
    }, /names docs-review, which the join at all-in already waits on/);
    refused((wf) => { wf.states['hold'] = { wait: { child: 'ended' }, onSuccess: 'done' }; }, /also waits with wait: \{ child \}/);
  });

  it('onDeadline belongs to a task step or a join', () => {
    refused((wf) => { wf.states.ship.onDeadline = 'done'; }, /only a task step declares it, or a join/);
  });
});
