/**
 * MeetingProvider - surviving a backgrounded tab.
 *
 * This is the failure mode a meeting has and nothing else here does: a browser throttles a hidden
 * tab's timers, Amazon Chime SDK's own reconnection runs on those timers, and so the recovery
 * mechanism is throttled exactly when it is needed. Somebody switches tabs, comes back, and the
 * session is dead with no reconnect ever attempted.
 *
 * The guarantee these tests exist for, and the one easiest to break by accident:
 *
 *   A REJOIN CREATES NO ATTENDEE. The server mints a new attendee on every join CALL, so recovering
 *   through the API would add one per reconnect and show one person on a train as a dozen - inflating
 *   the roster and every attendance figure taken from it. A rejoin must reuse the cached credentials.
 *
 * Plus: the session is not thrown away on a brief hide, a healthy session is not rejoined for nothing,
 * a stale one is, and a meeting that genuinely ended is not retried.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { AudioVideoObserver } from 'amazon-chime-sdk-js';
import '@ae/shared/i18n';
import { MeetingProvider, useMeeting } from './MeetingProvider';
import VideoTiles from '../components/meeting/VideoTiles';

/** The observers the fake session handed back, so a test can drive SDK callbacks. */
let observers: AudioVideoObserver[] = [];
/** Every MeetingSessionConfiguration the SDK was constructed with, in order. */
let configurations: Array<{ meetingId: string; attendeeId: string }> = [];
/** The client-event observers the fake session was handed, so a test can emit an SDK event. */
let eventObservers: Array<{ eventDidReceive: (name: string, attributes: unknown) => void }> = [];
const avStart = vi.fn();
const avBindVideo = vi.fn();
/** Every mute and unmute any session was told, in order, with the session it was told to. */
let muteCalls: Array<{ session: number; muted: boolean }> = [];
let contentShareObservers: Array<{ contentShareDidStop?: () => void }> = [];
const stopAudioInput = vi.fn(() => Promise.resolve());
/** The microphones and speakers the fake browser lists, and how starting a microphone goes. */
let mics: Array<{ deviceId: string; label: string }> = [];
let outputs: Array<{ deviceId: string; label: string }> = [];
const startAudioInput = vi.fn((_id: string) => Promise.resolve());
/** The session's own-mute subscribers and device-change observers, so a test can see them called and removed. */
let muteSubscribers: Array<(muted: boolean) => void> = [];
let deviceChangeObservers: Array<Record<string, (...a: unknown[]) => void>> = [];
/** The live session's presence subscribers, so a test can say who arrives and who goes. */
let presenceSubscribers: Array<(attendeeId: string, present: boolean, externalUserId?: string) => void> = [];
const deviceDestroy = vi.fn(() => Promise.resolve());

vi.mock('amazon-chime-sdk-js', () => {
  class ConsoleLogger { constructor(_n?: string, _l?: number) {} }
  class DefaultDeviceController { constructor(_l?: unknown) {} destroy() { return deviceDestroy(); } }
  class DefaultActiveSpeakerPolicy {}
  class VideoPriorityBasedPolicy { chooseRemoteVideoSources() {} }
  // The layout's choice of videos (`useVideoSubscriptions.ts`), built into what the policy above is handed.
  const VideoPreference = function VideoPreference(this: object, attendeeId: string, priority: number, targetSize?: number) { Object.assign(this, { attendeeId, priority, targetSize }); };
  const VideoPreferences = { prepare: () => { const items: unknown[] = []; return { add: (p: unknown) => items.push(p), build: () => items }; } };
  const TargetDisplaySize = { Low: 0, Medium: 1, High: 2, Maximum: 3 };
  class MeetingSessionConfiguration {
    meetingId: string;
    attendeeId: string;
    constructor(meeting: { MeetingId: string }, attendee: { AttendeeId: string }) {
      this.meetingId = meeting.MeetingId;
      this.attendeeId = attendee.AttendeeId;
      configurations.push({ meetingId: this.meetingId, attendeeId: this.attendeeId });
    }
  }
  class DefaultMeetingSession {
    audioVideo: Record<string, unknown>;
    // The SDK's client events, which the provider reports for the meeting's analytics.
    eventController = {
      addObserver: (o: { eventDidReceive: (n: string, a: unknown) => void }) => { eventObservers.push(o); },
      removeObserver: (o: unknown) => { eventObservers = eventObservers.filter((x) => x !== o); },
    };
    constructor(_c: unknown, _l: unknown, _d: unknown) {
      const session = configurations.length;
      this.audioVideo = {
        addObserver: (o: AudioVideoObserver) => { observers.push(o); },
        // Mirrors the real SDK, so a test sees the provider taking its observer off again.
        removeObserver: (o: AudioVideoObserver) => { observers = observers.filter((x) => x !== o); },
        start: avStart,
        bindVideoElement: avBindVideo,
        stop: vi.fn(),
        stopLocalVideoTile: vi.fn(),
        stopContentShare: vi.fn(),
        listAudioInputDevices: () => Promise.resolve(mics),
        listAudioOutputDevices: () => Promise.resolve(outputs),
        startAudioInput: (id: string) => startAudioInput(id),
        realtimeSubscribeToMuteAndUnmuteLocalAudio: (cb: (muted: boolean) => void) => { muteSubscribers.push(cb); },
        realtimeUnsubscribeToMuteAndUnmuteLocalAudio: (cb: unknown) => { muteSubscribers = muteSubscribers.filter((x) => x !== cb); },
        addDeviceChangeObserver: (o: Record<string, (...a: unknown[]) => void>) => { deviceChangeObservers.push(o); },
        removeDeviceChangeObserver: (o: unknown) => { deviceChangeObservers = deviceChangeObservers.filter((x) => x !== o); },
        listVideoInputDevices: () => Promise.resolve([]),
        bindAudioElement: () => Promise.resolve(),
        realtimeMuteLocalAudio: () => { muteCalls.push({ session, muted: true }); muteSubscribers.forEach((cb) => cb(true)); },
        realtimeUnmuteLocalAudio: () => { muteCalls.push({ session, muted: false }); muteSubscribers.forEach((cb) => cb(false)); },
        addContentShareObserver: (o: { contentShareDidStop?: () => void }) => { contentShareObservers.push(o); },
        removeContentShareObserver: (o: unknown) => { contentShareObservers = contentShareObservers.filter((x) => x !== o); },
        startContentShareFromScreenCapture: () => Promise.resolve(),
        startContentShare: () => Promise.resolve(),
        realtimeSetCanUnmuteLocalAudio: vi.fn(),
        stopAudioInput,
        stopVideoInput: () => Promise.resolve(),
        realtimeSubscribeToAttendeeIdPresence: (cb: (id: string, present: boolean, ext?: string) => void) => { presenceSubscribers.push(cb); },
        realtimeUnsubscribeToAttendeeIdPresence: (cb: unknown) => { presenceSubscribers = presenceSubscribers.filter((x) => x !== cb); },
        realtimeSubscribeToVolumeIndicator: vi.fn(),
        realtimeUnsubscribeFromVolumeIndicator: vi.fn(),
        subscribeToActiveSpeakerDetector: vi.fn(),
        unsubscribeFromActiveSpeakerDetector: vi.fn(),
      };
    }
  }
  return {
    ConsoleLogger,
    DefaultActiveSpeakerPolicy,
    VideoPriorityBasedPolicy,
    VideoPreference,
    VideoPreferences,
    TargetDisplaySize,
    DefaultDeviceController,
    DefaultMeetingSession,
    MeetingSessionConfiguration,
    MeetingSessionStatusCode: { Left: 1, AudioJoinedFromAnotherDevice: 2, AudioAuthenticationRejected: 3, AudioCallAtCapacity: 4, MeetingEnded: 5, AudioDisconnected: 8, VideoCallAtSourceCapacity: 10, SignalingRequestFailed: 13, AudioAttendeeRemoved: 22 },
    LogLevel: { WARN: 2 },
  };
});

