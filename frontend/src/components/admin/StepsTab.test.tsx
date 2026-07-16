import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StepsTab from './StepsTab';
import type { AnalyticsResult, ExecutionStepRow } from '../../types/analytics';

const row: ExecutionStepRow = {
  message_id: 'msg-abcdef123456',
  timestamp: '2026-06-20T00:00:00.000Z',
  intent: 'report_generation',
  bedrock_model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  total_ms: 4200,
  step_count: 2,
  steps: [
    {
      stepLabel: 'tool:load_company_context',
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      startedAt: '2026-06-20T00:00:00.000Z',
      endedAt: '2026-06-20T00:00:01.000Z', // 1.0 s
      tokensIn: 1200,
      tokensOut: 80,
      estCostUsd: 0.0042,
    },
    {
      stepLabel: 'generate',
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      startedAt: '2026-06-20T00:00:01.000Z',
      endedAt: '2026-06-20T00:00:04.000Z', // 3.0 s
      tokensIn: 1300,
      tokensOut: 640,
      estCostUsd: null, // honesty contract → "—"
    },
  ],
};

const data = (rows: ExecutionStepRow[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] });

describe('StepsTab', () => {
  it('lists a row per message with intent, model, and step count', () => {
    render(<StepsTab data={data([row])} isLoading={false} />);
    expect(screen.getByText('report_generation')).toBeTruthy();
    expect(screen.getByText('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBeTruthy();
    // total time formatted (4200ms → 4.2 s)
    expect(screen.getByText('4.2 s')).toBeTruthy();
  });

  it('reveals the per-step breakdown on demand, with durations and honest-null cost', () => {
    render(<StepsTab data={data([row])} isLoading={false} />);
    // Steps are hidden until the row is expanded.
    expect(screen.queryByText('tool:load_company_context')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Steps' }));

    expect(screen.getByText('tool:load_company_context')).toBeTruthy();
    expect(screen.getByText('generate')).toBeTruthy();
    // per-step durations
    expect(screen.getByText('1.0 s')).toBeTruthy();
    expect(screen.getByText('3.0 s')).toBeTruthy();
    // tokens in/out (raw numbers, no separators)
    expect(screen.getByText('1200 / 80')).toBeTruthy();
    // cost: a real estimate renders, the null one renders "—"
    expect(screen.getByText('$0.0042')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows the loading state', () => {
    render(<StepsTab data={null} isLoading={true} />);
    expect(screen.getByText(/Loading execution steps/i)).toBeTruthy();
  });

  it('shows an Aurora-only empty message when there are no rows', () => {
    render(<StepsTab data={data([])} isLoading={false} />);
    expect(screen.getByText(/No per-step telemetry recorded/i)).toBeTruthy();
  });
});
