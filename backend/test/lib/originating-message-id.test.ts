/**
 * Resolving the message that triggered drift.
 *
 * THE DISTINCTION THIS EXISTS FOR. `CHIME.message.id` arrives empty on this deployment, so the id is read
 * back from the parent channel. The obvious way to do that is "take the sender's most recent message", which
 * is a NEAR-MISS for "take the message being handled": the two agree almost always, and disagree exactly when
 * a second message lands while the turn is in flight.
 *
 * The consequence of getting it wrong is not a missing link but a WRONG one, pointing at a message the person
 * did not ask about, while still looking live. So the match is on the exact transcript of the message being
 * handled, and these tests fail for a recency-based implementation.
 */
const mockChimeSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockChimeSend })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((input) => ({ __type: 'ListMessages', input })),
}), { virtual: true });

// The module builds an SSM client and imports a wide dependency graph at load; stub what it only needs to
// construct so this file can exercise the one exported resolver.
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn(),
}), { virtual: true });

import { resolveOriginatingMessageId } from '../../lambda/src/lib/live-drift-flow';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/conv-parent';
const SENDER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/user-a';
const OTHER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/user-b';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/assistant';
const TRIGGER = "let's talk about CI costs instead";

const base = { channelArn: CHANNEL, senderArn: SENDER, botArn: BOT, userMessage: TRIGGER };
const evt = (attrs: Record<string, string> = {}) => ({
  inputTranscript: TRIGGER,
  sessionState: { intent: { name: 'FallbackIntent' } },
  requestAttributes: attrs,
});

/** Newest-first, as Chime returns with SortOrder DESCENDING. */
const messages = (...items: Array<{ id: string; sender: string; content: string }>) =>
  mockChimeSend.mockResolvedValue({
    ChannelMessages: items.map((i) => ({ MessageId: i.id, Sender: { Arn: i.sender }, Content: i.content })),
  });

beforeEach(() => mockChimeSend.mockReset());

describe('resolveOriginatingMessageId', () => {
  it('prefers the request attribute when Chime provides one, with no lookup', async () => {
    const id = await resolveOriginatingMessageId({ ...base, event: evt({ 'CHIME.message.id': 'from-chime' }) });
    expect(id).toBe('from-chime');
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('matches the triggering message BY CONTENT, not by recency', async () => {
    // The failing case for a recency implementation: the sender's newest message is something else, sent
    // while this turn was in flight. Recency returns 'newer'; the correct answer is 'trigger'.
    messages(
      { id: 'newer', sender: SENDER, content: 'wait, ignore that' },
      { id: 'trigger', sender: SENDER, content: TRIGGER },
    );
    await expect(resolveOriginatingMessageId({ ...base, event: evt() })).resolves.toBe('trigger');
  });

  it('resolves the CURRENT send when the same text was sent before', async () => {
    // Newest-first means a repeated phrase resolves to this turn's message, not the older identical one.
    messages(
      { id: 'this-turn', sender: SENDER, content: TRIGGER },
      { id: 'last-week', sender: SENDER, content: TRIGGER },
    );
    await expect(resolveOriginatingMessageId({ ...base, event: evt() })).resolves.toBe('this-turn');
  });

  it('ignores an identical message from a DIFFERENT sender', async () => {
    messages(
      { id: 'someone-else', sender: OTHER, content: TRIGGER },
      { id: 'mine', sender: SENDER, content: TRIGGER },
    );
    await expect(resolveOriginatingMessageId({ ...base, event: evt() })).resolves.toBe('mine');
  });

  it('matches when Chime stored the content URI-encoded', async () => {
    messages({ id: 'encoded', sender: SENDER, content: encodeURIComponent(TRIGGER) });
    await expect(resolveOriginatingMessageId({ ...base, event: evt() })).resolves.toBe('encoded');
  });

  it('returns NOTHING rather than a wrong anchor when the message is not in the window', async () => {
    // The load-bearing negative. A recency implementation returns 'unrelated' here and produces a link that
    // looks live and points at the wrong message.
    messages({ id: 'unrelated', sender: SENDER, content: 'something else entirely' });
    await expect(resolveOriginatingMessageId({ ...base, event: evt() })).resolves.toBe('');
  });

  it('returns nothing on a denied or failed read, without throwing', async () => {
    // The grant was missing when this shipped: the call was denied, the catch swallowed it, and the welcome
    // silently linked to the conversation instead. Degrading is correct; failing the turn is not.
    mockChimeSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(resolveOriginatingMessageId({ ...base, event: evt() })).resolves.toBe('');
  });

  it('does not attempt a lookup without the inputs it needs', async () => {
    for (const missing of [{ senderArn: '' }, { botArn: '' }, { channelArn: '' }, { userMessage: '  ' }]) {
      mockChimeSend.mockReset();
      await expect(resolveOriginatingMessageId({ ...base, ...missing, event: evt() })).resolves.toBe('');
      expect(mockChimeSend).not.toHaveBeenCalled();
    }
  });
});
