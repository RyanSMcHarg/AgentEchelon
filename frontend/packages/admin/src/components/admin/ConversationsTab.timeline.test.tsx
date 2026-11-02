import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ConversationsTab from './ConversationsTab';
import type { AdminConversationMessage, AdminMembershipEvent } from '@ae/shared';
import * as svc from '../../services/adminConversationService';

/**
 * ONE TIMELINE, THE FULL RECORD BY DEFAULT (SPEC-ADMIN-CONSOLE FR55).
 *
 * Membership changes sit between the messages they separated, a removed message stays in place as its
 * tombstone so the reply that answered it still has its question, and "Current state" narrows the
 * timeline to what is there now.
 */
vi.mock('../../services/adminConversationService', () => ({
  listAdminConversations: vi.fn(),
  listAdminConversationMessages: vi.fn(),
  listAdminConversationMembers: vi.fn(),
  getAdminMembershipHistory: vi.fn(),
  getAdminConversationIdentities: vi.fn(),
}));

const CHANNEL = 'arn:aws:chime:us-east-1:123:app-instance/x/channel/abc';
const MESSAGES: AdminConversationMessage[] = [
  { id: 'm-q', content: '', senderArn: 'a', timestamp: '2026-07-18T10:01:00Z', isBot: false, redacted: true, deleted: false },
  { id: 'm-a', content: 'I cannot take card numbers', senderArn: 'b', timestamp: '2026-07-18T10:02:00Z', isBot: true },
  {
    id: 'm-e', content: 'my order is 4411', senderArn: 'a', timestamp: '2026-07-18T10:03:00Z', isBot: false,
    versions: [
      { at: '2026-07-18T10:03:00Z', content: 'my order is 4410' },
      { at: '2026-07-18T10:03:30Z', content: 'my order is 4412' },
      { at: '2026-07-18T10:04:00Z', content: 'my order is 4411' },
    ],
  },
];
const HISTORY: AdminMembershipEvent[] = [
  { action: 'joined', memberArn: 'arn:x/user/alice', timestamp: '2026-07-18T10:00:00Z', isBot: false },
  { action: 'joined', memberArn: 'arn:x/bot/hr', timestamp: '2026-07-18T10:01:30Z', isBot: true },
  { action: 'joined', memberArn: 'arn:x/user/operator', timestamp: '2026-07-18T10:01:40Z', isBot: false, hidden: true },
];

describe('the conversation timeline', () => {
  beforeEach(() => {
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue(HISTORY);
  });

  const rowsText = () => screen.getAllByRole('row').map((r) => r.textContent ?? '');

  it('interleaves membership changes with the messages, in time order, keeping a removed message in place', async () => {
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText('I cannot take card numbers');
    const order = rowsText().filter((t) => /Membership: joined|Redacted by a moderator|I cannot take card numbers/.test(t))
      .map((t) => (t.includes('Membership') ? 'join' : t.includes('Redacted') ? 'removed question' : 'answer'));
    expect(order).toEqual(['join', 'removed question', 'join', 'join', 'answer']);
  });

  it('narrows to what is there now on request', async () => {
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText('I cannot take card numbers');
    fireEvent.click(screen.getByLabelText('Current state'));
    expect(screen.queryByText(/Redacted by a moderator/)).toBeNull();
    expect(screen.getByText('I cannot take card numbers')).toBeTruthy();
    // A hidden member's join leaves; a visible one stays, and so does one archived before visibility
    // was recorded (no `hidden` at all), because the filter must not guess.
    expect(rowsText().filter((t) => t.includes('Membership: joined'))).toHaveLength(2);
    expect(rowsText().some((t) => t.includes('hidden from other members'))).toBe(false);
  });

  it('shows where the subject changed: a flag with its outcome, and subjects added or dropped', async () => {
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([
      ...HISTORY,
      { action: 'subject_added', memberArn: '', subject: 'Order lookup', timestamp: '2026-07-18T10:01:10Z', isBot: false },
      { action: 'subject_flagged', memberArn: '', timestamp: '2026-07-18T10:03:10Z', isBot: false },
      { action: 'subject_resolved', memberArn: '', subjectOutcome: 'declined', timestamp: '2026-07-18T10:03:15Z', isBot: false },
      { action: 'subject_dropped', memberArn: '', subject: 'Order lookup', timestamp: '2026-07-18T10:03:20Z', isBot: false },
    ]);
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText('I cannot take card numbers');
    expect(rowsText().some((t) => t.includes('Subject added: Order lookup'))).toBe(true);
    expect(rowsText().some((t) => t.includes('New subject flagged'))).toBe(true);
    expect(rowsText().some((t) => t.includes('Flagged subject · kept in this conversation'))).toBe(true);
    expect(rowsText().some((t) => t.includes('Subject dropped: Order lookup'))).toBe(true);
  });

  it('marks a hidden member in the full record', async () => {
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText('I cannot take card numbers');
    expect(rowsText().filter((t) => t.includes('hidden from other members'))).toHaveLength(1);
  });

  it('shows every earlier version of an edited message in the record, and only the latest in the current state', async () => {
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText('I cannot take card numbers');
    expect(screen.getByText(/Edited: 3 versions/)).toBeTruthy();
    expect(screen.getByText(/my order is 4410/)).toBeTruthy();
    expect(screen.getByText(/my order is 4412/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Current state'));
    expect(screen.queryByText(/Edited: 3 versions/)).toBeNull();
    expect(screen.queryByText(/my order is 4410/)).toBeNull();
    expect(screen.getByText('my order is 4411')).toBeTruthy();
  });

  it('offers no message controls on a membership change', async () => {
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText('I cannot take card numbers');
    const join = screen.getAllByRole('row').find((r) => (r.textContent ?? '').includes('Membership: joined'))!;
    expect(within(join).queryByRole('button')).toBeNull();
  });
});
