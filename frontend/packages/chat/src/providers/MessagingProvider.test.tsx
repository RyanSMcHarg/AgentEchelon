/**
 * MessagingProvider — an unattended WebSocket drop reconnects itself.
 *
 * THE DEFECT THIS EXISTS FOR. `messagingSessionDidStop` cleared the session, set `isConnected(false)`
 * and emitted an analytics event, and that was all. The only thing that ever re-established a session
 * was the `visibilitychange` handler, so a socket dropping while the page was VISIBLE - the ordinary
 * case for a user sitting in a conversation - was never reconnected. The header rendered
 * "Reconnecting..." indefinitely while nothing reconnected, and messages the backend had already
 * delivered never arrived. Recovery required switching tabs away and back.
 *
 * It presented as flakiness rather than as a bug: a drift e2e failed once with "Reconnecting..." in
 * the header and no reply rendered, while the backend had answered correctly. A DOM-only test cannot
 * tell those apart, which is why the drift spec now asserts the channel wire too.
 *
 * These tests drive the session observer directly, because the observer IS the state machine. Each
 * case is one transition, and the two guards matter as much as the reconnect: a deliberate stop
 * (forceReconnect, unmount) must NOT schedule one, or the provider races itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const sessionStart = vi.fn();
const sessionStop = vi.fn();
/** Observers registered by the provider, so a test can fire lifecycle events at it. */
let observers: Array<Record<string, (...a: unknown[]) => void>> = [];

vi.mock('amazon-chime-sdk-js', () => ({
  // A plain function, NOT an arrow: the provider calls this with `new`, and an arrow function is not
  // a constructor. Returning an object from a constructor call yields that object.
  DefaultMessagingSession: vi.fn(function DefaultMessagingSessionMock() {
    return {
      addObserver: (o: Record<string, (...a: unknown[]) => void>) => observers.push(o),
      start: sessionStart,
      stop: sessionStop,
    };
  }),
  MessagingSessionConfiguration: vi.fn(),
  ConsoleLogger: vi.fn(),
  LogLevel: { WARN: 2 },
}));

const refreshCredentials = vi.fn().mockResolvedValue(undefined);
vi.mock('@ae/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ae/shared')>()),
  useAuth: () => ({ refreshCredentials }),
  trackEvent: vi.fn(),
}));

vi.mock('./AwsClientProvider', () => ({
  useAwsClient: () => ({ isInitialized: true, userArn: 'arn:aws:chime:::user/u1' }),
}));

vi.mock('../services/chimeService', () => ({
  chimeService: {
    getMessagingClient: () => ({}),
    getUserArn: () => 'arn:aws:chime:::user/u1',
  },
}));

// EVERY export the provider imports. A partial mock leaves the missing name `undefined`, and the
// call site is a plain call in the WebSocket switch - so an omission here does not fail as "mock
// missing", it throws a TypeError inside message processing and takes the delivery path with it.
vi.mock('../services/messageLatencyTracker', () => ({
  markResponseReceived: vi.fn(),
  markPlaceholderShown: vi.fn(),
}));

import { MessagingProvider, useMessaging } from './MessagingProvider';

// The mocked tracker, so the assertions below can read what the provider did with a notice.
import { markResponseReceived, markPlaceholderShown } from '../services/messageLatencyTracker';

/**
 * Fire a lifecycle event on the CURRENT session's observer only.
 *
 * Each reconnect builds a new session with its own observer, and the provider keeps the old one
 * registered here. Firing all of them would report one drop several times over, inflating the backoff
 * count in a way the live SDK never does - the test would then be measuring its own harness.
 */
