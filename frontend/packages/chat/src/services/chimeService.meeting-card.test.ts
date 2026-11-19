/**
 * A MEETING'S STARTED CARD LOADED FROM HISTORY: the room's primary assistant's message, with the Metadata the router
 * writes for a person's start (the card and the room's email directive), is read as the card.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ae/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ae/shared')>()),
  trackEvent: vi.fn(),
}));

import { chimeService } from './chimeService';
import { MEETING_CONVERSATION, STARTED_CARD_CONTENT, STARTED_CARD_METADATA } from '../test-fixtures/meetingStartedCard';

const USER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1';
const ADVISOR = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/advisor';
const ROOM = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/conv-ops-1794616000000-aaaa';

describe("a meeting's started card from history", () => {
  it('is read as the card from the Metadata the router writes', async () => {
    const send = vi.fn().mockResolvedValue({ ChannelMessages: [{
      MessageId: 'card-1', Content: STARTED_CARD_CONTENT, Metadata: JSON.stringify(STARTED_CARD_METADATA),
      Sender: { Arn: ADVISOR, Name: 'Advisor' }, CreatedTimestamp: new Date('2026-11-13T23:02:00Z'),
    }] });
    Object.assign(chimeService as unknown as object, { messagingClient: { send }, userArn: USER });
    const [card] = await chimeService.listMessages(ROOM);
    expect(card.meetingCard).toEqual({ event: 'meeting-started', meetingId: STARTED_CARD_METADATA.meetingCard.meetingId, conversationId: MEETING_CONVERSATION });
  });
});
