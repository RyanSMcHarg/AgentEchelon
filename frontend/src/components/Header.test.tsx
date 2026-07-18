import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import Header from './Header';
import { useAuth, type User } from '../providers/AuthProvider';

// Isolate Header from the auth + realtime plumbing.
vi.mock('../providers/AuthProvider', () => ({ useAuth: vi.fn() }));
vi.mock('./ConnectionStatus', () => ({ default: () => null }));

function renderWith(user: Partial<User> | null) {
  vi.mocked(useAuth).mockReturnValue({ user, logout: vi.fn() } as unknown as ReturnType<typeof useAuth>);
  return render(<Header onAdminToggle={vi.fn()} isAdminView={false} onHome={vi.fn()} />);
}

describe('Header — the Admin button is gated on the admins group, not tier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the Admin button for a user in the admins group', () => {
    const { container } = renderWith({ id: '1', email: 'a@x', tier: 'basic', isAdmin: true });
    expect(container.querySelector('.header-admin-btn')).not.toBeNull();
  });

  it('hides the Admin button for a premium user who is NOT an admin (the fix)', () => {
    const { container } = renderWith({ id: '2', email: 'b@x', tier: 'premium', isAdmin: false });
    expect(container.querySelector('.header-admin-btn')).toBeNull();
  });

  it('hides the Admin button when isAdmin is absent', () => {
    const { container } = renderWith({ id: '3', email: 'c@x', tier: 'premium' });
    expect(container.querySelector('.header-admin-btn')).toBeNull();
  });
});
