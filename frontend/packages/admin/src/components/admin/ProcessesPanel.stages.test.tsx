/**
 * THE PROCESS VIEW SHOWS THE PROCESS, NOT THE PLUMBING (SPEC-PROCESSES P9, UX section 5).
 *
 * What it proves, in the console's own English: the incident's stages come in run order, Triage first, each under its step's
 * label and tied to its workflow, with its median and 95th percentile time; no internal move (`open`, `hold`, the room's
 * opening) is shown; where each run spent its time is a grid of stages on a wide screen and a stacked list of stage cards at a
 * phone's width (390px); the drill for one process id says each stage's start, end and time, how it ended in words, and the
 * process's end to end. The stages' names and order come from the owner's active version, read where the process is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ProcessesPanel, { NARROW_QUERY } from './ProcessesPanel';
import { WorkflowEditorNavigation } from './WorkflowEditorLink';
import { PARALLEL_ORDER, PARALLEL_WORKFLOWS, TRIAGE_FIRST_WORKFLOWS } from './__tests__/processChainFixture';

const svc = vi.hoisted(() => ({ queryAnalytics: vi.fn(), listProfiles: vi.fn(), exportProfile: vi.fn() }));
vi.mock('../../services/analyticsService', () => ({ queryAnalytics: svc.queryAnalytics }));
vi.mock('../../services/profileService', () => ({ listProfiles: svc.listProfiles, exportProfile: svc.exportProfile }));

const M = 60_000;
const T0 = Date.parse('2026-11-16T09:00:00Z');
const ID = 'a1b2c3d4e5f6';
const at = (m: number) => T0 + m * M;
const team = {
  dimension: 'run', process: 'incident-response', process_id: ID, process_edition: 'ed1', workflow: 'incident-triage', owner_team: 'ops',
  disposition: 'success', started_at: at(0), ended_at: at(60), process_started_at: at(0),
  steps: [{ step: 'triage', outcome: 'task:success:acknowledged' }, { step: 'open', outcome: 'opened' }, { step: 'hold', outcome: 'task:success:resolved' }],
  step_times: [{ step: 'triage', at: at(0) }, { step: 'tell', at: at(5) }],
  step_costs: [{ step: 'triage', assistant: 'ops-premium', usd: null, unpriced: 0 }],
};
const room = {
  ...team, workflow: 'ops-room', started_at: at(5), ended_at: at(120),
  steps: [{ step: 'review', outcome: 'task:success:acknowledged' }],
  step_costs: [{ step: 'first-look', assistant: 'ops-assistant', usd: 0.02, unpriced: 0 }],
  step_times: [{ step: 'opening', at: at(5) }, { step: 'lead-task', at: at(6) }, { step: 'first-look', at: at(8) }, { step: 'resolved', at: at(60) }, { step: 'review', at: at(100) }],
};
const rows = [
  { dimension: 'process', process: 'incident-response', runs: 1, ended: 1, succeeded: 1, p50_ms: 120 * M, p95_ms: 120 * M },
  { dimension: 'workflow', process: 'incident-response', workflow: 'ops-room', owner_team: 'ops', runs: 1, ended: 1, succeeded: 1, p50_ms: M, p95_ms: M },
  team, room,
];

function atWidth(narrow: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (q: string) => ({ matches: narrow && q === NARROW_QUERY, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), onchange: null, addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  svc.queryAnalytics.mockResolvedValue({ data: rows });
  svc.listProfiles.mockResolvedValue([{ profileName: 'ops-premium', activeProcesses: { 'incident-response': { label: 'Incident response', edition: 'ed1' } } }]);
  svc.exportProfile.mockResolvedValue({ body: {
    eventWorkflows: { 'incident-triage': TRIAGE_FIRST_WORKFLOWS['incident-triage'], 'ops-room': TRIAGE_FIRST_WORKFLOWS['ops-room'] },
    processes: { 'incident-response': { label: 'Incident response', workflows: ['incident-triage', 'ops-room'] } },
  } });
  atWidth(false);
});
afterEach(() => { delete (window as { matchMedia?: unknown }).matchMedia; });

const flowNames = () => [...screen.getByTestId('process-stages').querySelectorAll('tbody tr')].map((tr) => tr.querySelector('.admin-process-stage-label')?.textContent);
/** The processes are listed first; one opens when it is chosen. */
const openProcess = async () => { fireEvent.click(await screen.findByTestId('process-pick-incident-response')); };
const shipped = (wf: string) => Object.values(TRIAGE_FIRST_WORKFLOWS[wf].states).filter((s) => (s as { label?: string }).label).map((s) => (s as { label: string }).label);

