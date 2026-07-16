/**
 * Sleep-mode pure-logic tests (no AWS). Covers the idle-threshold parser and
 * the shouldSleep decision, including the defensive guards that keep a bad
 * timestamp from ever triggering a false sleep.
 */

import { parseIdleThresholdMs, shouldSleep } from '../../lambda/src/lib/sleep-mode';

describe('parseIdleThresholdMs', () => {
  it('parses minutes/hours/days with common unit spellings', () => {
    expect(parseIdleThresholdMs('30m')).toBe(30 * 60_000);
    expect(parseIdleThresholdMs('30 min')).toBe(30 * 60_000);
    expect(parseIdleThresholdMs('2h')).toBe(2 * 3_600_000);
    expect(parseIdleThresholdMs('2 hours')).toBe(2 * 3_600_000);
    expect(parseIdleThresholdMs('1d')).toBe(86_400_000);
  });

  it('treats a bare integer as minutes', () => {
    expect(parseIdleThresholdMs('45')).toBe(45 * 60_000);
  });

  it('returns null on garbage / empty / non-positive so the caller can default', () => {
    expect(parseIdleThresholdMs('')).toBeNull();
    expect(parseIdleThresholdMs(undefined)).toBeNull();
    expect(parseIdleThresholdMs('soon')).toBeNull();
    expect(parseIdleThresholdMs('0h')).toBeNull();
    expect(parseIdleThresholdMs('-5m')).toBeNull();
  });
});

describe('shouldSleep', () => {
  const threshold = 2 * 3_600_000; // 2h
  const t = 1_000_000_000_000;

  it('sleeps only when awake AND idle beyond the threshold', () => {
    expect(shouldSleep({ state: 'awake', lastActivityAt: t - threshold - 1 }, threshold, t)).toBe(true);
  });

  it('does not sleep when idle is within the threshold', () => {
    expect(shouldSleep({ state: 'awake', lastActivityAt: t - threshold + 1 }, threshold, t)).toBe(false);
    expect(shouldSleep({ state: 'awake', lastActivityAt: t - 60_000 }, threshold, t)).toBe(false);
  });

  it('never sleeps an already-asleep deployment', () => {
    expect(shouldSleep({ state: 'asleep', lastActivityAt: t - threshold - 10_000 }, threshold, t)).toBe(false);
  });

  it('is defensive: a missing or future lastActivityAt never triggers sleep', () => {
    expect(shouldSleep({ state: 'awake', lastActivityAt: NaN }, threshold, t)).toBe(false);
    expect(shouldSleep({ state: 'awake', lastActivityAt: t + 5_000 }, threshold, t)).toBe(false);
  });
});
