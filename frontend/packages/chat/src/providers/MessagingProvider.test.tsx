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

const reportEvents = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock('../services/meetingService', async (importOriginal) => ({
  meetingCardFromMetadata: (await importOriginal<typeof import('../services/meetingService')>()).meetingCardFromMetadata,
  isMeetingEnabled: () => true,
  meetingService: { reportEvents: (...a: unknown[]) => reportEvents(...a) },
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
import { endSessionEpoch } from '@ae/shared/services/sessionEpoch.ts';

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
 * sessionVersion: the session contract this app follows. Anything holding data the
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

/**
 * A CONVERSATION THAT IS GONE LEAVES THE CLIENT AT ONCE. A conversation deleted anywhere else (another client,
 * the console, a demo reset) stayed listed and open until a reload, because nothing handled DELETE_CHANNEL, and a
 * removal of the viewer's own membership only refreshed the member list.
 */
describe('MessagingProvider — a deleted conversation, or the viewer removed from it, is reported', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/gone';

  async function mountListening() {
    const removed: string[] = [];
    const Probe = () => {
      const { setGlobalListener } = useMessaging();
      setGlobalListener({ onRemovedFromChannel: (arn) => removed.push(arn) });
      return null;
    };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    return removed;
  }

  it('reports a deleted channel', async () => {
    const removed = await mountListening();
    fireMessage('DELETE_CHANNEL', { ChannelArn: CHANNEL });
    expect(removed).toEqual([CHANNEL]);
  });

  it('reports the viewer removed from a channel', async () => {
    const removed = await mountListening();
    fireMessage('DELETE_CHANNEL_MEMBERSHIP', { ChannelArn: CHANNEL, Member: { Arn: 'arn:aws:chime:::user/u1' } });
    expect(removed).toEqual([CHANNEL]);
  });

  it('does not report another member leaving', async () => {
    const removed = await mountListening();
    fireMessage('DELETE_CHANNEL_MEMBERSHIP', { ChannelArn: CHANNEL, Member: { Arn: 'arn:aws:chime:::user/someone-else' } });
    expect(removed).toEqual([]);
  });
});

/**
 * A MEETING'S RING (`meetingRing.ts`): a control message rings the viewer for what is left of it, never reaches the
 * conversation view or its unread state, and a ring the viewer sent rings nobody here.
 */
describe('MessagingProvider: a meeting ring', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  async function mountRinging() {
    const seen: { ring: unknown; messages: number } = { ring: null, messages: 0 };
    const Probe = () => {
      const { incomingRing, setGlobalListener, setChannelListener } = useMessaging();
      seen.ring = incomingRing;
      setGlobalListener({ onMessageInAnyChannel: () => { seen.messages += 1; } });
      setChannelListener({ onMessage: () => { seen.messages += 1; } } as never);
      return null;
    };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    return seen;
  }

  it('lets go of the ring and the meeting news when the session ends, so the next person signed in hears neither', async () => {
    const BOT_ARN = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops';
    let state: { ring: unknown; news: unknown; heard: unknown } = { ring: null, news: null, heard: null };
    const Probe = () => { const m = useMessaging(); state = { ring: m.incomingRing, news: m.meetingNews, heard: m.ringHeard }; return null; };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: BOT_ARN } });
    const card = JSON.stringify({ meetingCard: { event: 'meeting-started', meetingId: '11111111-2222-3333-4444-555555555555', conversationId: 'meet-1' } });
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: CHANNEL, Type: 'STANDARD', Content: 'started', Metadata: card, Sender: { Arn: BOT_ARN } });
    expect(state.ring).toMatchObject({ channelArn: CHANNEL });
    expect(state.news).not.toBeNull();
    await act(async () => { endSessionEpoch('signed-out'); });
    expect(state).toEqual({ ring: null, news: null, heard: null });
  });

  it('keeps every piece of meeting news, so two that land in one render are both read', async () => {
    const BOT_ARN = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops';
    let after: ((seq: number) => Array<{ card?: { conversationId?: string } }>) | undefined;
    const Probe = () => { after = useMessaging().meetingNewsAfter; return null; };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    const card = (id: string) => JSON.stringify({ meetingCard: { event: 'meeting-started', meetingId: '11111111-2222-3333-4444-555555555555', conversationId: id } });
    act(() => {
      fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: `${CHANNEL}-a`, Type: 'STANDARD', Content: 'started', Metadata: card('meet-a'), Sender: { Arn: BOT_ARN } });
      fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: `${CHANNEL}-b`, Type: 'STANDARD', Content: 'started', Metadata: card('meet-b'), Sender: { Arn: BOT_ARN } });
    });
    expect(after!(0).map((n) => n.card?.conversationId)).toEqual(['meet-a', 'meet-b']);
  });

  it('rings for the ring\'s length, then stops on its own, and is never a message', async () => {
    const seen = await mountRinging();
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(),
      Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toMatchObject({ channelArn: CHANNEL });
    expect(seen.messages).toBe(0);
    act(() => { vi.advanceTimersByTime(10_500); });
    expect(seen.ring).toBeNull();
  });

  it("rings for no member: a person's ring rings nobody, and a person's ring-off stops nothing", async () => {
    const seen = await mountRinging();
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(),
      Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/u2' },
    });
    expect(seen.ring).toBeNull();
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(),
      Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toMatchObject({ channelArn: CHANNEL });
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:off', Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/u2' },
    });
    expect(seen.ring).toMatchObject({ channelArn: CHANNEL });
  });

  it('does not ring a person already in the meeting in a window of this browser, their own start among them', async () => {
    const query = vi.fn(async () => ({ held: [{ name: 'ae-in-meeting-c' }], pending: [] }));
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { query, request: vi.fn(() => new Promise(() => undefined)) } });
    try {
      const seen = await mountRinging();
      fireMessage('CREATE_CHANNEL_MESSAGE', {
        ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(),
        Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
      });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(query).toHaveBeenCalled();
      expect(seen.ring).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still rings after this device's clock steps forward by more than a ring", async () => {
    const seen = await mountRinging();
    const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops';
    // A prompt delivery first, which the next ring's lateness is measured against.
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'other', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: BOT } });
    const serverNow = Date.now();
    // The device clock jumps a minute ahead; the server's does not.
    vi.setSystemTime(Date.now() + 60_000);
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date(serverNow).toISOString(), Sender: { Arn: BOT },
    });
    expect(seen.ring).toMatchObject({ channelArn: CHANNEL });
  });

  it("tells a meeting window, which shows no ring, that its conversation's meeting rang, so it reads the meeting again", async () => {
    sessionStorage.setItem('ae.meeting.window', 'c');
    let heard: unknown = null;
    const Probe = () => { heard = useMessaging().ringHeard; return null; };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(heard).toMatchObject({ channelArn: CHANNEL });
  });

  it("hears meeting news in any conversation, carrying the card: a meeting card from an assistant, and this person removed from a conversation, not another member or a person's card", async () => {
    const BOT_ARN = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops';
    const news: unknown[] = [];
    const Probe = () => { const n = useMessaging().meetingNews; if (n && news[news.length - 1] !== n) news.push(n); return null; };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    const card = JSON.stringify({ meetingCard: { event: 'meeting-started', meetingId: '11111111-2222-3333-4444-555555555555', conversationId: 'meet-1' } });
    // A member's message carrying the same metadata is not news: only an assistant posts a meeting card.
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: CHANNEL, Type: 'STANDARD', Content: 'hi', Metadata: card, Sender: { Arn: 'arn:aws:chime:::user/u2' } });
    // Another member joining is not this person's news.
    fireMessage('CREATE_CHANNEL_MEMBERSHIP', { ChannelArn: CHANNEL, Member: { Arn: 'arn:aws:chime:::user/u2' } });
    expect(news).toHaveLength(0);
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: `${CHANNEL}-room`, Type: 'STANDARD', Content: 'started', Metadata: card, Sender: { Arn: BOT_ARN } });
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ channelArn: `${CHANNEL}-room`, card: { event: 'meeting-started', meetingId: '11111111-2222-3333-4444-555555555555', conversationId: 'meet-1' } });
    // This person added to a conversation is not news: the meeting's own conversation holds the parent conversation's people from its opening.
    fireMessage('CREATE_CHANNEL_MEMBERSHIP', { ChannelArn: `${CHANNEL}-meet`, Member: { Arn: 'arn:aws:chime:::user/u1' } });
    expect(news).toHaveLength(1);
    fireMessage('DELETE_CHANNEL_MEMBERSHIP', { ChannelArn: `${CHANNEL}-meet`, Member: { Arn: 'arn:aws:chime:::user/u1' } });
    expect(news).toHaveLength(2);
    expect(news[1]).toMatchObject({ channelArn: `${CHANNEL}-meet`, removed: true });
  });

  it('stops the ring on a ring-off addressed to this person, who took the meeting elsewhere, and a ring that arrives after it sounds nothing', async () => {
    const seen = await mountRinging();
    const ring = () => fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    ring();
    expect(seen.ring).toMatchObject({ channelArn: CHANNEL });
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:off', Target: [{ MemberArn: 'arn:aws:chime:::user/u1' }], Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toBeNull();
    // Their own start, taken before its ring went out: the ring comes after the ring-off, and rings nobody.
    ring();
    expect(seen.ring).toBeNull();
  });

  it('rings in one tab of this browser per meeting: a ring another tab claimed shows nothing here', async () => {
    const seen = await mountRinging();
    localStorage.setItem('meeting-invite-claim-c', `another-tab@${Date.now()}`);
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toBeNull();
  });

  it('rings where another tab\'s claim on the meeting is older than its window', async () => {
    const seen = await mountRinging();
    localStorage.setItem('meeting-invite-claim-c', `another-tab@${Date.now() - 31_000}`);
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toMatchObject({ channelArn: CHANNEL });
  });

  it('does not ring for a ring already over when it arrives', async () => {
    const seen = await mountRinging();
    // The connection delivers promptly, which is what a late ring is measured against.
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'other', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:::user/u2' } });
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date(Date.now() - 30_000).toISOString(),
      Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toBeNull();
  });

  it('reports a ring left to run out once, as the viewer with no attendee, and one stopped by the meeting ending not at all', async () => {
    reportEvents.mockClear();
    const seen = await mountRinging();
    const ring = () => fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    ring();
    act(() => { vi.advanceTimersByTime(10_500); });
    expect(seen.ring).toBeNull();
    expect(reportEvents).toHaveBeenCalledTimes(1);
    expect(reportEvents).toHaveBeenCalledWith(CHANNEL, null, [expect.objectContaining({ name: 'ringTimedOut' })]);
    ring();
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:off', Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' } });
    expect(seen.ring).toBeNull();
    act(() => { vi.advanceTimersByTime(10_500); });
    expect(reportEvents).toHaveBeenCalledTimes(1);
  });

  it('rings its whole length on a device whose clock runs ahead of the server by more than the ring', async () => {
    const seen = await mountRinging();
    // Every message reads 12 seconds old on arrival: this clock is 12 seconds fast, and the ring is on time.
    const serverNow = () => new Date(Date.now() - 12_000).toISOString();
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'other', CreatedTimestamp: serverNow(), Sender: { Arn: 'arn:aws:chime:::user/u2' } });
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: serverNow(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toMatchObject({ channelArn: CHANNEL });
    act(() => { vi.advanceTimersByTime(9_000); });
    expect(seen.ring).toMatchObject({ channelArn: CHANNEL });
  });

  it('reports nothing for a ring another tab of this person already settled, and does not show it', async () => {
    reportEvents.mockClear();
    const seen = await mountRinging();
    localStorage.setItem('ae.meeting.ringSettled', JSON.stringify({ [CHANNEL]: Date.now() + 10_000 }));
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toBeNull();
    act(() => { vi.advanceTimersByTime(10_500); });
    expect(reportEvents).not.toHaveBeenCalled();
  });

  it('settles a timed-out ring once, so another tab whose ring runs out reports nothing', async () => {
    reportEvents.mockClear();
    // Two tabs of one person, sharing the browser's storage, both hear the ring.
    const first = await mountRinging();
    const second = await mountRinging();
    const payload = JSON.stringify({
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    act(() => {
      for (const o of observers) o.messagingSessionDidReceiveMessage?.({ headers: { 'x-amz-chime-event-type': 'CREATE_CHANNEL_MESSAGE' }, payload });
    });
    expect(first.ring).toMatchObject({ channelArn: CHANNEL });
    expect(second.ring).toMatchObject({ channelArn: CHANNEL });
    act(() => { vi.advanceTimersByTime(10_500); });
    expect(reportEvents).toHaveBeenCalledTimes(1);
  });

  it('takes no ring in a meeting window', async () => {
    sessionStorage.setItem('ae.meeting.window', 'c');
    const seen = await mountRinging();
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: CHANNEL, Type: 'CONTROL', Content: 'ae:ring:10', CreatedTimestamp: new Date().toISOString(), Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops' },
    });
    expect(seen.ring).toBeNull();
  });
});

