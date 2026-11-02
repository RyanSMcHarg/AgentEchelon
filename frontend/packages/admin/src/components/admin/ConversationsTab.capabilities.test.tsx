import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ConversationsTab from './ConversationsTab';
import type { AdminConversationMessage } from '@ae/shared';
import * as svc from '../../services/adminConversationService';
import { CapabilityTestProvider } from '../../capabilities';
import { setTeamAssistant } from '../../services/teamScope';

/**
 * A CONTROL A ROLE DOES NOT HOLD IS NEVER RENDERED (SPEC-ADMIN-CONSOLE FR0f, FR36).
 *
 * The console used to render every action to every role and let IAM refuse the click, which was safe and
 * taught operators to distrust the surface. A role reading a conversation without the moderation
 * capabilities sees the transcript and no Redact, Delete, Join or member controls; a role with them sees
 * them all. The live member list is an administration-identity read, so a role without it is not even
 * asked for one.
 */
vi.mock('../../services/adminConversationService', () => ({
  listAdminConversations: vi.fn(),
  listAdminConversationMessages: vi.fn(),
  listAdminConversationMembers: vi.fn(),
  getAdminMembershipHistory: vi.fn(),
  getAdminConversationIdentities: vi.fn(),
  findAdminConversation: vi.fn(),
  archiveAdminConversation: vi.fn(),
  deleteAdminConversation: vi.fn(),
  getCleanConversation: vi.fn(),
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

function renderAs(capabilities: string[]) {
  return render(
    <CapabilityTestProvider capabilities={capabilities} role="team-members">
      <ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />
    </CapabilityTestProvider>,
  );
}

describe('ConversationsTab renders only what the role holds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
  });

  it('shows a reader the transcript and no moderation controls', async () => {
    renderAs(['view-conversations', 'view-messages']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    for (const name of [/^Redact$/, /^Delete$/, /Join visibly/, /Join invisibly/, /Add member/, /Flag/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    // Not even asked for the live member list, which is an administration-identity read.
    expect(svc.listAdminConversationMembers).not.toHaveBeenCalled();
  });

  it('shows a role holding them every control', async () => {
    renderAs(['view-conversations', 'view-messages', 'view-live-members', 'redact', 'delete', 'manage-membership', 'triage-responses']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /^Redact$/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^Delete$/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Join visibly/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add member/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Flag/ })).toBeTruthy();
    expect(svc.listAdminConversationMembers).toHaveBeenCalled();
  });

  it('shows Redact without Delete to a role holding only redact', async () => {
    renderAs(['view-conversations', 'view-messages', 'redact']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /^Redact$/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
  });
});

describe('finding a conversation by its id (FR52)', () => {
  const renderList = (capabilities: string[]) => render(
    <CapabilityTestProvider capabilities={capabilities} role="team-members">
      <ConversationsTab summaryData={null} driftData={null} isLoading={false} />
    </CapabilityTestProvider>,
  );
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
  });

  it('is offered only to a role holding find-conversation', async () => {
    renderList(['view-conversations']);
    await waitFor(() => expect(svc.listAdminConversations).toHaveBeenCalled());
    expect(screen.queryByLabelText('Conversation id')).toBeNull();
  });

  it('opens the conversation it finds', async () => {
    vi.mocked(svc.findAdminConversation).mockResolvedValue({ channelArn: CHANNEL, name: 'Refund question', messageCount: 2, memberCount: 2 } as never);
    renderList(['view-conversations', 'view-messages', 'find-conversation']);
    fireEvent.change(screen.getByLabelText('Conversation id'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(svc.findAdminConversation).toHaveBeenCalledWith('abc');
  });

  it('says why nothing opened when the id is not in scope', async () => {
    vi.mocked(svc.findAdminConversation).mockResolvedValue(null);
    renderList(['view-conversations', 'find-conversation']);
    fireEvent.change(screen.getByLabelText('Conversation id'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(screen.getByText(/No conversation with that id in your scope/)).toBeTruthy());
  });
});

describe('archiving or deleting the whole conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
  });

  it('is offered to neither a reader nor a moderator', async () => {
    renderAs(['view-conversations', 'view-messages', 'redact', 'delete', 'manage-membership']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Archive conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete conversation' })).toBeNull();
  });

  it('offers each to the role holding it, and archives only once confirmed', async () => {
    renderAs(['view-conversations', 'view-messages', 'archive-conversation']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Delete conversation' })).toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Archive conversation' }));
    expect(svc.archiveAdminConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive conversation' }));
    await waitFor(() => expect(svc.archiveAdminConversation).toHaveBeenCalledWith(CHANNEL));
    confirm.mockRestore();
  });

  it('deletes through delete-conversation alone', async () => {
    renderAs(['view-conversations', 'view-messages', 'delete-conversation']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Archive conversation' })).toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(svc.deleteAdminConversation).toHaveBeenCalledWith(CHANNEL));
    confirm.mockRestore();
  });
});

describe('a team member opening a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTeamAssistant('hr');
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
  });
  afterEach(() => setTeamAssistant(null));

  it('reads what was said while its assistant was there, and says so', async () => {
    renderAs(['view-conversations', 'view-messages']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(screen.getByText(/Showing only what was said while hr was in this conversation/)).toBeTruthy();
    // The membership record, live members and names are not reads a team session holds.
    expect(svc.getAdminMembershipHistory).not.toHaveBeenCalled();
    expect(svc.getAdminConversationIdentities).not.toHaveBeenCalled();
    expect(svc.listAdminConversationMembers).not.toHaveBeenCalled();
  });

  it('reads nothing without view-messages', async () => {
    renderAs(['view-conversations']);
    await waitFor(() => expect(screen.getByText(/does not hold view-messages/)).toBeTruthy());
    expect(svc.listAdminConversationMessages).not.toHaveBeenCalled();
  });
});

describe('the de-identified copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
    vi.mocked(svc.getCleanConversation).mockResolvedValue({ rows: [], derivedAt: null });
  });

  it('is not offered to a role without view-clean-conversations', async () => {
    renderAs(['view-conversations', 'view-messages']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'De-identified' })).toBeNull();
  });

  it('opens on the record, and reads the copy only when asked for', async () => {
    renderAs(['view-conversations', 'view-messages', 'view-clean-conversations']);
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(svc.getCleanConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'De-identified' }));
    await waitFor(() => expect(svc.getCleanConversation).toHaveBeenCalledWith(CHANNEL));
  });
});
