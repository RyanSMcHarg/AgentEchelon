/**
 * A SEND CARRIES ITS CLIENT MESSAGE ID, so a retry is one message: as the send's idempotency token and in its Metadata,
 * where `sentByClientId` finds it among the conversation's recent messages, from this person only.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ae/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ae/shared')>()),
  trackEvent: vi.fn(),
}));

import { chimeService } from './chimeService';

const USER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1';
const OTHER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u2';
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';

function withClient(answer: unknown) {
  const send = vi.fn().mockResolvedValue(answer);
  const svc = chimeService as unknown as { messagingClient: unknown; userArn: string | null };
  svc.messagingClient = { send };
  svc.userArn = USER;
  return send;
}

describe('the client message id', () => {
  it('is the idempotency token and rides the Metadata beside what the caller sent', async () => {
    const send = withClient({ MessageId: 'm1' });
    await chimeService.sendMessage(CHANNEL, 'hi', { attachment: { fileKey: 'k' } }, { clientMessageId: 'cid-1' });
    const input = send.mock.calls[0][0].input;
    expect(input.ClientRequestToken).toBe('cid-1');
    expect(JSON.parse(input.Metadata)).toEqual({ attachment: { fileKey: 'k' }, clientMessageId: 'cid-1' });
  });

  it('is absent when the caller gives none, leaving the send as it was', async () => {
    const send = withClient({ MessageId: 'm1' });
    await chimeService.sendMessage(CHANNEL, 'hi');
    const input = send.mock.calls[0][0].input;
    expect(input.ClientRequestToken).toBeUndefined();
    expect(input.Metadata).toBeUndefined();
  });

  it('finds a message this person sent with the id, and not one another member sent with it', async () => {
    withClient({
      ChannelMessages: [
        { MessageId: 'x', Sender: { Arn: OTHER }, Metadata: JSON.stringify({ clientMessageId: 'cid-1' }) },
        { MessageId: 'y', Sender: { Arn: USER }, Metadata: 'not json' },
      ],
    });
    expect(await chimeService.sentByClientId(CHANNEL, 'cid-1')).toBe(false);
    withClient({ ChannelMessages: [{ MessageId: 'z', Sender: { Arn: USER }, Metadata: JSON.stringify({ clientMessageId: 'cid-1' }) }] });
    expect(await chimeService.sentByClientId(CHANNEL, 'cid-1')).toBe(true);
  });
});