const startMeeting = vi.fn();
const joinMeeting = vi.fn();
const endMeeting = vi.fn();
const statusRead = vi.fn();
vi.mock('../services/meetingService', () => ({
  meetingService: {
    startMeeting: (a: string) => startMeeting(a),
    joinMeeting: (a: string) => joinMeeting(a),
    endMeeting: (a: string) => endMeeting(a),
    status: (a: string) => statusRead(a),
    reportEvents: (...a: unknown[]) => reportEvents(...(a as [])),
  },
  isMeetingEnabled: () => true,
}));

const sendRing = vi.fn(() => Promise.resolve());
const reportEvents = vi.fn(() => Promise.resolve());
vi.mock('../services/chimeService', () => ({ chimeService: { sendRing: (...a: unknown[]) => sendRing(...(a as [])) } }));

// The keepalive is a browser workaround with its own file; here, only when it starts, stops and resumes.
const keepaliveStop = vi.fn();
const keepaliveResume = vi.fn();
let keepaliveStarts = 0;
vi.mock('./meetingKeepalive', () => ({
  startKeepalive: () => { keepaliveStarts += 1; return Promise.resolve({ stop: keepaliveStop, resume: keepaliveResume }); },
}));

const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1';
const JOIN_INFO = {
  meeting: { MeetingId: 'm-1', MediaPlacement: {} },
  attendee: { AttendeeId: 'a-1', ExternalUserId: 'alice', JoinToken: 'tok' },
  classification: 'premium',
  startedAt: '2026-10-01T00:00:00.000Z',
};

let endResult: boolean | undefined;

function Probe() {
  const m = useMeeting();
  return (
    <div>
      <span data-testid="status">{m.status}</span>
      <span data-testid="code">{m.errorCode ?? ''}</span>
      <button onClick={() => { void m.start(CHANNEL); }}>start</button>
      <button onClick={() => { void m.startNow(CHANNEL); }}>start now</button>
      <button onClick={() => { void m.join(CHANNEL); }}>join</button>
      <span data-testid="started-here">{String(m.startedHere)}</span>
      <span data-testid="muted">{String(m.muted)}</span>
      <span data-testid="mode">{`${m.transcribing ? 'captions' : 'none'}/${m.recording ? 'recording' : 'not-recorded'}`}</span>
      <span data-testid="held">{String(m.mutedByHost)}</span>
      <span data-testid="sharing">{String(m.sharing)}</span>
      <span data-testid="left">{m.leftPersonIds.join(',')}</span>
      <span data-testid="present">{m.attendees.map((a) => a.personId).join(',')}</span>
      <button onClick={() => { m.leave(); }}>leave</button>
      <button onClick={() => { void m.end(CHANNEL).then((ok) => { endResult = ok; }); }}>end</button>
      <button onClick={() => { m.toggleMute(); }}>mute</button>
      <button onClick={() => { m.toggleShare(); }}>share</button>
    </div>
  );
}

