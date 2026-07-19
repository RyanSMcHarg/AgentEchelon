import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import Header from './Header';
import { useAuth, type User } from '../providers/AuthProvider';

// Isolate Header from the auth + realtime plumbing.
vi.mock('../providers/AuthProvider', () => ({ useAuth: vi.fn() }));
vi.mock('./ConnectionStatus', () => ({ default: () => null }));

function renderWith(user: Partial<User> | null) {
  vi.mocked(useAuth).mockReturnValue({ user, logout: vi.fn() } as unknown as ReturnType<typeof useAuth>);
  return render(<Header onHome={vi.fn()} />);
}

describe('Header — chat-only after the admin console split (SPEC-SEPARATE-ADMIN-APP)', () => {
  beforeEach(() => vi.clearAllMocks());

  // The admin console is a separate app on its own origin; the chat Header no
  // longer carries an Admin button or any admin affordance, for anyone.
  it('renders no admin button, even for an admin user', () => {
    const { container } = renderWith({ id: '1', email: 'a@x', tier: 'basic', isAdmin: true });
    expect(container.querySelector('.header-admin-btn')).toBeNull();
  });

  it('renders the sign-out button for an authenticated user', () => {
    const { container } = renderWith({ id: '2', email: 'b@x', tier: 'premium', isAdmin: false });
    expect(container.querySelector('.header-logout-btn')).not.toBeNull();
  });
});
