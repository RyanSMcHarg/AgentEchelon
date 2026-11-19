/**
 * MeetingProvider - a session's life, start to end:
 *
 *  - THE WINDOW'S SIGN-IN ENDING LEAVES THE MEETING: microphone, camera and the meeting's audio stop, and the attendee is
 *    forgotten, so whoever signs in next is never in the meeting as the person who was.
 *  - A SESSION TORN DOWN WHILE IT CONNECTS NEVER STARTS.
 *  - A TORN-DOWN SESSION NEVER REJOINS ON ITS OWN: the SDK's waiting reconnect is cancelled, and a session that starts
 *    anyway is stopped the moment it does.
 *  - A LINE IS KEPT BY WHEN IT WAS SPOKEN, not by when the service finished it.
 *  - AFTER THE SDK'S OWN RECONNECT the mode is read from the service, so a recording started meanwhile is shown.
 *  - A control's failure is put away by the next success of that control.
 *  - The context value is the same object across a render that changed nothing the meeting shows, and captions live in a
 *    context of their own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { AudioVideoObserver, TranscriptEvent } from 'amazon-chime-sdk-js';
import '@ae/shared/i18n';
import { endSessionEpoch } from '@ae/shared/services/sessionEpoch.ts';
import { MeetingProvider, useMeeting, useMeetingCaptions, type MeetingContextValue } from './MeetingProvider';

interface FakeSession {
  observers: AudioVideoObserver[];
  stop: ReturnType<typeof vi.fn<() => void>>;
  start: ReturnType<typeof vi.fn<() => void>>;
  cancelReconnect: ReturnType<typeof vi.fn<() => void>>;
  transcript: Array<(e: TranscriptEvent) => void>;
  sentData: unknown[][];
}
let sessions: FakeSession[] = [];
/** How the next session's microphone opens: a test may hold it to tear the session down mid-connect. */
let openMic: () => Promise<void> = () => Promise.resolve();
let videoInputs: Array<{ deviceId: string; label: string }> = [];
let startVideoInput: (id: string) => Promise<void> = () => Promise.resolve();

vi.mock('amazon-chime-sdk-js', () => {
  class ConsoleLogger { constructor(_n?: string, _l?: number) {} }
  class DefaultDeviceController { constructor(_l?: unknown) {} destroy() { return Promise.resolve(); } }
  class DefaultActiveSpeakerPolicy {}
  class VideoPriorityBasedPolicy { chooseRemoteVideoSources() {} }
  class MeetingSessionConfiguration { constructor(_m: unknown, _a: unknown) {} }
  class Transcript {}
  class TranscriptionStatus {}
  class DefaultMeetingSession {
    eventController = { addObserver: () => undefined, removeObserver: () => undefined };
    audioVideoController: { _reconnectController: { cancel: () => void } };
    audioVideo: Record<string, unknown>;
    constructor(_c: unknown, _l: unknown, _d: unknown) {
      const fake: FakeSession = {
        observers: [], stop: vi.fn<() => void>(), start: vi.fn<() => void>(), cancelReconnect: vi.fn<() => void>(), transcript: [], sentData: [],
      };
      fake.start.mockImplementation(() => { fake.observers.forEach((o) => o.audioVideoDidStart?.()); });
      sessions.push(fake);
      this.audioVideoController = { _reconnectController: { cancel: fake.cancelReconnect } };
      this.audioVideo = {
        addObserver: (o: AudioVideoObserver) => { fake.observers.push(o); },
        removeObserver: (o: AudioVideoObserver) => { fake.observers = fake.observers.filter((x) => x !== o); },
        start: fake.start,
        stop: fake.stop,
        stopLocalVideoTile: vi.fn(), startLocalVideoTile: vi.fn(), stopContentShare: vi.fn(), bindVideoElement: vi.fn(), unbindAudioElement: vi.fn(),
        listAudioInputDevices: () => Promise.resolve([{ deviceId: 'mic', label: 'Mic' }]),
        listAudioOutputDevices: () => Promise.resolve([]),
        listVideoInputDevices: () => Promise.resolve(videoInputs),
        startAudioInput: () => openMic(), stopAudioInput: () => Promise.resolve(),
        startVideoInput: (id: string) => startVideoInput(id), stopVideoInput: () => Promise.resolve(),
        chooseAudioOutput: () => Promise.resolve(),
        bindAudioElement: () => Promise.resolve(),
        realtimeSubscribeToMuteAndUnmuteLocalAudio: () => undefined, realtimeUnsubscribeToMuteAndUnmuteLocalAudio: () => undefined,
        addDeviceChangeObserver: () => undefined, removeDeviceChangeObserver: () => undefined,
        addContentShareObserver: () => undefined, removeContentShareObserver: () => undefined,
        realtimeMuteLocalAudio: () => undefined, realtimeUnmuteLocalAudio: () => true, realtimeSetCanUnmuteLocalAudio: () => undefined,
        realtimeSubscribeToAttendeeIdPresence: () => undefined, realtimeUnsubscribeToAttendeeIdPresence: () => undefined,
        realtimeSubscribeToVolumeIndicator: () => undefined, realtimeUnsubscribeFromVolumeIndicator: () => undefined,
        subscribeToActiveSpeakerDetector: () => undefined, unsubscribeFromActiveSpeakerDetector: () => undefined,
        realtimeSubscribeToReceiveDataMessage: () => undefined, realtimeUnsubscribeFromReceiveDataMessage: () => undefined,
        realtimeSendDataMessage: (...a: unknown[]) => { fake.sentData.push(a); },
        transcriptionController: {
          subscribeToTranscriptEvent: (cb: (e: TranscriptEvent) => void) => { fake.transcript.push(cb); },
          unsubscribeFromTranscriptEvent: (cb: unknown) => { fake.transcript = fake.transcript.filter((x) => x !== cb); },
        },
      };
    }
  }
  return {
    ConsoleLogger, DefaultActiveSpeakerPolicy, VideoPriorityBasedPolicy, DefaultDeviceController, DefaultMeetingSession, MeetingSessionConfiguration,
    Transcript, TranscriptionStatus, TranscriptItemType: { PRONUNCIATION: 'pronunciation' }, TranscriptionStatusType: { STARTED: 'started', STOPPED: 'stopped', RESUMED: 'resumed', FAILED: 'failed' },
    MeetingSessionStatusCode: { Left: 1, MeetingEnded: 5, AudioAttendeeRemoved: 22 }, LogLevel: { WARN: 2 },
  };
});