/**
 * Report a stop on the LIVE session's observer.
 *
 * Only the latest, because a torn-down session's observer is removed - and if it were not, firing on
 * a stale one would be how the compounding-rejoin bug reappears.
 */
async function reportStop(opts: { terminal: boolean; statusCode?: number }) {
  const live = observers[observers.length - 1];
  // A terminal stop is the meeting ending (5) unless a test names another code.
  const statusCode = opts.statusCode ?? (opts.terminal ? 5 : 18);
  await act(async () => {
    live?.audioVideoDidStop?.({ isTerminal: () => opts.terminal, isFailure: () => true, statusCode: () => statusCode } as never);
  });
  // A rejoin pauses before it connects (`rejoinDelayMs`), longest for the last attempt of a round.
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
}

const status = () => screen.getByTestId('status').textContent;
const code = () => screen.getByTestId('code').textContent;

/** Hide the tab, wait `ms` of wall clock, then show it again. */
function hideFor(ms: number) {
  const spy = vi.spyOn(document, 'visibilityState', 'get');
  spy.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(ms);
  spy.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
}

async function startAMeeting() {
  render(<MeetingProvider><Probe /></MeetingProvider>);
  await act(async () => { screen.getByText('start').click(); });
  expect(status()).toBe('joined');
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  observers = [];
  configurations = [];
  eventObservers = [];
  reportEvents.mockClear();
  // RESET, not clear: one test replaces this with a throwing implementation, and `mockClear` leaves
  // that in place for every test after it - which shows up as an unrelated test failing to join.
  // The SDK's start reports the session started on the observer it was given, which is what turns the room to joined.
  avStart.mockReset().mockImplementation(() => { observers[observers.length - 1]?.audioVideoDidStart?.(); });
  muteCalls = [];
  contentShareObservers = [];
  stopAudioInput.mockClear();
  mics = [];
  outputs = [];
  startAudioInput.mockReset().mockResolvedValue(undefined);
  muteSubscribers = [];
  deviceChangeObservers = [];
  presenceSubscribers = [];
  deviceDestroy.mockClear();
  avBindVideo.mockReset();
  endMeeting.mockReset();
  endResult = undefined;
  keepaliveStop.mockClear();
  keepaliveResume.mockClear();
  keepaliveStarts = 0;
  startMeeting.mockReset().mockResolvedValue(JOIN_INFO);
  joinMeeting.mockReset().mockResolvedValue(JOIN_INFO);
  statusRead.mockReset().mockResolvedValue({ running: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a rejoin reuses the credentials and creates no attendee', () => {
  it('does NOT call the API again when the SDK reports a recoverable stop', async () => {
    await startAMeeting();
    expect(startMeeting).toHaveBeenCalledTimes(1);

    await reportStop({ terminal: false });

    // THE GUARANTEE: one API call for the whole meeting, however many reconnects happened.
    expect(startMeeting).toHaveBeenCalledTimes(1);
    expect(joinMeeting).not.toHaveBeenCalled();
    // And the rejoin used the SAME attendee, so the roster did not grow.
    expect(configurations).toHaveLength(2);
    expect(configurations[1]).toEqual({ meetingId: 'm-1', attendeeId: 'a-1' });
  });

  it('leaves exactly ONE observer registered, so a dead session cannot trigger more rejoins', async () => {
    // Every observer that can report a stop. A torn-down session keeps one observer of its own, which only stops it again
    // should it start, and reports nothing.
    const reporting = () => observers.filter((o) => o.audioVideoDidStop);
    await startAMeeting();
    expect(reporting()).toHaveLength(1);
    await reportStop({ terminal: false });
    // The dead session's observer was taken off when it was torn down. Without that it would still
    // be registered and still able to report a stop - read as the LIVE session dropping, triggering
    // another rejoin that kills the session somebody is actually in, once more per reconnect.
    expect(reporting()).toHaveLength(1);
    await reportStop({ terminal: false });
    expect(reporting()).toHaveLength(1);
    expect(observers.filter((o) => !o.audioVideoDidStop).every((o) => Object.keys(o).join() === 'audioVideoDidStart')).toBe(true);
    expect(startMeeting).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of attempts rather than retrying forever', async () => {
    await startAMeeting();
    // Every rejoin now fails to CONNECT. That is the case the cap is for: a rejoin that connects and
    // then drops again has genuinely succeeded, and resetting the count on it is correct - otherwise
    // a long meeting over a flaky connection would exhaust its attempts and give up on someone who
    // was reconnecting fine.
    avStart.mockImplementation(() => { throw new Error('cannot reach the media endpoint'); });
    await reportStop({ terminal: false });

    expect(status()).toBe('error');
    expect(code()).toBe('CONNECTION_LOST');
    // Still no second API call, even having given up.
    expect(startMeeting).toHaveBeenCalledTimes(1);
  });
});

describe('a terminal stop is the meeting ending, not a connection to recover', () => {
  it('cleans up instead of rejoining', async () => {
    await startAMeeting();
    const sessionsBefore = configurations.length;
    await reportStop({ terminal: true });
    expect(status()).toBe('idle');
    // No new session was built: a meeting that ended is not reconnected to.
    expect(configurations).toHaveLength(sessionsBefore);
    expect(keepaliveStop).toHaveBeenCalled();
  });
});

describe('coming back to the tab', () => {
  it('does not touch a session after a blink of hiddenness', async () => {
    await startAMeeting();
    const before = configurations.length;
    act(() => { hideFor(500) });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(status()).toBe('joined');
    expect(configurations).toHaveLength(before);
  });

  it('leaves a HEALTHY session alone after a long hide', async () => {
    await startAMeeting();
    const before = configurations.length;
    act(() => { hideFor(60_000) });
    // The grace period passes and the session never reported trouble, so nothing is rejoined.
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(status()).toBe('joined');
    expect(configurations).toHaveLength(before);
    expect(startMeeting).toHaveBeenCalledTimes(1);
  });

  it('rejoins a session still stuck reconnecting once the grace period passes', async () => {
    await startAMeeting();
    // The SDK noticed the drop while hidden and is stuck trying to recover.
    await act(async () => {
      for (const o of observers) o.audioVideoDidStartConnecting?.(true);
    });
    expect(status()).toBe('reconnecting');
    const before = configurations.length;

    act(() => { hideFor(60_000) });
    // Nothing happens before the grace period: an immediate check passes on a dead session, because
    // a returning tab reports healthy until something crosses the connection.
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(configurations).toHaveLength(before);

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(configurations.length).toBeGreaterThan(before);
    expect(configurations[configurations.length - 1]).toEqual({ meetingId: 'm-1', attendeeId: 'a-1' });
    expect(startMeeting).toHaveBeenCalledTimes(1);
  });
});

describe('the SDK starting to reconnect DURING the grace period', () => {
  it('still rejoins: the status change must not cancel the check it is the reason for', async () => {
    await startAMeeting();
    const before = configurations.length;
    act(() => { hideFor(60_000) });
    // Healthy on return; the drop is noticed a second later, inside the grace period.
    await act(async () => { vi.advanceTimersByTime(1000); });
    await act(async () => {
      for (const o of observers) o.audioVideoDidStartConnecting?.(true);
    });
    expect(status()).toBe('reconnecting');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(configurations.length).toBeGreaterThan(before);
    expect(startMeeting).toHaveBeenCalledTimes(1);
  });
});

describe('ending for everyone', () => {
  it('reports a refused end, so the room can stay open and say the meeting is still running', async () => {
    await startAMeeting();
    endMeeting.mockRejectedValue(Object.assign(new Error('nope'), { code: 'END_FAILED' }));
    await act(async () => { screen.getByText('end').click(); });
    expect(endResult).toBe(false);
    expect(status()).toBe('error');
    expect(code()).toBe('END_FAILED');
  });

  it('reports a completed end', async () => {
    await startAMeeting();
    endMeeting.mockResolvedValue({ ended: true });
    await act(async () => { screen.getByText('end').click(); });
    expect(endResult).toBe(true);
    expect(status()).toBe('idle');
  });

  it('sends what this app is holding, then ends the meeting at once without waiting on that batch', async () => {
    await startAMeeting();
    await act(async () => { screen.getByText('mute').click(); });
    reportEvents.mockImplementationOnce(() => new Promise<void>(() => undefined));
    endMeeting.mockResolvedValue({ ended: true });
    await act(async () => { screen.getByText('end').click(); });
    expect(reported().map((e) => e.name)).toContain('audioMuted');
    expect(reportEvents.mock.invocationCallOrder.at(-1)!).toBeLessThan(endMeeting.mock.invocationCallOrder[0]);
    expect(endMeeting).toHaveBeenCalledWith(CHANNEL);
    expect(endResult).toBe(true);
  });

  it("sends no ring-off itself: the platform stops the ring as the room's assistant, the one sender a ring counts from", async () => {
    startMeeting.mockResolvedValue({ ...JOIN_INFO, conversationId: 'c1', roomConversationId: 'room-1' });
    await startAMeeting();
    sendRing.mockClear();
    endMeeting.mockResolvedValue({ ended: true });
    await act(async () => { screen.getByText('end').click(); });
    expect(endMeeting).toHaveBeenCalledWith(CHANNEL);
    expect(sendRing).not.toHaveBeenCalled();
  });
});

describe('this person is in the meeting under every name it goes by', () => {
  it('holds presence for the conversation entered from, the meeting\'s own conversation and its room', async () => {
    const requested: string[] = [];
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      locks: { request: vi.fn((name: string) => { requested.push(name); return new Promise(() => undefined); }), query: vi.fn() },
    });
    startMeeting.mockResolvedValue({ ...JOIN_INFO, conversationId: 'meet-1', roomConversationId: 'room-1' });
    await startAMeeting();
    expect(new Set(requested)).toEqual(new Set(['ae-in-meeting-c1', 'ae-in-meeting-meet-1', 'ae-in-meeting-room-1']));
    vi.unstubAllGlobals();
  });
});

