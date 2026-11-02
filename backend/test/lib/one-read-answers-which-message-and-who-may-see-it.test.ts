/**
 * THE READ THAT FINDS THE MESSAGE ALSO KNOWS WHO MAY SEE IT (DESIGN 2.4).
 *
 * A task opened from a targeted request and written without its visibility reads as conversation-visible,
 * and a conversation-visible task announces to the room that somebody made a request they deliberately
 * sent privately. The row was narrowed later, once the placeholder came back targeted - which closes the
 * row without closing the window: it was wrong for as long as the turn ran.
 *
 * It was narrowed later because nothing on this path knew the addressing any earlier. That was never true.
 * `ChannelMessageSummary` carries `Target`, so the listing that answers "which message is this" is already
 * holding "and who was it sent to" - and threw it away. These tests hold the two facts to ONE read, because
 * a second round trip for a field that was already in hand is what makes somebody argue for skipping it on
 * the turn a person is waiting for.
 *
 * ── UNDEFINED IS NOT FALSE, AND THAT IS THE WHOLE SAFETY PROPERTY ────────────────────────────────────
 *
 * `false` says the message was sent to the room. `undefined` says nobody found out. A caller writing
 * conversation-visible from the second publishes the exact request that must not be published, so a failed
 * lookup has to stay distinguishable from a successful one that found no target.
 */
const mockChimeSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockChimeSend })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListMessages', input })),
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn(),
}), { virtual: true });

import { resolveOriginatingMessage } from '../../lambda/src/lib/live-drift-flow';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/conv-parent';
const SENDER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/user-a';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/assistant';
const TRIGGER = 'can you look at the billing spike privately';

const base = { channelArn: CHANNEL, senderArn: SENDER, botArn: BOT, userMessage: TRIGGER };
const evt = (attrs: Record<string, string> = {}) => ({
  inputTranscript: TRIGGER,
  sessionState: { intent: { name: 'FallbackIntent' } },
  requestAttributes: attrs,
});

/** Newest-first, as Chime returns with SortOrder DESCENDING. */
const listing = (...items: Array<Record<string, unknown>>) =>
  mockChimeSend.mockResolvedValue({ ChannelMessages: items });

const sent = (extra: Record<string, unknown> = {}) => ({
  MessageId: 'msg-trigger',
  Sender: { Arn: SENDER },
  Content: TRIGGER,
  ...extra,
});

beforeEach(() => mockChimeSend.mockReset());

describe('one read, both facts', () => {
  it('reports the message as targeted, from the same listing that identified it', async () => {
    listing(sent({ Target: [{ MemberArn: BOT }] }));

    const resolved = await resolveOriginatingMessage({ ...base, event: evt() });

    expect(resolved).toEqual({ messageId: 'msg-trigger', targeted: true });
    // THE POINT OF THE CHANGE: one round trip, not a list followed by a get. A second call is what
    // makes this expensive enough that somebody argues for not doing it at all.
    expect(mockChimeSend).toHaveBeenCalledTimes(1);
  });

  it('reports a message sent to the room as not targeted', async () => {
    listing(sent());

    expect(await resolveOriginatingMessage({ ...base, event: evt() }))
      .toEqual({ messageId: 'msg-trigger', targeted: false });
  });

  it('reads the second spelling too', async () => {
    // Being wrong in the direction of "not targeted" is the expensive error, so both spellings count -
    // the same rule the triage read follows.
    listing(sent({ Targets: [{ MemberArn: BOT }] }));

    expect((await resolveOriginatingMessage({ ...base, event: evt() })).targeted).toBe(true);
  });

  it('treats an empty target list as untargeted rather than as targeting', async () => {
    listing(sent({ Target: [] }));

    expect((await resolveOriginatingMessage({ ...base, event: evt() })).targeted).toBe(false);
  });

  it('takes the addressing of the MATCHED message, not of the newest one', async () => {
    // A targeted message from this sender sits above the one being handled. Answering "is there a
    // targeted message near here" instead of "was THIS one targeted" would turn every task in a
    // conversation private the moment one private request was made in it.
    listing(
      { MessageId: 'msg-newer', Sender: { Arn: SENDER }, Content: 'and one more thing', Target: [{ MemberArn: BOT }] },
      sent(),
    );

    expect(await resolveOriginatingMessage({ ...base, event: evt() }))
      .toEqual({ messageId: 'msg-trigger', targeted: false });
  });
});

describe('what it refuses to claim', () => {
  it('leaves the addressing UNSET when the read failed', async () => {
    mockChimeSend.mockRejectedValue(new Error('AccessDeniedException'));

    const resolved = await resolveOriginatingMessage({ ...base, event: evt() });

    // Not `false`. A caller writing conversation-visible from a failed read publishes the request.
    expect(resolved.targeted).toBeUndefined();
    expect(resolved.messageId).toBe('');
  });

  it('leaves the addressing UNSET when the message is not in the window', async () => {
    listing({ MessageId: 'msg-other', Sender: { Arn: SENDER }, Content: 'something else entirely' });

    expect((await resolveOriginatingMessage({ ...base, event: evt() })).targeted).toBeUndefined();
  });

  it('leaves the addressing UNSET when the id came from the request attribute', async () => {
    // The attribute carries an id and nothing about addressing. It never arrives on this deployment,
    // but if it did, holding an id is not permission to guess who the message was for.
    const resolved = await resolveOriginatingMessage({
      ...base,
      event: evt({ 'CHIME.message.id': 'from-chime' }),
    });

    expect(resolved).toEqual({ messageId: 'from-chime' });
    expect(resolved.targeted).toBeUndefined();
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('leaves the addressing UNSET when it had no inputs to look anything up with', async () => {
    expect(await resolveOriginatingMessage({ ...base, senderArn: '', event: evt() }))
      .toEqual({ messageId: '' });
    expect(mockChimeSend).not.toHaveBeenCalled();
  });
});
