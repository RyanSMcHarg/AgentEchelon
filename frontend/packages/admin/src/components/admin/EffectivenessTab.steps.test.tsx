import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import EffectivenessTab, { type Drill } from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';
import { linkSearch, stepFromUrl, withIntentParam } from './assistantLinks';

/**
 * AN INTENT, BY STEP AND BY MODEL (ADR-064 decision 4; SPEC-ADMIN-CONSOLE-EFFECTIVENESS FR38 to FR42).
 *
 * The L1 view of an intent reads `intent_steps` under the same filters as its row and shows each step its turns recorded
 * (a model call, a tool, a platform action, a correction) with its calls, time per call and summed cost, grouped under the
 * task step each turn started in when the intent has a workflow, and each model with its kind and cost; `?step=` (a
 * drill's `step`) narrows both, a task step narrows to itself, and Athena mode says the breakdown is not built there. The L3 timeline names each turn's model, the step it
 * started in and the rule that chose it.
 */
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [], ...extra } as AnalyticsResult);

const RANGE = { start: '2026-05-13', end: '2026-05-20' };
const L0 = result([{ intent: 'image_generation', exchange_count: 4, direct_count: 0, task_count: 1, avg_total_ms: 900, p95_total_ms: 1500 }]);
const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';
const CANVAS = 'amazon.nova-canvas-v1:0';
// A workflow intent: each turn step under the task step its turn started in, and one turn bound to no task.
const STEPS = [
  { dimension: 'model', group_key: CANVAS, turns: '1', calls: '1', avg_ms: '3500', cost_usd: '0.04', unpriced_steps: '0', model_kind: 'image', steps: ['generate'] },
  { dimension: 'step', group_key: `model:${HAIKU}`, task_step: 'gather', step_kind: 'model', step_key: HAIKU, turns: '2', calls: '3', avg_ms: '700', p95_ms: '900', cost_usd: '0.0021', unpriced_steps: '0', models: [HAIKU] },
  { dimension: 'step', group_key: 'platform:generate_image', task_step: 'generate', step_kind: 'platform', step_key: 'generate_image', turns: '1', calls: '1', avg_ms: '3500', p95_ms: '3500', cost_usd: '0.04', unpriced_steps: '0', models: [CANVAS] },
  { dimension: 'step', group_key: 'correction:correction-deliverable', task_step: 'generate', step_kind: 'correction', step_key: 'correction-deliverable', turns: '1', calls: '1', avg_ms: '500', p95_ms: '500', cost_usd: null, unpriced_steps: '1', models: [HAIKU] },
  { dimension: 'step', group_key: `model:${HAIKU}`, task_step: null, step_kind: 'model', step_key: HAIKU, turns: '1', calls: '1', avg_ms: '600', p95_ms: '600', cost_usd: '0.0005', unpriced_steps: '0', models: [HAIKU] },
  { dimension: 'task_step', group_key: 'gather', task_step: 'gather', turns: '2', avg_ms: '800', p95_ms: '900', cost_usd: '0.0021', unpriced_steps: '0', models: [HAIKU] },
  { dimension: 'task_step', group_key: 'generate', task_step: 'generate', turns: '1', avg_ms: '4000', p95_ms: '4000', cost_usd: '0.04', unpriced_steps: '1', models: [HAIKU] },
  { dimension: 'task_step', group_key: null, task_step: null, turns: '1', avg_ms: '600', p95_ms: '600', cost_usd: '0.0005', unpriced_steps: '0', models: [HAIKU] },
];
// A single-turn intent with no workflow: a tool a model called and the model call that answered.
const SINGLE_TURN = [
  { dimension: 'step', group_key: 'tool:load_company_context', task_step: null, step_kind: 'tool', step_key: 'load_company_context', turns: '3', calls: '3', avg_ms: '900', p95_ms: '1100', cost_usd: '0.0120', unpriced_steps: '0', models: [HAIKU] },
  { dimension: 'step', group_key: `model:${HAIKU}`, task_step: null, step_kind: 'model', step_key: HAIKU, turns: '3', calls: '3', avg_ms: '1500', p95_ms: '2000', cost_usd: '0.0180', unpriced_steps: '2', models: [HAIKU] },
  { dimension: 'task_step', group_key: null, task_step: null, turns: '3', avg_ms: '2800', p95_ms: '3500', cost_usd: '0.0300', unpriced_steps: '2', models: [HAIKU] },
  { dimension: 'model', group_key: HAIKU, turns: '3', calls: '6', avg_ms: '1200', cost_usd: '0.0300', unpriced_steps: '2', model_kind: 'text', steps: [] },
];
const rowsOf = (table: HTMLElement) => Array.from(table.querySelectorAll('tbody tr')) as HTMLElement[];
const cell = (row: HTMLElement, col: string) => row.querySelector(`td[data-col="${col}"]`)?.textContent ?? '';

