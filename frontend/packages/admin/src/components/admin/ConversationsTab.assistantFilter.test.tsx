/**
 * THE CONVERSATIONS LIST NARROWED TO ONE ASSISTANT (SPEC-ADMIN-CONSOLE "Assistants": the page's Conversations link).
 *
 * An assistant page's Conversations link carries the assistant on the URL (`as`, the Performance filter set's key). The
 * list applies it on load: it asks the server for the conversations that assistant was in, says so above the list, and
 * offers every conversation again. Without the filter the list is asked for unnarrowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConversationsTab from './ConversationsTab';
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
});

describe('the conversation list, narrowed to an assistant', () => {
  it('asks for the conversations the assistant was in, says so, and offers every conversation again', async () => {
    const clear = vi.fn();
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} assistantFilter="advisor" onClearAssistantFilter={clear} />);
    await waitFor(() => expect(svc.listAdminConversations).toHaveBeenCalled());
    expect(vi.mocked(svc.listAdminConversations).mock.calls[0][3]).toBe('advisor');
    const banner = await screen.findByTestId('conversations-assistant-filter');
    expect(banner).toHaveTextContent('Showing only conversations advisor was in.');
    fireEvent.click(screen.getByRole('button', { name: 'Show every conversation' }));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('asks for every conversation without the filter (non-vacuity)', async () => {
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} />);
    await waitFor(() => expect(svc.listAdminConversations).toHaveBeenCalled());
    expect(vi.mocked(svc.listAdminConversations).mock.calls[0][3]).toBeNull();
    expect(screen.queryByTestId('conversations-assistant-filter')).toBeNull();
  });
});