const joinMeeting = vi.fn();
const statusRead = vi.fn();
const reportTranscript = vi.fn();
const setTranscription = vi.fn();
vi.mock('../services/meetingService', () => ({
  meetingService: {
    joinMeeting: (a: string) => joinMeeting(a),
    status: (a: string) => statusRead(a),
    reportEvents: () => Promise.resolve(),
    reportTranscript: (...a: unknown[]) => reportTranscript(...a),
    setTranscription: (...a: unknown[]) => setTranscription(...a),
  },
  isMeetingEnabled: () => true,
}));
vi.mock('../services/chimeService', () => ({ chimeService: { sendRing: () => Promise.resolve() } }));
const keepaliveStop = vi.fn();
vi.mock('./meetingKeepalive', () => ({ startKeepalive: () => Promise.resolve({ stop: keepaliveStop, resume: vi.fn() }) }));

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const JOIN = {
  meeting: { MeetingId: 'm-1', MediaPlacement: {} }, attendee: { AttendeeId: 'a-1', ExternalUserId: 'alice', JoinToken: 't' },
  classification: 'premium', startedAt: '2026-11-12T00:00:00.000Z', hostIds: ['host'],
};

let renders: Array<{ value: unknown; captions: unknown }> = [];
function Probe() {
  const m = useMeeting();
  const captions = useMeetingCaptions();
  renders.push({ value: m, captions });
  return (
    <div>
      <span data-testid="status">{m.status}</span>
      <span data-testid="recording">{String(m.recording)}</span>
      <span data-testid="error">{m.errorCode ?? ''}</span>
      <span data-testid="self">{m.selfAttendeeId ?? ''}</span>
      <button onClick={() => { void m.join(CHANNEL); }}>join</button>
      <button onClick={() => m.leave()}>leave</button>
      <button onClick={() => { void m.toggleCamera(); }}>camera</button>
    </div>
  );
}
const text = (id: string) => screen.getByTestId(id).textContent;
const click = (name: string) => act(async () => { screen.getByText(name).click(); });

/** A final transcript line of this person's, begun at `startMs`. */
async function sayLine(session: FakeSession, id: string, startMs: number) {
  const { Transcript } = await import('amazon-chime-sdk-js');
  const t = new Transcript() as unknown as { results: unknown[] };
  t.results = [{
    resultId: id, isPartial: false, startTimeMs: startMs, endTimeMs: startMs + 500,
    alternatives: [{ transcript: `line ${id}`, items: [{ type: 'pronunciation', attendee: { attendeeId: 'a-1', externalUserId: 'alice' } }] }],
  }];
  await act(async () => { session.transcript.forEach((cb) => cb(t as unknown as TranscriptEvent)); });
}