function renderAt(drill: Drill, onDrillChange = vi.fn(), filters = EMPTY_FILTERS) {
  render(<EffectivenessTab data={L0} dateRange={RANGE} isLoading={false} filters={filters} onFiltersChange={() => {}} drill={drill} onDrillChange={onDrillChange} />);
  return onDrillChange;
}

describe('an intent by step and by model', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (type) => (type === 'intent_steps' ? result(STEPS) : result([])));
  });

  it('reads the breakdown under the row\'s filters and shows each step and each model with its summed cost', async () => {
    renderAt({ level: 1, intent: 'image_generation' }, vi.fn(), { ...EMPTY_FILTERS, assistant: 'advisor', version: '4' });
    await waitFor(() => expect(mockQuery).toHaveBeenCalledWith('intent_steps', RANGE, { intent: 'image_generation', agentType: 'advisor', profileVersion: '4' }));
    const steps = await screen.findByTestId('intent-steps-table');
    expect(within(steps).getByText('generate')).toBeTruthy();
    expect(steps.textContent).toContain('$0.0400');
    expect(screen.getByTestId('intent-steps-unpriced')).toHaveTextContent('1 step entries recorded no cost');
    const models = screen.getByTestId('intent-models-table');
    expect(models.textContent).toContain('Image');
    expect(models.textContent).toContain('generate');
  });

  it('a workflow intent groups its turn steps under the task step each turn started in, a turn with no task last and blank', async () => {
    renderAt({ level: 1, intent: 'image_generation' });
    const table = await screen.findByTestId('intent-steps-table');
    expect(table.querySelector('th')?.textContent).toBe('Task step');
    const rows = rowsOf(table);
    expect(rows.map((r) => cell(r, 'task_step'))).toEqual(['gather 2 turns, 800ms avg, $0.0021', 'generate 1 turn, 4.0s avg, $0.0400', '', '']);
    // The platform's action and its correction read in the reader's language, each with the model it ran on.
    expect(cell(rows[1], 'step_key')).toMatch(/^Platform Generated an image on .*Nova Canvas/);
    expect(cell(rows[2], 'step_key')).toMatch(/^Correction Corrected the deliverable on /);
    expect(cell(rows[3], 'step_key')).toMatch(/^Model /);
    // Each step's cost is its own, and the one that recorded none is not read as free.
    expect(rows.map((r) => cell(r, 'cost_usd'))).toEqual(['$0.0021', '$0.0400', '—', '$0.0005']);
    expect(rows.map((r) => cell(r, 'calls'))).toEqual(['3', '1', '1', '1']);
    expect(table.textContent).not.toContain('No step');
  });

  it('a task step whose turns recorded no steps is still read, with its turns, latency and cost', async () => {
    const CONFIRM = { dimension: 'task_step', group_key: 'confirm', task_step: 'confirm', turns: '3', avg_ms: '1200', p95_ms: '1500', cost_usd: null, unpriced_steps: '0', models: [] };
    mockQuery.mockImplementation(async (type) => (type === 'intent_steps' ? result([...STEPS, CONFIRM]) : result([])));
    renderAt({ level: 1, intent: 'image_generation' });
    const table = await screen.findByTestId('intent-steps-table');
    const empty = await within(table).findByTestId('intent-task-step-no-steps-confirm');
    expect(empty).toHaveTextContent('No recorded steps');
    expect(screen.getByTestId('intent-task-step-summary-confirm')).toHaveTextContent('3 turns, 1.2s avg, —');
    expect(screen.getByTestId('intent-step-open-confirm')).toBeTruthy();
    // It sits among the task steps, before the turns bound to no task.
    expect(rowsOf(table).map((r) => cell(r, 'task_step').split(' ')[0])).toEqual(['gather', 'generate', '', 'confirm', '']);
  });

  it('a single-turn intent shows its model and tool steps with no task-step column', async () => {
    mockQuery.mockImplementation(async (type) => (type === 'intent_steps' ? result(SINGLE_TURN) : result([])));
    renderAt({ level: 1, intent: 'image_generation' });
    const table = await screen.findByTestId('intent-steps-table');
    expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent?.trim())).toEqual(['Step', 'Turns', 'Calls', 'Avg per call', 'p95 per call', 'Cost']);
    const rows = rowsOf(table);
    expect(rows).toHaveLength(2);
    expect(within(screen.getByTestId('intent-turn-step-tool:load_company_context')).getByText('load_company_context').tagName).toBe('CODE');
    expect(cell(rows[0], 'step_key')).toMatch(/^Tool load_company_context on /);
    expect(cell(rows[0], 'p95_ms')).toBe('1.1s');
    expect(cell(rows[1], 'step_key')).toMatch(/^Model /);
    expect(cell(rows[1], 'cost_usd')).toBe('$0.0180');
    expect(screen.getByTestId('intent-steps-unpriced')).toHaveTextContent('2 step entries recorded no cost');
    expect(table.textContent).not.toContain('No step');
  });

  it('a step row narrows to itself, and ?step= narrows the read', async () => {
    const onDrill = renderAt({ level: 1, intent: 'image_generation' });
    fireEvent.click(await screen.findByTestId('intent-step-open-generate'));
    expect(onDrill).toHaveBeenCalledWith({ level: 1, intent: 'image_generation', step: 'generate' });
  });

  it('a drill on one step asks for that step and says so, with a way back to every step', async () => {
    const onDrill = renderAt({ level: 1, intent: 'image_generation', step: 'generate' });
    await waitFor(() => expect(mockQuery).toHaveBeenCalledWith('intent_steps', RANGE, { intent: 'image_generation', step: 'generate' }));
    expect(await screen.findByTestId('intent-step-filter')).toHaveTextContent('Narrowed to the generate step');
    fireEvent.click(screen.getByTestId('intent-step-filter-clear'));
    expect(onDrill).toHaveBeenCalledWith({ level: 1, intent: 'image_generation' });
  });

  it('says the breakdown is not built in Athena mode rather than showing nothing', async () => {
    mockQuery.mockImplementation(async (type) => (type === 'intent_steps' ? result([], { unsupported: true }) : result([])));
    renderAt({ level: 1, intent: 'image_generation' });
    expect(await screen.findByText(/not built for Athena mode/)).toBeTruthy();
  });

  it('the L3 timeline names each turn\'s model, the step it started in and what chose it', async () => {
    mockQuery.mockImplementation(async (type) => (type === 'task_timeline'
      ? result([{ exchange_id: 'x1', task_state: 'revise', task_step: 'generate', model_from: 'route', bedrock_model: 'amazon.nova-canvas-v1:0', steps: [] }])
      : result([])));
    renderAt({ level: 3, intent: 'image_generation', taskId: 't-1' });
    const model = await screen.findByTestId('timeline-turn-model');
    expect(model).toHaveTextContent('started in generate');
    expect(model).toHaveTextContent('chosen by route');
  });
});

describe('the step rides the URL beside the intent', () => {
  it('a step link carries both, and a step without an intent narrows nothing', () => {
    const search = linkSearch({ tab: 'effectiveness', assistant: 'advisor', intent: 'image_generation', step: 'generate' });
    expect(stepFromUrl(search)).toBe('generate');
    expect(stepFromUrl('?admin=effectiveness&step=generate')).toBeNull();
    expect(withIntentParam(null, '?intent=a&step=b')).toBe('');
    expect(withIntentParam('a', '?intent=a&step=b', 'c')).toBe('?intent=a&step=c');
  });
});
