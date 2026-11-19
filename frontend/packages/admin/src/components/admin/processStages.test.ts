/**
 * A PROCESS'S STAGES, IN RUN ORDER, WITH THEIR TIMES (SPEC-PROCESSES P9; DESIGN-PROCESSES section 6).
 *
 * What it proves, on the shipped incident workflows: a stage is a step its workflow labels, shown under that label and tied to
 * its workflow; internal moves (`open`, `hold`, the room's opening) are never stages, and a step the workflow does not declare
 * (a reminder) never ends one; a stage runs from its step's first message to the run's next labeled step, or the run's end, so
 * an unlabeled step (a send that only tells the room, an `open`, a wait) is the stage's own and never cuts it short,
 * and a run still open has its last stage open; the process's stages come in its declared workflow order and then run order,
 * with the median and 95th percentile across runs; every outcome is said from the locale file.
 */
import { describe, expect, it } from 'vitest';
import en from '@ae/shared/locales/en.json';
import { endToEnd, joinWaitsOf, outcomeCopy, percentile, processShapeOf, runStages, stageSummary, type ProcessShape, type StageRun } from './processStages';
import { PARALLEL_ORDER, PARALLEL_WORKFLOWS, TRIAGE_FIRST_WORKFLOWS } from './__tests__/processChainFixture';

const M = 60_000;
const T0 = Date.parse('2026-11-16T09:00:00Z');
const body = {
  eventWorkflows: { 'incident-triage': TRIAGE_FIRST_WORKFLOWS['incident-triage'], 'ops-room': TRIAGE_FIRST_WORKFLOWS['ops-room'] },
  processes: { 'incident-response': { label: 'Incident response', workflows: ['incident-triage', 'ops-room'] } },
};
const shape = processShapeOf(body, 'incident-response') as ProcessShape;

/** One incident: the team's triage run and the incident conversation's run, offsets in minutes from T0. */
function incident(id: string, scale = 1, open = false): StageRun[] {
  const at = (m: number) => T0 + m * M * scale;
  const team: StageRun = {
    process_id: id, workflow: 'incident-triage', started_at: at(0), ended_at: open ? null : at(60), disposition: 'success',
    steps: [{ step: 'triage', outcome: 'task:success:acknowledged' }, { step: 'open', outcome: 'opened' }, { step: 'hold', outcome: 'task:success:resolved' }],
    step_times: [{ step: 'triage', at: at(0) }, { step: 'triage:remind', at: at(4) }, { step: 'tell', at: at(5) }],
  };
  const room: StageRun = {
    process_id: id, workflow: 'ops-room', started_at: at(5), ended_at: open ? null : at(120), disposition: 'success',
    steps: [{ step: 'review', outcome: 'task:success:acknowledged' }],
    step_times: [
      { step: 'opening', at: at(5) }, { step: 'lead-task', at: at(6) }, { step: 'investigation', at: at(7) }, { step: 'first-look', at: at(8) },
      { step: 'runbook-verify', at: at(30) }, { step: 'resolved', at: at(60) }, { step: 'tell-team', at: at(61) },
      ...(open ? [] : [{ step: 'review-draft', at: at(90) }, { step: 'review', at: at(100) }]),
    ],
  };
  return [team, room];
}

