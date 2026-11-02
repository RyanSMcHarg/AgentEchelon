import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConversationsTab from './ConversationsTab';
import type { AdminConversationMessage } from '@ae/shared';
import * as svc from '../../services/adminConversationService';
import * as analytics from '../../services/analyticsService';

/**
 * A MODERATOR CAN RAISE A FLAG FROM THE TRANSCRIPT.
 *
 * Oversight is the moderator surface and it was read-only about quality: the Flagged list had one
 * author, the judge, and a human could only approve or reject what the judge had already raised. So
 * somebody reading a conversation and seeing a bad answer had nowhere to record it.
 *
 * These tests assert the DATA the action sends and the state it reflects back, not that a button
 * exists - a control that renders and posts the wrong thing is the failure worth catching.
 */
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

function renderTab() {
  return render(
    <ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />,
  );
}

describe('ConversationsTab — raising a flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    // No identity grant in these fixtures: the detail view renders participants by id, which is the
    // default for every caller. See a-withheld-name-is-withheld-everywhere-it-rides.test.ts.
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
  });

  it('sends the channel, the message and the chosen reason', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Flag/ }));
    await user.click(await screen.findByRole('button', { name: 'Wrong assistant' }));

    await waitFor(() => {
      expect(analytics.flagResponse).toHaveBeenCalledWith(CHANNEL, 'm-bot', 'wrong_assistant');
    });
  });

  it('offers exactly the three reasons the end user is offered, so the two count together', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Flag/ }));

    expect(await screen.findByRole('button', { name: 'Wrong assistant' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Poor answer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Had to re-ask' })).toBeTruthy();
  });

  it('offers the flag ONLY on an assistant response', async () => {
    renderTab();

    // Two messages, one of them a person's. Flagging a person's own words is not what this measures.
    await waitFor(() => expect(screen.getByText(/how much leave do I have/)).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /Flag/ })).toHaveLength(1);
  });

  it('offers no flag on an assistant message that answers nothing, such as a welcome', async () => {
    // The Flagged list reaches a flag through the exchange that claims the message. A welcome has no
    // exchange, so a flag on it was stored, shown as flagged here, and never listed (e2e, 2026-10-23).
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([
      { id: 'm-welcome', content: 'Hi - I am your assistant', senderArn: 'b', senderName: 'Assistant', timestamp: '2026-07-18T09:59:00Z', isBot: true },
      ...MESSAGES,
    ]);
    renderTab();

    await waitFor(() => expect(screen.getByText(/Hi - I am your assistant/)).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /Flag/ })).toHaveLength(1);
  });

  it('re-reads the transcript after flagging rather than trusting its own memory', async () => {
    // The flag is stored and the transcript read projects it. Patching local state instead would
    // leave the button asserting what this component believes it wrote, not what is in the table.
    const user = userEvent.setup();
    renderTab();
    await waitFor(() => expect(svc.listAdminConversationMessages).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole('button', { name: /Flag/ }));
    await user.click(await screen.findByRole('button', { name: 'Poor answer' }));

    await waitFor(() => expect(svc.listAdminConversationMessages).toHaveBeenCalledTimes(2));
  });

  it('shows an already-flagged response as flagged, and withdrawing deletes it', async () => {
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([
      MESSAGES[0],
      { ...MESSAGES[1], flagReason: 'asked_again', flaggedAt: '2026-07-18T11:00:00Z' },
    ]);
    const user = userEvent.setup();
    renderTab();

    const flagged = await screen.findByRole('button', { name: /Flagged/ });
    expect(flagged).toBeTruthy();
    // The stored reason is readable without opening anything, so a moderator can see what a
    // colleague already said before adding their own view.
    expect(flagged.getAttribute('title')).toContain('Had to re-ask');

    await user.click(flagged);
    await waitFor(() => expect(analytics.unflagResponse).toHaveBeenCalledWith(CHANNEL, 'm-bot'));
  });

  it('surfaces a failure instead of appearing to have flagged', async () => {
    vi.mocked(analytics.flagResponse).mockRejectedValueOnce(new Error('Access denied'));
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole('button', { name: /Flag/ }));
    await user.click(await screen.findByRole('button', { name: 'Poor answer' }));

    expect(await screen.findByText(/Access denied/)).toBeTruthy();
  });
});
