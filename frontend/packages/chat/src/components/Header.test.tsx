import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import Header from './Header';
import { useAuth, type User } from '@ae/shared';

// Isolate Header from the auth + realtime plumbing. AuthProvider/useAuth now live
// in @ae/shared, so mock useAuth there (preserving the rest of the shared barrel).
// `ADMIN_APP_URL` is read from that same barrel at render, so the mock owns it too and
// each case can set it - the deployer's configuration IS the behavior under test.
const shared = vi.hoisted(() => ({ adminAppUrl: '' }));
vi.mock('@ae/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ae/shared')>()),
  useAuth: vi.fn(),
  get ADMIN_APP_URL() {
    return shared.adminAppUrl;
  },
}));
vi.mock('./ConnectionStatus', () => ({ default: () => null }));

function renderWith(user: Partial<User> | null, adminAppUrl = '') {
  shared.adminAppUrl = adminAppUrl;
  vi.mocked(useAuth).mockReturnValue({ user, logout: vi.fn() } as unknown as ReturnType<typeof useAuth>);
  return render(<Header onHome={vi.fn()} />);
}

const ADMIN_URL = 'https://admin.example.test';
const adminLink = (c: HTMLElement) => c.querySelector('a.header-admin-link');

/**
 * THE PREVIOUS VERSION OF THIS SUITE PASSED FOR TWO INDEPENDENT WRONG REASONS, and asserted a design
 * that is not the one that ships. It queried `.header-admin-btn`, a class the component never renders
 * (it renders `a.header-admin-link`), so the assertion could not fail; and `ADMIN_APP_URL` was empty
 * under test, so the element was absent anyway. Its name - "renders no admin button, even for an admin
 * user" - stated the opposite of DESIGN-SEPARATE-ADMIN-APP.md, which specifies a configurable LINK OUT
 * shown to admins when the deployer sets `VITE_ADMIN_APP_URL`.
 *
 * What the split actually promises is narrower and worth pinning: no operator CODE in the chat bundle
 * (that is `assert-no-admin-in-chat.mjs`), and a link that appears only for an admin and only when a
 * deployer configured somewhere to send them.
 */
describe('Header — the admin link out is configuration, not an operator surface (DESIGN-SEPARATE-ADMIN-APP)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.adminAppUrl = '';
  });

  it('links an admin to the console the deployer configured, in a new tab', () => {
    const { container } = renderWith({ id: '1', email: 'a@x', tier: 'basic', isAdmin: true }, ADMIN_URL);
    const link = adminLink(container);
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', ADMIN_URL);
    expect(link).toHaveAttribute('target', '_blank');
    // Without this an opened console can reach back through window.opener.
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('offers no admin link to a non-admin, even when a console URL is configured', () => {
    const { container } = renderWith({ id: '2', email: 'b@x', tier: 'premium', isAdmin: false }, ADMIN_URL);
    expect(adminLink(container)).toBeNull();
  });

  it('offers no admin link when the deployer configured no console, even to an admin', () => {
    const { container } = renderWith({ id: '3', email: 'c@x', tier: 'basic', isAdmin: true }, '');
    expect(adminLink(container)).toBeNull();
  });

  it('renders no admin link at all when nobody is signed in', () => {
    const { container } = renderWith(null, ADMIN_URL);
    expect(adminLink(container)).toBeNull();
  });

  it('renders the account menu, which holds Account settings and Sign out, for an authenticated user', () => {
    const { container } = renderWith({ id: '4', email: 'd@x', tier: 'premium', isAdmin: false });
    expect(container.querySelector('.account-menu-trigger')).not.toBeNull();
    // Email preferences live in Account settings, not in the header.
    expect(container.textContent).not.toMatch(/Email preferences/);
  });
});