describe('the list comes first', () => {
  it('lists the process with its owner, opens nothing until it is chosen, and says where a process is created', async () => {
    render(<ProcessesPanel dateRange={undefined} onOpenAssistants={() => undefined} />);
    const list = await screen.findByTestId('processes-table');
    await waitFor(() => expect(list.textContent).toContain('ops-premium'));
    expect(list.textContent).toContain('Incident response');
    expect(screen.queryByTestId('process-detail')).toBeNull();
    expect(svc.exportProfile).not.toHaveBeenCalled();
    expect(screen.getByTestId('processes-owner-note').textContent).toContain('owned by the assistant that manages it');
    expect(screen.getByTestId('processes-open-assistants').textContent).toBe('Open Assistants');
    await openProcess();
    expect(await screen.findByTestId('process-detail')).toBeTruthy();
    expect(screen.queryByTestId('processes-table')).toBeNull();
    fireEvent.click(screen.getByTestId('process-back'));
    expect(screen.getByTestId('processes-table')).toBeTruthy();
  });
});

describe('the process\'s stages', () => {
  it('every stage it declares, Triage first, workflows in the process\'s order; how many runs reached each, and no internal move', async () => {
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    await waitFor(() => expect(flowNames()).toEqual([...shipped('incident-triage'), ...shipped('ops-room')]));
    expect(svc.exportProfile).toHaveBeenCalledWith('ops-premium');
    const triage = screen.getByTestId('process-stage-incident-triage-triage');
    expect(triage.textContent).toContain('Stage 1');
    expect(triage.textContent).toContain('1 of 1');
    // Its unlabeled steps after it (the open, the tell, the hold) are its own, so it runs to the team run's end.
    expect(triage.textContent).toContain('median 1h 0m, p95 1h 0m');
    // A STAGE NO RUN REACHED IS SHOWN, AND SAYS SO.
    expect(screen.getByTestId('process-stage-ops-room-runbook-cause').textContent).toContain('not reached');
    for (const [wf, internal] of [['incident-triage', 'open'], ['incident-triage', 'hold'], ['incident-triage', 'tell'], ['ops-room', 'opening']]) expect(screen.queryByTestId(`process-stage-${wf}-${internal}`)).toBeNull();
  });

  it('each stage says what it is for, who is answerable for it, how many runs reached it, its time and its cost, and its workflow', async () => {
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    const triage = await screen.findByTestId('process-stage-incident-triage-triage');
    expect(triage.textContent).toContain('The on-call confirms the scope and whether customers are impacted.');
    expect(triage.textContent).toContain('In workflow incident-triage');
    expect(triage.textContent).toContain('1 of 1');
    // A PERSON'S STAGE NAMES THEIR ROLE AND TEAM; AN ASSISTANT'S NAMES THE ASSISTANT THAT ANSWERED IT; NO INTERNAL NAME IS SHOWN.
    expect(screen.getByTestId('process-stage-who-incident-triage-triage').textContent).toBe('on call, ops team');
    expect(screen.getByTestId('process-stage-who-ops-room-first-look').textContent).toBe('ops-assistant (assistant)');
    expect(screen.getByTestId('process-stages').textContent).not.toMatch(/customer_impact|incident_first_look|participantRole/);
    expect(screen.getByTestId('process-stage-cost-ops-room-first-look').textContent).toBe('$0.02');
    expect(screen.getByTestId('process-stage-cost-incident-triage-triage').textContent).toBe('—');
    expect(screen.getByTestId('process-kpi-cost').textContent).toContain('$0.02');
    // TIME WAITING GOES TO WHO IS ANSWERABLE: the on-call's cards to the ops team, the ops assistant's work to the assistants.
    const parties = screen.getAllByTestId('process-party').map((li) => li.textContent);
    expect(parties.some((x) => x?.startsWith('ops team'))).toBe(true);
    expect(parties.some((x) => x?.startsWith('Assistants'))).toBe(true);
  });

  it('one run\'s flow: its time in each stage it reached, and the stages it did not reach', async () => {
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    fireEvent.click(await screen.findByTestId(`process-flow-pick-${ID}`));
    expect(screen.getByTestId('process-stage-incident-triage-triage').textContent).toContain('1h 0m');
    expect(screen.getByTestId('process-stage-reached-incident-triage-triage').textContent).toBe('done');
    expect(screen.getByTestId('process-stage-ops-room-runbook-cause').textContent).toContain('not reached');
  });

  it('a wide screen shows where each run spent its time as a grid of stages, one hue, darker where longer', async () => {
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    const grid = await screen.findByTestId('process-spent');
    await waitFor(() => expect(grid.querySelectorAll('thead th')).toHaveLength(1 + shipped('incident-triage').length + shipped('ops-room').length));
    expect(grid.tagName).toBe('DIV');
    const row = screen.getByTestId(`process-spent-${ID}`);
    // UNDER 10m THE LIGHTEST STEP, 30m TO 1h THE THIRD, in the stages' order; a stage the run did not reach is blank.
    const shades = [...row.querySelectorAll('.admin-process-cell')].filter((c) => c.textContent !== '—').map((c) => [c.textContent, c.className.replace('admin-process-cell admin-process-cell-', '')]);
    expect(shades).toEqual([['1h 0m', '4'], ['2m', '1'], ['52m', '3'], ['40m', '3'], ['20m', '2']]);
  });

  it('at a phone\'s width (390px), each run is a stacked list of its stages with their times, not a grid', async () => {
    atWidth(true);
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    const list = await screen.findByTestId('process-spent');
    expect(list.tagName).toBe('UL');
    await waitFor(() => expect(within(screen.getByTestId(`process-spent-${ID}`)).getAllByRole('listitem').map((li) => li.textContent))
      .toEqual(['Triage1h 0m', 'Incident owner2m', 'First look52m', 'Resolve40m', 'Post-incident review20m']));
  });
});