describe('the meeting starts when Start is pressed, and the device check joins it', () => {
  it('creates the meeting at once, connects nobody yet, and holds presence so its own ring rings nobody', async () => {
    const requested: string[] = [];
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      locks: { request: vi.fn((name: string) => { requested.push(name); return new Promise(() => undefined); }), query: vi.fn() },
    });
    startMeeting.mockResolvedValue({ ...JOIN_INFO, created: true, conversationId: 'meet-1', roomConversationId: 'room-1' });
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await act(async () => { screen.getByText('start now').click(); });
    expect(startMeeting).toHaveBeenCalledWith(CHANNEL);
    expect(screen.getByTestId('started-here').textContent).toBe('true');
    expect(status()).toBe('idle');
    expect(avStart).not.toHaveBeenCalled();
    expect(new Set(requested)).toEqual(new Set(['ae-in-meeting-c1', 'ae-in-meeting-meet-1', 'ae-in-meeting-room-1']));
    vi.unstubAllGlobals();
  });

  it("joins with the start's own answer, asking the service nothing more", async () => {
    startMeeting.mockResolvedValue({ ...JOIN_INFO, created: true, conversationId: 'meet-1', roomConversationId: 'c1' });
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await act(async () => { screen.getByText('start now').click(); });
    await act(async () => { screen.getByText('join').click(); });
    expect(status()).toBe('joined');
    expect(startMeeting).toHaveBeenCalledTimes(1);
    expect(joinMeeting).not.toHaveBeenCalled();
    expect(screen.getByTestId('started-here').textContent).toBe('false');
  });

  it('says a start the service refused, and keeps nothing for a later join', async () => {
    startMeeting.mockRejectedValue(Object.assign(new Error('no'), { code: 'NOT_HOST' }));
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await act(async () => { screen.getByText('start now').click(); });
    expect(status()).toBe('error');
    expect(code()).toBe('NOT_HOST');
    expect(screen.getByTestId('started-here').textContent).toBe('false');
    await act(async () => { screen.getByText('join').click(); });
    expect(joinMeeting).toHaveBeenCalledTimes(1);
  });
});

