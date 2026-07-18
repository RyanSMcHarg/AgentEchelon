import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import ConversationsTab from './ConversationsTab';
import type { AdminConversationMessage } from '../../types';
import * as svc from '../../services/adminConversationService';

vi.mock('../../services/adminConversationService', () => ({
  listAdminConversations: vi.fn(),
  listAdminConversationMessages: vi.fn(),
  listAdminConversationMembers: vi.fn(),
  getAdminMembershipHistory: vi.fn(),
  addAdminToConversation: vi.fn(),
  addAdminMember: vi.fn(),
  removeAdminMember: vi.fn(),
  redactAdminConversationMessage: vi.fn(),
  deleteAdminConversationMessage: vi.fn(),
}));

const CHANNEL = 'arn:aws:chime:us-east-1:123:app-instance/x/channel/abc';
const MSG: AdminConversationMessage = {
  id: 'm1', content: 'hello', senderArn: 'a', senderName: 'Alice',
  timestamp: '2026-07-18T10:00:00Z', isBot: false,
};

describe('ConversationsTab — global Back closes the detail first', () => {
  beforeEach(() => {
    vi.mocked(svc.listAdminConversations).mockResolvedValue([]);
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([MSG]);
  });

  it('registers a back handler while a detail is open, and it returns to the list', async () => {
    const registerBack = vi.fn();
    render(
      <ConversationsTab
        summaryData={null}
        driftData={null}
        isLoading={false}
        deepLinkChannelArn={CHANNEL}
        registerBack={registerBack}
      />,
    );

    // Detail opens (deep link) → the in-detail Back control appears.
    const backControl = await screen.findByText('← Back to conversations');
    expect(backControl).toBeTruthy();

    // The parent was handed a real closer (so the console's global Back can use it).
    await waitFor(() => {
      const lastArg = registerBack.mock.calls.at(-1)?.[0];
      expect(typeof lastArg).toBe('function');
    });
    const closer = registerBack.mock.calls.at(-1)![0] as () => void;

    // Invoking the closer returns to the list — the detail Back control is gone.
    act(() => closer());
    await waitFor(() => {
      expect(screen.queryByText('← Back to conversations')).toBeNull();
    });

    // And the parent is told there is no longer a detail to close.
    expect(registerBack.mock.calls.at(-1)?.[0]).toBeNull();
  });
});