describe('the drill for one process id', () => {
  it('each stage\'s start, end and time, how it ended in words, and the process end to end', async () => {
    svc.queryAnalytics.mockImplementation(async (_q: string, _r: unknown, extra: Record<string, string>) => ({ data: extra.processId ? [rows[0], team, room] : rows }));
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    await waitFor(() => expect(flowNames().length).toBeGreaterThan(5));
    fireEvent.click(screen.getAllByRole('button', { name: `Open process ${ID.slice(0, 6)}` })[0]);
    const drill = await screen.findByTestId('process-drill-runs');
    expect(svc.queryAnalytics).toHaveBeenLastCalledWith('process_runs', undefined, { processId: ID });
    expect(screen.getByTestId('process-drill-summary').textContent).toBe('End to end 2h 0m, from 2026-11-16 09:00 to 2026-11-16 11:00. Ended: 1. Succeeded: 1.');
    // THE TEAM'S RUN FIRST, as the process declares its workflows.
    const runs = [...drill.querySelectorAll('[data-testid^="process-drill-run-"]')].map((el) => el.getAttribute('data-testid'));
    expect(runs).toEqual(['process-drill-run-incident-triage', 'process-drill-run-ops-room']);
    const triage = screen.getByTestId('process-drill-stage-triage').textContent;
    expect(triage).toContain('Triage');
    expect(triage).toContain('2026-11-16 09:00 to 2026-11-16 10:00');
    expect(triage).toContain('1h 0m');
    expect(triage).toContain('Done (acknowledged)');
    expect(drill.textContent).not.toContain('task:success');
    expect(screen.queryByTestId('process-drill-stage-open')).toBeNull();
    expect(screen.queryByTestId('process-drill-stage-hold')).toBeNull();
    expect(screen.getByTestId('process-drill-stage-review').textContent).toContain('20m');
  });
});

