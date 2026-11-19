/**
 * A PERSON WHO ARRIVES LATE SEES THE MEETING (SPEC-ASSISTANT-MEETINGS FR35 to FR37): what decides whether the open
 * conversation's meeting runs, the platform's card as the app reads it, and one tab ringing per person.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@ae/shared';
import { lateRingEndsAt, latestMeetingCard, meetingRuns } from './useConversationMeeting';
import { meetingCardFromMetadata } from '../services/meetingService';
import { holdMeetingPresence, ringInOneTab, watchMeetingPresenceAs } from '../services/meetingPresence';

const msg = (id: string, at: number, meetingCard?: Message['meetingCard']): Message => ({
  id, content: 'x', sender: { arn: 'arn:aws:chime:us-east-1:1:app-instance/a/bot/b', name: '' }, timestamp: new Date(at), isBot: true, status: 'sent',
  ...(meetingCard ? { meetingCard } : {}),
}) as Message;

describe('whether the meeting runs', () => {
  const started = msg('s', 1_000, { event: 'meeting-started', meetingId: 'm-2' });
  const endedOld = msg('e', 500, { event: 'meeting-ended', meetingId: 'm-1' });

  it('is the read until a card newer than it says otherwise', () => {
    // A workflow's start posts no card: the history's last card is an older meeting's end, and the read decides.
    expect(meetingRuns({ ringing: false, read: { running: true, at: 2_000 }, card: endedOld })).toBe(true);
    expect(meetingRuns({ ringing: false, read: { running: false, at: 2_000 }, card: started })).toBe(false);
    // A card posted after the read decides.
    expect(meetingRuns({ ringing: false, read: { running: false, at: 900 }, card: started })).toBe(true);
    expect(meetingRuns({ ringing: false, read: { running: true, at: 400 }, card: endedOld })).toBe(false);
  });

  it('compares a card with the read on the clock of this device, so a fast clock does not hide a card posted after the read', () => {
    // This clock runs 12 seconds ahead: the read at local 13_000 is server 1_000, and the card at server 1_500 came after it.
    const card = msg('s2', 1_500, { event: 'meeting-started', meetingId: 'm-3' });
    expect(meetingRuns({ ringing: false, read: { running: false, at: 13_000 }, card, localTimeOf: (t) => t + 12_000 })).toBe(true);
    expect(meetingRuns({ ringing: false, read: { running: false, at: 13_000 }, card })).toBe(false);
  });

  it('is shown by a ring, and before the read answers by the newest card: a started card shows Join until it is known otherwise', () => {
    expect(meetingRuns({ ringing: true, read: null, card: undefined })).toBe(true);
    expect(meetingRuns({ ringing: false, read: null, card: started })).toBe(true);
    // An ended card that followed it: the meeting is over, read or not.
    expect(meetingRuns({ ringing: false, read: null, card: endedOld })).toBe(false);
    expect(meetingRuns({ ringing: false, read: null, card: undefined })).toBe(false);
  });

  it('takes the latest card among the messages', () => {
    expect(latestMeetingCard([endedOld, msg('plain', 700), started, msg('after', 1_200)])?.id).toBe('s');
    expect(latestMeetingCard([msg('plain', 1)])).toBeUndefined();
  });
});

describe('the card as the app reads it', () => {
  const ASSISTANT = 'arn:aws:chime:us-east-1:1:app-instance/a/bot/b';
  const PERSON = 'arn:aws:chime:us-east-1:1:app-instance/a/user/u';

  it('is the platform card only, its event and meeting id checked', () => {
    expect(meetingCardFromMetadata({ meetingCard: { event: 'meeting-ended', meetingId: 'a1-b2' } }, ASSISTANT)).toEqual({ event: 'meeting-ended', meetingId: 'a1-b2' });
    expect(meetingCardFromMetadata({ meetingCard: { event: 'meeting-paused', meetingId: 'a1' } }, ASSISTANT)).toBeUndefined();
    expect(meetingCardFromMetadata({ meetingCard: { event: 'meeting-started', meetingId: '<b>' } }, ASSISTANT)).toBeUndefined();
    expect(meetingCardFromMetadata({}, ASSISTANT)).toBeUndefined();
  });

  it('counts only from an assistant, because a member can write any Metadata', () => {
    const forged = { meetingCard: { event: 'meeting-started', meetingId: 'a1' } };
    expect(meetingCardFromMetadata(forged, PERSON)).toBeUndefined();
    expect(meetingCardFromMetadata(forged, undefined)).toBeUndefined();
  });

  it('names the meeting\'s own conversation where the card carries one', () => {
    expect(meetingCardFromMetadata({ meetingCard: { event: 'meeting-started', meetingId: 'a1', conversationId: 'm-1' } }, ASSISTANT))
      .toEqual({ event: 'meeting-started', meetingId: 'a1', conversationId: 'm-1' });
    expect(meetingCardFromMetadata({ meetingCard: { event: 'meeting-started', meetingId: 'a1', conversationId: '../x' } }, ASSISTANT))
      .toEqual({ event: 'meeting-started', meetingId: 'a1' });
  });

  it("reads when a started card's ring stops, and nothing else as that time", () => {
    expect(meetingCardFromMetadata({ meetingCard: { event: 'meeting-started', meetingId: 'a1', ringUntil: '2026-11-12T10:00:30.000Z' } }, ASSISTANT))
      .toEqual({ event: 'meeting-started', meetingId: 'a1', ringUntil: Date.parse('2026-11-12T10:00:30.000Z') });
    expect(meetingCardFromMetadata({ meetingCard: { event: 'meeting-started', meetingId: 'a1', ringUntil: 'soon' } }, ASSISTANT))
      .toEqual({ event: 'meeting-started', meetingId: 'a1' });
    expect(meetingCardFromMetadata({ meetingCard: { event: 'meeting-ended', meetingId: 'a1', ringUntil: '2026-11-12T10:00:30.000Z' } }, ASSISTANT))
      .toEqual({ event: 'meeting-ended', meetingId: 'a1' });
  });
});

describe('one tab rings per person', () => {
  it('plays the tone only in the tab that takes the lock, and stops it', async () => {
    const grants: boolean[] = [true, false];
    const locks = {
      request: vi.fn(async (_name: string, _opts: unknown, cb: (lock: unknown) => unknown) => cb(grants.shift() ? { name: 'ae-meeting-ring-tone' } : null)),
    };
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks });
    const stopA = vi.fn();
    const stopB = vi.fn();
    const toneA = vi.fn(() => stopA);
    const toneB = vi.fn(() => stopB);
    const a = ringInOneTab(toneA);
    const b = ringInOneTab(toneB);
    await Promise.resolve();
    expect(toneA).toHaveBeenCalledTimes(1);
    expect(toneB).not.toHaveBeenCalled();
    a();
    b();
    expect(stopA).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('a ring that replaces another in this tab takes the tone over, under the lock this tab holds', async () => {
    let held = false;
    const locks = {
      request: vi.fn(async (_name: string, _opts: unknown, cb: (lock: unknown) => unknown) => {
        if (held) return cb(null);
        held = true;
        try { return await cb({ name: 'ae-meeting-ring-tone' }); } finally { held = false; }
      }),
    };
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks });
    const stopFirst = vi.fn();
    const first = vi.fn(() => stopFirst);
    const second = vi.fn(() => vi.fn());
    const stop1 = ringInOneTab(first);
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    // React runs the old ring's cleanup and the new ring's effect in one flush.
    stop1();
    const stop2 = ringInOneTab(second);
    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stop2();
    await Promise.resolve();
    await Promise.resolve();
    expect(held).toBe(false);
    vi.unstubAllGlobals();
  });

  it('rings as before where the browser has no locks', () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks: undefined });
    const stop = vi.fn();
    const tone = vi.fn(() => stop);
    ringInOneTab(tone)();
    expect(tone).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('a meeting window that leaves holds nothing', () => {
  it('withdraws a lock request still waiting, and lets go at once of one granted after it left', async () => {
    let granted: (() => unknown) | undefined;
    let signal: AbortSignal | undefined;
    const locks = {
      request: vi.fn((_name: string, opts: { signal?: AbortSignal }, cb: () => unknown) => {
        signal = opts.signal;
        granted = cb;
        return new Promise(() => undefined);
      }),
    };
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks });
    const release = holdMeetingPresence('m-1');
    release();
    expect(signal?.aborted).toBe(true);
    // A grant that races the withdrawal finds the window gone and returns straight away.
    expect(granted?.()).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('reads a meeting known by several names as one presence: in it while a window holds any of them', async () => {
    let releaseMeeting: (() => void) | undefined;
    let holding = true;
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      locks: {
        query: vi.fn(() => Promise.resolve({ held: holding ? [{ name: 'ae-in-meeting-meet-1' }] : [] })),
        // The watcher waits on the held lock; the holder letting go grants it.
        request: vi.fn(() => new Promise<void>((resolve) => { releaseMeeting = resolve; })),
      },
    });
    const seen: boolean[] = [];
    const stop = watchMeetingPresenceAs(['room-1', 'meet-1', 'room-1', ''], (here) => seen.push(here));
    await vi.waitFor(() => expect(seen).toEqual([true]));
    holding = false;
    releaseMeeting?.();
    await vi.waitFor(() => expect(seen).toEqual([true, false]));
    stop();
    vi.unstubAllGlobals();
  });

  it('stays present when the window lets go and holds again (a rejoin), rather than dropping to Join', async () => {
    let releaseMeeting: (() => void) | undefined;
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      locks: {
        // The window holds the lock again by the time this watcher's own request is granted.
        query: vi.fn(() => Promise.resolve({ held: [{ name: 'ae-in-meeting-meet-1' }] })),
        request: vi.fn(() => new Promise<void>((resolve) => { releaseMeeting = resolve; })),
      },
    });
    const seen: boolean[] = [];
    const stop = watchMeetingPresenceAs(['meet-1'], (here) => seen.push(here));
    await vi.waitFor(() => expect(seen).toEqual([true]));
    releaseMeeting?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([true]);
    stop();
    vi.unstubAllGlobals();
  });
});

describe('a late arrival rings for what is left of the ring', () => {
  it('rings for the seconds the server counts as left, at the length of its own ring and whatever this clock says', () => {
    // A step that rings 30 seconds, 15 in: the arrival rings 15 more, though the deployment's default is 10.
    expect(lateRingEndsAt({ running: true, startedAt: '2026-11-12T00:00:00.000Z', ringSecondsLeft: 15 }, 1_000)).toBe(16_000);
    expect(lateRingEndsAt({ running: true, ringSecondsLeft: 0 }, 1_000)).toBeNull();
  });

  it('never rings the person who started it, nor for a meeting that is not running', () => {
    expect(lateRingEndsAt({ running: true, startedByYou: true, ringSecondsLeft: 5 }, 1_000)).toBeNull();
    expect(lateRingEndsAt({ running: false }, 1_000)).toBeNull();
  });

  it('rings nobody where the server names no seconds left, whatever this clock says of the start', () => {
    // The server names what is left only while the ring sounds; a device clock running behind would otherwise ring late.
    const start = Date.parse('2026-11-12T00:00:00.000Z');
    expect(lateRingEndsAt({ running: true, startedAt: '2026-11-12T00:00:00.000Z' }, start + 3_000)).toBeNull();
  });
});
