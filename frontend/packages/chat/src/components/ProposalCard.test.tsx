/**
 * The confirmation card (ADR-061 decision 8, rule 8): a proposal is answered by the person it is addressed to, and
 * nothing happens until they do. A reminder asks for the invitee's address and sends it with the answer; a decline
 * sends nothing else; a refusal the server named is said in the client's own words and, where the proposal can no
 * longer be answered, leaves no buttons behind (tenet D11).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import { ProposalCard } from './ProposalCard';
import { ProposalError, proposalFromMetadata } from '../services/proposalService';

const NOW = 1_800_000_000_000;
const nudge = { id: 'handle-1', op: 'send_nudge', expiresAt: NOW / 1000 + 3600 };

describe('the confirmation card', () => {
  it('sends a reminder to the address entered, and says it was sent', async () => {
    const user = userEvent.setup();
    const decide = vi.fn().mockResolvedValue({ applied: true, op: 'send_nudge', sent: true });
    render(<ProposalCard proposal={nudge} decide={decide} now={() => NOW} />);
    await user.type(screen.getByLabelText('Their email address'), 'friend@example.com');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(decide).toHaveBeenCalledWith('handle-1', 'apply', 'friend@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('Reminder sent.');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('asks for the address before a reminder is confirmed, and calls nothing', async () => {
    const user = userEvent.setup();
    const decide = vi.fn();
    render(<ProposalCard proposal={nudge} decide={decide} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(decide).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Enter the email address to send the reminder to.');
    expect(screen.getByLabelText('Their email address')).toHaveAttribute('aria-invalid', 'true');
  });

  it('declines with no address, and says nothing was done', async () => {
    const user = userEvent.setup();
    const decide = vi.fn().mockResolvedValue({ declined: true, op: 'send_nudge' });
    render(<ProposalCard proposal={nudge} decide={decide} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(decide).toHaveBeenCalledWith('handle-1', 'decline', undefined);
    expect(await screen.findByRole('status')).toHaveTextContent('Declined. Nothing was done.');
  });

  it('says a proposal for someone else is theirs, in its own words, and offers no second answer', async () => {
    const user = userEvent.setup();
    const decide = vi.fn().mockRejectedValue(new ProposalError('NOT_ADDRESSEE', 'the proposal cannot be decided: not-addressee'));
    render(<ProposalCard proposal={nudge} decide={decide} now={() => NOW} />);
    await user.type(screen.getByLabelText('Their email address'), 'friend@example.com');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('status')).toHaveTextContent('This proposal is for someone else.');
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('shows an expired proposal as expired, with nothing to press', () => {
    render(<ProposalCard proposal={{ ...nudge, expiresAt: NOW / 1000 - 1 }} decide={vi.fn()} now={() => NOW} />);
    expect(screen.getByRole('status')).toHaveTextContent('This proposal has expired.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens the conversation an applied open_conversation proposal opened', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const decide = vi.fn().mockResolvedValue({ applied: true, op: 'open_conversation', channelArn: 'arn:aws:chime:us-east-1:1:app-instance/a/channel/conv-9' });
    render(<ProposalCard proposal={{ id: 'h', op: 'open_conversation', expiresAt: NOW / 1000 + 60 }} decide={decide} now={() => NOW} onOpenConversation={open} />);
    expect(screen.queryByLabelText('Their email address')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await user.click(await screen.findByRole('button', { name: 'Open it' }));
    expect(open).toHaveBeenCalledWith('conv-9');
  });

  it('is drawn from a message\'s Metadata by one function, and nothing malformed is a proposal', () => {
    expect(proposalFromMetadata({ proposal: { id: 'h', op: 'send_nudge', expiresAt: 5 } })).toEqual({ id: 'h', op: 'send_nudge', expiresAt: 5 });
    expect(proposalFromMetadata({ proposal: { id: 'h', op: 'send_nudge' } })).toBeUndefined();
    expect(proposalFromMetadata({ proposal: 'h' })).toBeUndefined();
    expect(proposalFromMetadata({})).toBeUndefined();
  });
});