function fire(event: 'messagingSessionDidStart' | 'messagingSessionDidStop') {
  const current = observers[observers.length - 1];
  act(() => {
    current?.[event]?.();
  });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

async function mount() {
  const r = render(<MessagingProvider><div /></MessagingProvider>);
  // Let the connect() effect run and register its observer.
  await act(async () => { await Promise.resolve(); });
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  sessionStart.mockClear();
  sessionStop.mockClear();
  refreshCredentials.mockClear();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MessagingProvider — an unattended drop reconnects itself', () => {
  it('reconnects after a drop that nobody asked for', async () => {
    await mount();
    fire('messagingSessionDidStart');
    const startsBefore = sessionStart.mock.calls.length;

    fire('messagingSessionDidStop');
    // Nothing yet: the retry is deliberately delayed, not immediate.
    expect(sessionStart.mock.calls.length).toBe(startsBefore);

    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(
      sessionStart.mock.calls.length,
      'a socket that dropped on its own was never re-established',
    ).toBeGreaterThan(startsBefore);
  });

  it('backs off across consecutive drops instead of retrying in lockstep', async () => {
    await mount();
    fire('messagingSessionDidStart');

    // First drop retries at ~1s.
    fire('messagingSessionDidStop');
    let starts = sessionStart.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(sessionStart.mock.calls.length).toBeGreaterThan(starts);

    // Second consecutive drop (no successful start in between) must wait LONGER than the first.
    // Without a growing delay a server-side outage is amplified by every open client.
    fire('messagingSessionDidStop');
    starts = sessionStart.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(sessionStart.mock.calls.length, 'the second retry did not back off').toBe(starts);

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(sessionStart.mock.calls.length).toBeGreaterThan(starts);
  });

  it('resets the backoff once a session starts, so a later drop retries promptly again', async () => {
    await mount();
    fire('messagingSessionDidStart');
    fire('messagingSessionDidStop');
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

    // A successful start clears the drop count.
    fire('messagingSessionDidStart');
    const starts = sessionStart.mock.calls.length;

    fire('messagingSessionDidStop');
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(
      sessionStart.mock.calls.length,
      'backoff was not reset by a healthy session, so a single earlier blip slows every later recovery',
    ).toBeGreaterThan(starts);
  });

  // A hidden tab is left alone ON PURPOSE: browsers suspend background sockets routinely, so retrying
  // there burns credentials against a connection the browser intends to keep down. The visibility
  // handler re-establishes it on return.
  it('does not retry while the tab is hidden', async () => {
    await mount();
    fire('messagingSessionDidStart');
    setVisibility('hidden');
    const starts = sessionStart.mock.calls.length;

    fire('messagingSessionDidStop');
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(sessionStart.mock.calls.length).toBe(starts);
  });

  // THE GUARD. forceReconnect stops the session itself and then reconnects; if the stop observer also
  // scheduled one, the provider would race two reconnects and could leave the later, dead session in
  // sessionRef. Unmount has the same shape with worse consequences: a reconnect against a torn-down
  // provider.
  it('does not schedule a reconnect for a stop the provider itself performed', async () => {
    const { unmount } = await mount();
    fire('messagingSessionDidStart');
    const starts = sessionStart.mock.calls.length;

    unmount();
    // The provider's cleanup stops the session; the SDK then reports the stop back.
    expect(sessionStop).toHaveBeenCalled();
    fire('messagingSessionDidStop');
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });

    expect(
      sessionStart.mock.calls.length,
      'an unmounted provider reconnected, which leaks a session nothing will ever stop',
    ).toBe(starts);
  });
});

/**
 * INVARIANT D (ADR-033): latency counts only turns a person actually waited for.
 *
 * A queue notice is written by the machine and rewritten by it as the drain advances and settles. It
 * is not an answer, and every write of it that reaches the latency path reports a system faster than
 * the one people use.
 *
 * Both of these were REGRESSIONS IN THE FIX for that: the guard went on the CREATE branch only, and
 * on CREATE it pushed the notice into the placeholder arm instead of out of the tracking entirely.
 */
function fireMessage(eventType: string, payload: Record<string, unknown>) {
  const current = observers[observers.length - 1];
  act(() => {
    current?.messagingSessionDidReceiveMessage?.({
      headers: { 'x-amz-chime-event-type': eventType },
      payload: JSON.stringify(payload),
    });
  });
}

const NOTICE_METADATA = JSON.stringify({ botResponse: true, respPhase: 'notice', queueDepth: 2 });

describe('MessagingProvider — a queue notice is not a turn somebody waited for', () => {
  it('does not record a round trip when the notice is rewritten', async () => {
    vi.mocked(markResponseReceived).mockClear();
    vi.mocked(markPlaceholderShown).mockClear();
    await mount();

    // advanceQueueNotice / settleQueueNotice rewrite the SAME message through UpdateChannelMessage.
    // Counting it recorded a ~1s round trip and deleted the pending send, so the real answer two
    // minutes later recorded nothing at all.
    fireMessage('UPDATE_CHANNEL_MESSAGE', {
      ChannelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c',
      MessageId: 'notice-1',
      Content: 'Two messages waiting',
      Metadata: NOTICE_METADATA,
      Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/bot', Name: 'bot' },
    });

    expect(markResponseReceived).not.toHaveBeenCalled();
  });

  it('does not latch the channel TTFF on a notice that carries no correlation id', async () => {
    vi.mocked(markResponseReceived).mockClear();
    vi.mocked(markPlaceholderShown).mockClear();
    await mount();

    // Excluded from trackBotResponse alone, the notice fell into the placeholder arm and called
    // markPlaceholderShown with correlationId undefined, latching ttffReported for the channel. The
    // real placeholder - the one carrying <!--corr:--> - then returned early, so the per-turn join
    // contained no queued turns at all.
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c',
      MessageId: 'notice-1',
      Content: 'Two messages waiting',
      Metadata: NOTICE_METADATA,
      Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/bot', Name: 'bot' },
    });

    expect(markPlaceholderShown).not.toHaveBeenCalled();
    expect(markResponseReceived).not.toHaveBeenCalled();
  });
});

/**
 * sessionVersion: the communication-hub contract this app now follows. Anything holding data the
 * session would have pushed re-reads when it changes, so it must go up on EVERY
 * start - the first connect and each reconnect - and on nothing else.
 */
describe('MessagingProvider - sessionVersion counts session starts', () => {
  const seen: number[] = [];
  const Probe = () => {
    const { sessionVersion } = useMessaging();
    seen.push(sessionVersion);
    return null;
  };

  it('starts at 0 and goes up by one on each session start, not on a stop', async () => {
    seen.length = 0;
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(seen[seen.length - 1]).toBe(0);
    fire('messagingSessionDidStart');
    expect(seen[seen.length - 1]).toBe(1);
    fire('messagingSessionDidStop');
    expect(seen[seen.length - 1]).toBe(1);
    fire('messagingSessionDidStart');
    expect(seen[seen.length - 1]).toBe(2);
  });
});