describe('the process as its owner\'s version declares it', () => {
  it('its workflows in the declared order, and each one\'s steps with their labels', () => {
    expect(shape.workflows).toEqual(['incident-triage', 'ops-room']);
    expect(shape.steps['incident-triage'].find((s) => s.step === 'triage')).toMatchObject({ step: 'triage', label: 'Triage', description: 'The on-call confirms the scope and whether customers are impacted.' });
    // A STEP WITH NO LABEL IS NO STAGE, and carries no label or description.
    const open = shape.steps['incident-triage'].find((s) => s.step === 'open');
    expect(open?.label).toBeUndefined();
    expect(open?.description).toBeUndefined();
    // THE INCIDENT'S OWNER AND RESOLVE ARE NAMED STAGES.
    expect(shape.steps['ops-room'].find((s) => s.step === 'lead-task')?.label).toBe('Incident owner');
    expect(shape.steps['ops-room'].find((s) => s.step === 'resolved')?.label).toBe('Resolve');
    expect(processShapeOf(body, 'no-such-process')).toBeNull();
    expect(processShapeOf(undefined, 'incident-response')).toBeNull();
  });

  it('a linked request-started workflow is read from intentWorkflows, by its intent, with its labeled steps', () => {
    const version = {
      intentWorkflows: { account_brief: { on: { intent: 'account_brief' }, initial: 'work', states: { work: { label: 'Brief written', task: { machine: 'account_brief', for: 'requester' } }, done: { disposition: 'success' } } } },
      processes: { briefs: { label: 'Account briefs', workflows: ['account_brief'] } },
    };
    const briefs = processShapeOf(version, 'briefs') as ProcessShape;
    expect(briefs.workflows).toEqual(['account_brief']);
    expect(briefs.steps.account_brief.find((s) => s.step === 'work')?.label).toBe('Brief written');
  });
});

describe('one run\'s stages', () => {
  it('triage is the team run\'s one stage: the unlabeled steps after it are its own, so it runs to the run\'s end, and a reminder ends nothing', () => {
    const [team] = incident('p1');
    const stages = runStages(team, shape);
    expect(stages.map((s) => s.label)).toEqual(['Triage']);
    expect(stages[0]).toMatchObject({ workflow: 'incident-triage', step: 'triage', start: T0, end: T0 + 60 * M, ms: 60 * M, outcome: 'task:success:acknowledged' });
  });

  it('an unlabeled step that posts belongs to the stage before it, which runs on to the next labeled step', () => {
    const [, room] = incident('p1');
    // The incident tells the conversation it opened a minute into the first look: a post, with no label.
    const told = { ...room, step_times: [...(room.step_times as Array<{ step: string; at: number }>), { step: 'messaging', at: T0 + 9 * M }, { step: 'tell-messaging', at: T0 + 9 * M + 1_000 }] };
    const stages = runStages(told, shape);
    expect(stages.map((s) => s.step)).not.toContain('tell-messaging');
    expect(stages.find((s) => s.step === 'first-look')).toMatchObject({ start: T0 + 8 * M, end: T0 + 30 * M, ms: 22 * M });
  });

  it('the incident run\'s stages in the order it reached them, under their labels, with internal moves hidden', () => {
    const [, room] = incident('p1');
    const stages = runStages(room, shape);
    expect(stages.map((s) => s.label)).toEqual(['Incident owner', 'Root-cause investigation', 'First look', 'Recovery check', 'Resolve', 'Team told', 'Post-incident review draft', 'Post-incident review']);
    expect(stages.map((s) => s.step)).not.toContain('opening');
    expect(stages.find((s) => s.step === 'resolved')).toMatchObject({ start: T0 + 60 * M, end: T0 + 61 * M, ms: M });
    // THE LAST STAGE RUNS TO THE RUN'S END.
    expect(stages.at(-1)).toMatchObject({ step: 'review', end: T0 + 120 * M, ms: 20 * M, outcome: 'task:success:acknowledged' });
  });

  it('a run still open has its last stage open: no end and no time', () => {
    const [, room] = incident('p1', 1, true);
    expect(runStages(room, shape).at(-1)).toMatchObject({ step: 'tell-team', end: null, ms: null });
  });

  it('without the version, every step the run took is a stage under its own name', () => {
    const [team] = incident('p1');
    expect(runStages(team, null).map((s) => s.label)).toEqual(['triage', 'triage:remind', 'tell']);
  });
});

