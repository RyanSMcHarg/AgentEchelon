import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import ConversationsTab from './ConversationsTab';
import type { AdminConversationMessage } from '@ae/shared';
import * as svc from '../../services/adminConversationService';
import { messageLinkFromSearch, nearestTo } from './messageLink';

/**
 * THE CONVERSATION VIEWER OPENS AT A MESSAGE (SPEC-ADMIN-CONSOLE, the conversation viewer's deep link).
 *
 * `?conv=<id>&msg=<MessageId>&at=<iso>` opens the conversation with that message in view and briefly
 * highlighted, on whichever page of the timeline holds it. A message the first read lacks is read for once
 * more; one still missing opens the conversation at the message nearest `at`, with a note saying so.
 */
vi.mock('../../services/adminConversationService', () => ({
  listAdminConversations: vi.fn(),
  listAdminConversationMessages: vi.fn(),
  listAdminConversationMembers: vi.fn(),
  getAdminMembershipHistory: vi.fn(),
  getAdminConversationIdentities: vi.fn(),
}));

const CHANNEL = 'arn:aws:chime:us-east-1:123:app-instance/x/channel/abc';
const T0 = Date.parse('2026-10-29T10:00:00Z');
/** Forty messages a minute apart, so the timeline spans two pages of twenty-five. */
const MESSAGES: AdminConversationMessage[] = Array.from({ length: 40 }, (_, i) => ({
  id: `m-${i}`,
  content: `message number ${i}`,
  senderArn: i % 2 ? 'arn:x/bot/advisor' : 'arn:x/user/alice',
  timestamp: new Date(T0 + i * 60_000).toISOString(),
  isBot: i % 2 === 1,
}));

const scrolled = vi.fn();

describe('the conversation viewer opens at a message', () => {
  beforeEach(() => {
    scrolled.mockReset();
    Element.prototype.scrollIntoView = scrolled;
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminConversationIdentities).mockResolvedValue({});
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.listAdminConversationMessages).mockReset();
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  const focusedRow = () => document.querySelector('tr[aria-current="true"]') as HTMLElement | null;

  it('scrolls to and highlights a loaded message, opening the page that holds it', async () => {
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
    render(
      <ConversationsTab
        summaryData={null} driftData={null} isLoading={false}
        deepLinkChannelArn={CHANNEL}
        deepLinkMessage={{ messageId: 'm-31', at: MESSAGES[31].timestamp, kind: 'battle' }}
      />,
    );
    // m-31 is on the second page; the table opens that page rather than the first.
    await waitFor(() => expect(focusedRow()).not.toBeNull());
    const row = focusedRow()!;
    expect(within(row).getByText('message number 31')).toBeInTheDocument();
    expect(row.className).toContain('data-table-row--focus');
    expect(row.getAttribute('data-row-key')).toBe('m-31');
    expect(screen.queryByText('message number 0')).toBeNull();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(row);
    // Found, so no note.
    expect(screen.queryByTestId('message-link-note')).toBeNull();
    // One read was enough.
    expect(svc.listAdminConversationMessages).toHaveBeenCalledTimes(1);
  });

  it('reads the conversation once more for a message the first read lacks, then highlights it', async () => {
    const latest: AdminConversationMessage = {
      id: 'm-new', content: '/battle which plan is better', senderArn: 'arn:x/user/alice',
      timestamp: new Date(T0 + 41 * 60_000).toISOString(), isBot: false,
    };
    vi.mocked(svc.listAdminConversationMessages)
      .mockResolvedValueOnce(MESSAGES)
      .mockResolvedValueOnce([...MESSAGES, latest]);
    render(
      <ConversationsTab
        summaryData={null} driftData={null} isLoading={false}
        deepLinkChannelArn={CHANNEL}
        deepLinkMessage={{ messageId: 'm-new', at: latest.timestamp, kind: 'battle' }}
      />,
    );
    await waitFor(() => expect(focusedRow()).not.toBeNull());
    expect(within(focusedRow()!).getByText('/battle which plan is better')).toBeInTheDocument();
    expect(svc.listAdminConversationMessages).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('message-link-note')).toBeNull();
  });

  it('falls back to the message nearest the time, and says the starting message is not available', async () => {
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
    // Twelve minutes and twenty seconds in: m-12 is the nearest message.
    const at = new Date(T0 + 12 * 60_000 + 20_000).toISOString();
    render(
      <ConversationsTab
        summaryData={null} driftData={null} isLoading={false}
        deepLinkChannelArn={CHANNEL}
        deepLinkMessage={{ messageId: 'm-gone', at, kind: 'battle' }}
      />,
    );
    const note = await screen.findByTestId('message-link-note');
    expect(note.textContent).toBe(`The battle's starting message isn't available; showing the conversation from ${new Date(at).toLocaleString()}.`);
    await waitFor(() => expect(focusedRow()).not.toBeNull());
    expect(focusedRow()!.getAttribute('data-row-key')).toBe('m-12');
    // Read twice, then stopped: no timer keeps asking.
    expect(svc.listAdminConversationMessages).toHaveBeenCalledTimes(2);
  });

  it('a link with no kind uses the general wording', async () => {
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
    const at = MESSAGES[3].timestamp;
    render(
      <ConversationsTab
        summaryData={null} driftData={null} isLoading={false}
        deepLinkChannelArn={CHANNEL}
        deepLinkMessage={{ messageId: 'm-gone', at }}
      />,
    );
    const note = await screen.findByTestId('message-link-note');
    expect(note.textContent).toBe(`The linked message isn't available; showing the conversation from ${new Date(at).toLocaleString()}.`);
  });

  it('opens without a highlight when there is no link', async () => {
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue(MESSAGES);
    render(<ConversationsTab summaryData={null} driftData={null} isLoading={false} deepLinkChannelArn={CHANNEL} />);
    await screen.findByText('message number 0');
    expect(focusedRow()).toBeNull();
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('the message link in a URL', () => {
  it('reads msg, at and a known kind, and ignores an unknown kind or an unreadable time', () => {
    expect(messageLinkFromSearch('?conv=c&msg=m-1&at=2026-10-29T10:00:00Z&kind=battle'))
      .toEqual({ messageId: 'm-1', at: '2026-10-29T10:00:00Z', kind: 'battle' });
    expect(messageLinkFromSearch('?conv=c&msg=m-1&at=yesterday&kind=whatever'))
      .toEqual({ messageId: 'm-1', at: null, kind: null });
    expect(messageLinkFromSearch('?conv=c')).toBeNull();
  });

  it('finds the nearest row by time', () => {
    expect(nearestTo(MESSAGES, new Date(T0 + 90_000 + 1).toISOString())?.id).toBe('m-2');
    expect(nearestTo(MESSAGES, null)).toBeNull();
  });
});
