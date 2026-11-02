/**
 * The account menu: email preferences moved out of the header into Account settings,
 * reached from one control that names the signed-in person.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import AccountMenu from './AccountMenu';

describe('the account menu', () => {
  it('names the person, and opens Account settings or signs out from a menu', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onSignOut = vi.fn();
    render(<AccountMenu name="Riley Chen" onOpenSettings={onOpenSettings} onSignOut={onSignOut} />);
    const trigger = screen.getByRole('button', { name: 'Account menu for Riley Chen' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Account settings' })).toHaveFocus();
    await user.click(screen.getByRole('menuitem', { name: 'Account settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<AccountMenu name="Riley" onOpenSettings={() => {}} onSignOut={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Account menu for Riley' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
