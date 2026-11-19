import { describe, it, expect } from 'vitest';
import { RING_OFF, configuredRingSeconds, isRingOff, nextRing, parseRing, ringContent, ringEndsAt } from './meetingRing';

describe('a meeting ring', () => {
  it('reads back what it writes, and nothing else', () => {
    expect(parseRing(ringContent(12))).toBe(12);
    expect(parseRing('a message')).toBeNull();
  });

  it('rings from its send time, so a late arrival rings only for what is left', () => {
    const now = 1_000_000;
    expect(ringEndsAt(10, now - 4000, now)).toBe(now + 6000);
    // A send time in the future or unreadable counts from now.
    expect(ringEndsAt(10, now + 60_000, now)).toBe(now + 10_000);
    expect(ringEndsAt(10, 'not a time', now)).toBe(now + 10_000);
  });

  it('is no ring at all outside 5 to 60 seconds, whoever sent it', () => {
    for (const s of [0, 4, 61, 600]) expect(parseRing(`ae:ring:${s}`)).toBeNull();
    expect(parseRing(RING_OFF)).toBeNull();
    expect(isRingOff(RING_OFF)).toBe(true);
    expect(isRingOff(ringContent(10))).toBe(false);
  });

  it('a second ring for the conversation already ringing neither restarts nor extends it; another conversation\'s replaces it', () => {
    const now = 1_000_000;
    const ringing = { channelArn: 'c1', endsAt: now + 5000 };
    expect(nextRing(ringing, { channelArn: 'c1', endsAt: now + 60_000 }, now)).toBe(ringing);
    const other = { channelArn: 'c2', endsAt: now + 10_000 };
    expect(nextRing(ringing, other, now)).toBe(other);
    // Once the first ring is over, the same conversation can ring again.
    const later = { channelArn: 'c1', endsAt: now + 20_000 };
    expect(nextRing({ channelArn: 'c1', endsAt: now - 1 }, later, now)).toBe(later);
    expect(nextRing(null, later, now)).toBe(later);
  });

  it('lasts the deployment\'s seconds within bounds, else ten', () => {
    expect(configuredRingSeconds('20')).toBe(20);
    expect(configuredRingSeconds('2')).toBe(10);
    expect(configuredRingSeconds(undefined)).toBe(10);
  });
});