describe('the video grid', () => {
  it('renders a tile without a render loop, and binds its element once across re-renders', async () => {
    render(<MeetingProvider><Probe /><VideoTiles /></MeetingProvider>);
    await act(async () => { screen.getByText('start').click(); });
    await act(async () => {
      observers[observers.length - 1].videoTileDidUpdate?.({ tileId: 1, boundAttendeeId: 'a-1', localTile: true } as never);
    });
    expect(document.querySelectorAll('video')).toHaveLength(1);
    // A re-announcement of the same tile and an unrelated state change both re-render the grid.
    await act(async () => {
      observers[observers.length - 1].videoTileDidUpdate?.({ tileId: 1, boundAttendeeId: 'a-1', localTile: true } as never);
      observers[observers.length - 1].audioVideoDidStartConnecting?.(true);
    });
    expect(avBindVideo).toHaveBeenCalledTimes(1);
  });
});

describe('a start sends no ring of its own (the platform rings the room as its assistant)', () => {
  it('sends nothing when the start created the meeting', async () => {
    sendRing.mockClear();
    startMeeting.mockResolvedValue({ ...JOIN_INFO, created: true, roomConversationId: 'room-1' });
    await startAMeeting();
    expect(sendRing).not.toHaveBeenCalled();
  });

  it('rings nobody when the start joined a meeting already running', async () => {
    sendRing.mockClear();
    startMeeting.mockResolvedValue({ ...JOIN_INFO, created: false });
    await startAMeeting();
    expect(sendRing).not.toHaveBeenCalled();
  });
});

describe('what the app sees of the meeting is reported for its analytics', () => {
  it('reports the join outcome at once, as this attendee in this conversation, and takes its observer off with the session', async () => {
    startMeeting.mockResolvedValue({ ...JOIN_INFO, created: false });
    await startAMeeting();
    expect(eventObservers).toHaveLength(1);
    await act(async () => { eventObservers[0].eventDidReceive('meetingStartSucceeded', { meetingStartDurationMs: 1500, browserName: 'Chrome' }); });
    expect(reportEvents).toHaveBeenCalledWith(CHANNEL, 'a-1', expect.arrayContaining([expect.objectContaining({ name: 'meetingStartSucceeded', attributes: { meetingStartDurationMs: 1500, browserName: 'Chrome' } })]));
    await reportStop({ terminal: true });
    expect(eventObservers).toHaveLength(0);
  });
});

/** Every event the provider reported, across every report, in order. */
const reported = (): Array<{ name: string; attributes?: Record<string, unknown> }> =>
  reportEvents.mock.calls.flatMap((c) => (c as unknown as [string, string, Array<{ name: string; attributes?: Record<string, unknown> }>])[2]);
const metricReport = (m: Record<string, number>) => ({ getObservableMetrics: () => m, getObservableVideoMetrics: () => ({}) });

