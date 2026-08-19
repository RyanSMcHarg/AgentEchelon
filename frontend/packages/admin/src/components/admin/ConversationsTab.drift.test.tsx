import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConversationsTab from './ConversationsTab';
import type { AnalyticsResult } from '@ae/shared';
import * as svc from '../../services/adminConversationService';

vi.mock('../../services/adminConversationService', () => ({
  listAdminConversations: vi.fn(),
  listAdminConversationMessages: vi.fn(),
  listAdminConversationMembers: vi.fn(),
  getAdminMembershipHistory: vi.fn(),
  addAdminToConversation: vi.fn(),
  addAdminMember: vi.fn(),
  removeAdminMember: vi.fn(),
  redactAdminConversationMessage: vi.fn(),
  deleteAdminConversationMessage: vi.fn(),
}));

function driftResult(stats: Record<string, string | number | null>): AnalyticsResult {
  return { data: [], columns: [], stats };
}

async function openDriftView(driftData: AnalyticsResult) {
  render(<ConversationsTab summaryData={null} driftData={driftData} isLoading={false} />);
  await userEvent.click(screen.getByRole('button', { name: /drift detection/i }));
}

/**
 * The drift view's job is to say whether the FEATURE was right. These assert the two ways a
 * presentational bug would make a broken or unmeasured feature look healthy - both are the same
 * class of mistake as the old badge that coloured high drift volume as bad.
 */
describe('ConversationsTab — drift reports precision, not volume', () => {
  beforeEach(() => {
    vi.mocked(svc.listAdminConversations).mockResolvedValue({ conversations: [], total: 0 });
    vi.mocked(svc.listAdminConversationMembers).mockResolvedValue([]);
    vi.mocked(svc.getAdminMembershipHistory).mockResolvedValue([]);
    vi.mocked(svc.listAdminConversationMessages).mockResolvedValue([]);
  });

  it('renders the outcome rates from the recorded counts', async () => {
    await openDriftView(
      driftResult({ total_events: '10', accepted_count: '6', pending_count: '0' }),
    );

    await waitFor(() => expect(screen.getByText('Acceptance')).toBeTruthy());
    expect(screen.getByText('60%')).toBeTruthy(); // 6 accepted of 10 offered
  });

  it('shows "Not measured" for accuracy until something has been judged', async () => {
    // A 0% would read as "always wrong" and a 100% as "always right"; both are claims no
    // evaluation supports while the judged set is empty.
    await openDriftView(driftResult({ total_events: '10', accepted_count: '10' }));

    await waitFor(() => expect(screen.getByText('Accuracy')).toBeTruthy());
    expect(screen.getByText('Not measured')).toBeTruthy();
  });

  it('renders accuracy from judge verdicts once they exist', async () => {
    await openDriftView(
      driftResult({
        total_events: '10',
        accepted_count: '5',
        evaluated_count: '8',
        evaluated_correct_count: '6',
      }),
    );

    await waitFor(() => expect(screen.getByText('75%')).toBeTruthy()); // 6 of 8 judged
    expect(screen.getByText('50%')).toBeTruthy(); // 5 accepted of 10 offered
    expect(screen.queryByText('Not measured')).toBeNull();
  });

  it('does not blend acceptance into accuracy: correct calls can still be declined', async () => {
    await openDriftView(
      driftResult({
        total_events: '10',
        accepted_count: '1',
        evaluated_count: '10',
        evaluated_correct_count: '10',
      }),
    );

    // Detector right every time, users accepting one in ten. Both must be visible.
    await waitFor(() => expect(screen.getByText('100%')).toBeTruthy());
    expect(screen.getByText('10%')).toBeTruthy();
  });

  it('shows "No data" rather than 0% for an empty window', async () => {
    await openDriftView(driftResult({ total_events: '0' }));

    await waitFor(() => expect(screen.getByText('Acceptance')).toBeTruthy());
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('warns that acceptance is a floor while offers are unsettled', async () => {
    await openDriftView(
      driftResult({ total_events: '10', accepted_count: '4', pending_count: '6' }),
    );

    await waitFor(() => expect(screen.getByText('40%')).toBeTruthy());
    expect(screen.getByText(/6 offers not yet settled/i)).toBeTruthy();
    expect(screen.getByText(/floor that rises/i)).toBeTruthy();
  });
});
