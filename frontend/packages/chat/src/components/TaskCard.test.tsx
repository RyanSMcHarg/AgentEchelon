/**
 * The task card (ADR-063 decision 2): a person answers a task a workflow assigned them by pressing one of the choices its
 * step declares. The press is sent with the state the card was drawn in; a refusal the server named is said in the
 * client's own words and, where the task can no longer be answered, leaves no buttons behind (tenet D11).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import { TaskCard } from './TaskCard';
import { TaskCardError, taskCardFromMetadata } from '../services/taskCardService';

const NOW = 1_800_000_000_000;
const CH = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
const approval = { id: 'evt-1', state: 'deciding', choices: ['approved', 'declined'], expiresAt: NOW / 1000 + 3600 };

describe('the task card', () => {
  it('offers the step\'s choices and sends the one pressed, with the state it was drawn in', async () => {
    const user = userEvent.setup();
    const choose = vi.fn().mockResolvedValue({ state: 'approved' });
    render(<TaskCard card={approval} channelArn={CH} choose={choose} now={() => NOW} />);
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(choose).toHaveBeenCalledWith(CH, approval, 'approved');
    expect(await screen.findByRole('status')).toHaveTextContent('Done: Approve.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('says a refusal in its own words, and a settled task leaves no buttons', async () => {
    const user = userEvent.setup();
    const choose = vi.fn().mockRejectedValue(new TaskCardError('NOT_ASSIGNEE', 'no'));
    render(<TaskCard card={approval} channelArn={CH} choose={choose} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('This task is not yours to answer.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('a transient failure keeps the choices so the person can try again', async () => {
    const user = userEvent.setup();
    const choose = vi.fn().mockRejectedValue(new Error('network'));
    render(<TaskCard card={approval} channelArn={CH} choose={choose} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your answer could not be recorded. Try again.');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('an ended task offers nothing', () => {
    render(<TaskCard card={{ ...approval, expiresAt: NOW / 1000 - 1 }} channelArn={CH} now={() => NOW} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('This task has ended.');
  });

  it('lifts a card from Metadata and nothing malformed', () => {
    expect(taskCardFromMetadata({ task: approval })).toEqual(approval);
    expect(taskCardFromMetadata({ task: { id: 'x', state: 's', choices: [] } })).toBeUndefined();
    expect(taskCardFromMetadata({ task: 'nope' })).toBeUndefined();
    expect(taskCardFromMetadata({})).toBeUndefined();
  });
});
