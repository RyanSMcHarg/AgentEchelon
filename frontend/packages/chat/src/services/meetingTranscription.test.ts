import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Transcript, TranscriptionStatus, TranscriptionStatusType, TranscriptItemType } from 'amazon-chime-sdk-js';
import { announce, createNoticeMicHold, createRecordingTimeline, createTranscriptReporter, RECORDED_FROM_GRACE_MS, REPORT_RETRY_DELAYS_MS, noticeHoldLimitMs, readTranscriptEvent, SEGMENTS_PER_REPORT, REPORT_AFTER_MS, type OwnSegment } from './meetingTranscription';

/** A transcript event as the service delivers it on the data channel. */
function transcript(results: Array<{ id: string; attendeeId: string; text: string; partial?: boolean }>): Transcript {
  const t = new Transcript();
  t.results = results.map((r) => ({
    resultId: r.id, channelId: '', isPartial: !!r.partial, startTimeMs: 1000, endTimeMs: 2000,
    alternatives: [{
      transcript: r.text,
      items: [{ content: r.text, type: TranscriptItemType.PRONUNCIATION, startTimeMs: 1000, endTimeMs: 2000, attendee: { attendeeId: r.attendeeId, externalUserId: `p-${r.attendeeId}` } }],
    }],
  })) as unknown as Transcript['results'];
  return t;
}

function status(type: TranscriptionStatusType): TranscriptionStatus {
  const s = new TranscriptionStatus();
  s.type = type;
  return s;
}

describe('what one transcript event says', () => {
  it('keeps only the final lines the service attributes to this person', () => {
    const read = readTranscriptEvent(transcript([
      { id: 'r1', attendeeId: 'me', text: 'we ship on friday' },
      { id: 'r2', attendeeId: 'them', text: 'agreed' },
      { id: 'r3', attendeeId: 'me', text: 'we sh', partial: true },
    ]), 'me');
    expect(read.own).toEqual([{ resultId: 'r1', attendeeId: 'me', text: 'we ship on friday', startMs: 1000, endMs: 2000 }]);
  });

  it('reads the transcription status as on or off', () => {
    expect(readTranscriptEvent(status(TranscriptionStatusType.STARTED), 'me').transcribing).toBe(true);
    expect(readTranscriptEvent(status(TranscriptionStatusType.STOPPED), 'me').transcribing).toBe(false);
    expect(readTranscriptEvent(status(TranscriptionStatusType.INTERRUPTED), 'me').transcribing).toBeUndefined();
  });
});

