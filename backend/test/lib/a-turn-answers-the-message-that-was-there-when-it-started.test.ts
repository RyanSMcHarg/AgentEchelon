/**
 * A RUNNING TURN CANNOT BE ANSWERING A MESSAGE THAT ARRIVED AFTER IT STARTED (ADR-038 option F).
 *
 * The processor names the message its turn is answering by a LATE content match: it reads the recent
 * window and takes the newest message from that sender whose text is identical to the transcript it
 * was handed. Newest-first is exact for a component reading the instant the message arrives, because
 * nothing later exists yet. It is not exact for this one, and the turn queue is what breaks it.
 *
 * A person sends "ok", the turn starts, and they send "ok" again while it runs. The second copy queues
 * behind the running turn, and by the time the late lookup reads the channel it is the newest match.
 * Three things then go wrong at once: the running turn records the wrong target, the queued message is
 * claimed by a turn that will never fold it, and the message that actually started the turn is claimed
 * by nobody. The exchange minted from that binding is short by the interval between the two sends, and
 * it is admitted to the measured average with nothing about it looking wrong - which is worse than a
 * gap, because a gap is visible.
 *
 * SO THE CANDIDATES ARE BOUNDED BY THE INSTANT THE TURN STARTED, and when only later copies exist the
 * turn declares NOTHING. That is already what the lookup does when it resolves nothing at all, and it
 * is the right direction here: a wrong declaration cannot be corrected once it is in the average.
 *
 * WHICH INSTANT, and the second half of what these tests pin: the ROUTER'S entry mark, the earliest
 * instant this turn's own path recorded. Every other candidate the event carries - the claim, the
 * dispatch, this handler's entry - is later, and a later bound admits messages that queued in the
 * meantime. The processor's own entry is the fallback for a dispatch that carries no router log.
 *
 * NON-VACUITY IS THE POINT OF HALF THESE CASES. A bound that rejected everything would pass the first
 * test here and would be a switch-off of the whole record, so the same "ok"/"ok" listing is asserted
 * BOTH ways: with the original above the queued copy the turn declares the original, and the id it
 * declares is asserted to be the older one rather than merely non-empty.
 */

const mockChimeSend = jest.fn();
const mockRememberHolder = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  // The real command classes, a fake client. Every module in this graph builds its own client from
  // this package, and several of them destructure commands this test never exercises.
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-messaging');
  return {
    ...actual,
    ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockChimeSend(...a); },
  };
});

jest.mock('../../lambda/src/lib/turn-lock', () => {
  const actual = jest.requireActual('../../lambda/src/lib/turn-lock');
  return { ...actual, rememberHolderMessage: (...a: unknown[]) => mockRememberHolder(...a) };
});

// The stack stamps the serving profile on every processor; the module refuses to load without one.
process.env.PROFILE_NAME = process.env.PROFILE_NAME || 'concierge';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const processor = require('../../lambda/src/assistant-async-processor');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findInboundMessage } = require('../../lambda/src/lib/inbound-message');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const SENDER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/user-a';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/assistant-premium';
const TEXT = 'ok';

/** The instants of one burst, in the order they happen. */
const SENT_FIRST = Date.parse('2026-09-16T10:00:00.000Z');
const ROUTER_ENTRY = Date.parse('2026-09-16T10:00:00.400Z');
const SENT_AGAIN = Date.parse('2026-09-16T10:00:06.000Z');
const PROCESSOR_ENTRY = Date.parse('2026-09-16T10:00:07.000Z');

/** Newest first, as Amazon Chime SDK returns with SortOrder DESCENDING. */
const listing = (...items: Array<Record<string, unknown>>) =>
  mockChimeSend.mockResolvedValue({ ChannelMessages: items });

const said = (id: string, at: number, text = TEXT) => ({
  MessageId: id,
  Sender: { Arn: SENDER },
  Content: text,
  CreatedTimestamp: new Date(at),
});

/** A turn dispatched by the router, owing the queue a description of what it is answering. */
const turn = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  channelArn: CHANNEL,
  botArn: BOT,
  senderArn: SENDER,
  correlationId: 'corr-1',
  userMessage: TEXT,
  rememberHolder: true,
  routerSteps: [{ step: 'entry', at: ROUTER_ENTRY }, { step: 'dispatched', at: ROUTER_ENTRY + 300 }],
  ...over,
});

const declaredId = (): string | undefined => mockRememberHolder.mock.calls[0]?.[0]?.messageId;

beforeEach(() => {
  mockChimeSend.mockReset();
  mockRememberHolder.mockReset().mockResolvedValue(undefined);
});

