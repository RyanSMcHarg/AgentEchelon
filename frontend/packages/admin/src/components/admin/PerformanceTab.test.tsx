import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';
import PerformanceTab, { weighted, foldIntents, flowParams, type PerfView } from './PerformanceTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';

/**
 * Performance, one view: the overview cards and the message flow, and nothing else
 * until somebody clicks. Every click opens the detail behind it, down to a single turn's record.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult => ({ data: rows as never, columns: [] });
const range = { start: '2026-10-01', end: '2026-10-26' };

const flow = (path: string, intent: string, outcome: string, turns: number, extra: Record<string, unknown> = {}) => ({
  path, intent, outcome, turns, avg_ttff_ms: path === 'lex' ? 2400 : 1100, ttff_n: turns, avg_e2e_ms: 7400, e2e_n: turns,
  avg_total_ms: 6000, total_n: turns, avg_model_ms: 4000, model_n: turns, avg_tool_ms: 900, tool_n: turns,
  avg_resolve_ms: path === 'lex' ? 1800 : 40, resolve_n: turns, poll_n: path === 'lex' ? turns : 0, ...extra,
});
const FLOW = [
  flow('flow', 'general', 'answered', 80), flow('lex', 'general', 'answered', 10),
  flow('flow', 'report_request', 'task', 40), flow('flow', 'image_generation', 'refused', 6),
];
const EFF = [
  { intent: 'general', avg_relevance: 82, relevance_scored_count: 60, exchange_count: 90, avg_confidence: 88 },
  { intent: 'report_request', avg_relevance: 70, relevance_scored_count: 30, exchange_count: 40, task_completion_rate: 54, task_flow_count: 40 },
];

const WELCOME = result([{ kind: 'greeting', welcomes: 12, measured: 10, avg_ms: 1800, p95_ms: 3100 }]);

function Harness({ initial = { view: 'overview' } as PerfView }) {
  const [view, setView] = useState<PerfView>(initial);
  return (
    <PerformanceTab
      flowData={result(FLOW)} welcomeData={WELCOME} effectivenessData={result(EFF)} dateRange={range} isLoading={false}
      filters={EMPTY_FILTERS} onFiltersChange={() => {}} filterRows={[]}
      view={view} onViewChange={setView}
      renderLatency={(openTtff) => <div>{openTtff ? 'LATENCY-AT-TTFF' : 'LATENCY-ALL'}</div>}
      renderEffectiveness={() => <div>EFFECTIVENESS-DRILL</div>}
      onOpenConversation={vi.fn()}
    />
  );
}

beforeEach(() => mockQuery.mockReset());

describe('the arithmetic', () => {
  it('weights averages by the count each was taken over, never averages averages', () => {
    expect(weighted([{ a: 1000, n: 9 }, { a: 2000, n: 1 }], 'a', 'n')).toEqual({ value: 1100, n: 10 });
    expect(weighted([], 'a', 'n').value).toBeNaN();
  });

  it('sends every filter of the shared bar, Path and Battles included, to each Performance query', () => {
    expect(flowParams({ ...EMPTY_FILTERS, assistant: 'analyst', entry: 'lex', duel: 'none', role: 'specialist' }))
      .toEqual({ agentType: 'analyst', assistantRole: 'specialist', turnEntry: 'lex', duelRound: 'none' });
  });

  it('folds the long tail of intents into one Other row', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((i, k) => ({ intent: i, path: 'flow', outcome: 'answered', turns: 100 - k }));
    const f = foldIntents(rows);
    expect(f.intents).toHaveLength(6);
    expect(f.folded).toEqual(['f', 'g']);
  });
});

describe('the overview', () => {
  it('shows the cards and the flow, and no detail until something is clicked', () => {
    render(<Harness />);
    expect(screen.getByText('Message flow')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^First update \(TTFF\) 1\.1 s/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Detail' })).toBeNull();
    expect(screen.queryByText('LATENCY-ALL')).toBeNull();
  });

  it('opens the first-update detail from the TTFF card, and the full latency from E2E', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^First update \(TTFF\)/ }));
    expect(screen.getByText('LATENCY-AT-TTFF')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^E2E/ }));
    expect(screen.getByText('LATENCY-ALL')).toBeInTheDocument();
  });

  it('opens an intent from its node: its flow figures, its turns, then its Effectiveness drill', async () => {
    mockQuery.mockResolvedValue(result([{ message_id: 'm-1', created_at: '2026-10-20T10:00:00Z', path: 'flow', intent: 'report_request', outcome: 'task', ttff_ms: 1200, e2e_ms: 14800, relevance_score: 70, cost_usd: 0.03 }]));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^report_request · 40/ }));
    expect(await screen.findByText('Quality detail for report_request')).toBeInTheDocument();
    expect(screen.getByText('EFFECTIVENESS-DRILL')).toBeInTheDocument();
    await waitFor(() => expect(mockQuery).toHaveBeenCalledWith('flow_turns', range, expect.objectContaining({ flowIntent: 'report_request' })));
  });

  it('opens a turn from a slice, and the turn record names the metric each step closes', async () => {
    mockQuery.mockImplementation(async (q) => (q === 'flow_turns'
      ? result([{ message_id: 'm-1', created_at: '2026-10-20T10:00:00Z', path: 'lex', intent: 'general', outcome: 'answered', ttff_ms: 2400, e2e_ms: 9000 }])
      : result([{
        message_id: 'm-1', created_at: '2026-10-20T10:00:00Z', path: 'lex', intent: 'general', outcome: 'answered', assistant: 'analyst',
        conversation_classification: 'standard', ttff_ms: 2400, e2e_ms: 9000, total_ms: 6200, guard_ms: 60, placeholder_resolve_ms: 1800,
        poll_ms: 1700, latency_ms: 4000, model_ms: 3500, tool_ms: 300, inbound_ms: 2400, channel_arn: 'arn:ch',
        router_steps: [{ step_name: 'classified', step_ms: 520 }, { step_name: 'dispatched', step_ms: 40 }],
        verdict: { relevance_score: 81, classification: 'good', is_grounded: null, is_compliant: true }, tool_verdicts: [],
      }])));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Amazon Lex/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open turn' }));
    expect(await screen.findByText('Classifier')).toBeInTheDocument();
    expect(screen.getByText('Router leg')).toBeInTheDocument();
    expect(screen.getByText('TTFF 2.4 s')).toBeInTheDocument();
    expect(screen.getByText('Scanned for 1.7 s')).toBeInTheDocument();
    expect(screen.getByText('Worker compute 6.2 s')).toBeInTheDocument();
    expect(screen.getByText('E2E 9.0 s')).toBeInTheDocument();
    expect(mockQuery).toHaveBeenCalledWith('flow_turn', range, expect.objectContaining({ messageId: 'm-1' }));
  });

  it('shows the Welcome lane in the first-update detail, timed from the join, with what it could not time', () => {
    render(<Harness initial={{ view: 'ttff' }} />);
    const lane = screen.getByRole('region', { name: 'Welcome' });
    expect(lane).toHaveTextContent('Greeting');
    expect(lane).toHaveTextContent('1.8 s');
    expect(lane).toHaveTextContent(/2 welcomes had no join/);
    expect(screen.getByText('LATENCY-AT-TTFF')).toBeInTheDocument();
  });

  it('brings the detail a click opens into view and gives it focus', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^First update \(TTFF\)/ }));
    const detail = screen.getByRole('region', { name: 'Detail' });
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(detail);
  });

  it('closes back to the overview', () => {
    render(<Harness initial={{ view: 'latency' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('LATENCY-ALL')).toBeNull();
  });
});
