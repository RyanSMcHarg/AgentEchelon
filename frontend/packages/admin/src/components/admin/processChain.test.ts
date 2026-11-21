/**
 * THE PROCESS WIZARD READS ITS PHASES AND HAND-OFFS FROM THE WORKFLOWS THEMSELVES (SPEC-PROCESSES P1, P3), proven on an
 * incident response that triages in the team conversation first (a fixture built on the shipped one): choosing what starts it reaches the incident and customer messaging by their open steps, and
 * each hand-off says where it goes, who leads it, on what condition, whether the phase before waits, and what is told across.
 */
import { describe, expect, it } from 'vitest';
import { chainFrom, handoffBetween, joinsOf, phaseOf, processLayout } from './processChain';
import { PARALLEL_ORDER, PARALLEL_WORKFLOWS, TRIAGE_FIRST_WORKFLOWS } from './__tests__/processChainFixture';

const wfs = { ...TRIAGE_FIRST_WORKFLOWS } as unknown as Record<string, unknown>;

describe('a process as a chain of workflows', () => {
  it('starting from triage reaches the incident, then customer messaging, by the conversations their open steps open', () => {
    expect(chainFrom(wfs, 'incident-triage')).toEqual(['incident-triage', 'ops-room', 'customer-messaging']);
    expect(chainFrom(wfs, 'customer-messaging')).toEqual(['customer-messaging']);
  });

  it('a phase is its workflow\'s named stages, with who answers each and the deadlines that are targets, not holds', () => {
    const triage = phaseOf(wfs, 'incident-triage');
    expect(triage.on).toBe('event-received');
    expect(triage.stages).toEqual([expect.objectContaining({ step: 'triage', label: 'Triage', dueMinutes: 30, responsible: { kind: 'person', role: 'on call', team: 'ops' } })]);
    const room = phaseOf(wfs, 'ops-room');
    // THE OWNER'S TASK IS HELD FOR THIRTY DAYS: a hold, so it carries no deadline target.
    expect(room.stages.find((s) => s.step === 'lead-task')?.dueMinutes).toBeUndefined();
    expect(room.stages.find((s) => s.step === 'offer-call')?.dueMinutes).toBe(10);
  });

  it('the hand-off to the incident: the on-call leads it, and the team conversation waits until it ends', () => {
    const h = handoffBetween(wfs, 'incident-triage', 'ops-room')!;
    expect(h).toMatchObject({ type: 'ops', ledBy: 'on-call:ops', waits: true });
  });

  it('a hand-off only conditional edges reach names their conditions', () => {
    const only = JSON.parse(JSON.stringify(wfs));
    only['ops-room'].states['customer-impact'].onSuccess = [{ to: 'runbook-cause', when: { 'event:customerImpact': 'impacted' } }, { to: 'messaging', when: { 'task:state': 'impacted' } }];
    only['ops-room'].states['customer-impact'].onFailure = 'runbook-cause';
    expect(handoffBetween(only, 'ops-room', 'customer-messaging')!.when).toEqual(expect.arrayContaining([{ source: 'event:customerImpact', value: 'impacted' }, { source: 'task:state', value: 'impacted' }]));
  });

  it('the hand-off to the account team: with no condition, since naming the accounts opens it, alongside, with what is told each way', () => {
    const h = handoffBetween(wfs, 'ops-room', 'customer-messaging')!;
    expect(h).toMatchObject({ type: 'customer-messaging', ledBy: 'lead:accounts', waits: false });
    expect(h.when).toEqual([]);
    expect(h.toldForward).toEqual(expect.arrayContaining(['customer-messaging-mitigating', 'customer-messaging-resolved']));
    expect(h.toldBack).toEqual(['customer-notice-approved']);
  });

  it('no hand-off where no open step of the one phase starts the next', () => {
    expect(handoffBetween(wfs, 'customer-messaging', 'ops-room')).toBeNull();
  });
});

describe('a process with parallel work (a test fixture, not shipped)', () => {
  it('a phase that opens several phases is a fork, and they run in parallel in the next step', () => {
    const { steps, places } = processLayout(PARALLEL_WORKFLOWS, PARALLEL_ORDER);
    expect(steps.map((s) => s.phases)).toEqual([['kickoff'], ['alpha-room', 'beta-room', 'gamma-room']]);
    expect(steps[1].forks).toEqual([{ from: 'kickoff', to: ['alpha-room', 'beta-room'] }]);
    expect(places['beta-room'].beside).toEqual(['alpha-room', 'gamma-room']);
    // THE JOIN NAMES BOTH OPENS, so kickoff waits on each.
    expect(places['alpha-room'].handoff?.waits).toBe(true);
    expect(places['beta-room'].openedBy).toBe('kickoff');
  });

  it('a phase its opener does not wait on runs alongside it, in the same step', () => {
    const { places } = processLayout(PARALLEL_WORKFLOWS, PARALLEL_ORDER);
    expect(places['gamma-room']).toMatchObject({ openedBy: 'alpha-room', alongsideOf: 'alpha-room' });
    expect(places['gamma-room'].handoff?.waits).toBe(false);
    expect(places['alpha-room'].alongsideOf).toBeUndefined();
  });

  it('a join names its parts in words: the workflow an opened conversation runs, or the alongside task\'s stage', () => {
    expect(joinsOf(PARALLEL_WORKFLOWS, 'kickoff')).toEqual([{
      step: 'both', label: 'Everything is in', when: 'all',
      parts: [
        { step: 'open-alpha', kind: 'open', words: 'alpha-room' },
        { step: 'open-beta', kind: 'open', words: 'beta-room' },
        { step: 'notes', kind: 'alongside', words: 'Notes' },
      ],
    }]);
    expect(processLayout(PARALLEL_WORKFLOWS, PARALLEL_ORDER).places.kickoff.joins).toHaveLength(1);
  });

  it('the triage-first incident response: customer messaging runs alongside the incident, which does not wait for it', () => {
    const { steps, places } = processLayout(wfs, ['incident-triage', 'ops-room', 'customer-messaging']);
    expect(steps.map((s) => s.phases)).toEqual([['incident-triage'], ['ops-room', 'customer-messaging']]);
    expect(places['customer-messaging'].alongsideOf).toBe('ops-room');
    expect(places['ops-room'].joins).toEqual([]);
  });

  it('a phase no earlier phase opens follows the last step', () => {
    const { steps } = processLayout(PARALLEL_WORKFLOWS, ['beta-room', 'kickoff']);
    expect(steps.map((s) => s.phases)).toEqual([['beta-room'], ['kickoff']]);
  });
});
