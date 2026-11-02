import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import GoldenSetPanel from './GoldenSetPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics, writeAnalytics } from '../../services/analyticsService';

/**
 * Label from the answer, and keep the ones worth keeping (SPEC-EVALUATION FR14, FR16): the queue says why
 * an answer is first and opens the label with it, and the set can be promoted and retired.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn(), writeAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const mockWrite = vi.mocked(writeAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

beforeEach(() => { mockQuery.mockReset(); mockWrite.mockReset(); });

describe('the golden set panel', () => {
  it('labels from the answer itself, safety findings first', async () => {
    mockQuery.mockImplementation(async (q) => (q === 'label_queue'
      ? result([{ exchange_id: 'ex-1', why: 'safety', assistant: 'analyst', intent: 'general', user_message: 'the request', agent_response: 'the answer' }])
      : result([])));
    const onLabel = vi.fn();
    render(<GoldenSetPanel canWrite onLabel={onLabel} />);
    expect(await screen.findByText('Guardrail finding')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Label' }));
    expect(onLabel).toHaveBeenCalledWith(expect.objectContaining({ exchange_id: 'ex-1' }));
  });

  it('promotes a capability entry and retires an entry through the label capability', async () => {
    mockQuery.mockImplementation(async (q) => (q === 'golden_set'
      ? result([{ id: 'g-1', conversation_classification: 'standard', purpose: 'capability', assistant: 'analyst', request_text: 'q', reference_text: null }])
      : result([])));
    mockWrite.mockResolvedValue(undefined);
    render(<GoldenSetPanel canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Promote to regression' }));
    await waitFor(() => expect(mockWrite).toHaveBeenCalledWith('golden_set', { action: 'promote', entryId: 'g-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(mockWrite).toHaveBeenCalledWith('golden_set', { action: 'retire', entryId: 'g-1' }));
  });

  it('offers no write to a session without the label capability', async () => {
    mockQuery.mockImplementation(async (q) => (q === 'golden_set'
      ? result([{ id: 'g-1', conversation_classification: 'standard', purpose: 'regression', request_text: 'q' }])
      : result([])));
    render(<GoldenSetPanel canWrite={false} />);
    expect(await screen.findByText('Regression')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
  });
});