describe('the transcript reporter', () => {
  const line = (i: number): OwnSegment => ({ resultId: `r${i}`, attendeeId: 'me', text: `line ${i}`, startMs: i, endMs: i + 1 });

  it('sends a full batch at once and the rest after a short wait, each line once', () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const r = createTranscriptReporter(send);
    r.add(Array.from({ length: SEGMENTS_PER_REPORT + 2 }, (_, i) => line(i)));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toHaveLength(SEGMENTS_PER_REPORT);
    r.add([line(100)]);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REPORT_AFTER_MS);
    expect(send).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('sends a batch again after a network error or a server error, and never one the server refused', async () => {
    vi.useFakeTimers();
    const unanswered = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
      .mockResolvedValue(undefined);
    const r = createTranscriptReporter(unanswered);
    r.add([line(1)]);
    r.flush();
    await vi.advanceTimersByTimeAsync(REPORT_RETRY_DELAYS_MS[0] + REPORT_RETRY_DELAYS_MS[1]);
    expect(unanswered).toHaveBeenCalledTimes(3);
    expect(unanswered.mock.calls.every((c) => c[0][0].resultId === 'r1')).toBe(true);

    const refusedOnce = vi.fn().mockRejectedValue(Object.assign(new Error('not yours'), { status: 403 }));
    const r2 = createTranscriptReporter(refusedOnce);
    r2.add([line(2)]);
    r2.flush();
    await vi.advanceTimersByTimeAsync(REPORT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(refusedOnce).toHaveBeenCalledTimes(1);

    const spent = vi.fn().mockRejectedValue(Object.assign(new Error('full'), { status: 429, code: 'TRANSCRIPT_SHARE_SPENT' }));
    const r3 = createTranscriptReporter(spent);
    r3.add([line(3)]);
    r3.flush();
    await vi.advanceTimersByTimeAsync(REPORT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(spent).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('sends what is waiting when the person leaves', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = createTranscriptReporter(send);
    r.add([line(1)]);
    r.flush();
    expect(send).toHaveBeenCalledWith([line(1)]);
  });
});

describe('when the meeting was recorded', () => {
  it('answers by the time a line was spoken: a line begun before recording started is not kept, one begun before it stopped is', () => {
    const t = createRecordingTimeline();
    t.set(true, 10_000);
    t.set(false, 15_000);
    // Up to the server's own allowance before the start counts; earlier does not.
    expect(t.recordedAt(10_000 - RECORDED_FROM_GRACE_MS - 1)).toBe(false);
    expect(t.recordedAt(10_000 - RECORDED_FROM_GRACE_MS)).toBe(true);
    expect(t.recordedAt(10_000)).toBe(true);
    expect(t.recordedAt(14_999)).toBe(true);
    expect(t.recordedAt(15_000)).toBe(false);
    expect(t.now()).toBe(false);
    t.set(true, 19_000);
    expect(t.now()).toBe(true);
    expect(t.recordedAt(20_000)).toBe(true);
    t.reset();
    expect(t.recordedAt(20_000)).toBe(false);
  });
});

describe('live captions and the mode a host says', () => {
  it('shows every speaker\'s lines, partial ones included, and grows a forming line in place', async () => {
    const { nextCaptions, CAPTION_LINES } = await import('./meetingTranscription');
    const read = readTranscriptEvent(transcript([{ id: 'r1', attendeeId: 'them', text: 'agre', partial: true }]), 'me');
    expect(read.own).toEqual([]);
    expect(read.captions).toEqual([{ resultId: 'r1', personId: 'p-them', text: 'agre', partial: true }]);
    const grown = nextCaptions(read.captions, [{ resultId: 'r1', personId: 'p-them', text: 'agreed', partial: false }]);
    expect(grown).toEqual([{ resultId: 'r1', personId: 'p-them', text: 'agreed', partial: false }]);
    const many = Array.from({ length: CAPTION_LINES + 2 }, (_, i) => ({ resultId: `x${i}`, personId: 'p', text: `${i}`, partial: false }));
    expect(nextCaptions([], many).map((l) => l.text)).toEqual(many.slice(-CAPTION_LINES).map((l) => l.text));
  });

  it('reads a mode message strictly', async () => {
    const { transcriptionModeOf } = await import('./meetingTranscription');
    expect(transcriptionModeOf('{"on":true,"recording":false}')).toEqual({ on: true, recording: false });
    expect(transcriptionModeOf('{"on":"yes"}')).toBeNull();
    expect(transcriptionModeOf('nope')).toBeNull();
  });
});

describe('a spoken notice never enters the meeting audio', () => {
  /** A session microphone: the person's own mute, and the session's actual state. */
  function mic(personMuted: boolean) {
    const state = { personMuted, sessionMuted: personMuted, mutes: 0, unmutes: 0 };
    const m = {
      personMuted: () => state.personMuted,
      mute: () => { state.sessionMuted = true; state.mutes += 1; },
      unmute: () => { state.sessionMuted = false; state.unmutes += 1; },
    };
    return { state, hold: createNoticeMicHold(() => m) };
  }

  it('mutes an open microphone for the notice and opens it again after', () => {
    const { state, hold } = mic(false);
    const release = hold.hold();
    expect(state.sessionMuted).toBe(true);
    release();
    expect(state.sessionMuted).toBe(false);
  });

  it('leaves a muted person muted, during and after', () => {
    const { state, hold } = mic(true);
    const release = hold.hold();
    release();
    expect(state.sessionMuted).toBe(true);
    expect(state.unmutes).toBe(0);
  });

  it('keeps the person muted when they mute themselves while the notice plays', () => {
    const { state, hold } = mic(false);
    const release = hold.hold();
    state.personMuted = true;
    release();
    expect(state.sessionMuted).toBe(true);
  });

  it('holds through overlapping notices and releases each once', () => {
    const { state, hold } = mic(false);
    const a = hold.hold();
    const b = hold.hold();
    a();
    a();
    expect(state.sessionMuted).toBe(true);
    expect(hold.held()).toBe(true);
    b();
    expect(state.sessionMuted).toBe(false);
    expect(state.mutes).toBe(1);
  });

  describe('as announce says it', () => {
    let spoken: Array<{ onend?: () => void; onerror?: () => void }> = [];
    beforeEach(() => {
      spoken = [];
      vi.stubGlobal('SpeechSynthesisUtterance', class { onend?: () => void; onerror?: () => void; text: string; constructor(text: string) { this.text = text; } });
      vi.stubGlobal('speechSynthesis', { speak: (u: { onend?: () => void }) => { spoken.push(u); } });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it('restores the microphone when the speech ends', () => {
      const { state, hold } = mic(false);
      announce('Recording started', 'en', hold.hold);
      expect(state.sessionMuted).toBe(true);
      spoken[0].onend?.();
      expect(state.sessionMuted).toBe(false);
    });

    it('restores the microphone when the speech fails', () => {
      const { state, hold } = mic(false);
      announce('Recording started', 'en', hold.hold);
      spoken[0].onerror?.();
      expect(state.sessionMuted).toBe(false);
    });

    it('restores the microphone when speaking throws', () => {
      vi.stubGlobal('speechSynthesis', { speak: () => { throw new Error('no voice'); } });
      const { state, hold } = mic(false);
      announce('Recording started', 'en', hold.hold);
      expect(state.sessionMuted).toBe(false);
      expect(hold.held()).toBe(false);
    });

    it('restores the microphone when the browser never says the speech ended', () => {
      vi.useFakeTimers();
      const { state, hold } = mic(false);
      announce('Recording started', 'en', hold.hold);
      vi.advanceTimersByTime(noticeHoldLimitMs('Recording started'));
      expect(state.sessionMuted).toBe(false);
    });

    it('cuts short a notice still being said at the limit, before the microphone opens', () => {
      vi.useFakeTimers();
      const order: string[] = [];
      vi.stubGlobal('speechSynthesis', { speak: () => undefined, cancel: () => { order.push('cancel'); } });
      const m = { personMuted: () => false, mute: () => undefined, unmute: () => { order.push('unmute'); } };
      announce('Recording started', 'en', createNoticeMicHold(() => m).hold);
      vi.advanceTimersByTime(noticeHoldLimitMs('Recording started'));
      expect(order).toEqual(['cancel', 'unmute']);
    });
  });

  it('holds no longer than the notice takes to say and a short margin', () => {
    // The longest notice the room says is under 200 characters: near 15 seconds of speech.
    const text = 'x'.repeat(200);
    expect(noticeHoldLimitMs(text)).toBeGreaterThan(200 * 60);
    expect(noticeHoldLimitMs(text)).toBeLessThanOrEqual(200 * 75 + 3000);
    expect(noticeHoldLimitMs('')).toBeLessThanOrEqual(3000);
  });

  it('says when the hold begins and ends, once for overlapping notices, after the microphone is returned', () => {
    const seen: string[] = [];
    const m = { personMuted: () => false, mute: () => { seen.push('mute'); }, unmute: () => { seen.push('unmute'); } };
    const hold = createNoticeMicHold(() => m, (held) => { seen.push(held ? 'held' : 'released'); });
    const a = hold.hold();
    const b = hold.hold();
    a();
    b();
    expect(seen).toEqual(['mute', 'held', 'unmute', 'released']);
  });

  it('gives back the session that is live when the notice ends, a rebuilt one included', () => {
    const first = { personMuted: () => false, mute: vi.fn(), unmute: vi.fn() };
    const rebuilt = { personMuted: () => false, mute: vi.fn(), unmute: vi.fn() };
    let live: typeof first | null = first;
    const hold = createNoticeMicHold(() => live);
    const release = hold.hold();
    live = rebuilt;
    expect(hold.held()).toBe(true);
    release();
    expect(rebuilt.unmute).toHaveBeenCalledTimes(1);
    expect(first.unmute).not.toHaveBeenCalled();
    // With no session left, the hold still ends cleanly.
    const again = hold.hold();
    live = null;
    again();
    expect(hold.held()).toBe(false);
  });
});