describe('the connection, the mute and the devices are reported, sampled and without a device name', () => {
  it('files one connectivity reading per interval from the SDK\'s per-second reports, and a turn to poor at once', async () => {
    await startAMeeting();
    const live = observers[observers.length - 1];
    await act(async () => {
      for (let i = 0; i <= 15; i++) {
        live.metricsDidReceive?.(metricReport({ audioPacketLossPercent: 2, currentRoundTripTimeMs: 80, availableOutgoingBitrate: 1_500_000 }) as never);
        vi.advanceTimersByTime(1000);
      }
    });
    // Sampled, not streamed: sixteen reports are one reading, and nothing is sent until a batch or a send-at-once event.
    expect(reportEvents).not.toHaveBeenCalled();
    await act(async () => { live.connectionDidBecomePoor?.(); });
    const names = reported().map((e) => e.name);
    expect(names.filter((n) => n === 'connectivitySample')).toHaveLength(1);
    expect(names).toContain('connectionBecamePoor');
    expect(reported().find((e) => e.name === 'connectivitySample')?.attributes).toEqual(expect.objectContaining({
      connectionHealth: 'good', audioLossSendPct: 2, rttMs: 80, availableSendKbps: 1500, readings: 16,
    }));
  });

  it('reports the person\'s own mute and unmute once each, and nothing for a rejoin re-applying it', async () => {
    await startAMeeting();
    await act(async () => { screen.getByText('mute').click(); });
    await reportStop({ terminal: false });
    await act(async () => { screen.getByText('mute').click(); });
    endMeeting.mockResolvedValue(undefined);
    await act(async () => { screen.getByText('end').click(); });
    expect(reported().map((e) => e.name).filter((n) => n === 'audioMuted' || n === 'audioUnmuted')).toEqual(['audioMuted', 'audioUnmuted']);
    expect(muteSubscribers).toHaveLength(0);
  });

  it('reports a device by its class and a device change by its count, never by label or id', async () => {
    mics = [{ deviceId: 'mic-jane-123', label: "Jane's AirPods (Bluetooth)" }];
    outputs = [{ deviceId: 'default', label: 'Default - MacBook Pro Speakers (Built-in)' }];
    await startAMeeting();
    await act(async () => { deviceChangeObservers[0].audioInputsChanged?.([{}, {}] as never); });
    endMeeting.mockResolvedValue(undefined);
    await act(async () => { screen.getByText('end').click(); });
    const events = reported();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'audioInputChanged', attributes: { deviceClass: 'bluetooth' } }),
      expect.objectContaining({ name: 'audioOutputChanged', attributes: { deviceClass: 'built-in' } }),
      expect.objectContaining({ name: 'devicesChanged', attributes: { deviceKind: 'audioinput', deviceCount: 2 } }),
    ]));
    const sent = JSON.stringify(reportEvents.mock.calls);
    expect(sent).not.toMatch(/Jane|AirPods|MacBook|mic-jane-123/);
    expect(deviceChangeObservers).toHaveLength(0);
  });

  it('reports a refused microphone permission at once, and the meeting still joins', async () => {
    mics = [{ deviceId: 'm1', label: '' }];
    startAudioInput.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await startAMeeting();
    expect(reported()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'devicePermissionDenied', attributes: { deviceKind: 'audioinput' } }),
    ]));
  });
});

describe('a person who muted stays muted', () => {
  it('applies the mute to the new session before it connects, so a rejoin sends no audio the person turned off', async () => {
    await startAMeeting();
    await act(async () => { screen.getByText('mute').click(); });
    expect(screen.getByTestId('muted').textContent).toBe('true');
    // The first session (index 1, constructed after one configuration) was muted by the click.
    expect(muteCalls).toEqual([{ session: 1, muted: true }]);

    avStart.mockClear();
    await reportStop({ terminal: false });

    // The new session (index 2) was muted, and muted BEFORE its start: the mute call precedes the start call.
    const secondSession = muteCalls.filter((c) => c.session === 2);
    expect(secondSession.length).toBeGreaterThan(0);
    expect(secondSession.every((c) => c.muted)).toBe(true);
    expect(muteCalls.some((c) => c.session === 2 && !c.muted)).toBe(false);
    expect(screen.getByTestId('muted').textContent).toBe('true');
    expect(status()).toBe('joined');
  });

  it('leaves an unmuted person unmuted across a rejoin', async () => {
    await startAMeeting();
    await reportStop({ terminal: false });
    expect(muteCalls).toEqual([]);
  });
});

describe('the server decides who joins muted (FR51)', () => {
  it('joins muted where the answer says startMuted, before the first session starts, and the person may unmute', async () => {
    startMeeting.mockReset().mockResolvedValue({ ...JOIN_INFO, startMuted: true });
    await startAMeeting();
    expect(screen.getByTestId('muted').textContent).toBe('true');
    // The first session was muted before it connected: the mute was applied to session 1 and never lifted on its own.
    expect(muteCalls.filter((c) => c.session === 1).every((c) => c.muted)).toBe(true);
    expect(muteCalls.some((c) => c.session === 1)).toBe(true);
    await act(async () => { screen.getByText('mute').click(); });
    expect(screen.getByTestId('muted').textContent).toBe('false');
  });

  it('joins with the microphone on where the answer does not say startMuted', async () => {
    await startAMeeting();
    expect(screen.getByTestId('muted').textContent).toBe('false');
    expect(muteCalls).toEqual([]);
  });
});

describe('a session that never comes up', () => {
  it('counts each rejoin toward the cap, so a connection that never starts ends at CONNECTION_LOST', async () => {
    await startAMeeting();
    // The SDK's start returns without connecting (no audioVideoDidStart), then reports another failure.
    avStart.mockReset();
    for (let i = 0; i < 5; i += 1) await reportStop({ terminal: false });
    expect(status()).toBe('error');
    expect(code()).toBe('CONNECTION_LOST');
  });
});

describe('a join the service refuses is said', () => {
  it.each([
    [4, 'MEETING_FULL'],
    [2, 'JOINED_ELSEWHERE'],
    [22, 'REMOVED_FROM_MEETING'],
    [3, 'CONNECTION_LOST'],
  ])('a terminal stop with status %i reads %s, and is not rejoined', async (statusCode, expected) => {
    await startAMeeting();
    const before = configurations.length;
    await reportStop({ terminal: true, statusCode });
    expect(status()).toBe('error');
    expect(code()).toBe(expected);
    expect(configurations).toHaveLength(before);
  });

  it('a person leaving says nothing', async () => {
    await startAMeeting();
    await reportStop({ terminal: true, statusCode: 1 });
    expect(status()).toBe('idle');
    expect(code()).toBe('');
  });
});