describe('the process\'s stages across its runs', () => {
  const runs = [...incident('p1', 1), ...incident('p2', 2), ...incident('p3', 3, true)];

  it('come in the declared workflow order, then run order, each tied to its workflow', () => {
    const summary = stageSummary(runs, shape);
    expect(summary.map((s) => `${s.workflow}:${s.label}`)).toEqual([
      'incident-triage:Triage',
      'ops-room:Incident owner', 'ops-room:Root-cause investigation', 'ops-room:First look', 'ops-room:Recovery check', 'ops-room:Resolve',
      'ops-room:Team told', 'ops-room:Post-incident review draft', 'ops-room:Post-incident review',
    ]);
  });

  it('each with the runs that reached it and the median and 95th percentile time of the runs where it ended', () => {
    const summary = stageSummary(runs, shape);
    const triage = summary.find((s) => s.step === 'triage')!;
    // The open incident's team run has not ended, so its triage has no time yet.
    expect(triage).toMatchObject({ reached: 3, timed: 2, p50_ms: 90 * M });
    expect(triage.p95_ms).toBeCloseTo(117 * M);
    // THE OPEN INCIDENT REACHED "TEAM TOLD" AND HAS NOT LEFT IT: it counts as reached, not as a time.
    expect(summary.find((s) => s.step === 'tell-team')).toMatchObject({ reached: 3, timed: 2 });
    expect(summary.find((s) => s.step === 'review')).toMatchObject({ reached: 2, timed: 2, p50_ms: 30 * M });
  });

  it('the percentile interpolates between the two nearest values, as the query\'s PERCENTILE_CONT does', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('end to end runs from the first run\'s start to the last run\'s end, and is open while any run is', () => {
    expect(endToEnd(incident('p1'))).toEqual({ start: T0, end: T0 + 120 * M, ms: 120 * M });
    expect(endToEnd(incident('p3', 1, true)).ms).toBeNull();
  });
});

describe('every outcome is said from the locale file', () => {
  const valueOf = (key: string): unknown => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

  it('a task\'s settlement, a run\'s own outcome, and one the console does not know, each a key with copy', () => {
    expect(outcomeCopy('task:success:acknowledged')).toEqual({ key: 'admin.processes.outcome.task.success', values: { state: 'acknowledged' } });
    expect(outcomeCopy('task:deadline')).toEqual({ key: 'admin.processes.outcome.task.deadline', values: { state: '' } });
    expect(outcomeCopy('no-worker').key).toBe('admin.processes.outcome.noWorker');
    expect(outcomeCopy('something-new')).toEqual({ key: 'admin.processes.outcome.other', values: { outcome: 'something-new' } });
    for (const o of ['', 'posted', 'opened', 'sent', 'refused', 'failed', 'success', 'failure', 'stopped', 'waiting', 'no-worker', 'timed-out', 'ended',
      'task:success:x', 'task:failure:x', 'task:deadline', 'other']) {
      expect(typeof valueOf(outcomeCopy(o).key), o).toBe('string');
    }
  });
});

describe('what a join waited for, from the run\'s recorded steps', () => {
  it('names the part it waited on last, each part as it stood, and nothing for a run with no join', () => {
    const shape = processShapeOf({ eventWorkflows: PARALLEL_WORKFLOWS, processes: { p: { workflows: [...PARALLEL_ORDER] } } }, 'p');
    const run = { workflow: 'kickoff', steps: [{ step: 'both', outcome: 'waiting' }, { step: 'both', outcome: 'joined:failure:notes:open-alpha=success,open-beta=open,notes=ended' }] };
    expect(joinWaitsOf(run, shape)).toEqual([{
      workflow: 'kickoff', step: 'both', label: 'Everything is in', edge: 'failure',
      waitedFor: { step: 'notes', kind: 'alongside', label: 'Notes' },
      parts: [
        { step: 'open-alpha', kind: 'open', type: 'alpha', state: 'success' },
        { step: 'open-beta', kind: 'open', type: 'beta', state: 'open' },
        { step: 'notes', kind: 'alongside', label: 'Notes', state: 'ended' },
      ],
    }]);
    const late = joinWaitsOf({ workflow: 'kickoff', steps: [{ step: 'both', outcome: 'joined:deadline:-:open-alpha=open,open-beta=open,notes=open' }] }, shape)[0];
    expect(late.edge).toBe('deadline');
    expect(late.waitedFor).toBeUndefined();
    expect(joinWaitsOf({ workflow: 'kickoff', steps: [{ step: 'notes', outcome: 'opened' }] }, shape)).toEqual([]);
  });
});
