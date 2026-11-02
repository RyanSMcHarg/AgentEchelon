/**
 * THE VISUAL WORKFLOW BUILDER EDITS A VERSION'S EVENT WORKFLOWS ON A CANVAS (ADR-061 decision 7).
 *
 * What it proves: the workflow is drawn as its steps and edges from the event that starts it (B1); selecting a step
 * opens the list editor's own controls as its inspector, an edit there is the workflow the draft is patched with, and
 * the server's errors land on the step they name (B2); the palette adds a step after the selected one or where it is
 * dropped, a port reconnects an edge, and the inspector removes a step and its edges (B3); Preview run shows what the
 * server's walk said, or why it refused (B4); every move, connection and selection works from the keyboard and is
 * announced, and the palette's Condition and Wait for a deadline explain where they are set rather than adding a step
 * the runtime does not run (B5); a drag saves the step's point into the layout, a saved point is where the step is
 * drawn, and a removed step's point is dropped (B7); and the list view is the same edits.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { PLATFORM_EVENT_WORKFLOWS, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import type { WorkflowLayout } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import WorkflowBuilder from './WorkflowBuilder';
import * as svc from '../../services/profileService';
import type { ToolDescriptor } from '../../services/profileService';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  previewWorkflowRun: vi.fn(),
}));
const preview = vi.mocked(svc.previewWorkflowRun);

const TOOLS: ToolDescriptor[] = [{ name: 'read_deployment_health', category: 'context', changesState: false, description: 'reads', requires: '' }];
const TEMPLATES = [
  { name: 'workflow-opening', kind: 'message' as const, source: '', origin: 'shipped' as const },
  { name: 'ops-room-opening', kind: 'message' as const, source: '', origin: 'shipped' as const },
  { name: 'ops-first-look', kind: 'prompt' as const, source: '', origin: 'shipped' as const },
];
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const OPS: EventWorkflow = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']);

function Harness({ initial, layout: initialLayout, serverErrors, onChange, onLayout }: {
  initial: Record<string, EventWorkflow>; layout?: WorkflowLayout; serverErrors?: string[];
  onChange: (n: Record<string, EventWorkflow> | null) => void; onLayout: (l: WorkflowLayout | null) => void;
}) {
  const [workflows, setWorkflows] = useState(initial);
  const [layout, setLayout] = useState(initialLayout);
  return (
    <WorkflowBuilder workflows={workflows} templates={TEMPLATES} tools={TOOLS} profileName="ops-premium" serverErrors={serverErrors}
      layout={layout} onLayoutChange={(l) => { onLayout(l); setLayout(l ?? undefined); }}
      onChange={(n) => { onChange(n); setWorkflows(n ?? {}); }} />
  );
}

function renderBuilder(workflows: Record<string, EventWorkflow> = { ops: OPS }, extra: { layout?: WorkflowLayout; serverErrors?: string[] } = {}) {
  const onChange = vi.fn<(n: Record<string, EventWorkflow> | null) => void>();
  const onLayout = vi.fn<(l: WorkflowLayout | null) => void>();
  render(<Harness initial={workflows} onChange={onChange} onLayout={onLayout} {...extra} />);
  return { onChange, onLayout, last: () => onChange.mock.calls.at(-1)?.[0], lastLayout: () => onLayout.mock.calls.at(-1)?.[0] };
}

beforeEach(() => preview.mockClear());

describe('B1: the workflow is a flow of steps from its event', () => {
  it('draws the event, each step and each edge, the first step marked', () => {
    renderBuilder();
    expect(screen.getByTestId('wfb-trigger')).toHaveTextContent('Starts on conversation-opened');
    expect(screen.getByTestId('wfb-trigger')).toHaveTextContent('In ops conversations');
    for (const step of Object.keys(OPS.states)) expect(screen.getByTestId(`wfb-node-${step}`)).toBeTruthy();
    expect(screen.getByTestId('wfb-node-opening').getAttribute('aria-label')).toMatch(/The run starts here/);
    expect(screen.getByTestId('wfb-edge-opening-onSuccess-greet-lead')).toBeTruthy();
    expect(screen.getByTestId('wfb-edge-first-look-onFailure-done')).toBeTruthy();
    expect(screen.getByTestId('wfb-status')).toHaveTextContent("Meets the server's rules");
  });

  it('a welcome says it starts on WelcomeIntent', () => {
    renderBuilder({ greet: clone(PLATFORM_EVENT_WORKFLOWS.welcome) });
    expect(screen.getByTestId('wfb-trigger')).toHaveTextContent('Starts on WelcomeIntent');
  });
});

describe('B2: the inspector is the list editor\'s own controls, and the server\'s errors land on their step', () => {
  it('an edit in the inspector is the workflow the draft is patched with', () => {
    const { last } = renderBuilder();
    fireEvent.click(screen.getByTestId('wfb-node-greet-lead'));
    const inspector = screen.getByTestId('wfb-inspector');
    expect(within(inspector).getByTestId('wfb-step-kind')).toHaveValue('send');
    fireEvent.change(within(inspector).getByTestId('wfb-step-template'), { target: { value: 'workflow-opening' } });
    expect(last()!.ops.states['greet-lead'].send!.template).toBe('workflow-opening');
    expect(JSON.parse(JSON.stringify(last()))).toEqual(last());
  });

  it('an error naming a step is shown on it and in its inspector; one naming the workflow under its settings', () => {
    renderBuilder({ ops: OPS }, { serverErrors: ['eventWorkflows.ops.states.first-look.agent.prompt names "x", which is not a prompt template', 'eventWorkflows.ops names an unknown type'] });
    expect(screen.getByTestId('wfb-node-first-look-problems')).toHaveTextContent('1 problem');
    expect(screen.getByTestId('wfb-status')).toHaveTextContent("2 problems against the server's rules");
    expect(screen.getByTestId('wfb-workflow-errors')).toHaveTextContent('names an unknown type');
    fireEvent.click(screen.getByTestId('wfb-node-first-look'));
    expect(screen.getByTestId('wfb-step-errors')).toHaveTextContent('which is not a prompt template');
  });

  it('the rules are the server\'s function, run as the person edits', () => {
    renderBuilder();
    fireEvent.click(screen.getByTestId('wfb-node-first-look'));
    fireEvent.change(screen.getByTestId('wfb-step-deadline'), { target: { value: '600' } });
    expect(screen.getByTestId('wfb-step-errors')).toHaveTextContent(/deadlineMs is a whole number of milliseconds, at most 60000/);
  });
});

describe('B3: add, connect, remove', () => {
  it('a palette step goes after the selected step, on its path', () => {
    const { last } = renderBuilder();
    fireEvent.click(screen.getByTestId('wfb-node-opening'));
    fireEvent.click(screen.getByTestId('wfb-palette-intake'));
    const wf = last()!.ops;
    const added = wf.states.opening.onSuccess as string;
    expect(wf.states[added].action).toEqual({ tool: 'start_intake', to: { people: 'event:person' } });
    expect(wf.states[added].onSuccess).toBe('greet-lead');
    expect(screen.getByTestId('wfb-announce')).toHaveTextContent(`Added ${added}`);
  });

  it('the + under a selected step inserts a message after it', () => {
    const { last } = renderBuilder();
    fireEvent.click(screen.getByTestId('wfb-node-greet-lead'));
    fireEvent.click(screen.getByTestId('wfb-add-after-greet-lead'));
    const wf = last()!.ops;
    expect(wf.states[wf.states['greet-lead'].onSuccess as string].send).toBeTruthy();
  });

  it('a port reconnects an edge to the step chosen next, and Escape cancels', () => {
    const { last } = renderBuilder();
    fireEvent.click(screen.getByTestId('wfb-node-opening'));
    fireEvent.click(screen.getByTestId('wfb-port-opening-onFailure'));
    expect(screen.getByTestId('wfb-connecting')).toHaveTextContent('Choose the step opening goes to');
    fireEvent.click(screen.getByTestId('wfb-node-done'));
    expect(last()!.ops.states.opening.onFailure).toBe('done');
    expect(screen.getByTestId('wfb-announce')).toHaveTextContent('opening now goes to done');
    fireEvent.click(screen.getByTestId('wfb-node-opening'));
    fireEvent.click(screen.getByTestId('wfb-port-opening-onSuccess'));
    fireEvent.keyDown(screen.getByTestId('wfb-node-done'), { key: 'Escape' });
    expect(screen.queryByTestId('wfb-connecting')).toBeNull();
    expect(last()!.ops.states.opening.onSuccess).toBe('greet-lead');
  });

  it('removing a step removes its edges and its saved point (B7)', () => {
    const { last, lastLayout } = renderBuilder({ ops: OPS }, { layout: { ops: { opening: { x: 40, y: 120 }, 'greet-lead': { x: 40, y: 280 } } } });
    fireEvent.click(screen.getByTestId('wfb-node-greet-lead'));
    fireEvent.click(screen.getByTestId('wfb-remove-step'));
    const wf = last()!.ops;
    expect(wf.states['greet-lead']).toBeUndefined();
    expect(wf.states.opening.onSuccess).toBeUndefined();
    expect(lastLayout()).toEqual({ ops: { opening: { x: 40, y: 120 } } });
  });
});

describe('B4: Preview run', () => {
  it('sends the workflow as it stands with the sample values and endings, and shows what the walk said', async () => {
    preview.mockResolvedValue({
      steps: [{ step: 'opening', outcome: 'posted' }, { step: 'first-look', outcome: 'dispatched' }],
      acts: [{ step: 'opening', act: 'send', template: 'ops-room-opening', to: 'room' }, { step: 'first-look', act: 'agent', template: 'ops-first-look' }],
      ended: 'success',
    });
    renderBuilder();
    fireEvent.change(screen.getByTestId('wfb-ending-first-look'), { target: { value: 'failure' } });
    fireEvent.click(screen.getByTestId('wfb-preview'));
    await waitFor(() => expect(screen.getByTestId('wfb-preview-result')).toBeTruthy());
    expect(preview).toHaveBeenCalledWith('ops-premium', 'ops', OPS, { values: {}, outcomes: { 'first-look': 'failure' } });
    expect(screen.getByTestId('wfb-preview-result')).toHaveTextContent('says ops-room-opening to the room');
    expect(screen.getByTestId('wfb-preview-end')).toHaveTextContent('The run ends (success).');
    expect(screen.getByTestId('wfb-node-opening').className).toMatch(/admin-wfb-node-visited/);
  });

  it('a refusal is shown with the server\'s reasons', async () => {
    preview.mockImplementationOnce(() => {
      const refused = Promise.reject(Object.assign(new Error('422'), { body: { errors: ['eventWorkflows.ops.initial names a declared step'] } }));
      refused.catch(() => undefined);
      return refused;
    });
    renderBuilder();
    fireEvent.click(screen.getByTestId('wfb-preview'));
    await waitFor(() => expect(screen.getByTestId('wfb-preview-refused')).toHaveTextContent('initial names a declared step'));
  });
});

describe('B5: without a mouse, and nothing the runtime does not run', () => {
  it('Enter selects, the arrow keys move a step and save its point, and each is announced', () => {
    const { lastLayout } = renderBuilder();
    const node = screen.getByTestId('wfb-node-opening');
    const left = parseInt((node.parentElement as HTMLElement).style.left, 10);
    fireEvent.keyDown(node, { key: 'ArrowRight' });
    expect(lastLayout()!.ops.opening.x).toBe(left + 8);
    fireEvent.keyDown(node, { key: 'ArrowDown', shiftKey: true });
    expect(screen.getByTestId('wfb-announce')).toHaveTextContent(/opening moved to/);
    expect(node.getAttribute('aria-describedby')).toBe('wfb-keys');
    expect(document.getElementById('wfb-keys')).toHaveTextContent(/Arrow keys move it/);
    fireEvent.click(node);
    expect(node).toHaveAttribute('aria-pressed', 'true');
  });

  it('Condition and Wait for a deadline explain where they are set, and add no step', () => {
    const { onChange } = renderBuilder();
    expect(screen.getByTestId('wfb-palette-condition').tagName).not.toBe('BUTTON');
    fireEvent.click(screen.getByTestId('wfb-palette-deadline-help'));
    expect(screen.getByTestId('wfb-palette-deadline-help-panel')).toHaveTextContent(/No step waits on a timer/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers the welcome\'s own steps only on a welcome', () => {
    renderBuilder();
    expect(screen.queryByTestId('wfb-palette-opening')).toBeNull();
    expect(screen.getByTestId('wfb-palette-task')).toBeTruthy();
  });
});

describe('B7: where steps sit is saved', () => {
  it('a drag saves the step\'s point, snapped to the grid, and every step\'s point with it', () => {
    const { lastLayout, onChange } = renderBuilder();
    const node = screen.getByTestId('wfb-node-done');
    const from = { x: parseInt((node.parentElement as HTMLElement).style.left, 10), y: parseInt((node.parentElement as HTMLElement).style.top, 10) };
    fireEvent.pointerDown(node, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(node, { clientX: 203, clientY: 141, pointerId: 1 });
    fireEvent.pointerUp(node, { clientX: 203, clientY: 141, pointerId: 1 });
    fireEvent.click(node);
    const saved = lastLayout()!.ops;
    expect(saved.done).toEqual({ x: Math.round((from.x + 103) / 8) * 8, y: Math.round((from.y + 41) / 8) * 8 });
    expect(Object.keys(saved).sort()).toEqual(Object.keys(OPS.states).sort());
    expect(onChange).not.toHaveBeenCalled();
    expect(node).toHaveAttribute('aria-pressed', 'false');
  });

  it('a saved point is where the step is drawn', () => {
    renderBuilder({ ops: OPS }, { layout: { ops: { 'first-look': { x: 600, y: 480 } } } });
    const wrap = screen.getByTestId('wfb-node-first-look').parentElement as HTMLElement;
    expect([wrap.style.left, wrap.style.top]).toEqual(['600px', '480px']);
  });

  it('renaming a step carries its point', () => {
    const { lastLayout } = renderBuilder({ ops: OPS }, { layout: { ops: { 'first-look': { x: 600, y: 480 } } } });
    fireEvent.click(screen.getByTestId('wfb-node-first-look'));
    const name = screen.getByTestId('wfb-step-name');
    fireEvent.change(name, { target: { value: 'health' } });
    fireEvent.blur(name, { target: { value: 'health' } });
    expect(lastLayout()!.ops.health).toEqual({ x: 600, y: 480 });
    expect(lastLayout()!.ops['first-look']).toBeUndefined();
  });
});

describe('one source of editing', () => {
  it('the list view is the same edits on the same workflows', () => {
    const { last } = renderBuilder();
    fireEvent.click(screen.getByTestId('wfb-view-list'));
    fireEvent.click(screen.getByTestId('event-workflow-add-end'));
    expect(Object.values(last()!.ops.states).filter((d) => d.disposition)).toHaveLength(2);
    fireEvent.click(screen.getByTestId('wfb-view-canvas'));
    expect(screen.getByTestId('wfb-canvas')).toBeTruthy();
  });
});