describe('the devices are released with the session', () => {
  it('stops the microphone and destroys the device controller when the meeting ends', async () => {
    await startAMeeting();
    await reportStop({ terminal: true });
    await act(async () => { await Promise.resolve(); });
    expect(stopAudioInput).toHaveBeenCalled();
    expect(deviceDestroy).toHaveBeenCalled();
  });
});

describe('a share the browser stops', () => {
  it('turns the share control off', async () => {
    // The browser's picker answers with a tab.
    const track = { stop: () => undefined, getSettings: () => ({ displaySurface: 'browser' }) };
    const picked = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { ...(navigator.mediaDevices ?? {}), getDisplayMedia: () => Promise.resolve(picked) } });
    await startAMeeting();
    await act(async () => { screen.getByText('share').click(); });
    expect(screen.getByTestId('sharing').textContent).toBe('true');
    await act(async () => { contentShareObservers[contentShareObservers.length - 1].contentShareDidStop?.(); });
    expect(screen.getByTestId('sharing').textContent).toBe('false');
  });
});

describe('a share picker dismissed', () => {
  it('leaves the person in the meeting exactly as they were, with nothing said', async () => {
    // The person looks at the picker for a moment and dismisses it.
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { ...(navigator.mediaDevices ?? {}), getDisplayMedia: () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })), 1_000)) } });
    await startAMeeting();
    const before = status();
    await act(async () => { screen.getByText('share').click(); await vi.advanceTimersByTimeAsync(1_000); });
    expect(status()).toBe(before);
    expect(screen.getByTestId('sharing').textContent).toBe('false');
    expect(screen.getByTestId('code').textContent).toBe('');
  });
});

describe('who left the meeting', () => {
  const presence = async (attendeeId: string, present: boolean, personId: string) => {
    await act(async () => { presenceSubscribers[presenceSubscribers.length - 1](attendeeId, present, personId); });
  };

  it('marks a person who goes as left, and not once they come back, and forgets it when this person leaves', async () => {
    await startAMeeting();
    await presence('a-bo', true, 'bo');
    expect(screen.getByTestId('present').textContent).toBe('bo');
    expect(screen.getByTestId('left').textContent).toBe('');

    await presence('a-bo', false, 'bo');
    expect(screen.getByTestId('present').textContent).toBe('');
    expect(screen.getByTestId('left').textContent).toBe('bo');

    // Back on a new attendee: in the meeting again, no longer left.
    await presence('a-bo-2', true, 'bo');
    expect(screen.getByTestId('left').textContent).toBe('');

    await presence('a-bo-2', false, 'bo');
    expect(screen.getByTestId('left').textContent).toBe('bo');
    await act(async () => { screen.getByText('leave').click(); });
    expect(screen.getByTestId('left').textContent).toBe('');
  });

  it('never counts the recording pipeline, a service attendee, as a person in the meeting or one who left', async () => {
    await startAMeeting();
    await presence('a-capture', true, 'aws:MediaPipeline-0f0f0f0f');
    expect(screen.getByTestId('present').textContent).toBe('');
    await presence('a-capture', false, 'aws:MediaPipeline-0f0f0f0f');
    expect(screen.getByTestId('left').textContent).toBe('');
  });

  it('keeps who left across a reconnect', async () => {
    await startAMeeting();
    await presence('a-bo', true, 'bo');
    await presence('a-bo', false, 'bo');
    await reportStop({ terminal: false });
    expect(screen.getByTestId('left').textContent).toBe('bo');
  });
});

