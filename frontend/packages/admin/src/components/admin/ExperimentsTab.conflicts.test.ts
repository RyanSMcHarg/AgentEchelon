import { describe, it, expect } from 'vitest';
import { isResolvableBlocker, presentableBlockers } from './ExperimentsTab';
import type { Experiment } from '@ae/shared';

// The type-exclusion 409 (§3.2.1) names the experiments the SERVER believes hold the classification,
// read from an eventually-consistent scan. After the operator ends a blocker, the auto-retried create
// can be refused again and the body can still name the row that was just freed. Presenting that row
// re-opens a resolution the operator already performed, and its End/Pause buttons act on a terminal
// experiment. These tests pin the filter that keeps a resolved blocker off the panel.

const NOW = Date.parse('2026-08-18T12:00:00Z');

function exp(over: Partial<Experiment>): Experiment {
  return {
    experimentId: 'exp-blocker',
    status: 'active',
    intent: '',
    tiers: ['premium'],
    variants: [],
    startDate: '2026-08-01T00:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
  } as Experiment;
}

describe('isResolvableBlocker', () => {
  it('an active experiment inside its window still holds the classification', () => {
    expect(isResolvableBlocker(exp({}), NOW)).toBe(true);
  });

  it('a completed experiment holds nothing, so it is not a blocker', () => {
    expect(isResolvableBlocker(exp({ status: 'completed' }), NOW)).toBe(false);
  });

  it('a soft-deleted experiment holds nothing', () => {
    expect(isResolvableBlocker(exp({ status: 'deleted' }), NOW)).toBe(false);
  });

  it('a paused experiment assigns no new conversations, so it is not a blocker', () => {
    expect(isResolvableBlocker(exp({ status: 'paused' }), NOW)).toBe(false);
  });

  it('an expired experiment resolves no traffic', () => {
    expect(isResolvableBlocker(exp({ endDate: '2026-08-17T00:00:00Z' }), NOW)).toBe(false);
  });

  it('an experiment that has not started yet resolves no traffic', () => {
    expect(isResolvableBlocker(exp({ startDate: '2026-08-19T00:00:00Z' }), NOW)).toBe(false);
  });

  it('an open-ended active experiment is a blocker (no endDate is not an expiry)', () => {
    expect(isResolvableBlocker(exp({ endDate: undefined }), NOW)).toBe(true);
  });
});

describe('presentableBlockers keeps a resolved conflict off the panel', () => {
  it('drops the blocker the operator just ended, even though the 409 still names it', () => {
    // The exact defect: the retry runs before the server read catches up, so the body repeats the
    // blocker with the client-stamped `status: active` default. Nothing about the row says it is
    // stale, which is why the resolved-id list is what has to carry that knowledge.
    const stale = exp({ experimentId: 'exp-ended' });
    expect(presentableBlockers([stale], ['exp-ended'], NOW)).toEqual([]);
  });

  it('drops a blocker whose own body reports it completed', () => {
    const completed = exp({ experimentId: 'exp-done', status: 'completed' });
    expect(presentableBlockers([completed], [], NOW)).toEqual([]);
  });

  it('drops a blocker whose window has closed', () => {
    const expired = exp({ experimentId: 'exp-expired', endDate: '2026-08-10T00:00:00Z' });
    expect(presentableBlockers([expired], [], NOW)).toEqual([]);
  });

  it('still presents a genuinely outstanding blocker alongside a resolved one', () => {
    // Over-filtering is the opposite failure: a real blocker dropped here would let the create retry
    // forever against a classification that is actually held.
    const resolved = exp({ experimentId: 'exp-ended' });
    const outstanding = exp({ experimentId: 'exp-live' });
    expect(presentableBlockers([resolved, outstanding], ['exp-ended'], NOW).map((c) => c.experimentId))
      .toEqual(['exp-live']);
  });

  it('remembers every resolution in the flow, not only the most recent one', () => {
    // A create blocked by two experiments is resolved one at a time; the first resolution must stay
    // filtered when the second retry is refused.
    const first = exp({ experimentId: 'exp-a' });
    const second = exp({ experimentId: 'exp-b' });
    expect(presentableBlockers([first, second], ['exp-a', 'exp-b'], NOW)).toEqual([]);
  });

  it('presents nothing from an empty candidate list without inventing a blocker', () => {
    expect(presentableBlockers([], [], NOW)).toEqual([]);
  });
});
