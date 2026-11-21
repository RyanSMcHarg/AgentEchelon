/**
 * A PROCESS AS A FLOW (SPEC-PROCESSES P1), on an incident response that triages in the team conversation first (a fixture
 * built on the shipped one): its steps top to bottom, each phase a card with its
 * stages down it, each stage naming the party that answers it, a stage's detail on selection, and the hand-offs in order. Nothing
 * in it is a wide table that scrolls sideways.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ProcessFlow from './ProcessFlow';
import { PARALLEL_ORDER, PARALLEL_WORKFLOWS, TRIAGE_FIRST_WORKFLOWS } from './__tests__/processChainFixture';

const workflows = { ...TRIAGE_FIRST_WORKFLOWS } as unknown as Record<string, unknown>;
/** The phases' workflows in the order the view shows them, top to bottom. */
const phaseOrder = () => [...screen.getByTestId('process-flow-view').querySelectorAll('[data-testid^="process-flow-phase-"] > .admin-process-flow-phase-head > code')].map((c) => c.textContent);
const process = { label: 'Incident response', workflows: ['incident-triage', 'ops-room', 'customer-messaging'] };

describe('a process as a flow', () => {
  it('its phases top to bottom in order, and each stage names the party that answers it', () => {
    render(<ProcessFlow workflows={workflows} process={process} />);
    expect(phaseOrder()).toEqual(['incident-triage', 'ops-room', 'customer-messaging']);
    expect(screen.getByTestId('process-flow-view').querySelector('table')).toBeNull();
    // THE ON-CALL TRIAGES; THE ACCOUNT TEAM LEAD APPROVES THE FIRST NOTICE; THE PRIMARY ASSISTANT DRAFTS IT.
    const who = (id: string) => screen.getByTestId(id).getAttribute('data-who');
    expect(who('process-flow-stage-incident-triage-triage')).toBe('person:on call:ops');
    expect(who('process-flow-stage-customer-messaging-initial-approval')).toBe('person:lead:accounts');
    expect(who('process-flow-stage-customer-messaging-initial-draft')).toBe('assistant:primary');
    expect(who('process-flow-stage-ops-room-first-look')).toBe('assistant:ops');
    // THE PARTY IS SAID ON THE STAGE ITSELF.
    expect(screen.getByTestId('process-flow-stage-incident-triage-triage').textContent).toMatch(/on call/);
    // THE STAGES OF A PHASE ARE IN ITS OWN CARD.
    expect(within(screen.getByTestId('process-flow-phase-incident-triage')).getByTestId('process-flow-stage-incident-triage-triage')).toBeTruthy();
  });

  it('selecting a stage says what it is for, who answers it, its deadline and where it runs, and offers its workflow', () => {
    const open = vi.fn();
    render(<ProcessFlow workflows={workflows} process={process} onOpenWorkflows={open} />);
    expect(screen.queryByTestId('process-flow-detail')).toBeNull();
    fireEvent.click(screen.getByTestId('process-flow-stage-customer-messaging-initial-approval'));
    const detail = screen.getByTestId('process-flow-detail');
    expect(detail.textContent).toContain('Initial notice approval');
    expect(detail.textContent).toContain('customer-messaging');
    expect(detail.textContent).toMatch(/15/);
    fireEvent.click(screen.getByTestId('process-flow-edit'));
    expect(open).toHaveBeenCalled();
  });

  it('the hand-offs in order: the incident from triage, then customer messaging from the incident', () => {
    render(<ProcessFlow workflows={workflows} process={process} />);
    const items = within(screen.getByTestId('process-flow-handoffs')).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('incident-triage');
    expect(items[0]).toContain('ops-room');
    expect(items[1]).toContain('customer-messaging');
  });
});

describe('a process with parallel work as a flow (a test fixture, not shipped)', () => {
  const parallel = { label: 'Parallel', workflows: [...PARALLEL_ORDER] };

  it('parallel phases stand side by side under one header naming their phase numbers, and a join says what it waits for', () => {
    render(<ProcessFlow workflows={PARALLEL_WORKFLOWS} process={parallel} />);
    expect(screen.getByTestId('process-flow-group-1').getAttribute('data-phases')).toBe('1');
    expect(screen.getByTestId('process-flow-group-2').getAttribute('data-phases')).toBe('3');
    expect(within(screen.getByTestId('process-flow-group-2')).getByTestId('process-flow-phase-beta-room')).toBeTruthy();
    expect(screen.getByTestId('process-flow-group-2').textContent).toContain('Phases 2 to 4, in parallel');
    expect(phaseOrder()).toEqual(['kickoff', 'alpha-room', 'beta-room', 'gamma-room']);
    expect(within(screen.getByTestId('process-flow-phase-kickoff')).getByTestId('process-flow-join-kickoff-both').textContent).toBe('Everything is in waits for all of: alpha-room, beta-room, Notes');
    expect(screen.getByTestId('process-flow-alongside-gamma-room').textContent).toBe('Runs alongside alpha-room; alpha-room does not wait for it.');
    // SELECTING THE JOIN'S STAGE SAYS WHAT IT WAITS FOR.
    fireEvent.click(screen.getByTestId('process-flow-stage-kickoff-both'));
    expect(screen.getByTestId('process-flow-detail').textContent).toContain('waits for all of: alpha-room, beta-room, Notes');
  });

  it('the triage-first incident: customer messaging stands beside the incident, as phases 2 to 3', () => {
    render(<ProcessFlow workflows={workflows} process={process} />);
    expect(screen.getByTestId('process-flow-group-2').getAttribute('data-phases')).toBe('2');
    expect(screen.getByTestId('process-flow-group-2').textContent).toContain('Phases 2 to 3, in parallel');
    // NO PROCESS-LEVEL "STEP": step is the workflow's word.
    expect(screen.getByTestId('process-flow-view').textContent).not.toMatch(/\bStep \d/);
    expect(screen.getByTestId('process-flow-alongside-customer-messaging')).toBeTruthy();
  });
});
