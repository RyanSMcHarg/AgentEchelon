import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import i18n from '@ae/shared/i18n';
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

const APP = 'arn:aws:chime:us-east-1:111:app-instance/app-1';
const person = (over: Record<string, unknown>) => ({
  personArn: `${APP}/user/p-1`, personId: 'p-1', displayName: 'Jane Doe', account: 'pool', username: 'jane@x', email: 'jane@x',
  tier: 'basic', approved: 'true', status: 'CONFIRMED', enabled: true, createdAt: '', membershipGroups: [], ...over,
});

/**
 * Offboarding from the console: the tab lists people from the AppInstanceUsers, handles a pool account
 * that has not signed in yet, deletes a person by AppInstanceUser, and STATES what offboarding keeps, as
 * a message from the admin console catalog rather than fixed English (tenet D11).
 */
describe('UserManagementTab offboarding', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.setItem('idToken', 'token');
    fetchMock.mockReset().mockImplementation((_url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            users: [
              person({}),
              // A pool account that has never signed in: no AppInstanceUser yet.
              person({ personArn: null, personId: null, displayName: null, username: 'pending@x', email: 'pending@x', approved: 'false', tier: 'none' }),
              // A person of another issuer: no pool account here.
              person({ personArn: `${APP}/user/p-2`, personId: 'p-2', displayName: 'Host Guest', account: 'other', username: null, email: '' }),
            ],
            membershipGroups: [],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage('en');
  });

  it('states what offboarding keeps, from the catalog', async () => {
    render(<UserManagementTab />);
    expect((await screen.findByTestId('offboarding-keeps')).textContent).toBe(i18n.t('admin.userManagement.offboardingKeeps'));
    expect(screen.getByTestId('offboarding-keeps').textContent).toMatch(/battle votes, their thumbs feedback and the conversation archive are kept/);
  });

  it('states it in a second locale when the console is in one', async () => {
    i18n.addResourceBundle('fr', 'translation', {
      admin: { userManagement: { offboardingKeeps: 'Les votes, les avis et l\'archive des conversations sont conservés.' } },
    }, true, true);
    await i18n.changeLanguage('fr');
    render(<UserManagementTab />);
    expect((await screen.findByTestId('offboarding-keeps')).textContent).toBe('Les votes, les avis et l\'archive des conversations sont conservés.');
  });

  it('offboards a person by AppInstanceUser', async () => {
    render(<UserManagementTab />);
    fireEvent.click(await screen.findByRole('button', { name: /approved/i }));
    const card = (await screen.findByText('Jane Doe')).closest('.um-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/users/delete') && init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(post![1].body as string)).toEqual({ personArn: `${APP}/user/p-1` });
    });
  });

  it('lists a pool account that has not signed in yet, and removes it by username', async () => {
    render(<UserManagementTab />);
    const card = (await screen.findByText('pending@x')).closest('.um-card') as HTMLElement;
    expect(within(card).getByText(i18n.t('admin.userManagement.notSignedInYet'))).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/users/delete') && init?.method === 'POST');
      expect(JSON.parse(post![1].body as string)).toEqual({ username: 'pending@x' });
    });
  });

  it('offers a person of another issuer offboarding only, not the pool\'s administration', async () => {
    render(<UserManagementTab />);
    fireEvent.click(await screen.findByRole('button', { name: /approved/i }));
    const card = (await screen.findByText('Host Guest')).closest('.um-card') as HTMLElement;
    expect(within(card).getByText(i18n.t('admin.userManagement.otherIssuer'))).toBeInTheDocument();
    expect(within(card).queryByRole('combobox')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
