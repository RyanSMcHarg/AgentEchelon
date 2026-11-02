import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import SafetyReadingsPanel from './SafetyReadingsPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * Safety and refusals (SPEC-EVALUATION Appendix C5): each reading is a count over its population, and a
 * refusal is shown as the boundary working.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });
const range = { start: '2026-10-01', end: '2026-10-26' };

beforeEach(() => mockQuery.mockReset());

describe('the safety panel', () => {
  it('shows refusals, guardrail findings and rules, each over its own population', async () => {
    mockQuery.mockResolvedValue(result([
      { dimension: 'refusal', assistant: 'ops', conversation_classification: 'basic', key: 'image_generation', count: 4, population: 6, judged: 3, judged_appropriate: 3 },
      { dimension: 'guardrail', assistant: 'ops', conversation_classification: 'basic', key: 'guardrail.input.pii.EMAIL', count: 2, population: 120 },
      { dimension: 'rule', assistant: 'ops', conversation_classification: 'basic', key: 'no-pii-disclosure', count: 1, population: 90 },
    ]));
    render(<SafetyReadingsPanel dateRange={range} />);
    expect(await screen.findByText('image_generation')).toBeInTheDocument();
    expect(screen.getByText('4 of 6')).toBeInTheDocument();
    expect(screen.getByText('3 of 3 judged')).toBeInTheDocument();
    expect(screen.getByText('guardrail.input.pii.EMAIL')).toBeInTheDocument();
    expect(screen.getByText('2 of 120')).toBeInTheDocument();
    expect(screen.getByText('no-pii-disclosure')).toBeInTheDocument();
    expect(screen.getByText('1 of 90')).toBeInTheDocument();
  });

  it('asks for the scope it is given, and says when there is nothing to show', async () => {
    mockQuery.mockResolvedValue(result([]));
    render(<SafetyReadingsPanel dateRange={range} assistant="ops" classification="basic" />);
    await waitFor(() => expect(mockQuery).toHaveBeenCalledWith('safety_readings', range, { agentType: 'ops', conversationClassification: 'basic' }));
    expect(await screen.findByText('No refusals, guardrail findings or rule breaches in this window.')).toBeInTheDocument();
  });
});