/**
 * A CHANNEL UPDATE CARRIES ITS METADATA to the conversation provider, so the archive's `archived` display mirror reaches
 * a conversation open in front of the person (SPEC-ASSISTANT-MEETINGS FR71).
 */
describe('MessagingProvider — a channel update hands over its name and metadata', () => {
  it('passes the channel Metadata beside its Name', async () => {
    const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/meet';
    const updates: Array<[string, string, string | undefined]> = [];
    const Probe = () => {
      const { setChannelListener } = useMessaging();
      setChannelListener({ onChannelUpdate: (arn, name, metadata) => updates.push([arn, name, metadata]) });
      return null;
    };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    const metadata = JSON.stringify({ meetingOf: 'room', archived: true });
    fireMessage('UPDATE_CHANNEL', { ChannelArn: CHANNEL, Name: 'Meeting Room', Metadata: metadata });
    expect(updates).toEqual([[CHANNEL, 'Meeting Room', metadata]]);
  });
});

/**
 * WHO A MESSAGE IS VISIBLE TO IS THE `Target` AMAZON CHIME SDK SET. Metadata is member-writable, so a message that only
 * says in its Metadata that it is targeted is an ordinary message the whole room reads.
 */
describe('MessagingProvider - a message is targeted only by the Target the service set', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
  const ME = 'arn:aws:chime:::user/u1';
  async function received(payload: Record<string, unknown>) {
    const seen: Array<{ targetedToUser?: boolean }> = [];
    const Probe = () => {
      const { setChannelListener } = useMessaging();
      setChannelListener({ onMessageCreate: (_arn: string, m: { targetedToUser?: boolean }) => { seen.push(m); } } as never);
      return null;
    };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    fireMessage('CREATE_CHANNEL_MESSAGE', { ChannelArn: CHANNEL, MessageId: 'm1', Content: 'hello', Sender: { Arn: 'arn:aws:chime:::user/u2', Name: 'Sam' }, ...payload });
    return seen;
  }

  it('DENY: Metadata naming this person does not make a message targeted', async () => {
    const seen = await received({ Metadata: JSON.stringify({ targetedSender: ME }) });
    expect(seen).toHaveLength(1);
    expect(seen[0].targetedToUser).toBeFalsy();
  });

  it('a Target naming this person does', async () => {
    const seen = await received({ Target: [{ MemberArn: ME }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].targetedToUser).toBe(true);
  });

  it('an assistant reply arriving with no Target is read by the recipient the platform stamped on it', async () => {
    const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops';
    const seen = await received({ Sender: { Arn: BOT, Name: 'Ops' }, Metadata: JSON.stringify({ targetedSender: ME }) });
    expect(seen[0].targetedToUser).toBe(true);
  });

  it('DENY: an assistant message the service delivered with a Target naming somebody else is not for this person', async () => {
    const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops';
    const seen = await received({ Sender: { Arn: BOT, Name: 'Ops' }, Target: [{ MemberArn: 'arn:aws:chime:::user/u3' }], Metadata: JSON.stringify({ targetedSender: ME }) });
    expect(seen[0].targetedToUser).toBeFalsy();
  });
});

