/**
 * A WORKFLOW NAMED IN ANALYTICS LINKS TO ITS ASSISTANT'S WORKFLOW EDITOR (`WorkflowEditorLink`).
 *
 * What it proves, for each place analytics names a workflow:
 *   - Workflow editions: each edition's workflow links to the row's assistant's editor on that workflow, and each rework
 *     row's task machine to that machine; a row with no assistant takes the one the view is narrowed to;
 *   - Workflows (trajectory): each task type links to the row's assistant's editor on that machine;
 *   - Effectiveness, one intent: the intent links to its workflow in the editor of the assistant that served it, each task
 *     step of its step breakdown links to the intent's workflow at that step (the editor resolves the intent's machine), and
 *     each task of its task list links to the machine the task ran under, for the assistant whose turns worked it;
 *   - a team member's console links to its own assistant; a row whose assistant is unknown, or a person who cannot open the
 *     Assistants tab, reads the name as plain text; a plain click opens the editor through the console's navigation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { AnalyticsResult } from '@ae/shared';
import { queryAnalytics } from '../../services/analyticsService';
import { setTeamAssistant } from '../../services/teamScope';
import { CapabilityTestProvider } from '../../capabilities';
import WorkflowEditionsPanel from './WorkflowEditionsPanel';
import WorkflowTrajectoryPanel from './WorkflowTrajectoryPanel';
import IntentStepBreakdown from './IntentStepBreakdown';
import EffectivenessTab from './EffectivenessTab';
import { EMPTY_FILTERS } from './PerformanceFilters';
import { WorkflowEditorNavigation } from './WorkflowEditorLink';

vi.mock('../../services/analyticsService', () => ({ queryAnalytics: vi.fn() }));
const mockQuery = vi.mocked(queryAnalytics);
const result = (rows: Record<string, unknown>[]): AnalyticsResult =>
  ({ data: rows as unknown as Record<string, string | number>[], columns: [] } as AnalyticsResult);
const RANGE = { start: '2026-05-13', end: '2026-05-20' };

const EDITIONS = [
  { dimension: 'edition', assistant: 'ops-premium', workflow_name: 'ops-room', workflow_origin_hash: 'aaaaaaaa1111', runs: 5, ended: 4, succeeded: 3, success_share: 0.75, avg_ms: 800 },
  { dimension: 'edition', assistant: null, workflow_name: 'welcome', workflow_origin_hash: 'bbbbbbbb2222', runs: 2, ended: 0, succeeded: 0, success_share: null, avg_ms: 900 },
];
const REWORK = [{ task_type: 'report_generation', assistant: 'advisor', task_origin_machine_hash: 'cccccccc3333', tasks: 4, tasks_reopened: 1, reopens: 2, reopens_per_task: 0.5 }];
const TRAJECTORY = [{ assistant: 'advisor', conversation_classification: 'standard', task_type: 'expense_approval', tasks: 3, success: 2 }];

const hrefOf = (el: HTMLElement) => el.getAttribute('href');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (type) => result(
    type === 'workflow_editions' ? EDITIONS : type === 'task_rework' ? REWORK : type === 'workflow_trajectory' ? TRAJECTORY : [],
  ));
});
afterEach(() => setTeamAssistant(null));

describe('workflow editions and rework', () => {
  it('link each workflow and task machine to the row\'s assistant\'s editor', async () => {
    render(<WorkflowEditionsPanel dateRange={RANGE} />);
    const link = await screen.findByTestId('workflow-edition-link-ops-room-aaaaaaaa');
    expect(hrefOf(link)).toBe('?admin=profiles&assistant=ops-premium&workflow=ops-room');
    expect(hrefOf(await screen.findByTestId('task-rework-link-report_generation'))).toBe('?admin=profiles&assistant=advisor&task=report_generation');
    // A row naming no assistant, in a view narrowed to none, cannot say whose workflow it is.
    expect(screen.queryByTestId('workflow-edition-link-welcome-bbbbbbbb')).toBeNull();
    expect(within(screen.getByTestId('workflow-editions-table')).getByText('welcome')).toBeTruthy();
  });

  it('a row with no assistant takes the one the view is narrowed to', async () => {
    render(<WorkflowEditionsPanel dateRange={RANGE} assistant="concierge" />);
    expect(hrefOf(await screen.findByTestId('workflow-edition-link-welcome-bbbbbbbb'))).toBe('?admin=profiles&assistant=concierge&workflow=welcome');
  });

  it('a team member\'s console links to its own assistant', async () => {
    setTeamAssistant('ops-premium');
    render(<WorkflowEditionsPanel dateRange={RANGE} />);
    expect(hrefOf(await screen.findByTestId('workflow-edition-link-welcome-bbbbbbbb'))).toBe('?admin=profiles&assistant=ops-premium&workflow=welcome');
  });

  it('a person who cannot open the Assistants tab reads the names as text', async () => {
    render(<CapabilityTestProvider capabilities={['view-analytics']}><WorkflowEditionsPanel dateRange={RANGE} /></CapabilityTestProvider>);
    await screen.findByTestId('workflow-editions-table');
    expect(screen.queryByTestId('workflow-edition-link-ops-room-aaaaaaaa')).toBeNull();
    expect(screen.queryByTestId('task-rework-link-report_generation')).toBeNull();
  });

  it('a plain click opens the editor through the console\'s navigation', async () => {
    const open = vi.fn();
    render(<WorkflowEditorNavigation.Provider value={open}><WorkflowEditionsPanel dateRange={RANGE} /></WorkflowEditorNavigation.Provider>);
    fireEvent.click(await screen.findByTestId('task-rework-link-report_generation'));
    expect(open).toHaveBeenCalledWith({ assistant: 'advisor', task: 'report_generation' });
  });
});

describe('workflows (trajectory)', () => {
  it('links each task type to its assistant\'s editor on that machine', async () => {
    render(<WorkflowTrajectoryPanel dateRange={RANGE} />);
    expect(hrefOf(await screen.findByTestId('workflow-trajectory-link-expense_approval'))).toBe('?admin=profiles&assistant=advisor&task=expense_approval');
  });
});

describe('effectiveness, one intent', () => {
  const L0 = result([{ intent: 'report_generation', assistant: 'advisor', exchange_count: 4, direct_count: 0, task_count: 1 }]);
  it('links the intent to its workflow in the editor of the assistant that served it', async () => {
    render(<EffectivenessTab data={L0} dateRange={RANGE} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}}
      drill={{ level: 1, intent: 'report_generation' }} onDrillChange={() => {}} />);
    expect(hrefOf(await screen.findByTestId('effectiveness-intent-workflow-link'))).toBe('?admin=profiles&assistant=advisor&workflow=report_generation');
  });

  it('names no assistant where several definitions served the intent, unless the view is narrowed to one', async () => {
    const mixed = result([{ intent: 'report_generation', assistant: 'advisor', assistant_definition_count: 2, exchange_count: 4, direct_count: 0, task_count: 1 }]);
    const { unmount } = render(<EffectivenessTab data={mixed} dateRange={RANGE} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}}
      drill={{ level: 1, intent: 'report_generation' }} onDrillChange={() => {}} />);
    await screen.findAllByText(/report_generation/);
    expect(screen.queryByTestId('effectiveness-intent-workflow-link')).toBeNull();
    unmount();
    render(<EffectivenessTab data={mixed} dateRange={RANGE} isLoading={false} filters={{ ...EMPTY_FILTERS, assistant: 'concierge' }} onFiltersChange={() => {}}
      drill={{ level: 1, intent: 'report_generation' }} onDrillChange={() => {}} />);
    expect(hrefOf(await screen.findByTestId('effectiveness-intent-workflow-link'))).toBe('?admin=profiles&assistant=concierge&workflow=report_generation');
  });

  it('says nothing where no assistant is known', async () => {
    const pooled = result([{ intent: 'report_generation', exchange_count: 4, direct_count: 0, task_count: 1 }]);
    render(<EffectivenessTab data={pooled} dateRange={RANGE} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}}
      drill={{ level: 1, intent: 'report_generation' }} onDrillChange={() => {}} />);
    await screen.findAllByText(/report_generation/);
    expect(screen.queryByTestId('effectiveness-intent-workflow-link')).toBeNull();
    expect(screen.queryByText('Open the workflow for report_generation')).toBeNull();
  });
});

describe('effectiveness, one intent\'s steps and tasks', () => {
  const STEPS = [
    { dimension: 'step', group_key: 'model:haiku', task_step: 'gather', step_kind: 'model', step_key: 'haiku', turns: '2', calls: '3' },
    { dimension: 'task_step', group_key: 'gather', task_step: 'gather', turns: '2' },
    { dimension: 'step', group_key: 'model:haiku', task_step: null, step_kind: 'model', step_key: 'haiku', turns: '1', calls: '1' },
  ];

  it('links each task step to the intent\'s workflow at that step, for the assistant that served it', async () => {
    mockQuery.mockImplementation(async () => result(STEPS));
    render(<IntentStepBreakdown intent="report_generation" dateRange={RANGE} filters={EMPTY_FILTERS} assistant="advisor" onStep={() => {}} />);
    expect(hrefOf(await screen.findByTestId('intent-step-editor-gather')))
      .toBe('?admin=profiles&assistant=advisor&workflow=report_generation&step=gather');
  });

  it('links nothing where no assistant is known', async () => {
    mockQuery.mockImplementation(async () => result(STEPS));
    render(<IntentStepBreakdown intent="report_generation" dateRange={RANGE} filters={EMPTY_FILTERS} onStep={() => {}} />);
    await screen.findByTestId('intent-step-open-gather');
    expect(screen.queryByTestId('intent-step-editor-gather')).toBeNull();
  });

  it('takes the assistant the view is narrowed to', async () => {
    mockQuery.mockImplementation(async () => result(STEPS));
    render(<IntentStepBreakdown intent="report_generation" dateRange={RANGE} filters={{ ...EMPTY_FILTERS, assistant: 'concierge' }} onStep={() => {}} />);
    expect(hrefOf(await screen.findByTestId('intent-step-editor-gather')))
      .toBe('?admin=profiles&assistant=concierge&workflow=report_generation&step=gather');
  });

  it('a person who cannot open the Assistants tab gets no step link', async () => {
    mockQuery.mockImplementation(async () => result(STEPS));
    render(<CapabilityTestProvider capabilities={['view-analytics']}>
      <IntentStepBreakdown intent="report_generation" dateRange={RANGE} filters={EMPTY_FILTERS} assistant="advisor" onStep={() => {}} />
    </CapabilityTestProvider>);
    await screen.findByTestId('intent-step-open-gather');
    expect(screen.queryByTestId('intent-step-editor-gather')).toBeNull();
  });

  it('links each task to the machine it ran under, for the assistant whose turns worked it', async () => {
    const L0 = result([{ intent: 'report_generation', exchange_count: 4, direct_count: 0, task_count: 2 }]);
    mockQuery.mockImplementation(async (type) => result(type === 'task_details' ? [
      { task_id: 'task-1', type: 'report_generation', task_type: 'report_generation', assistant: 'advisor', status: 'completed', task_state: 'done' },
      { task_id: 'task-2', type: 'report_generation', task_type: null, assistant: null, status: 'completed', task_state: null },
    ] : []));
    render(<EffectivenessTab data={L0} dateRange={RANGE} isLoading={false} filters={EMPTY_FILTERS} onFiltersChange={() => {}}
      drill={{ level: 2, intent: 'report_generation', delivery: 'task' }} onDrillChange={() => {}} />);
    expect(hrefOf(await screen.findByTestId('effectiveness-task-workflow-link-task-1'))).toBe('?admin=profiles&assistant=advisor&task=report_generation');
    // A turn bound to no machine names none, so the row links nowhere.
    expect(screen.queryByTestId('effectiveness-task-workflow-link-task-2')).toBeNull();
  });
});
