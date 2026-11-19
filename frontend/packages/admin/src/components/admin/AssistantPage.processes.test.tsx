/**
 * A VERSION'S PROCESSES ARE A SECTION OF THE ASSISTANT'S PAGE, BESIDE WORKFLOWS (SPEC-PROCESSES P1, UX section 1).
 *
 * What it proves:
 *   - the active version's processes are read, with no control;
 *   - in the draft, a process is added from the version's own workflows and saved through the draft's own save, naming the
 *     draft it was based on, and the menu marks the section changed;
 *   - a refusal Validate gives a process is said in its reason code's words, in the banner and in the section;
 *   - a reader who may not edit the draft reads it, with no control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listOwnership } from '../../services/ownershipService';
import { CapabilityTestProvider } from '../../capabilities';
import { SHIPPED_EVENT_WORKFLOWS } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

vi.mock('../../services/profileService', () => ({
  DEFAULT_MODEL: 'default',
  listProfilesAndTools: vi.fn(),
  listOwnedProfiles: vi.fn(),
  createProfileVersion: vi.fn(),
  editProfileDraft: vi.fn(),
  validateProfileDraft: vi.fn(),
  activateProfileDraft: vi.fn(),
  rollbackProfile: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  readGoldenGate: vi.fn(),
  startGoldenRun: vi.fn(),
  listMessageTemplates: vi.fn(),
}));
vi.mock('../../services/rosterService', () => ({ listTeamRoster: vi.fn(), createAssistant: vi.fn(), retireAssistant: vi.fn(), setTurnLimit: vi.fn() }));
vi.mock('../../services/ownershipService', () => ({ listOwnership: vi.fn(), setOwnership: vi.fn() }));

const OPS = {
  profileName: 'ops-premium', displayName: 'Ops', activeVersion: 2, hasDraft: true, draftConfigId: 'draft-1', draftBasedOnVersion: 2,
  versions: [{ version: 2, configId: 'cfg-2', active: true }],
  classification: 'premium', role: 'ops', ownerTeam: 'ops', origin: 'deployed',
} as unknown as svc.ProfileListing;

const WORKFLOWS = { 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'] };
const PROCESS = { label: 'Incident response', workflows: ['ops-room'] };
const ACTIVE: svc.ProfileDefinitionBody = { modelKey: 'sonnet', eventWorkflows: WORKFLOWS, processes: { 'incident-response': PROCESS } };
const DRAFT: svc.ProfileDefinitionBody = { modelKey: 'sonnet', eventWorkflows: WORKFLOWS };

const EDIT_CAPS = ['view-profiles', 'edit-profiles', 'activate-profiles'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({ profiles: [OPS], tools: [], runtimeAssistants: [], rosterTargets: [] });
  vi.mocked(svc.exportProfile).mockImplementation(async (_n, version) => ({
    body: version === 'draft' ? DRAFT : ACTIVE, provenance: { exportedConfigId: version === 'draft' ? 'draft-1' : 'cfg-2' },
  } as unknown as svc.ProfileManifest));
  vi.mocked(svc.readGoldenGate).mockResolvedValue({ profileName: 'ops-premium', draftConfigId: 'draft-1', available: true, gate: { entries: 0, regressionEntries: 0, answeredEntries: 0, run: null }, outcome: { proceed: true, note: 'none' } } as never);
  vi.mocked(svc.editProfileDraft).mockResolvedValue({ profileName: 'ops-premium', draftConfigId: 'draft-2' });
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['ops'] });
});

async function open(caps: string[], draft: boolean) {
  render(<CapabilityTestProvider capabilities={caps}><ProfilesTab /></CapabilityTestProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Ops' }));
  if (draft) {
    fireEvent.click(await screen.findByTestId('assistant-mode-draft'));
    await screen.findByTestId('assistant-draft');
  }
  const nav = await screen.findByTestId('assistant-nav-processes');
  expect(nav).toHaveTextContent('Processes');
  fireEvent.click(nav);
  return screen.findByTestId('assistant-section-processes');
}

describe('the Processes section of an assistant\'s version', () => {
  it('reads the active version\'s processes, with no control', async () => {
    const section = await open(EDIT_CAPS, false);
    await waitFor(() => expect(within(section).getByTestId('process-entry-incident-response')).toHaveTextContent('Incident response'));
    expect(within(section).queryByTestId('draft-step-processes')).toBeNull();
    expect(within(section).queryByTestId('process-add')).toBeNull();
  });

  it('adds a process in the draft from the version\'s own workflows, saved through the draft\'s save', async () => {
    const section = await open(EDIT_CAPS, true);
    const step = await within(section).findByTestId('draft-step-processes');
    expect(within(step).getByTestId('processes-none')).toHaveTextContent('ops-premium declares no processes.');
    fireEvent.click(within(step).getByRole('button', { name: 'Add process' }));
    // THE WIZARD: the workflow that starts it, then its name, then its phases, then metrics and review.
    fireEvent.click(within(step).getByRole('radio', { name: 'ops-room' }));
    fireEvent.click(within(step).getByRole('button', { name: 'Next' }));
    fireEvent.change(within(step).getByLabelText(/^Name/), { target: { value: 'incident-response' } });
    fireEvent.change(within(step).getAllByLabelText('Label')[0], { target: { value: 'Incident response' } });
    fireEvent.click(within(step).getByRole('button', { name: 'Next' }));
    expect(within(step).getByTestId('process-phase-ops-room')).toBeTruthy();
    fireEvent.click(within(step).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(step).getByRole('button', { name: 'Done' }));
    expect(within(step).getByTestId('draft-step-preview')).toHaveTextContent('1 process: Incident response.');
    expect(screen.getByTestId('assistant-nav-processes-unsaved')).toBeTruthy();
    fireEvent.click(within(step).getByTestId('draft-step-save'));
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalledWith('ops-premium', { processes: { 'incident-response': PROCESS } }, 'draft-1'));
  });

  it('marks the section changed where the draft\'s processes differ from the active version\'s', async () => {
    await open(EDIT_CAPS, true);
    expect(screen.getByTestId('assistant-nav-processes-changed')).toBeTruthy();
  });

  it('says a refusal Validate gave a process in its reason code\'s words, in the banner and the section', async () => {
    vi.mocked(svc.validateProfileDraft).mockResolvedValueOnce({
      profileName: 'ops-premium', valid: false, configId: 'draft-1', errors: ['processes.incident-response.workflows.incident-triage: PROCESS_WORKFLOW_UNDECLARED'],
    });
    const section = await open(EDIT_CAPS, true);
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    const said = 'processes.incident-response.workflows.incident-triage: this version declares no workflow by that name.';
    expect(await screen.findByTestId('draft-refused')).toHaveTextContent(said);
    expect(await within(section).findByTestId('processes-server-refusals')).toHaveTextContent(said);
  });

  it('is read-only in the draft for a reader without edit rights, as Workflows is', async () => {
    vi.mocked(svc.exportProfile).mockImplementation(async (_n, version) => ({
      body: ACTIVE, provenance: { exportedConfigId: version === 'draft' ? 'draft-1' : 'cfg-2' },
    } as unknown as svc.ProfileManifest));
    const section = await open(['view-profiles'], true);
    await waitFor(() => expect(within(section).getByTestId('process-entry-incident-response')).toBeTruthy());
    expect(within(section).queryByTestId('process-add')).toBeNull();
    expect(within(section).queryByTestId('process-edit-incident-response')).toBeNull();
    expect(within(section).getByTestId('draft-step-save')).toBeDisabled();
  });
});
