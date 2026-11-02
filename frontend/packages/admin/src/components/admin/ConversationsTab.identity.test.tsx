import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConversationsTab from './ConversationsTab';
import type { AdminConversationMessage } from '@ae/shared';
import * as svc from '../../services/adminConversationService';

/**
 * A PERSON-BEARING SURFACE IDENTIFIES BY ID, AND A NAME IS AN ENRICHMENT (SPEC-ADMIN-CONSOLE FR42).
 *
 * The conversation reads return no participant name to any caller, because the name is an email address
 * and a separate grant. So the transcript renders the Cognito `sub` from the ARN, and a name appears only
 * when `see-user-identity` let the identity call answer.
 *
 * WHY THIS IS ASSERTED ON THE CLIENT AS WELL AS THE SERVER: a refusal here is the NORMAL case, not an
 * error, and the failure it guards against is cosmetic rather than a leak - a column that renders blank,
 * or the word `undefined`, for every operator who lacks the grant. The server test proves nothing reaches
 * the browser; this proves the browser stays usable when nothing does.
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

const CHANNEL = 'arn:aws:chime:us-east-1:123:app-instance/x/channel/abc';
const SENDER_ARN = 'arn:aws:chime:us-east-1:123:app-instance/x/user/7f3c-sub-of-a-person';
const SUB = '7f3c-sub-of-a-person';

// Exactly what the read returns now: an ARN and no name, whoever asked.
const MESSAGES: AdminConversationMessage[] = [
  { id: 'm-1', content: 'what is our refund policy', senderArn: SENDER_ARN, timestamp: '2026-07-18T10:00:00Z', isBot: false },
];

const renderTab = () => render(
  <ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />,
);

describe('ConversationsTab - who a participant is', () => {
  beforeEach(() => {
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
  });

  it('renders the principal id when the operator holds no identity grant', async () => {
    // The refusal reaches the component as an empty map, which is what the service returns on a 403.
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    renderTab();

    expect(await screen.findByText(/what is our refund policy/)).toBeTruthy();
    // The id, not a blank and not the string "undefined".
    expect(await screen.findByText(SUB)).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('renders the name when the identity call answered', async () => {
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({ [SENDER_ARN]: 'a.person@example.com' });
    renderTab();

    expect(await screen.findByText('a.person@example.com')).toBeTruthy();
    // The name REPLACES the id rather than appearing beside it, so the column stays one identity wide.
    expect(screen.queryByText(SUB)).toBeNull();
  });

  it('still shows the transcript when the identity call fails outright', async () => {
    // Distinct from a refusal: a broken identity read must not blank the messages, which are the point
    // of the view. The same rule the live-members and history reads already follow.
    vi.mocked(svc.getAdminConversationIdentities).mockRejectedValue(new Error('gateway refused'));
    renderTab();

    expect(await screen.findByText(/what is our refund policy/)).toBeTruthy();
    expect(await screen.findByText(SUB)).toBeTruthy();
  });

  it('asks for identities scoped to the conversation being viewed', async () => {
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    renderTab();

    await screen.findByText(/what is our refund policy/);
    // Per conversation, so the scope applies to the same subject the other reads check.
    expect(vi.mocked(svc.getAdminConversationIdentities)).toHaveBeenCalledWith(CHANNEL);
  });
});
