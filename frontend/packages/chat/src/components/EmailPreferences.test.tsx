/**
 * The email section of Account settings (B9, M-7): optional emails each say their state and switch on or
 * off, the bulk action opts out of (or back in to) every optional email, required emails are listed apart
 * with no control, and a failure is said in the client's own words rather than shown as nothing opted out
 * (tenet D11).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import EmailPreferences from './EmailPreferences';
import { NoticePreferencesError, type NoticePreferencesView } from '../services/noticePreferencesService';

const KINDS: Array<[string, boolean]> = [
  ['conversation', false], ['conversation-shared', false], ['briefing', false], ['alarm', false],
  ['invitation', true], ['claim', true], ['reply-receipt', true],
];
const viewOf = (muted: string[] = [], allMuted = false): NoticePreferencesView => ({
  kinds: KINDS.map(([kind, transactional]) => ({ kind, transactional, muted: !transactional && (allMuted || muted.includes(kind)) })),
  allMuted,
});

describe('the email section of Account settings', () => {
  it('lists optional emails with their state and a switch, and required emails apart with none', async () => {
    render(<EmailPreferences deps={{ load: async () => viewOf(['briefing']) }} />);
    expect(await screen.findByRole('heading', { name: 'Optional emails' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Messages from conversations you are in' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Proactive briefings' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByText('Sending')).toHaveLength(3);
    expect(screen.getAllByText('Opted out')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Required emails' })).toBeInTheDocument();
    for (const label of ['Invitations to a conversation', 'Registration claims', 'Receipts for replies you send by email']) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: label })).toBeNull();
    }
    expect(screen.getAllByText('Always sent')).toHaveLength(3);
  });

  it('opts out of one kind, then back in', async () => {
    const user = userEvent.setup();
    const set = vi.fn()
      .mockResolvedValueOnce(viewOf(['conversation-shared']))
      .mockResolvedValueOnce(viewOf());
    render(<EmailPreferences deps={{ load: async () => viewOf(), set }} />);
    await user.click(await screen.findByRole('switch', { name: 'Someone adds you to a conversation' }));
    expect(set).toHaveBeenLastCalledWith('conversation-shared', true);
    expect(await screen.findByText('Your preferences are saved.')).toBeInTheDocument();
    const row = screen.getByRole('switch', { name: 'Someone adds you to a conversation' }).closest('li')!;
    expect(within(row).getByText('Opted out')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Someone adds you to a conversation' }));
    expect(set).toHaveBeenLastCalledWith('conversation-shared', false);
  });

  it('opts out of every optional email at once, and offers to opt back in', async () => {
    const user = userEvent.setup();
    const set = vi.fn().mockResolvedValue(viewOf([], true));
    render(<EmailPreferences deps={{ load: async () => viewOf(), set }} />);
    await user.click(await screen.findByRole('button', { name: 'Opt out of optional emails' }));
    expect(set).toHaveBeenCalledWith('*', true);
    expect(await screen.findByRole('button', { name: 'Opt back in to optional emails' })).toBeInTheDocument();
  });

  it('says a failed read in its own words, and shows no switch', async () => {
    const load = vi.fn(async () => { throw new NoticePreferencesError('UNREADABLE', 'server sentence'); });
    render(<EmailPreferences deps={{ load }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your preferences could not be read right now. Nothing has changed. Try again.');
    expect(screen.queryByText('server sentence')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
