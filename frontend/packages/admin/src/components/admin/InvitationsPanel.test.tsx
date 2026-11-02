/**
 * A conversation's invitations in the console (M-10, E6): listed with who invited whom, how they join and
 * where each stands; withdrawn only by a session holding `revoke-invitations`, after a confirmation.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import { InvitationsPanel } from './InvitationsPanel';
import type { AdminInvitation } from '../../services/adminConversationService';

const CH = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/room-1';
const row = (over: Partial<AdminInvitation> = {}): AdminInvitation => ({
  invitationId: 'inv-1', channelArn: CH, inviteeArn: 'x', inviteeName: 'Jordan', inviterArn: 'y', inviterName: 'Riley',
  mode: 'link', classification: 'standard', status: 'pending', createdAt: '2026-10-19T00:00:00.000Z', expiresAt: 2_000_000_000, emailed: true, ...over,
});

describe('the console invitations panel', () => {
  it('lists each invitation with its inviter, mode and status', async () => {
    const list = vi.fn(async () => [row(), row({ invitationId: 'inv-2', inviteeName: 'Sam', mode: 'sign-in', status: 'redeemed' })]);
    render(<InvitationsPanel channelArn={CH} canRevoke={false} deps={{ list }} />);
    expect(await screen.findAllByText('Jordan')).not.toHaveLength(0);
    expect(screen.getAllByText('Riley').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Link (guest)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Joined').length).toBeGreaterThanOrEqual(1);
    // No withdraw control for a session that cannot withdraw.
    expect(screen.queryByRole('button', { name: /Withdraw/ })).toBeNull();
  });

  it('withdraws one after a confirmation, and shows it withdrawn', async () => {
    const user = userEvent.setup();
    const revoke = vi.fn(async () => row({ status: 'revoked' }));
    const confirm = vi.fn(() => true);
    render(<InvitationsPanel channelArn={CH} canRevoke deps={{ list: vi.fn(async () => [row()]), revoke, confirm }} />);
    const [button] = await screen.findAllByRole('button', { name: 'Withdraw the invitation for Jordan' });
    await user.click(button);
    expect(confirm).toHaveBeenCalledWith('Withdraw the invitation for Jordan? They are removed from the conversation.');
    expect(revoke).toHaveBeenCalledWith(CH, 'inv-1');
    await waitFor(() => expect(screen.getAllByText('Withdrawn').length).toBeGreaterThanOrEqual(1));
  });

  it('says the list could not be loaded rather than showing an empty one', async () => {
    render(<InvitationsPanel channelArn={CH} canRevoke deps={{ list: vi.fn(async () => { throw new Error('403'); }) }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The invitations could not be loaded.');
  });
});
