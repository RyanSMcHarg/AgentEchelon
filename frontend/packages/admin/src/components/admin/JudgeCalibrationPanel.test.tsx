import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@ae/shared/i18n';
import JudgeCalibrationPanel from './JudgeCalibrationPanel';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * How far each judge agrees with people (SPEC-EVALUATION Appendix C4): kappa and both error rates per
 * rubric and instance with the labels behind them, people's own agreement beside it, a judge that judged
 * its own answers called out, and battle picks read for the first time.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [], ...extra }) as AnalyticsResult;

beforeEach(() => mockQuery.mockReset());

describe('the judge calibration panel', () => {
  it('shows kappa, caught and passed per rubric and instance, with people\'s agreement beside it', async () => {
    mockQuery.mockImplementation(async (q) => (q === 'judge_calibration'
      ? result([
        { dimension: 'judge', rubric: 'compliance', assistant: 'analyst', conversation_classification: 'standard', evaluator_model: 'judge-m', version: '2', n: 50, kappa: 0.4, tpr: 0.667, tnr: 0.75 },
        { dimension: 'people', rubric: 'compliance', assistant: 'analyst', conversation_classification: 'standard', n: 12, kappa: 0.81 },
        { dimension: 'self', assistant: 'analyst', evaluator_model: 'answer-m', judged: 40, self_judged: 3 },
      ])
      : result([], { agreementRate: 72.5, comparedCount: 40 })));
    render(<JudgeCalibrationPanel />);
    expect(await screen.findByText('Compliance')).toBeInTheDocument();
    expect(screen.getByText('0.40')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('0.81 over 12')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('3 of 40 of analyst\'s answers were judged by answer-m');
    expect(screen.getByText(/preferred the answer people picked 72.5% of the time, over 40 picks/)).toBeInTheDocument();
  });

  it('says so when nothing has both a verdict and a label', async () => {
    mockQuery.mockResolvedValue(result([]));
    render(<JudgeCalibrationPanel />);
    expect(await screen.findByText('No answer has both a judge\'s verdict and a person\'s label yet.')).toBeInTheDocument();
  });
});