describe('each run is read against the version it ran on', () => {
  const ID2 = 'f6e5d4c3b2a1';
  const later = 24 * 60 * M;
  const v = (r: Record<string, unknown>, cfg: string, id = ID, shift = 0) => ({
    ...r, origin_config_id: cfg, process_id: id,
    started_at: (r.started_at as number) + shift, ended_at: (r.ended_at as number) + shift, process_started_at: (r.process_started_at as number) + shift,
    step_times: (r.step_times as Array<{ step: string; at: number }>).map((s) => ({ ...s, at: s.at + shift })),
  });
  const wfs = { 'incident-triage': TRIAGE_FIRST_WORKFLOWS['incident-triage'], 'ops-room': TRIAGE_FIRST_WORKFLOWS['ops-room'] };
  const twoVersions = () => {
    // v2 RAN THE SECOND INCIDENT, whose first look took 30m rather than 52m.
    const room2 = { ...room, step_times: [{ step: 'opening', at: at(5) }, { step: 'lead-task', at: at(6) }, { step: 'first-look', at: at(8) }, { step: 'resolved', at: at(38) }, { step: 'review', at: at(100) }] };
    svc.queryAnalytics.mockResolvedValue({ data: [rows[0], v(team, 'cfgA'), v(room, 'cfgA'), v(team, 'cfgB', ID2, later), v(room2, 'cfgB', ID2, later)] });
    svc.listProfiles.mockResolvedValue([{ profileName: 'ops-premium', activeProcesses: {}, versions: [{ version: 1, configId: 'cfgA' }, { version: 2, configId: 'cfgB' }] }]);
    // NEITHER VERSION DECLARES THE PROCESS NOW (rolled back, or edited since): its runs still name their stages and who answers them.
    svc.exportProfile.mockResolvedValue({ body: { eventWorkflows: wfs } });
  };

  it('a process the active version no longer declares still shows its stages, who answers them, and the time waiting on each', async () => {
    twoVersions();
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    await waitFor(() => expect(screen.getAllByTestId('process-party').length).toBeGreaterThan(0));
    expect(svc.exportProfile).toHaveBeenCalledWith('ops-premium', 1);
    expect(svc.exportProfile).toHaveBeenCalledWith('ops-premium', 2);
    expect(screen.getByTestId('process-stage-who-incident-triage-triage').textContent).toBe('on call, ops team');
  });

  it('versions compared side by side, newest first, stage by stage; choosing one reads only its processes', async () => {
    twoVersions();
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    const table = await screen.findByTestId('process-versions');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Measure', 'v2', 'v1']);
    await waitFor(() => expect(screen.getByTestId('process-versions-ops-room-first-look').textContent).toBe('First look30m52m'));
    expect(screen.getByTestId('process-kpi-started').textContent).toContain('2');
    fireEvent.click(screen.getByTestId('process-version-pick-cfgB'));
    expect(screen.getByTestId('process-kpi-started').textContent).toContain('1');
  });
});

