import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@ae/shared/i18n';
import FrustrationPanel from './FrustrationPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * Had to work to be understood (SPEC-EVALUATION Appendix C6): people with a signal over the people
 * answered, the signals by kind, and the conversations behind the number, each openable.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });
const range = { start: '2026-10-01', end: '2026-10-26' };

beforeEach(() => mockQuery.mockReset());

describe('the frustration panel', () => {
  it('counts people, names the signals, and opens a conversation behind the number', async () => {
    mockQuery.mockResolvedValue(result([
      { dimension: 'summary', assistant: 'analyst', conversation_classification: 'standard', population: 40, with_signal: 3, asked_again: 2, declined_drift: 0, unanswered_handover: 0, stopped: 1, most_signals: 2 },
      { dimension: 'conversation', assistant: 'analyst', conversation_classification: 'standard', channel_arn: 'arn:ch/1', population: 2, with_signal: 1, asked_again: 1, declined_drift: 0, unanswered_handover: 0, stopped: 1, most_signals: 2 },
    ]));
    const onOpen = vi.fn();
    render(<FrustrationPanel dateRange={range} onOpenConversation={onOpen} />);
    expect(await screen.findByText('3 of 40 people')).toBeInTheDocument();
    expect(screen.getByText('2 asked again · 1 stopped work')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 people')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('arn:ch/1');
  });

  it('says when there is nothing in the window', async () => {
    mockQuery.mockResolvedValue(result([]));
    render(<FrustrationPanel dateRange={range} />);
    expect(await screen.findByText('No conversations in this window.')).toBeInTheDocument();
  });
});
