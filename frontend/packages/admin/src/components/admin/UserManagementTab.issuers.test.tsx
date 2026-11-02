/**
 * The Users view shows each person's issuers and hides unbound visitors by default (E6), and exports one
 * person's records as a file (B13), each a query over the existing record.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@ae/shared/i18n';
import UserManagementTab from './UserManagementTab';

vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.com/');
vi.mock('../../services/sigv4Fetch', () => ({
  adminRequest: async (method: string, url: string, opts: { body?: unknown } = {}) => {
    const res = await (globalThis.fetch as typeof fetch)(url, { method, ...(method === 'GET' ? {} : { body: JSON.stringify(opts.body ?? {}) }) });
    return res.json();
  },
}));

const APP = 'arn:aws:chime:us-east-1:111:app-instance/app-1';
const person = (over: Record<string, unknown>) => ({
  personArn: `${APP}/user/p-1`, personId: 'p-1', displayName: 'Jane Doe', account: 'pool', username: 'jane@x', email: 'jane@x',
  tier: 'basic', approved: 'true', status: 'CONFIRMED', enabled: true, createdAt: '', membershipGroups: [],
  issuers: ['deployment'], guest: false, ...over,
});

describe('the Users view, by issuer', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    localStorage.setItem('idToken', 'token');
    fetchMock.mockReset().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/users/export')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ format: 'agentechelon-person-export', sections: [] }) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          users: [
            person({}),
            person({ personArn: `${APP}/user/p-2`, personId: 'p-2', displayName: 'Casey Customer', account: 'other', username: null, email: '', issuers: ['customers', 'guest'] }),
            person({ personArn: `${APP}/user/p-3`, personId: 'p-3', displayName: 'Visitor', account: 'other', username: null, email: '', issuers: ['guest'], guest: true }),
            person({ personArn: `${APP}/user/p-4`, personId: 'p-4', displayName: 'Dana Departed', account: 'other', username: null, email: '', issuers: ['customers'], enabled: false }),
          ],
          membershipGroups: [],
        }),
      });
      void init;
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('names the issuers each person signs in through', async () => {
    render(<UserManagementTab />);
    fireEvent.click(await screen.findByRole('button', { name: /total/i }));
    const casey = (await screen.findByText('Casey Customer')).closest('.um-card') as HTMLElement;
    expect(within(casey).getByTestId('person-issuers').textContent).toBe('Signs in through customers, guest');
  });

  it('says a person of another issuer is disabled when their identity provider reports it', async () => {
    render(<UserManagementTab />);
    fireEvent.click(await screen.findByRole('button', { name: /total/i }));
    const dana = (await screen.findByText('Dana Departed')).closest('.um-card') as HTMLElement;
    expect(within(dana).getByText('Disabled')).toBeInTheDocument();
    expect(within(dana).getByText('Disabled by their identity provider')).toBeInTheDocument();
    const casey = (await screen.findByText('Casey Customer')).closest('.um-card') as HTMLElement;
    expect(within(casey).queryByText('Disabled by their identity provider')).toBeNull();
  });

  it('lists no visitor and offers no visitor toggle while the guest experience is hidden', async () => {
    render(<UserManagementTab />);
    fireEvent.click(await screen.findByRole('button', { name: /total/i }));
    await screen.findByText('Jane Doe');
    expect(screen.queryByText('Visitor', { selector: '.um-card-email' })).toBeNull();
    expect(screen.queryByLabelText(/Show visitors/)).toBeNull();
  });

  it('exports a person by AppInstanceUser', async () => {
    render(<UserManagementTab />);
    fireEvent.click(await screen.findByRole('button', { name: /total/i }));
    const jane = (await screen.findByText('Jane Doe')).closest('.um-card') as HTMLElement;
    fireEvent.click(within(jane).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('https://admin.example.com/users/export', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ personArn: `${APP}/user/p-1` }),
    })));
  });
});
