import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConversationsTab from './ConversationsTab';
import type { AdminConversationMessage } from '@ae/shared';
import * as svc from '../../services/adminConversationService';

vi.mock('../../services/adminConversationService', () => ({
  listAdminConversations: vi.fn(),
  listAdminConversationMessages: vi.fn(),
  listAdminConversationMembers: vi.fn(),
  getAdminMembershipHistory: vi.fn(),
  getAdminConversationIdentities: vi.fn(),
  addAdminToConversation: vi.fn(),
  addAdminMember: vi.fn(),
  removeAdminMember: vi.fn(),
  redactAdminConversationMessage: vi.fn(),
  deleteAdminConversationMessage: vi.fn(),
}));

vi.mock('../../services/analyticsService', () => ({
  recordModeration: vi.fn(),
  listChannelEvents: vi.fn().mockResolvedValue([]),
  flagResponse: vi.fn(),
  unflagResponse: vi.fn(),
}));

const CHANNEL = 'arn:aws:chime:us-east-1:123:app-instance/x/channel/abc';

const MESSAGES: AdminConversationMessage[] = [
  { id: 'm-user', content: 'how much leave do I have', senderArn: 'a', senderName: 'Alice', timestamp: '2026-07-18T10:00:00Z', isBot: false },
  { id: 'm-bot', content: 'I can help with expenses', senderArn: 'b', senderName: 'Assistant', timestamp: '2026-07-18T10:01:00Z', isBot: true, answersTurn: true },
];


/**
 * A conversation opened from another tab returns there. Back takes the person to the page they
 * were on, the turn they followed, rather than to the conversation list.
 */
describe('ConversationsTab - returning to where a conversation was opened from', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
  });

  it('returns to the page it was opened from', async () => {
    const user = userEvent.setup();
    const onReturn = vi.fn();
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL}
      returnTo={{ onReturn }} />);
    await user.click(await screen.findByRole('button', { name: '← Back' }));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('offers the same Back when it was opened from the list', async () => {
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    expect(await screen.findByRole('button', { name: '← Back' })).toBeTruthy();
  });
});