describe('the turn declares nothing rather than claiming a message it cannot be answering', () => {
  it('does not take the copy the person sent while it was running', async () => {
    // THE DEFECT, end to end: the only text match in the window is the queued second "ok".
    listing(said('m-queued', SENT_AGAIN));

    const event = turn();
    await processor.recordWhatThisTurnIsAnswering(event, PROCESSOR_ENTRY);

    expect(mockRememberHolder).not.toHaveBeenCalled();
    // AND THE TURN DOES NOT CARRY IT FORWARD EITHER. A parked or folded run reads this field back, so
    // a wrong id here would outlive the run that resolved it.
    expect(event.userMessageId).toBeUndefined();
  });

  it('warns rather than throwing, because an unresolved id costs a description and not the turn', async () => {
    listing(said('m-queued', SENT_AGAIN));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(processor.recordWhatThisTurnIsAnswering(turn(), PROCESSOR_ENTRY)).resolves.toBeUndefined();

    // The two ways a lookup finds nothing read differently to an operator: a window that is too
    // narrow, against a person repeating themselves while the assistant works.
    expect(warn.mock.calls.flat().join(' ')).toContain('after the turn started');
    warn.mockRestore();
  });

  it('declares nothing when the read fails, exactly as before', async () => {
    mockChimeSend.mockRejectedValue(new Error('AccessDeniedException'));

    await expect(processor.recordWhatThisTurnIsAnswering(turn(), PROCESSOR_ENTRY)).resolves.toBeUndefined();
    expect(mockRememberHolder).not.toHaveBeenCalled();
  });
});

describe('and it still declares the message it IS answering', () => {
  it('takes the original when both copies are in the window, not the queued one', async () => {
    // NON-VACUITY, on the case that produced the defect. Both "ok"s are readable and the newest-first
    // rule would take `m-queued`; the bound makes the answer `m-first`, which is a different id rather
    // than merely a present one.
    listing(said('m-queued', SENT_AGAIN), said('m-first', SENT_FIRST));

    const event = turn();
    await processor.recordWhatThisTurnIsAnswering(event, PROCESSOR_ENTRY);

    expect(declaredId()).toBe('m-first');
    expect(declaredId()).not.toBe('m-queued');
    expect(event.userMessageId).toBe('m-first');
  });

  it('declares an ordinary turn with nothing queued behind it', async () => {
    listing(said('m-first', SENT_FIRST));

    await processor.recordWhatThisTurnIsAnswering(turn(), PROCESSOR_ENTRY);

    expect(declaredId()).toBe('m-first');
  });

  it('pays nothing at all when the router already declared the id', async () => {
    await processor.recordWhatThisTurnIsAnswering(turn({ userMessageId: 'm-declared' }), PROCESSOR_ENTRY);

    expect(declaredId()).toBe('m-declared');
    expect(mockChimeSend).not.toHaveBeenCalled();
  });
});

describe('the instant it bounds by is the earliest one this turn recorded', () => {
  it('is the ROUTER entry, so a message that queued before this handler woke is still refused', async () => {
    // The distinguishing case. `m-queued` was sent after the router entered and before this handler
    // did, so a bound taken from the processor's own entry would admit it and a bound taken from the
    // router's would not. Nothing else separates the two choices.
    expect(SENT_AGAIN).toBeGreaterThan(ROUTER_ENTRY);
    expect(SENT_AGAIN).toBeLessThan(PROCESSOR_ENTRY);
    listing(said('m-queued', SENT_AGAIN));

    await processor.recordWhatThisTurnIsAnswering(turn(), PROCESSOR_ENTRY);

    expect(mockRememberHolder).not.toHaveBeenCalled();
  });

  it('falls back to this handler\'s entry when the dispatch carries no router log', async () => {
    // A dispatch with no router steps has no earlier instant to offer. The fallback is looser and is
    // still a bound: it is before anything that can queue behind a turn whose placeholder is not up.
    listing(said('m-first', SENT_FIRST));

    await processor.recordWhatThisTurnIsAnswering(turn({ routerSteps: undefined }), PROCESSOR_ENTRY);

    expect(declaredId()).toBe('m-first');
  });
});

describe('the matcher is unchanged for the caller that reads at arrival', () => {
  it('still takes the newest match when no bound is given, which is the router\'s queued branch', async () => {
    // The router resolves a queued message's own id the instant it arrives, when the newest match IS
    // that message. Narrowing that read would break the acknowledgement this defect's other half
    // depends on.
    listing(said('m-queued', SENT_AGAIN), said('m-first', SENT_FIRST));

    expect((await findInboundMessage({
      channelArn: CHANNEL, senderArn: SENDER, botArn: BOT, userMessage: TEXT,
    })).messageId).toBe('m-queued');
  });

  it('will not take a match whose instant Amazon Chime SDK did not report, once bounded', async () => {
    // It cannot be shown to have preceded the turn, and an anchor that might be wrong is worse than
    // none. Unbounded it is still taken, because nothing was being asked of its instant.
    listing({ MessageId: 'm-undated', Sender: { Arn: SENDER }, Content: TEXT });

    expect((await findInboundMessage({
      channelArn: CHANNEL, senderArn: SENDER, botArn: BOT, userMessage: TEXT, notAfter: ROUTER_ENTRY,
    })).messageId).toBe('');
    expect((await findInboundMessage({
      channelArn: CHANNEL, senderArn: SENDER, botArn: BOT, userMessage: TEXT,
    })).messageId).toBe('m-undated');
  });
});