beforeEach(() => {
  sessions = [];
  renders = [];
  openMic = () => Promise.resolve();
  videoInputs = [];
  startVideoInput = () => Promise.resolve();
  keepaliveStop.mockClear();
  joinMeeting.mockReset().mockResolvedValue(JOIN);
  statusRead.mockReset().mockResolvedValue({ running: true });
  reportTranscript.mockReset().mockResolvedValue(undefined);
  setTranscription.mockReset();
});

describe('the window\'s sign-in ending', () => {
  it('leaves the meeting: the session stops, the attendee is forgotten, and nothing is left joined', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    expect(text('status')).toBe('joined');
    expect(text('self')).toBe('a-1');
    await act(async () => { endSessionEpoch('ended'); });
    expect(sessions[0].stop).toHaveBeenCalled();
    expect(text('status')).toBe('idle');
    expect(text('self')).toBe('');
    expect(keepaliveStop).toHaveBeenCalled();
  });
});

describe('a session torn down while it connects', () => {
  it('never starts: the person who left is not joined to the meeting', async () => {
    let release!: () => void;
    openMic = () => new Promise<void>((r) => { release = r; });
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    expect(sessions).toHaveLength(1);
    await click('leave');
    await act(async () => { release(); });
    expect(sessions[0].start).not.toHaveBeenCalled();
    expect(text('status')).toBe('idle');
  });
});

describe('a torn-down session', () => {
  it('has the SDK\'s waiting reconnect cancelled, and is stopped again if it starts all the same', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    const torn = sessions[0];
    await click('leave');
    expect(torn.cancelReconnect).toHaveBeenCalled();
    const stopsBefore = torn.stop.mock.calls.length;
    // The SDK's backoff fired regardless and the old session came back up as the same attendee.
    await act(async () => { torn.observers.forEach((o) => o.audioVideoDidStart?.()); });
    expect(torn.stop.mock.calls.length).toBe(stopsBefore + 1);
    expect(text('status')).toBe('idle');
  });
});

describe('a line of this person\'s', () => {
  it('is kept by whether the meeting was recorded when it was spoken', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(10_000);
      setTranscription.mockResolvedValue({ on: true, recording: true });
      joinMeeting.mockResolvedValue({ ...JOIN, transcribing: true, recording: false });
      render(<MeetingProvider><Probe /></MeetingProvider>);
      await click('join');
      // Recording starts at 20s; a line begun at 15s (under captions alone) is finished after it.
      vi.setSystemTime(20_000);
      const meeting = renders[renders.length - 1].value as MeetingContextValue;
      await act(async () => { await meeting.setTranscription({ recording: true }); });
      expect(text('recording')).toBe('true');
      await sayLine(sessions[0], 'before', 15_000);
      await sayLine(sessions[0], 'during', 21_000);
      await click('leave');
      const sent = reportTranscript.mock.calls.flatMap((c) => (c[2] as Array<{ resultId: string }>).map((l) => l.resultId));
      expect(sent).toEqual(['during']);
      // Each line goes as exactly the fields the server reads, its start the moment it was spoken.
      const line = (reportTranscript.mock.calls[0][2] as Array<Record<string, unknown>>)[0];
      expect(Object.keys(line).sort()).toEqual(['attendeeId', 'endMs', 'resultId', 'startMs', 'text']);
      expect(line.startMs).toBe(21_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the SDK\'s own reconnect', () => {
  it('reads the mode from the service when the session is back, so a recording started meanwhile is shown', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    expect(text('recording')).toBe('false');
    statusRead.mockResolvedValue({ running: true, transcribing: true, recording: true });
    const live = sessions[0].observers[0];
    await act(async () => { live.audioVideoDidStartConnecting?.(true); });
    expect(text('status')).toBe('reconnecting');
    await act(async () => { live.audioVideoDidStart?.(); });
    expect(statusRead).toHaveBeenCalledWith(CHANNEL);
    expect(text('recording')).toBe('true');
  });
});

describe('a control that failed', () => {
  it('has its failure put away when it works on a later try', async () => {
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await click('join');
    await click('camera');
    expect(text('error')).toBe('CAMERA_UNAVAILABLE');
    videoInputs = [{ deviceId: 'cam', label: 'Camera' }];
    await click('camera');
    expect(text('error')).toBe('');
  });
});

describe('the context value', () => {
  it('is the same object across a render that changed nothing, and captions come from their own context', async () => {
    function Outer({ n }: { n: number }) {
      return <MeetingProvider><span data-testid="n">{n}</span><Probe /></MeetingProvider>;
    }
    const { rerender } = render(<Outer n={1} />);
    await click('join');
    const before = renders[renders.length - 1].value;
    rerender(<Outer n={2} />);
    expect(renders[renders.length - 1].value).toBe(before);
    expect(renders[renders.length - 1].captions).toEqual([]);
  });
});
