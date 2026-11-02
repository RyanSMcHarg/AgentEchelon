import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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
 * A PERSON'S TEAMS ARE CHOSEN IN THEIR DETAILS (owner decision, 2026-10-24: "Teams should be editable").
 *
 * The details offer every team the deployment has, checked for the ones the person is in, with what a team does and
 * that joining a first one gives a team member's console access. A change posts to /users/team. The row shows the
 * person's teams, read-only.
 */
describe('UserManagementTab teams', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.setItem('idToken', 'token');
    fetchMock.mockReset().mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            users: [{ personArn: 'arn:aws:chime:us-east-1:111:app-instance/a/user/p-1', personId: 'p-1', displayName: null, account: 'pool', username: 'lead@x', email: 'lead@x', tier: 'premium', approved: 'true', status: 'CONFIRMED', enabled: true, createdAt: '', membershipGroups: [], teams: ['ops'] }],
            membershipGroups: [],
            teams: ['finance', 'ops'],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows the teams a person is in on their row, and offers every team in their details', async () => {
    render(<UserManagementTab />);
    fireEvent.click(await screen.findByRole('button', { name: /approved/i }));
    expect(await screen.findByTestId('person-teams')).toHaveTextContent('Ops team');
    fireEvent.click(screen.getByRole('button', { name: 'Details for lead@x' }));
    const teams = await screen.findByTestId('person-teams-edit');
    expect(teams).toHaveTextContent("Joining a first team also gives the person a team member's console access");
    expect((within(teams).getByRole('checkbox', { name: 'Ops team' }) as HTMLInputElement).checked).toBe(true);
    expect((within(teams).getByRole('checkbox', { name: 'Finance team' }) as HTMLInputElement).checked).toBe(false);
  });

  it('posts a team change to /users/team', async () => {
    render(<UserManagementTab />);
    fireEvent.click(await screen.findByRole('button', { name: /approved/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Details for lead@x' }));
    fireEvent.click(within(await screen.findByTestId('person-teams-edit')).getByRole('checkbox', { name: 'Finance team' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/users/team') && init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(post![1].body as string)).toEqual({ username: 'lead@x', team: 'finance', member: true });
    });
  });
});
