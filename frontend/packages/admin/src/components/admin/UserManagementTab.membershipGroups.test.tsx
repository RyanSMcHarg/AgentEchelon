import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import UserManagementTab from './UserManagementTab';

// Every user-management route is IAM-authorized, so the tab signs each call. The signer is replaced by a
// plain fetch so the test asserts what the tab asks for, not how SigV4 canonicalizes it.
vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.com/');
vi.mock('../../services/sigv4Fetch', () => ({
  adminRequest: async (method: string, url: string, opts: { body?: unknown } = {}) => {
    const res = await (globalThis.fetch as typeof fetch)(url, {
      method,
      ...(method === 'GET' ? {} : { body: JSON.stringify(opts.body ?? {}) }),
    });
    return res.json();
  },
}));

/**
 * A membership group (e.g. `ops`) is chosen in the person's details, not on their row: a
 * checkbox per group on every row reads as one setting while there is one group and becomes a wall of them once
 * there are several. The details offer exactly the groups the API declares, each with the clearance it requires
 * and what a group does, and a change posts to /group.
 */
describe('UserManagementTab membership groups', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.setItem('idToken', 'token');
    fetchMock.mockReset().mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            users: [{ personArn: 'arn:aws:chime:us-east-1:111:app-instance/a/user/p-1', personId: 'p-1', displayName: null, account: 'pool', username: 'lead@x', email: 'lead@x', tier: 'premium', approved: 'true', status: 'CONFIRMED', enabled: true, createdAt: '', membershipGroups: [] }],
            membershipGroups: [{ name: 'ops', requires: 'premium' }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('offers the declared membership group and posts the change when toggled', async () => {
    render(<UserManagementTab />);
    // The tab opens on pending; this user is approved.
    fireEvent.click(await screen.findByRole('button', { name: /approved/i }));
    await screen.findByText('lead@x', { selector: '.um-card-email' });
    // No group checkbox on the row.
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details for lead@x' }));
    const detail = await screen.findByTestId('person-detail');
    expect(detail).toHaveTextContent('grants no access of its own');
    expect(detail).toHaveTextContent(/Requires .*premium.* clearance/i);
    const toggle = await screen.findByRole('checkbox', { name: /ops/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/users/group') && init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(post![1].body as string)).toEqual({ username: 'lead@x', group: 'ops', member: true });
    });
  });
});
