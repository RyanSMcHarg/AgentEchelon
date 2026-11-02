/**
 * Inviting somebody new from the share dialog (M-10): the invitation is issued for this conversation with
 * the name, the address (when given) and the mode; the link is shown only when no email carried it; the
 * invitations issued here are listed with their status and can be withdrawn; and a refusal is the client's
 * own sentence for the server's code (tenet D11).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import InvitePanel from './InvitePanel';
import { InvitationRequestError, type InvitationView } from '../services/invitationService';

const CH = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/room-1';
const view = (over: Partial<InvitationView> = {}): InvitationView => ({
  invitationId: 'inv-1', channelArn: CH, inviteeArn: `${CH}/user/x`, inviteeName: 'Jordan', inviterArn: 'me', inviterName: 'Riley',
  mode: 'sign-in', classification: 'standard', status: 'pending', createdAt: '2026-10-19T00:00:00.000Z', expiresAt: 2_000_000_000, emailed: true, ...over,
});
const noList = () => vi.fn(async () => ({ invitations: [] as InvitationView[], moderator: false }));

describe('inviting somebody new', () => {
  it('issues the invitation with the name, the address and the mode, and says it was sent', async () => {
    const user = userEvent.setup();
    const issue = vi.fn(async () => ({ invitation: view(), emailed: true }));
    render(<InvitePanel channelArn={CH} deps={{ issue, list: noList() }} />);
    await user.type(screen.getByLabelText('Their name'), 'Jordan');
    await user.type(screen.getByLabelText('Their email (optional)'), 'jordan@example.org');
    await user.click(screen.getByLabelText('By the link alone, as a guest for 15 minutes'));
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('Invitation sent to Jordan.')).toBeInTheDocument();
    expect(issue).toHaveBeenCalledWith({ channelArn: CH, name: 'Jordan', email: 'jordan@example.org', mode: 'link' });
    expect(screen.queryByLabelText('Invitation link')).toBeNull();
  });

  it('shows the link only when no email carried it', async () => {
    const user = userEvent.setup();
    const issue = vi.fn(async () => ({ invitation: view({ emailed: false }), emailed: false, link: 'https://w.example/invite.html#t=abc' }));
    render(<InvitePanel channelArn={CH} deps={{ issue, list: noList() }} />);
    await user.type(screen.getByLabelText('Their name'), 'Jordan');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByLabelText('Invitation link')).toHaveValue('https://w.example/invite.html#t=abc');
    expect(issue).toHaveBeenCalledWith({ channelArn: CH, name: 'Jordan', mode: 'sign-in' });
  });

  it('lists the invitations issued here, and withdraws one', async () => {
    const user = userEvent.setup();
    const list = vi.fn()
      .mockResolvedValueOnce({ invitations: [view()], moderator: false })
      .mockResolvedValue({ invitations: [view({ status: 'revoked' })], moderator: false });
    const revoke = vi.fn(async () => view({ status: 'revoked' }));
    render(<InvitePanel channelArn={CH} deps={{ list, revoke }} />);
    await user.click(await screen.findByRole('button', { name: 'Withdraw the invitation for Jordan' }));
    expect(revoke).toHaveBeenCalledWith(CH, 'inv-1');
    await waitFor(() => expect(screen.getByText('withdrawn')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Withdraw the invitation for Jordan' })).toBeNull();
  });

  it.each([
    ['LINK_NOT_AVAILABLE', 'A link alone cannot open this conversation. Invite them to sign in instead.'],
    ['INVITATIONS_NOT_DECLARED', 'Nobody can be invited into a conversation of this kind.'],
    ['SOMETHING_NEW', 'The invitation could not be made. Try again.'],
  ])('says why in its own words for %s', async (code, text) => {
    const user = userEvent.setup();
    const issue = vi.fn(async () => { throw new InvitationRequestError(code, 403, 'server sentence'); });
    render(<InvitePanel channelArn={CH} deps={{ issue, list: noList() }} />);
    await user.type(screen.getByLabelText('Their name'), 'Jordan');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText('server sentence')).toBeNull();
  });
});