describe('MessagingProvider - Metadata that is not an object is read as none', () => {
  it('a message whose Metadata is the text null is delivered like any other', async () => {
    const seen: unknown[] = [];
    const Probe = () => {
      const { setChannelListener } = useMessaging();
      setChannelListener({ onMessageCreate: (_arn: string, m: unknown) => { seen.push(m); } } as never);
      return null;
    };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c', MessageId: 'm-null', Content: 'hello', Metadata: 'null',
      Sender: { Arn: 'arn:aws:chime:::user/u2', Name: 'Sam' },
    });
    expect(seen).toHaveLength(1);
  });
});

describe('MessagingProvider - a message that disagrees with its Target is logged under the monitored marker', () => {
  it('logs an assistant reply stamped for a person its Target does not name, and marks the message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: Array<{ targetMismatch?: string }> = [];
    const Probe = () => {
      const { setChannelListener } = useMessaging();
      setChannelListener({ onMessageCreate: (_arn: string, m: { targetMismatch?: string }) => { seen.push(m); } } as never);
      return null;
    };
    render(<MessagingProvider><Probe /></MessagingProvider>);
    await act(async () => { await Promise.resolve(); });
    fireMessage('CREATE_CHANNEL_MESSAGE', {
      ChannelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c', MessageId: 'm-mismatch', Content: 'here you go',
      Metadata: JSON.stringify({ botResponse: true, targetedSender: 'arn:aws:chime:::user/u1' }),
      Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b1', Name: 'Advisor' },
    });
    expect(seen[0]?.targetMismatch).toBe('assistant');
    expect(logged.mock.calls.some((c) => String(c[0]).startsWith('[target-mismatch]'))).toBe(true);
    logged.mockRestore();
  });
});
