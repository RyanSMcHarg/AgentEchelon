/**
 * WHAT A CONVERSATION KEEPS AT ITS TOP: its newest dashboard, the step it is on and who holds its roles, drawn
 * from the dashboard message every member already reads. A member cannot draw one by writing Metadata (`dashboardFromMetadata`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import type { Message } from '@ae/shared';
import { PinnedStatus, pinnedDashboardOf } from './PinnedStatus';
import { TaskCardError } from '../services/taskCardService';
import { dashboardFromMetadata } from '../services/dashboardService';

vi.mock('./DashboardCard', () => ({ DashboardCard: () => <div data-testid="dashboard-card" /> }));

const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/ops';
const PERSON = 'arn:aws:chime:us-east-1:1:app-instance/i/user/p1';
const CH = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
const meta = (over: Record<string, unknown> = {}) => ({ dashboard: { kind: 'snapshot', conversationId: 'c', updatedAt: '2026-11-19T19:00:00Z', state: 'ALARM', ...over } });
const msg = (id: string, dashboard?: Message['dashboard']): Message => ({ id, content: '', sender: { arn: BOT, name: 'Ops' }, timestamp: new Date(), isBot: true, ...(dashboard ? { dashboard } : {}) } as Message);

describe('the dashboard a message carries', () => {
  it('lifts the step the run is on and who holds its roles, clipped and as text', () => {
    const d = dashboardFromMetadata(meta({ now: { label: 'Mitigation decision', status: 'waiting', holder: 'Jordan Reyes' }, people: [{ role: 'on-call:ops', name: 'Jordan Reyes' }, { role: 'secondary:ops', name: 'Priya Raman' }] }), BOT);
    expect(d?.now).toEqual({ label: 'Mitigation decision', status: 'waiting', holder: 'Jordan Reyes' });
    expect(d?.people).toEqual([{ role: 'on-call:ops', name: 'Jordan Reyes' }, { role: 'secondary:ops', name: 'Priya Raman' }]);
  });

  it('DENY: a member writing the same Metadata draws nothing, and an unknown status is no step', () => {
    expect(dashboardFromMetadata(meta({ now: { label: 'x', status: 'waiting' } }), PERSON)).toBeUndefined();
    expect(dashboardFromMetadata(meta({ now: { label: 'x', status: 'whatever' } }), BOT)?.now).toBeUndefined();
  });
});

describe('the pinned status', () => {
  it('pins the newest dashboard: the alarm\'s state, and the on-call, secondary and lead; its open steps stay on the dashboard', () => {
    const older = msg('m1', { kind: 'snapshot', conversationId: 'c', updatedAt: '2026-11-19T18:00:00Z' });
    const newest = msg('m3', { kind: 'snapshot', conversationId: 'c', updatedAt: '2026-11-19T19:00:00Z', state: 'ALARM',
      now: { label: 'Mitigation decision', status: 'waiting', holder: 'Jordan Reyes' },
      people: [{ role: 'on-call:ops', name: 'Jordan Reyes' }, { role: 'secondary:ops', name: 'Priya Raman' }, { role: 'lead', name: 'Jordan Reyes' }] });
    const messages = [older, msg('m2'), newest, msg('m4')];
    expect(pinnedDashboardOf(messages)?.id).toBe('m3');
    render(<PinnedStatus messages={messages} channelArn={CH} />);
    expect(screen.getByTestId('pinned-alarm').textContent).toBe('Alarm: In alarm');
    expect(screen.queryByTestId('pinned-now')).toBeNull();
    expect(screen.getByTestId('pinned-people').textContent).toBe('On call: Jordan ReyesSecondary: Priya RamanLead: Jordan Reyes');
    expect(screen.getByTestId('dashboard-card')).toBeTruthy();
  });

  it('pins nothing in a conversation with no dashboard', () => {
    render(<PinnedStatus messages={[msg('m1')]} channelArn={CH} />);
    expect(screen.queryByTestId('pinned-status')).toBeNull();
  });
});

describe('where it stands, and deciding it from the top', () => {
  const decide = { taskId: 't1', state: 'open', choices: ['resolved'], by: ['jordan', 'priya'] };
  const at = (over: Record<string, unknown> = {}) => msg('m1', { kind: 'snapshot', conversationId: 'c', updatedAt: '2026-11-19T19:00:00Z', standing: 'open', decide, ...over } as Message['dashboard']);

  it('says its status to everyone', () => {
    render(<PinnedStatus messages={[at()]} channelArn={CH} />);
    expect(screen.getByTestId('pinned-standing').textContent).toBe('Status: Open');
  });

  it('offers its choices to a person who decides it, and sends one only once it is confirmed', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<PinnedStatus messages={[at()]} channelArn={CH} personId="priya" onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId('pinned-choice-resolved'));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByTestId('pinned-decide').textContent).toContain('Resolve? Everyone in this conversation is told.');
    fireEvent.click(screen.getByTestId('pinned-confirm'));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(decide, 'resolved'));
  });

  it('says a refused decision by its code in the reader\'s language, never the server\'s English', async () => {
    const onDecide = vi.fn()
      .mockRejectedValueOnce(new TaskCardError('SETTLED', 'server text in English'))
      .mockRejectedValueOnce(new TaskCardError('HTTP_502', 'Bad Gateway'))
      .mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<PinnedStatus messages={[at()]} channelArn={CH} personId="priya" onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId('pinned-choice-resolved'));
    fireEvent.click(screen.getByTestId('pinned-confirm'));
    expect((await screen.findByRole('alert')).textContent).toBe('This task is already finished.');
    fireEvent.click(screen.getByTestId('pinned-confirm'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Your answer could not be recorded. Try again.'));
    expect(onDecide).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('pinned-confirm'));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('alert').textContent).toBe('Your answer could not be recorded. Try again.');
    expect(screen.getByTestId('pinned-decide').textContent).not.toMatch(/server text|Bad Gateway|Failed to fetch/);
  });

  it('a resolved one offers its reopen, labelled Reopen, and cancelling sends nothing', () => {
    const onDecide = vi.fn();
    render(<PinnedStatus messages={[at({ standing: 'resolved', decide: { ...decide, state: 'resolved', choices: ['open'], reopen: true } })]} channelArn={CH} personId="jordan" onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId('pinned-choice-open'));
    expect(screen.getByTestId('pinned-confirm').textContent).toBe('Reopen');
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByTestId('pinned-choice-open')).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('DENY: offers nothing to a person who does not decide it, nor where the message names no decision', () => {
    render(<PinnedStatus messages={[at()]} channelArn={CH} personId="sam" onDecide={vi.fn()} />);
    expect(screen.queryByTestId('pinned-decide')).toBeNull();
    render(<PinnedStatus messages={[at({ decide: undefined })]} channelArn={CH} personId="priya" onDecide={vi.fn()} />);
    expect(screen.queryByTestId('pinned-decide')).toBeNull();
  });

  it('says an alarm that recovered leaves the incident open until it is resolved', () => {
    render(<PinnedStatus messages={[at({ state: 'OK' })]} channelArn={CH} />);
    expect(screen.getByTestId('pinned-alarm').textContent).toBe('Alarm: OK, recovered The incident stays open until its owner resolves it.');
  });

  it('reads a decision from the message, and drops a malformed one', () => {
    expect(dashboardFromMetadata(meta({ decide }), BOT)?.decide).toEqual(decide);
    expect(dashboardFromMetadata(meta({ decide: { taskId: 't1', state: 'open', choices: [], by: ['p'] } }), BOT)?.decide).toBeUndefined();
    expect(dashboardFromMetadata(meta({ decide: { taskId: 't1', state: 'open', choices: ['resolved'], by: 'p' } }), BOT)?.decide).toBeUndefined();
  });
});