describe('a join says which part it waited on last (a test fixture, not shipped)', () => {
  const kickoff = {
    dimension: 'run', process: 'incident-response', process_id: ID, process_edition: 'ed1', workflow: 'kickoff', owner_team: 'ops',
    disposition: 'success', started_at: at(0), ended_at: at(90), process_started_at: at(0),
    steps: [{ step: 'notes', outcome: 'opened' }, { step: 'both', outcome: 'waiting' }, { step: 'both', outcome: 'joined:success:open-beta:open-alpha=success,open-beta=success,notes=success' }],
    step_times: [{ step: 'notes', at: at(0) }],
  };
  beforeEach(() => {
    svc.queryAnalytics.mockImplementation(async () => ({ data: [rows[0], kickoff] }));
    svc.exportProfile.mockResolvedValue({ body: {
      eventWorkflows: PARALLEL_WORKFLOWS,
      processes: { 'incident-response': { label: 'Incident response', workflows: [...PARALLEL_ORDER] } },
    } });
  });

  it('the picked run\'s join stage says what it waited for, and so does the drill', async () => {
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    fireEvent.click(await screen.findByTestId(`process-flow-pick-${ID}`));
    await waitFor(() => expect(screen.getByTestId('process-stage-reached-kickoff-both').textContent).toBe('waited for the beta conversation'));
    fireEvent.click(screen.getAllByRole('button', { name: `Open process ${ID.slice(0, 6)}` })[0]);
    const join = await screen.findByTestId('process-drill-join-both');
    expect(join.textContent).toBe('Everything is in waited for the beta conversation · Succeeded');
  });
});

