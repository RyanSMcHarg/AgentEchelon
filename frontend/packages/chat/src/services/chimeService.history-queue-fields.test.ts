/**
 * A MESSAGE LOADED FROM HISTORY CARRIES THE SAME TURN STATE AS THE LIVE EVENT THAT DELIVERED IT.
 *
 * The live WebSocket parse lifted `respPhase`, `queueDepth`, `queueStatus` and `queueStatusLabel` out of
 * the metadata; `listMessages` did not. So the queue indicator rendered while a person watched, and
 * vanished when they reloaded - on the deferral notice, which is the oldest message in the window and
 * belongs to whoever has waited longest.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ae/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ae/shared')>()),
  trackEvent: vi.fn(),
}));

import { chimeService } from './chimeService';
import { liftTurnStateFields } from './turnStateFields';

const USER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/assistant';
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';

const NOTICE_METADATA = {
  botResponse: true,
  respPhase: 'notice',
  queueDepth: 2,
  queueStatus: 'reviewing',
  queueStatusLabel: 'Reading what you sent',
};

function withHistory(messages: unknown[]) {
  const send = vi.fn().mockResolvedValue({ ChannelMessages: messages });
  const svc = chimeService as unknown as { messagingClient: unknown; userArn: string | null };
  svc.messagingClient = { send };
  svc.userArn = USER;
  return send;
}

describe('listMessages lifts the turn state the live path lifts', () => {
  it('carries the queue depth, stage, label and phase of a deferral notice', async () => {
    withHistory([{
      MessageId: 'notice-1',
      Content: '2 messages waiting',
      Metadata: JSON.stringify(NOTICE_METADATA),
      Sender: { Arn: BOT, Name: 'Assistant' },
      CreatedTimestamp: new Date('2026-09-15T10:00:00Z'),
    }]);

    const [notice] = await chimeService.listMessages(CHANNEL);

    expect(notice.queueDepth).toBe(2);
    expect(notice.queueStatus).toBe('reviewing');
    expect(notice.queueStatusLabel).toBe('Reading what you sent');
    expect(notice.responsePhase).toBe('notice');
  });

  it('is the same lift the live path spreads, field for field', async () => {
    withHistory([{
      MessageId: 'notice-1',
      Content: '2 messages waiting',
      Metadata: JSON.stringify(NOTICE_METADATA),
      Sender: { Arn: BOT, Name: 'Assistant' },
      CreatedTimestamp: new Date('2026-09-15T10:00:00Z'),
    }]);

    const [notice] = await chimeService.listMessages(CHANNEL);

    expect(notice).toMatchObject(liftTurnStateFields(NOTICE_METADATA));
  });

  it('leaves the fields absent on a message that declares none, rather than inventing a state', async () => {
    withHistory([{
      MessageId: 'plain-1',
      Content: 'hello',
      Metadata: JSON.stringify({ queueDepth: 'two' }),
      Sender: { Arn: USER, Name: 'Ana' },
      CreatedTimestamp: new Date('2026-09-15T10:00:00Z'),
    }]);

    const [plain] = await chimeService.listMessages(CHANNEL);

    expect(plain.queueDepth).toBeUndefined();
    expect(plain.queueStatus).toBeUndefined();
    expect(plain.responsePhase).toBeUndefined();
  });
});
