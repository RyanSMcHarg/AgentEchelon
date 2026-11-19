import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ProcessesFields, ProcessList, processRefusals } from './ProcessesFields';
import type { ProfileDefinitionBody } from '../../services/profileService';
import { PARALLEL_ORDER, PARALLEL_WORKFLOWS } from './__tests__/processChainFixture';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { at?: string }) => (o?.at ? `${k}@${o.at}` : k) }) }));

const workflow = (states: string[]) => ({ on: 'conversation-opened', start: states[0], states: Object.fromEntries(states.map((s) => [s, { type: 'say' }])) });
const draft = (over: Partial<ProfileDefinitionBody> = {}): ProfileDefinitionBody => ({
  modelKey: 'default',
  eventWorkflows: { 'incident-triage': workflow(['triage']), 'ops-room': workflow(['lead-task', 'review']) } as unknown as ProfileDefinitionBody['eventWorkflows'],
  processes: { 'incident-response': { label: 'Incident response', workflows: ['incident-triage', 'ops-room'], metrics: [{ id: 'resolved-in-4h', label: 'Resolved within 4 hours', workflow: 'ops-room', within: 'PT4H', target: 0.8 }] } },
  ...over,
});

describe("a version's processes on the assistant's page (SPEC-PROCESSES P1)", () => {
  it('lists each process with its label, the workflows it links and its metrics', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="ops-premium" />);
    const entry = screen.getByTestId('process-entry-incident-response');
    expect(entry.textContent).toContain('Incident response');
    expect(entry.textContent).toContain('admin.processes.editor.links');
    expect(screen.getByTestId('process-metrics-incident-response').textContent).toContain('Resolved within 4 hours');
  });

  it('adds a process step by step: the workflow that starts it, its name, a phase added, a metric, written to the area\'s patch', () => {
    const onPatch = vi.fn();
    render(<ProcessesFields draft={draft({ processes: undefined })} onPatch={onPatch} canEdit profileName="ops-premium" />);
    expect(screen.getByTestId('processes-none')).toBeTruthy();
    fireEvent.click(screen.getByTestId('process-add'));
    // 1. WHAT STARTS IT: this version's event workflows, one chosen; Next waits for a choice.
    expect((screen.getByTestId('process-next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('process-start-incident-triage'));
    fireEvent.click(screen.getByTestId('process-next'));
    // 2. NAME AND OWNER.
    fireEvent.change(screen.getByTestId('process-name'), { target: { value: 'incident-response' } });
    fireEvent.change(screen.getByTestId('process-label'), { target: { value: 'Incident response' } });
    expect(screen.getByTestId('process-owner').textContent).toContain('admin.processes.wizard.owner');
    fireEvent.click(screen.getByTestId('process-next'));
    // 3. PHASES: the starting workflow is phase 1; a workflow no step opens is added by hand, and says nothing hands off to it.
    expect(screen.getByTestId('process-phase-incident-triage')).toBeTruthy();
    fireEvent.change(screen.getByTestId('process-phase-add'), { target: { value: 'ops-room' } });
    expect(screen.getByTestId('process-no-handoff-ops-room')).toBeTruthy();
    fireEvent.click(screen.getByTestId('process-next'));
    // 4. METRICS AND REVIEW.
    fireEvent.click(screen.getByTestId('process-metric-add'));
    fireEvent.change(screen.getByTestId('process-metric-0-id'), { target: { value: 'reviewed' } });
    fireEvent.change(screen.getByTestId('process-metric-0-label'), { target: { value: 'Reviewed within 2 days' } });
    fireEvent.change(screen.getByTestId('process-metric-0-workflow'), { target: { value: 'ops-room' } });
    fireEvent.change(screen.getByTestId('process-metric-0-step'), { target: { value: 'review' } });
    fireEvent.change(screen.getByTestId('process-metric-0-within'), { target: { value: 'P2D' } });
    fireEvent.change(screen.getByTestId('process-metric-0-target'), { target: { value: '0.8' } });
    expect(screen.getByTestId('process-review').textContent).toContain('incident-triage → ops-room');
    expect(screen.queryByTestId('process-refusals')).toBeNull();
    fireEvent.click(screen.getByTestId('process-done'));
    expect(onPatch).toHaveBeenLastCalledWith({ processes: { 'incident-response': {
      label: 'Incident response', workflows: ['incident-triage', 'ops-room'],
      metrics: [{ id: 'reviewed', label: 'Reviewed within 2 days', workflow: 'ops-room', step: 'review', within: 'P2D', target: 0.8 }],
    } } });
    expect(screen.getByTestId('process-entry-incident-response')).toBeTruthy();
  });

  it('edits a process under its fixed name, opening on its phases, and removes one, the last removal clearing the field', () => {
    const onPatch = vi.fn();
    render(<ProcessesFields draft={draft()} onPatch={onPatch} canEdit profileName="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-edit-incident-response'));
    expect(screen.getByTestId('process-phases')).toBeTruthy();
    fireEvent.click(screen.getByTestId('process-step-owner'));
    expect(screen.getByTestId('process-name-fixed').textContent).toBe('incident-response');
    fireEvent.change(screen.getByTestId('process-label'), { target: { value: 'Incidents' } });
    fireEvent.click(screen.getByTestId('process-step-review'));
    fireEvent.click(screen.getByTestId('process-metric-0-remove'));
    fireEvent.click(screen.getByTestId('process-done'));
    expect(onPatch).toHaveBeenLastCalledWith({ processes: { 'incident-response': { label: 'Incidents', workflows: ['incident-triage', 'ops-room'] } } });
    fireEvent.click(screen.getByTestId('process-remove-incident-response'));
    expect(onPatch).toHaveBeenLastCalledWith({ processes: null });
    expect(screen.getByTestId('processes-none')).toBeTruthy();
  });

  it('removing a phase takes its metrics with it; a refusal shows in its reason code\'s words on the review, and holds Done back', () => {
    const onPatch = vi.fn();
    render(<ProcessesFields draft={draft()} onPatch={onPatch} canEdit profileName="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-edit-incident-response'));
    fireEvent.click(screen.getByTestId('process-phase-remove-ops-room'));
    expect(screen.queryByTestId('process-phase-ops-room')).toBeNull();
    fireEvent.click(screen.getByTestId('process-step-owner'));
    fireEvent.change(screen.getByTestId('process-label'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('process-step-review'));
    expect(screen.queryByTestId('process-metric-0')).toBeNull();
    const refusals = screen.getByTestId('process-refusals');
    expect(refusals.getAttribute('role')).toBe('alert');
    expect(refusals.textContent).toContain('admin.processes.errors.PROCESS_LABEL@processes.incident-response.label');
    expect((screen.getByTestId('process-done') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('process-cancel'));
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('refuses a name already taken, and a name that is not lowercase letters, digits and hyphens', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-add'));
    fireEvent.click(screen.getByTestId('process-start-incident-triage'));
    fireEvent.click(screen.getByTestId('process-step-owner'));
    fireEvent.change(screen.getByTestId('process-name'), { target: { value: 'incident-response' } });
    fireEvent.click(screen.getByTestId('process-step-review'));
    expect(screen.getByTestId('process-refusals').textContent).toContain('admin.processes.editor.nameTaken');
    fireEvent.click(screen.getByTestId('process-step-owner'));
    fireEvent.change(screen.getByTestId('process-name'), { target: { value: 'Incident Response' } });
    fireEvent.click(screen.getByTestId('process-step-review'));
    expect(screen.getByTestId('process-refusals').textContent).toContain('admin.processes.errors.PROCESS_NAME');
  });

  it('says the refusals the last Validate gave for processes, in the same words', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="ops-premium"
      validationErrors={['processes.incident-response.workflows.gone: PROCESS_WORKFLOW_UNDECLARED', 'persona is too long']} />);
    const shown = screen.getByTestId('processes-server-refusals').textContent ?? '';
    expect(shown).toContain('admin.processes.errors.PROCESS_WORKFLOW_UNDECLARED@processes.incident-response.workflows.gone');
    expect(shown).not.toContain('persona');
    expect(processRefusals(['processes: PROCESSES_TOO_MANY'], (k) => k)).toEqual(['admin.processes.errors.PROCESSES_TOO_MANY']);
  });

  it('is read-only for a reader without edit rights, as Workflows is', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit={false} profileName="ops-premium" />);
    expect(screen.getByTestId('process-entry-incident-response')).toBeTruthy();
    expect(screen.queryByTestId('process-add')).toBeNull();
    expect(screen.queryByTestId('process-edit-incident-response')).toBeNull();
    expect(screen.queryByTestId('process-remove-incident-response')).toBeNull();
  });

  it('reads the active version\'s processes with no controls at all', () => {
    render(<ProcessList processes={draft().processes} name="Ops" />);
    expect(screen.getByTestId('processes-list').textContent).toContain('Incident response');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('moves keyboard focus onto the form when it opens, and back to Add process when it closes', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-add'));
    expect(document.activeElement?.id).toBe('process-form-title');
    fireEvent.click(screen.getByTestId('process-cancel'));
    expect(document.activeElement).toBe(screen.getByTestId('process-add'));
  });
});

describe('the workflows a process may start with, listed under what starts them', () => {
  it('groups the version\'s workflows by their event, says what starts each, and lists request-started ones under a request, linkable', () => {
    const d = draft({
      eventWorkflows: { 'incident-triage': { ...workflow(['triage']), on: 'event-received', types: ['ops-team'] }, 'ops-room': { ...workflow(['escalate']), types: ['ops'] } } as unknown as ProfileDefinitionBody['eventWorkflows'],
      intentWorkflows: { general_question: {} },
    } as unknown as Partial<ProfileDefinitionBody>);
    render(<ProcessesFields draft={d} onPatch={() => undefined} canEdit profileName="ops-premium" onOpenWorkflows={() => undefined} />);
    fireEvent.click(screen.getByTestId('process-add'));
    expect(within(screen.getByTestId('process-workflows-event-received')).getByRole('radio', { name: 'incident-triage' })).toBeTruthy();
    expect(within(screen.getByTestId('process-workflows-conversation-opened')).getByRole('radio', { name: 'ops-room' })).toBeTruthy();
    expect(screen.getByTestId('process-workflows-event-received').textContent).toContain('admin.eventWorkflows.starts');
    const request = screen.getByTestId('process-workflows-request');
    expect(request.textContent).toContain('admin.processes.editor.byRequestHelp');
    expect(request.textContent).toContain('admin.processes.wizard.startsByRequest');
    expect((within(request).getByRole('radio') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId('process-create-workflow')).toBeTruthy();
  });

  it('a request-started workflow starts a process, its labeled steps are its stages, and its open step hands off to the workflow the opened conversation runs', () => {
    const onPatch = vi.fn();
    const d = draft({
      processes: undefined,
      eventWorkflows: { 'ops-room': { on: 'conversation-opened', types: ['ops'], initial: 'lead', states: { lead: { label: 'Incident owner', task: { machine: 'acknowledge', by: { participantRole: 'lead' } }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } } } },
      intentWorkflows: { account_brief: { on: { intent: 'account_brief' }, initial: 'work', states: {
        work: { label: 'Brief written', task: { machine: 'account_brief', for: 'requester' }, onSuccess: 'escalate', onFailure: 'done' },
        escalate: { label: 'Escalated', open: { type: 'ops', for: { typeRole: 'lead' } }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      } } },
    } as unknown as Partial<ProfileDefinitionBody>);
    render(<ProcessesFields draft={d} onPatch={onPatch} canEdit profileName="advisor" />);
    fireEvent.click(screen.getByTestId('process-add'));
    fireEvent.click(screen.getByTestId('process-workflow-request-account_brief'));
    fireEvent.click(screen.getByTestId('process-next'));
    fireEvent.change(screen.getByTestId('process-name'), { target: { value: 'account-briefs' } });
    fireEvent.change(screen.getByTestId('process-label'), { target: { value: 'Account briefs' } });
    fireEvent.click(screen.getByTestId('process-next'));
    // THE REQUEST'S WORKFLOW IS PHASE 1, its stages its labeled steps; its open step proposed the incident room's workflow next.
    const first = screen.getByTestId('process-phase-account_brief');
    expect(first.textContent).toContain('Brief written');
    expect(first.textContent).toContain('admin.processes.wizard.startsByRequest');
    expect(screen.getByTestId('process-handoff-ops-room')).toBeTruthy();
    fireEvent.click(screen.getByTestId('process-next'));
    expect(screen.queryByTestId('process-refusals')).toBeNull();
    fireEvent.click(screen.getByTestId('process-done'));
    expect(onPatch).toHaveBeenLastCalledWith({ processes: { 'account-briefs': { label: 'Account briefs', workflows: ['account_brief', 'ops-room'] } } });
  });
});

describe('a process as a flow, from the list and in the wizard', () => {
  it('View flow on a listed process shows its flow, and the wizard\'s phases switch between list and flow', () => {
    render(<ProcessesFields draft={draft()} onPatch={() => undefined} canEdit profileName="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-flow-toggle-incident-response'));
    expect(screen.getByTestId('process-flow-view')).toBeTruthy();
    fireEvent.click(screen.getByTestId('process-flow-toggle-incident-response'));
    expect(screen.queryByTestId('process-flow-view')).toBeNull();
    fireEvent.click(screen.getByTestId('process-edit-incident-response'));
    fireEvent.click(screen.getByTestId('process-view-flow'));
    expect(screen.getByTestId('process-flow-view')).toBeTruthy();
    expect(screen.queryByTestId('process-phase-ops-room')).toBeNull();
    fireEvent.click(screen.getByTestId('process-view-list'));
    expect(screen.getByTestId('process-phase-ops-room')).toBeTruthy();
  });
});

describe('the wizard\'s phases in run order, parallel work side by side (a test fixture, not shipped)', () => {
  const parallel = (): ProfileDefinitionBody => ({
    modelKey: 'default',
    eventWorkflows: PARALLEL_WORKFLOWS as unknown as ProfileDefinitionBody['eventWorkflows'],
    processes: { parallel: { label: 'Parallel', workflows: [...PARALLEL_ORDER] } },
  });

  it('groups phases into groups: a fork starts several, an alongside phase is marked, and a join names what it waits for', () => {
    render(<ProcessesFields draft={parallel()} onPatch={() => undefined} canEdit profileName="ops-premium" />);
    fireEvent.click(screen.getByTestId('process-edit-parallel'));
    const first = screen.getByTestId('process-phase-group-1');
    expect(within(first).getByTestId('process-phase-kickoff')).toBeTruthy();
    const second = screen.getByTestId('process-phase-group-2');
    for (const wf of ['alpha-room', 'beta-room', 'gamma-room']) expect(within(second).getByTestId(`process-phase-${wf}`)).toBeTruthy();
    expect(second.textContent).toContain('admin.processes.wizard.group');
    // THE FORK: kickoff starts alpha and beta, which run in parallel.
    expect(within(second).getByTestId('process-fork-kickoff').textContent).toBe('admin.processes.wizard.fork');
    // ALONGSIDE: gamma runs beside alpha, which does not wait for it.
    expect(screen.getByTestId('process-alongside-gamma-room').textContent).toBe('admin.processes.wizard.runsAlongside');
    expect(screen.queryByTestId('process-alongside-beta-room')).toBeNull();
    // THE JOIN: its card on the phase that declares it.
    expect(within(screen.getByTestId('process-phase-kickoff')).getByTestId('process-join-kickoff-both').textContent).toBe('admin.processes.wizard.joinAll');
    // EACH OPENED PHASE'S HAND-OFF IS FROM THE PHASE THAT OPENED IT.
    expect(screen.getByTestId('process-handoff-beta-room')).toBeTruthy();
    expect(screen.getByTestId('process-handoff-gamma-room')).toBeTruthy();
  });
});
