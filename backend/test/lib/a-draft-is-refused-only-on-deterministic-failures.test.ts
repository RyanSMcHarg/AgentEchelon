/**
 * The promotion gate's rule (SPEC-EVALUATION FR17, Appendix C1): a draft is refused only when a
 * regression entry fails a deterministic check on any of its k attempts; judged quality is reported as a
 * paired difference with its interval and the smallest difference the set can detect, and never blocks.
 */
import { gateResult, attemptFailure, type GateAttempt, type GateEntry } from '../../lambda/src/lib/promotion-gate';

const pass = (score?: number): GateAttempt => ({ ok: true, empty: false, blocked: false, breaches: [], score });

const entry = (id: string, purpose: GateEntry['purpose'], candidate: GateAttempt[], baseline: GateAttempt[] = [pass(70), pass(70), pass(70)]): GateEntry =>
  ({ entryId: id, purpose, candidate, baseline });

describe('the promotion gate', () => {
  it('refuses a draft whose regression entry fails one of its k attempts', () => {
    const r = gateResult([
      entry('a', 'regression', [pass(80), { ok: true, empty: false, blocked: true, breaches: [] }, pass(80)]),
      entry('b', 'regression', [pass(80), pass(80), pass(80)]),
    ]);
    expect(r.refused).toBe(true);
    expect(r.failures).toEqual([{ entryId: 'a', attempt: 2, reason: 'blocked' }]);
    expect(r.k).toBe(3);
  });

  it('names the rules a breaching attempt broke', () => {
    const r = gateResult([entry('a', 'regression', [{ ok: true, empty: false, blocked: false, breaches: ['no-pii'] }])]);
    expect(r.failures[0]).toEqual({ entryId: 'a', attempt: 1, reason: 'breach', rules: ['no-pii'] });
  });

  it('does not refuse a draft whose judged quality fell, and reports the fall with its interval', () => {
    const r = gateResult([
      entry('a', 'regression', [pass(50), pass(52), pass(48)], [pass(80), pass(80), pass(80)]),
      entry('b', 'regression', [pass(60), pass(60), pass(60)], [pass(85), pass(85), pass(85)]),
      entry('c', 'regression', [pass(55), pass(55), pass(55)], [pass(75), pass(75), pass(75)]),
    ]);
    expect(r.refused).toBe(false);
    expect(r.pairedDifference!.mean).toBeLessThan(0);
    expect(r.pairedDifference!.entries).toBe(3);
    expect(r.pairedDifference!.ci[0]).toBeLessThan(r.pairedDifference!.ci[1]);
    expect(Number.isFinite(r.minimumDetectable)).toBe(true);
  });

  it('never blocks on a capability entry, and reports one passed every time as ready to promote', () => {
    const r = gateResult([
      entry('cap-ok', 'capability', [pass(), pass(), pass()]),
      entry('cap-no', 'capability', [pass(), { ok: false, empty: true, blocked: false, breaches: [] }, pass()]),
    ]);
    expect(r.refused).toBe(false);
    expect(r.readyToPromote).toEqual(['cap-ok']);
  });

  it('says how small a set is: no interval and an unbounded detectable difference under two judged entries', () => {
    const r = gateResult([entry('a', 'regression', [pass(70)], [pass(60)])]);
    expect(r.minimumDetectable).toBe(Infinity);
    expect(r.pairedDifference!.ci).toEqual([-Infinity, Infinity]);
  });

  it('orders the deterministic reasons: an error before an empty answer before a block before a breach', () => {
    expect(attemptFailure({ ok: false, empty: true, blocked: true, breaches: ['x'] })).toBe('error');
    expect(attemptFailure({ ok: true, empty: true, blocked: true, breaches: ['x'] })).toBe('empty');
    expect(attemptFailure({ ok: true, empty: false, blocked: true, breaches: ['x'] })).toBe('blocked');
    expect(attemptFailure(pass())).toBeNull();
  });
});