describe('the connection survives the tab and the network going away', () => {
  /** The browser's network state, as `navigator.onLine` reads. */
  const setOnline = (online: boolean) => { vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online); };
  /** A stop on the live session, without letting time pass. */
  const stopNow = async (statusCode = 18, terminal = false) => {
    const live = observers[observers.length - 1];
    await act(async () => {
      live?.audioVideoDidStop?.({ isTerminal: () => terminal, isFailure: () => true, statusCode: () => statusCode } as never);
    });
  };

  it('hidden then visible resumes the meeting audio and the keepalive the browser paused', async () => {
    await startAMeeting();
    const el = document.querySelector('audio') as HTMLAudioElement;
    const play = vi.fn(() => Promise.resolve());
    Object.defineProperty(el, 'srcObject', { value: {}, configurable: true });
    Object.defineProperty(el, 'paused', { get: () => true, configurable: true });
    el.play = play;
    act(() => { hideFor(60_000); });
    expect(play).toHaveBeenCalled();
    expect(keepaliveResume).toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(status()).toBe('joined');
  });

  it('offline then online reconnects with the same attendee, and spends no attempt while offline', async () => {
    await startAMeeting();
    const before = configurations.length;
    setOnline(false);
    await stopNow();
    // Offline for ten minutes: no attempt is made, so the round is not spent and the person is not dropped.
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(status()).toBe('reconnecting');
    expect(code()).toBe('');
    expect(configurations).toHaveLength(before);

    setOnline(true);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(status()).toBe('joined');
    expect(configurations).toHaveLength(before + 1);
    expect(configurations[configurations.length - 1]).toEqual({ meetingId: 'm-1', attendeeId: 'a-1' });
    // NO DUPLICATE ATTENDEE: the join API was called once, for the first join only.
    expect(startMeeting).toHaveBeenCalledTimes(1);
    expect(joinMeeting).not.toHaveBeenCalled();
  });

  it('a healthy session in a background tab is left alone however long its timers run', async () => {
    await startAMeeting();
    const before = configurations.length;
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    expect(status()).toBe('joined');
    expect(configurations).toHaveLength(before);
    expect(keepaliveStop).not.toHaveBeenCalled();
    spy.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(status()).toBe('joined');
    expect(configurations).toHaveLength(before);
  });

  it('a connection lost while the tab was hidden is not a leave: the person is back in when they return', async () => {
    await startAMeeting();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    avStart.mockImplementation(() => { throw new Error('cannot reach the media endpoint'); });
    await reportStop({ terminal: false });
    expect(status()).toBe('error');
    expect(code()).toBe('CONNECTION_LOST');

    avStart.mockReset().mockImplementation(() => { observers[observers.length - 1]?.audioVideoDidStart?.(); });
    spy.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(status()).toBe('joined');
    expect(code()).toBe('');
    expect(configurations[configurations.length - 1]).toEqual({ meetingId: 'm-1', attendeeId: 'a-1' });
    expect(startMeeting).toHaveBeenCalledTimes(1);
    expect(joinMeeting).not.toHaveBeenCalled();
  });

  it('a connection lost while the tab is visible stays lost until the person joins again', async () => {
    await startAMeeting();
    avStart.mockImplementation(() => { throw new Error('cannot reach the media endpoint'); });
    await reportStop({ terminal: false });
    expect(code()).toBe('CONNECTION_LOST');
    const after = configurations.length;
    act(() => { hideFor(60_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(status()).toBe('error');
    expect(configurations).toHaveLength(after);
  });

  it.each([
    [8, 'AudioDisconnected'],
    [13, 'SignalingRequestFailed'],
  ])('a terminal transport stop (%i, %s) goes to the rejoin path, with the same attendee', async (statusCode) => {
    await startAMeeting();
    const before = configurations.length;
    await reportStop({ terminal: true, statusCode });
    expect(status()).toBe('joined');
    expect(configurations).toHaveLength(before + 1);
    expect(configurations[configurations.length - 1]).toEqual({ meetingId: 'm-1', attendeeId: 'a-1' });
    expect(startMeeting).toHaveBeenCalledTimes(1);
  });

  it('pauses before each rejoin attempt, longer after each failure', async () => {
    await startAMeeting();
    const before = configurations.length;
    avStart.mockImplementation(() => { throw new Error('cannot reach the media endpoint'); });
    await stopNow();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(configurations).toHaveLength(before);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(configurations).toHaveLength(before + 1);
    // The second attempt waits the settle pause plus one backoff step.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(configurations).toHaveLength(before + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(configurations).toHaveLength(before + 2);
  });

  it('keeps one keepalive playing through a rejoin', async () => {
    await startAMeeting();
    await reportStop({ terminal: false });
    expect(status()).toBe('joined');
    expect(keepaliveStarts).toBe(1);
    expect(keepaliveStop).not.toHaveBeenCalled();
  });

  it('leaves the meeting when the page unloads', async () => {
    await startAMeeting();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(status()).toBe('idle');
    expect(keepaliveStop).toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
    expect(deviceDestroy).toHaveBeenCalled();
  });
});

describe('the session ends with the provider', () => {
  it('releases the microphone and camera when the provider unmounts (sign-in lost, an error boundary)', async () => {
    const { unmount } = render(<MeetingProvider><Probe /></MeetingProvider>);
    await act(async () => { screen.getByText('start').click(); });
    expect(status()).toBe('joined');
    stopAudioInput.mockClear();
    deviceDestroy.mockClear();
    keepaliveStop.mockClear();
    await act(async () => { unmount(); });
    await act(async () => { await Promise.resolve(); });
    expect(stopAudioInput).toHaveBeenCalled();
    expect(deviceDestroy).toHaveBeenCalled();
    expect(keepaliveStop).toHaveBeenCalled();
  });
});

describe('what a meeting carries ends with it', () => {
  it("a rejoin reads the mode now rather than re-applying the join's, which a host may have changed while it was down", async () => {
    startMeeting.mockResolvedValue({ ...JOIN_INFO, transcribing: false, recording: false });
    statusRead.mockResolvedValue({ running: true, transcribing: true, recording: true });
    await startAMeeting();
    expect(screen.getByTestId('mode').textContent).toBe('none/not-recorded');
    await reportStop({ terminal: false });
    await act(async () => { await Promise.resolve(); });
    expect(statusRead).toHaveBeenCalledWith(CHANNEL);
    expect(screen.getByTestId('mode').textContent).toBe('captions/recording');
  });

  it('a new join after one that ended in an error carries no hold and no mode from it', async () => {
    startMeeting.mockResolvedValueOnce({ ...JOIN_INFO, mutedByHost: true, transcribing: true, recording: true });
    render(<MeetingProvider><Probe /></MeetingProvider>);
    await act(async () => { screen.getByText('start').click(); });
    expect(screen.getByTestId('held').textContent).toBe('true');
    expect(screen.getByTestId('mode').textContent).toBe('captions/recording');
    // The session gives up (CONNECTION_LOST), which does not pass through leave.
    avStart.mockImplementation(() => { throw new Error('cannot reach the media endpoint'); });
    await reportStop({ terminal: false });
    expect(status()).toBe('error');
    avStart.mockReset().mockImplementation(() => { observers[observers.length - 1]?.audioVideoDidStart?.(); });
    startMeeting.mockResolvedValueOnce(JOIN_INFO);
    await act(async () => { screen.getByText('start').click(); });
    expect(status()).toBe('joined');
    expect(screen.getByTestId('held').textContent).toBe('false');
    expect(screen.getByTestId('mode').textContent).toBe('none/not-recorded');
  });
});
