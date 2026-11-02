/**
 * THE ACCESS LOG TAB (ADR-052, SPEC-ADMIN-CONSOLE 3.3, FR30).
 *
 * It shows who was given access to which conversation, when, and why; it filters by conversation and by
 * person; and a read the service refuses (the log could not record it) shows the refusal rather than an
 * empty table that would read as "nobody looked".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import AccessLogTab from './AccessLogTab';
import { CapabilityTestProvider } from '../../capabilities';
import { fetchAccessLog } from '../../services/accessLogService';
import { TAB_CAPABILITY, SECTIONS } from './AdminDashboard';

vi.mock('../../services/accessLogService', () => ({ fetchAccessLog: vi.fn() }));
const mockFetch = vi.mocked(fetchAccessLog);

const record = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  event: 'admin_scoped_credential_vend',
  at: '2026-10-12T10:00:00.000Z',
  actor: 'sub-legal-1',
  conversation: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/conv-42',
  capabilities: ['view-messages'],
  reason: 'Matter 2026-118 review',
  detail: null,
  ...over,
});

beforeEach(() => { mockFetch.mockReset(); });

describe('the Access Log tab', () => {
  it('lists who was given access, to which conversation, and the reason they stated', async () => {
    mockFetch.mockResolvedValue([record()]);
    render(<AccessLogTab />);
    expect(await screen.findByText('sub-legal-1')).toBeTruthy();
    expect(screen.getByText('conv-42')).toBeTruthy();
    expect(screen.getByText('Matter 2026-118 review')).toBeTruthy();
    expect(screen.getByText('Temporary read access')).toBeTruthy();
    expect(screen.getByText('Read messages')).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledWith({ days: 30, channelId: '', actor: '' });
  });

  it('says when a credential was a temporary moderation one, what it allowed, and that it expired', async () => {
    mockFetch.mockResolvedValue([record({
      capabilities: ['redact', 'manage-membership'],
      detail: { moderation: true, ttlSeconds: 1800 },
    })]);
    render(<AccessLogTab />);
    expect(await screen.findByText('Temporary moderation access')).toBeTruthy();
    expect(screen.getByText('Redact a message, Add or remove members')).toBeTruthy();
    expect(screen.getByText(new Date('2026-10-12T10:30:00.000Z').toLocaleString())).toBeTruthy();
  });

  it('shows a team member\'s read of a conversation, through which assistant', async () => {
    mockFetch.mockResolvedValue([record({ event: 'team_conversation_read', detail: { assistant: 'hr' } })]);
    render(<AccessLogTab />);
    expect(await screen.findByText('Conversation read by a team member (through hr)')).toBeTruthy();
    expect(screen.getByText('Not a timed credential')).toBeTruthy();
  });

  it('filters by conversation and person', async () => {
    mockFetch.mockResolvedValue([]);
    render(<AccessLogTab />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('Conversation id'), { target: { value: 'conv-42' } });
    fireEvent.change(screen.getByPlaceholderText('Person id'), { target: { value: 'sub-legal-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith({ days: 30, channelId: 'conv-42', actor: 'sub-legal-1' }));
  });

  it('shows a refused read as a refusal, not as an empty log', async () => {
    mockFetch.mockImplementation(async () => { throw new Error('This read cannot be recorded right now, so it is not served'); });
    render(<AccessLogTab />);
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be recorded');
    expect(screen.queryByText('No access recorded in this window.')).toBeNull();
  });

  it('sits in Oversight and needs view-access-log', () => {
    expect(TAB_CAPABILITY.access_log).toBe('view-access-log');
    expect(SECTIONS.find((s) => s.id === 'oversight')?.tabs).toContain('access_log');
  });
});

/**
 * YOUR ACCESS (FR0e). The operator's reach is split as the exchange reports it: what the console session
 * holds, and what the exchange vends only on request for one conversation, for the stated minutes.
 */
describe('Your access, on the Access Log tab', () => {
  const held = ['view-access-log', 'view-analytics', 'delete-conversation', 'redact'];

  it('lists what the session holds apart from what is granted on request, for the minutes the exchange states', async () => {
    mockFetch.mockResolvedValue([]);
    render(
      <CapabilityTestProvider capabilities={held} onRequest={{ capabilities: ['delete-conversation', 'redact'], ttlSeconds: 1800 }}>
        <AccessLogTab />
      </CapabilityTestProvider>,
    );
    const standing = await screen.findByTestId('access-log-held');
    const onRequest = screen.getByTestId('access-log-on-request');
    expect(within(standing).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['view-access-log', 'view-analytics']);
    expect(within(onRequest).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['delete-conversation', 'redact']);
    expect(screen.getByText(/for 30 minutes/)).toBeTruthy();
    expect(screen.getByText('Signed in as an administrator.')).toBeTruthy();
  });

  it('states no split when the exchange did not report one, rather than guessing it', async () => {
    mockFetch.mockResolvedValue([]);
    render(
      <CapabilityTestProvider capabilities={held}>
        <AccessLogTab />
      </CapabilityTestProvider>,
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('access-log-your-access')).toBeNull();
  });
});
