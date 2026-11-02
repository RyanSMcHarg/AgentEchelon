import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import CleanConversationView from './CleanConversationView';
import * as svc from '../../services/adminConversationService';

/**
 * THE DE-IDENTIFIED VIEW SHOWS THE FULL RECORD BY DEFAULT (SPEC-ADMIN-CONSOLE FR54, FR55).
 *
 * A removed message stays in place, described rather than shown, so the reply that answered it still has
 * its question; an edited message shows its first version; membership changes sit in the same timeline.
 * "Current state" narrows it to what is there now, and the view says how old the copy is.
 */
vi.mock('../../services/adminConversationService', () => ({ getCleanConversation: vi.fn() }));

const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
const ROWS: svc.CleanConversationRow[] = [
  { seq: 0, kind: 'membership', occurredAt: at(0), actor: 'Person 1', actorKind: 'person', action: 'joined', subject: 'hr', text: null, originalText: null, state: 'present' },
  { seq: 1, kind: 'message', occurredAt: at(1), actor: 'Person 1', actorKind: 'person', action: null, subject: null, text: null, originalText: null, state: 'redacted' },
  { seq: 2, kind: 'message', occurredAt: at(2), actor: 'hr', actorKind: 'assistant', action: null, subject: null, text: 'I cannot take card numbers.', originalText: null, state: 'present' },
  { seq: 3, kind: 'message', occurredAt: at(3), actor: 'Person 1', actorKind: 'person', action: null, subject: null, text: 'mail [an email address removed]', originalText: 'call [a phone number removed]', state: 'present' },
];

describe('the de-identified conversation view', () => {
  beforeEach(() => {
    vi.mocked(svc.getCleanConversation).mockResolvedValue({ rows: ROWS, derivedAt: at(30) });
  });

  it('shows the full record by default: removals marked in place, edits with their first version, membership inline', async () => {
    render(<CleanConversationView channelArn="arn:c" />);
    await waitFor(() => expect(screen.getByText('I cannot take card numbers.')).toBeTruthy());
    expect(screen.getByText('[Message redacted by an operator]')).toBeTruthy();
    expect(screen.getByText(/Edited\. First version: call \[a phone number removed\]/)).toBeTruthy();
    expect(screen.getByText(/hr joined \(added by Person 1\)/)).toBeTruthy();
    // How old the copy is, and where to go for anything urgent.
    expect(screen.getByText(/as of .*up to a day old.*read the record/)).toBeTruthy();
  });

  it('narrows to the current state on request', async () => {
    render(<CleanConversationView channelArn="arn:c" />);
    await waitFor(() => expect(screen.getByText('I cannot take card numbers.')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Current state'));
    expect(screen.queryByText('[Message redacted by an operator]')).toBeNull();
    expect(screen.queryByText(/First version/)).toBeNull();
    expect(screen.getByText('mail [an email address removed]')).toBeTruthy();
  });

  it('says a conversation has not been de-identified yet, rather than showing it as empty', async () => {
    vi.mocked(svc.getCleanConversation).mockResolvedValue({ rows: [], derivedAt: null });
    render(<CleanConversationView channelArn="arn:c" />);
    await waitFor(() => expect(screen.getByText(/has not been de-identified yet/)).toBeTruthy());
  });
});
