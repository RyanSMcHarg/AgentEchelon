import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@ae/shared/i18n';
import RetrievalSourcesPanel from './RetrievalSourcesPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/** Retrieval by source (SPEC-EVALUATION Appendix C7): how often a source was retrieved, and used. */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });
const range = { start: '2026-10-01', end: '2026-10-26' };

beforeEach(() => mockQuery.mockReset());

describe('the retrieval by source panel', () => {
  it('names each source by its title, with the share the answer used', async () => {
    mockQuery.mockResolvedValue(result([
      { assistant: 'analyst', conversation_classification: 'standard', source_id: 'doc-a', title: 'Travel policy', retrieved: 40, used: 10, turns: 22 },
    ]));
    render(<RetrievalSourcesPanel dateRange={range} />);
    expect(await screen.findByText('Travel policy')).toBeInTheDocument();
    expect(screen.getByText('10 of 40 (25%)')).toBeInTheDocument();
  });

  it('says when nothing was assessed', async () => {
    mockQuery.mockResolvedValue(result([]));
    render(<RetrievalSourcesPanel dateRange={range} />);
    expect(await screen.findByText('No turn in this window retrieved a passage the judge assessed.')).toBeInTheDocument();
  });
});