describe('what the panel reads', () => {
  it('exports each owner\'s version once, however many of its processes are opened', async () => {
    svc.listProfiles.mockResolvedValue([{ profileName: 'ops-premium', activeProcesses: {
      'incident-response': { label: 'Incident response', edition: 'ed1' },
      'change-review': { label: 'Change review', edition: 'ed1' },
    } }]);
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    await waitFor(() => expect(svc.exportProfile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('process-back'));
    fireEvent.click(await screen.findByTestId('process-pick-change-review'));
    await screen.findByTestId('process-detail');
    fireEvent.click(screen.getByTestId('process-back'));
    await openProcess();
    await screen.findByTestId('process-detail');
    expect(svc.exportProfile).toHaveBeenCalledTimes(1);
    expect(svc.exportProfile).toHaveBeenCalledWith('ops-premium');
  });

  it('says the list is cut when the window held more runs than one read returns', async () => {
    render(<ProcessesPanel dateRange={undefined} />);
    await screen.findByTestId('processes-table');
    expect(screen.queryByTestId('processes-truncated')).toBeNull();
    cleanup();
    svc.queryAnalytics.mockResolvedValue({ data: rows, truncated: true });
    render(<ProcessesPanel dateRange={undefined} />);
    expect((await screen.findByTestId('processes-truncated')).textContent).toBe('This window holds more runs than one read returns, so the stages and runs below cover only its newest processes. Choose a shorter window.');
  });
});

describe('from a process down to its workflows and conversations', () => {
  const TEAM_ROOM = 'arn:aws:chime:us-east-1:1:app-instance/x/channel/team-ops';
  const INCIDENT_ROOM = 'arn:aws:chime:us-east-1:1:app-instance/x/channel/conv-ops-1';
  const withRooms = () => svc.queryAnalytics.mockResolvedValue({ data: [
    rows[0], rows[1],
    { ...team, channel_arn: TEAM_ROOM, assistant: 'ops-premium' },
    { ...room, channel_arn: INCIDENT_ROOM, assistant: 'ops-assistant' },
  ] });

  it('one run\'s pick lists each of its runs with its workflow, opened in its own assistant\'s editor, and its conversation', async () => {
    withRooms();
    const onOpenConversation = vi.fn();
    const openEditor = vi.fn();
    render(
      <WorkflowEditorNavigation.Provider value={openEditor}>
        <ProcessesPanel dateRange={undefined} onOpenConversation={onOpenConversation} />
      </WorkflowEditorNavigation.Provider>,
    );
    await openProcess();
    fireEvent.click(await screen.findByTestId(`process-flow-pick-${ID}`));
    const runs = screen.getByTestId('process-pick-runs');
    expect(within(runs).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('process-pick-run-ops-room-workflow'));
    expect(openEditor).toHaveBeenLastCalledWith({ assistant: 'ops-assistant', workflow: 'ops-room' });
    fireEvent.click(screen.getByTestId('process-pick-run-incident-triage-conversation'));
    expect(onOpenConversation).toHaveBeenLastCalledWith(TEAM_ROOM);
    fireEvent.click(screen.getByTestId('process-pick-run-ops-room-conversation'));
    expect(onOpenConversation).toHaveBeenLastCalledWith(INCIDENT_ROOM);
    // THE STAGE TABLE'S WORKFLOW opens in the assistant whose workflow it is, too.
    fireEvent.click(screen.getByTestId('process-stage-link-ops-room-first-look'));
    expect(openEditor).toHaveBeenLastCalledWith({ assistant: 'ops-assistant', workflow: 'ops-room' });
  });

  it('the drill for one process id gives each run its workflow and its conversation', async () => {
    // The drill reads the process id on its own; this stand-in answers it with the same runs.
    withRooms();
    const onOpenConversation = vi.fn();
    render(<ProcessesPanel dateRange={undefined} onOpenConversation={onOpenConversation} />);
    await openProcess();
    await waitFor(() => expect(flowNames().length).toBeGreaterThan(5));
    fireEvent.click(screen.getAllByRole('button', { name: `Open process ${ID.slice(0, 6)}` })[0]);
    await screen.findByTestId('process-drill-runs');
    expect(screen.getByTestId('process-drill-open-ops-room-conversation').textContent).toBe('Open conversation');
    fireEvent.click(screen.getByTestId('process-drill-open-ops-room-conversation'));
    expect(onOpenConversation).toHaveBeenCalledWith(INCIDENT_ROOM);
    expect(screen.getByTestId('process-drill-open-incident-triage-workflow').getAttribute('href')).toContain('assistant=ops-premium');
  });

  it('offers no conversation where none is handed in, or the run names none', async () => {
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    fireEvent.click(await screen.findByTestId(`process-flow-pick-${ID}`));
    expect(screen.queryByTestId('process-pick-run-ops-room-conversation')).toBeNull();
  });
});

describe('the cost per process is every priced turn of its runs, and never a cost of nothing', () => {
  const costed = (teamCosts: unknown[], roomCosts: unknown[]) => svc.queryAnalytics.mockResolvedValue({ data: [
    rows[0], rows[1], { ...team, step_costs: teamCosts }, { ...room, step_costs: roomCosts },
  ] });

  it('sums every run\'s priced steps, an unlabeled step included, and says what no stage shows', async () => {
    costed(
      [{ step: 'triage', assistant: 'ops-premium', usd: 0.01, unpriced: 0 }, { step: 'tell', assistant: 'ops-premium', usd: 0.02, unpriced: 0 }],
      [{ step: 'first-look', assistant: 'ops-assistant', usd: 0.03, unpriced: 0 }],
    );
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    await waitFor(() => expect(screen.getByTestId('process-kpi-cost').textContent).toContain('$0.06'));
    expect(screen.getByTestId('process-stage-other-cost').textContent).toBe('Other steps: $0.02 per process');
  });

  it('a process with no priced turn has no cost, and one whose model is not priced says so', async () => {
    costed([], []);
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    await waitFor(() => expect(screen.getByTestId('process-kpi-cost').textContent).toContain('—'));
    expect(screen.getByTestId('process-kpi-cost').textContent).not.toContain('$0.00');
    expect(screen.queryByTestId('process-stage-other-cost')).toBeNull();
    cleanup();
    window.history.replaceState({}, '', '/');
    costed([{ step: 'triage', assistant: 'ops-premium', usd: null, unpriced: 2 }], []);
    render(<ProcessesPanel dateRange={undefined} />);
    await openProcess();
    await waitFor(() => expect(screen.getByTestId('process-kpi-cost').textContent).toContain('Not priced'));
  });
});
