/**
 * Subjects no intent serves: the general and off-topic turns, ranked by the subjects they cluster around, so a
 * subject people keep asking about can become an intent.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UnservedSubjects from './UnservedSubjects';
import { queryAnalytics } from '../../services/analyticsService';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));

const RANGE = { startDate: '2026-10-01', endDate: '2026-10-15' } as never;

beforeEach(() => vi.mocked(queryAnalytics).mockReset());

describe('subjects no intent serves', () => {
  it('reads the unserved-subjects breakdown and shows each subject with how it was classified', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({
      data: [
        { subject: 'vendor contracts', intent: 'general', turns: '14', conversations: '6' },
        { subject: 'office parking', intent: 'off_topic', turns: '5', conversations: '4' },
      ],
    } as never);
    render(<UnservedSubjects dateRange={RANGE} />);
    await waitFor(() => expect(screen.getByText('vendor contracts')).toBeTruthy());
    expect(vi.mocked(queryAnalytics).mock.calls[0][0]).toBe('unserved_subjects');
    expect(screen.getByText('Off topic')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();
  });

  it('says so when the window has no unserved turns, rather than showing an empty table', async () => {
    vi.mocked(queryAnalytics).mockResolvedValue({ data: [] } as never);
    render(<UnservedSubjects dateRange={RANGE} />);
    await waitFor(() => expect(screen.getByText('No general or off-topic turns in this window.')).toBeTruthy());
  });
});
