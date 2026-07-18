import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConversationsTab from './ConversationsTab';
import type { AdminConversationMessage } from '../../types';
import * as svc from '../../services/adminConversationService';

// Mock the data layer only — NOT DataTable, which is the component that runs the
// preview column's render fn (the code under test). We want the real render path.
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

// The backend blanks content for a redacted OR deleted message and carries the
// distinction in the flags. These fixtures mirror exactly what the Aurora admin
// read returns (see admin-conversations-aurora.test.ts).
const MESSAGES: AdminConversationMessage[] = [
  { id: 'm-normal', content: 'the quarterly revenue was up', senderArn: 'a', senderName: 'Alice', timestamp: '2026-07-18T10:00:00Z', isBot: false },
  { id: 'm-redacted', content: '', senderArn: 'a', senderName: 'Alice', timestamp: '2026-07-18T10:01:00Z', isBot: false, redacted: true, deleted: false },
  { id: 'm-deleted', content: '', senderArn: 'b', senderName: 'Bot', timestamp: '2026-07-18T10:02:00Z', isBot: true, redacted: false, deleted: true },
];

describe('ConversationsTab — redacted/deleted tombstones', () => {
  beforeEach(() => {
    vi.mocked(svc.listAdminConversations).mockResolvedValue([]);
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
  });

  it('renders a distinct tombstone for redacted vs deleted, and real content otherwise', async () => {
    // deepLinkChannelArn auto-opens the conversation detail → loads the messages above.
    render(
      <ConversationsTab
        summaryData={null}
        driftData={null}
        isLoading={false}
        deepLinkChannelArn={CHANNEL}
      />,
    );

    // Normal content shows verbatim (truncated form still contains the text).
    expect(await screen.findByText(/the quarterly revenue was up/)).toBeTruthy();

    // A redacted message must show the redacted tombstone — NOT a blank cell, NOT "deleted".
    const redacted = await screen.findByText(/Redacted by a moderator/);
    expect(redacted).toBeTruthy();

    // A deleted message must show the DISTINCT deleted tombstone.
    const deleted = await screen.findByText(/Deleted by an admin/);
    expect(deleted).toBeTruthy();

    // The original (now-blanked) content of the moderated messages must never leak.
    expect(screen.queryByText(/the quarterly revenue was up/)).toBeTruthy(); // control still present
  });

  it('does not show a redacted tombstone when nothing is moderated', async () => {
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([MESSAGES[0]]);
    render(
      <ConversationsTab
        summaryData={null}
        driftData={null}
        isLoading={false}
        deepLinkChannelArn={CHANNEL}
      />,
    );
    expect(await screen.findByText(/the quarterly revenue was up/)).toBeTruthy();
    expect(screen.queryByText(/Redacted by a moderator/)).toBeNull();
    expect(screen.queryByText(/Deleted by an admin/)).toBeNull();
  });

  it('still renders messages when the live members call fails (resilient detail load)', async () => {
    // A delete-only / abandoned channel can 4xx on the live Chime members read. That must
    // NOT reject the whole detail load and blank the messages — the deleted tombstone must
    // still render. (Regression: Promise.all with an unguarded members call blanked it.)
    vi.mocked(svc.listAdminConversationMembers).mockRejectedValue(new Error('Chime 403'));
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([MESSAGES[2]]); // the deleted one
    render(
      <ConversationsTab
        summaryData={null}
        driftData={null}
        isLoading={false}
        deepLinkChannelArn={CHANNEL}
      />,
    );
    expect(await screen.findByText(/Deleted by an admin/)).toBeTruthy();
    expect(screen.queryByText(/No messages loaded/)).toBeNull();
  });

  it('attributes to the actual actor when the moderation is audited', async () => {
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([
      { ...MESSAGES[2], moderatedByName: 'Alice Admin' }, // deleted + audited actor
    ]);
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    expect(await screen.findByText('Deleted by Alice Admin')).toBeTruthy();
    expect(screen.queryByText('Deleted by an admin')).toBeNull(); // the role fallback is not used
  });

  it('hides Redact once redacted, and both actions once deleted', async () => {
    // Redacted → Redact gone, Delete stays.
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([MESSAGES[1]]);
    const view = render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText(/Redacted by/);
    expect(screen.queryByRole('button', { name: 'Redact' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    view.unmount();

    // Deleted → neither action.
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([MESSAGES[2]]);
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText(/Deleted by/);
    expect(screen.queryByRole('button', { name: 'Redact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
