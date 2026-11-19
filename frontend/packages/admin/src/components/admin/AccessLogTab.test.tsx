/**
 * THE ACCESS LOG TAB (ADR-052, SPEC-ADMIN-CONSOLE 3.3, FR30).
 *
 * It shows who was given access to which conversation, when, and why, and each refusal distinctly with its
 * code; it filters by conversation and by person; and a read the service refuses (the log could not record
 * it) shows the refusal rather than an empty table that would read as "nobody looked".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import AccessLogTab from './AccessLogTab';
import { CapabilityTestProvider } from '../../capabilities';
import { fetchAccessLog } from '../../services/accessLogService';
import { TAB_CAPABILITY, SECTIONS } from './AdminDashboard';

vi.mock('../../services/accessLogService', () => ({ fetchAccessLog: vi.fn() }));
vi.mock('../../services/peopleService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  userManagementUrl: () => 'https://api.test/users',
  listPeople: vi.fn(async () => ({
    users: [{ personId: 'sub-legal-1', displayName: 'Lena Ortiz' }],
    membershipGroups: [],
  })),
}));
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
    expect(screen.getByText('Read on the console session')).toBeTruthy();
  });

  it('marks a grant as granted', async () => {
    mockFetch.mockResolvedValue([record({ outcome: 'granted' })]);
    render(<AccessLogTab />);
    expect(await screen.findByText('Granted')).toBeTruthy();
    expect(screen.queryByTestId('access-log-refused')).toBeNull();
  });

  it('shows a refusal distinctly: refused, with its code, what was asked for, and no expiry', async () => {
    mockFetch.mockResolvedValue([record({
      id: 'r2', event: 'admin_credential_refused', outcome: 'refused', code: 'CONVERSATION_NOT_FOUND', status: 404,
      capabilities: ['attachment-read'], reason: 'customer asked about the report',
    })]);
    render(<AccessLogTab />);
    const refused = await screen.findByTestId('access-log-refused');
    expect(within(refused).getByText('Refused')).toBeTruthy();
    expect(within(refused).getByText('CONVERSATION_NOT_FOUND')).toBeTruthy();
    expect(screen.getByText('Admin credential request')).toBeTruthy();
    expect(screen.getByText('Open attachments')).toBeTruthy();
    expect(screen.getByText('Not granted')).toBeTruthy();
    expect(screen.queryByText('Granted')).toBeNull();
  });

  it('shows a refusal with no code by its status, and one with no person as such', async () => {
    mockFetch.mockResolvedValue([record({
      id: 'r3', event: 'person_credential_refused', outcome: 'refused', code: null, status: 400, actor: null, conversation: null,
      capabilities: [], reason: null,
    })]);
    render(<AccessLogTab />);
    const refused = await screen.findByTestId('access-log-refused');
    expect(refused.textContent).toContain('(HTTP 400)');
    expect(screen.getByText('Sign-in credential request')).toBeTruthy();
    expect(screen.getByText('Not signed in as a person')).toBeTruthy();
    expect(screen.getByText('None given')).toBeTruthy();
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

  it('names the person beside their id, for a role that may be told who a person is', async () => {
    mockFetch.mockResolvedValue([record()]);
    render(
      <CapabilityTestProvider capabilities={['view-access-log', 'view-users', 'see-user-identity']}>
        <AccessLogTab />
      </CapabilityTestProvider>,
    );
    const person = await screen.findByTestId('access-log-person');
    expect(person.textContent).toContain('Lena Ortiz');
    expect(person.textContent).toContain('sub-legal-1');
  });

  it('shows the id alone to a role that may not be told who a person is', async () => {
    mockFetch.mockResolvedValue([record()]);
    render(
      <CapabilityTestProvider capabilities={['view-access-log']}>
        <AccessLogTab />
      </CapabilityTestProvider>,
    );
    expect(await screen.findByText('sub-legal-1')).toBeTruthy();
    expect(screen.queryByText(/Lena Ortiz/)).toBeNull();
  });

  it('shows an analytics content read with its reason, the scope it reached, and that it was read on the session', async () => {
    mockFetch.mockResolvedValue([record({
      event: 'analytics_content_read', conversation: null, capabilities: ['view-events'], reason: 'checking a flagged answer',
      detail: { queryType: 'flagged_responses', scope: 'full' },
    })]);
    render(<AccessLogTab />);
    expect(await screen.findByText('Conversation content read in analytics')).toBeTruthy();
    expect(screen.getByText('checking a flagged answer')).toBeTruthy();
    expect(screen.getByText('Classifications: full · Query: flagged_responses')).toBeTruthy();
    expect(screen.getByText('Read conversation content')).toBeTruthy();
    expect(screen.getByText('Read on the console session')).toBeTruthy();
  });

  it('says "None required" only for an access that asks for no reason', async () => {
    mockFetch.mockResolvedValue([
      record({ id: 'a', event: 'admin_console_session_vend', conversation: null, reason: null, detail: { role: 'admins', ttlSeconds: 3600 } }),
      record({ id: 'b', event: 'clean_conversation_read', reason: null }),
    ]);
    render(<AccessLogTab />);
    expect(await screen.findByText('None required')).toBeTruthy();
    expect(screen.getByText('Not recorded')).toBeTruthy();
    expect(screen.getByText('Role: admins')).toBeTruthy();
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

describe('a reader that is not a person', () => {
  it('is shown by the name of the IAM role that signed the request, with the principal ARN as its title', async () => {
    const arn = 'arn:aws:sts::111122223333:assumed-role/App-AdminRole-def/ops-automation';
    mockFetch.mockResolvedValue([record({ event: 'analytics_content_read', actor: `iam#${arn}`, actorKind: 'iam', actorPrincipalArn: arn })]);
    render(<AccessLogTab />);
    const who = await screen.findByTestId('access-log-iam-actor');
    expect(who.textContent).toBe('App-AdminRole-def (IAM principal)');
    expect(who.getAttribute('title')).toBe(arn);
    expect(screen.queryByText(`iam#${arn}`)).toBeNull();
  });
});
