/**
 * AN INTENT'S TASK STEPS ARE EDITED ON THE BUILDER AND WRITE THE VERSION'S PACK (ADR-067 stage 1, ADR-066 build step 3).
 *
 * What it proves: in a draft, View steps on an intent the version declares opens its machine on the builder's
 * task-machine mode; an edit there is saved through the draft patch as `intentPack.machines[<intent>]`, with every other
 * field of the pack kept; a shipped machine the version does not hold yet is copied into the draft whole; a platform
 * machine opens read-only, with no builder and no copy; and outside a draft the page offers to edit the steps in one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listOwnership } from '../../services/ownershipService';
import { CapabilityTestProvider } from '../../capabilities';
import { DEFAULT_TASK_STATE_MACHINES } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';

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
  listMessageTemplates: vi.fn(),
  saveMessageTemplate: vi.fn(),
  rollbackMessageTemplate: vi.fn(),
}));
vi.mock('../../services/rosterService', () => ({ listTeamRoster: vi.fn(), createAssistant: vi.fn(), retireAssistant: vi.fn(), setTurnLimit: vi.fn() }));
vi.mock('../../services/ownershipService', () => ({ listOwnership: vi.fn(), setOwnership: vi.fn() }));

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const REPORT = clone(DEFAULT_TASK_STATE_MACHINES.report_generation);

const ADVISOR = {
  profileName: 'advisor', displayName: 'Advisor', activeVersion: 3, hasDraft: true, draftConfigId: 'draft-1',
  versions: [{ version: 3, configId: 'cfg-3', active: true }],
  classification: 'premium', role: 'primary', ownerTeam: 'finance', origin: 'deployed', deployedTurnLimit: 60, deployedClassifierMode: 'llm',
} as unknown as svc.ProfileListing;

const PREMIUM: svc.ClassificationCatalog = {
  classification: 'premium',
  models: { text: ['sonnet'], image: [], default: 'sonnet' },
  workflows: [
    { key: 'report_generation', source: 'platform', required: false, initial: REPORT.initial, states: Object.keys(REPORT.states) },
    { key: 'image_generation', source: 'platform', required: false, initial: 'gather', states: ['gather'] },
    { key: 'queue_drain', source: 'platform', required: true, initial: 'triage', states: ['triage', 'done'] },
  ],
  intents: [
    { key: 'report_generation', description: 'A report', multiStep: true, machine: 'report_generation' },
    { key: 'image_generation', description: 'An image', multiStep: true, machine: 'image_generation' },
  ],
  retrievalReach: [], roles: { primary: { contextPrefixes: [] } },
};

const PACK = { extends: 'default' as const, intents: [{ key: 'report_generation' }, { key: 'image_generation' }], machines: { report_generation: REPORT } };
const BODY = {
  modelKey: 'sonnet', tools: ['search_context'], persona: 'You advise.', workflows: ['report_generation', 'image_generation'],
  intentPack: PACK,
} as unknown as svc.ProfileDefinitionBody;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
    profiles: [ADVISOR], tools: [{ name: 'search_context', category: 'context', changesState: false, description: 'Search', requires: 'nothing' }],
    runtimeAssistants: [], rosterTargets: [], classifications: { premium: PREMIUM }, fieldDecisions: {},
  } as unknown as Awaited<ReturnType<typeof svc.listProfilesAndTools>>);
  vi.mocked(svc.exportProfile).mockResolvedValue({ body: clone(BODY) } as unknown as svc.ProfileManifest);
  vi.mocked(svc.editProfileDraft).mockResolvedValue({ profileName: 'advisor', draftConfigId: 'draft-2' });
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['finance'] });
});

async function openWorkflows(draft: boolean) {
  render(<CapabilityTestProvider capabilities={['view-profiles', 'edit-profiles', 'activate-profiles', 'manage-assistants']}><ProfilesTab /></CapabilityTestProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
  await screen.findByTestId('field-displayName');
  if (draft) {
    fireEvent.click(screen.getByTestId('assistant-mode-draft'));
    await screen.findByTestId('assistant-draft');
  }
  fireEvent.click(screen.getByTestId('assistant-nav-workflows'));
  return screen.findByTestId('field-machines');
}

describe('an-intents-task-steps-write-the-pack', () => {
  it('edits an intent\'s task steps on the builder and saves them as the version\'s machine, the rest of the pack kept', async () => {
    const list = await openWorkflows(true);
    fireEvent.click(within(list).getByTestId('assistant-machine-report_generation'));
    const editor = await screen.findByTestId('assistant-machine-editor');
    fireEvent.click(within(editor).getByTestId(`mb-node-${REPORT.initial}`));
    fireEvent.change(within(editor).getByTestId('mb-label'), { target: { value: 'Ask what the report is for' } });
    fireEvent.click(screen.getByTestId('assistant-machine-save'));
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    const patch = vi.mocked(svc.editProfileDraft).mock.calls[0][1] as { intentPack: typeof PACK };
    expect(patch.intentPack.machines.report_generation.states[REPORT.initial].label).toBe('Ask what the report is for');
    expect(patch.intentPack.intents).toEqual(PACK.intents);
    expect(patch.intentPack.extends).toBe('default');
    // Only the one field changed: every other step is saved as it was.
    const { [REPORT.initial]: _edited, ...rest } = patch.intentPack.machines.report_generation.states;
    const { [REPORT.initial]: _was, ...restWas } = REPORT.states;
    expect(rest).toEqual(restWas);
  });

  it('copies a shipped machine the version does not hold yet into the draft, whole', async () => {
    const list = await openWorkflows(true);
    fireEvent.click(within(list).getByTestId('assistant-machine-image_generation'));
    fireEvent.click(await screen.findByTestId('assistant-machine-copy'));
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    const patch = vi.mocked(svc.editProfileDraft).mock.calls[0][1] as { intentPack: { machines: Record<string, unknown> } };
    expect(patch.intentPack.machines.image_generation).toEqual(DEFAULT_TASK_STATE_MACHINES.image_generation);
    expect(patch.intentPack.machines.report_generation).toEqual(REPORT);
  });

  it('opens a platform machine read-only, with no builder and no copy', async () => {
    await openWorkflows(true);
    const platform = screen.getByTestId('workflows-platform-section');
    fireEvent.click(within(platform).getByTestId('assistant-machine-queue_drain'));
    expect(await screen.findByTestId('assistant-machine-fixed')).toBeTruthy();
    expect(screen.queryByTestId('machine-builder')).toBeNull();
    expect(screen.queryByTestId('assistant-machine-copy')).toBeNull();
    expect(screen.queryByTestId('assistant-machine-edit')).toBeNull();
  });

  it('outside a draft offers to edit an intent\'s steps in one, and never for a platform machine', async () => {
    const list = await openWorkflows(false);
    fireEvent.click(within(list).getByTestId('assistant-machine-report_generation'));
    expect(await screen.findByTestId('assistant-machine-edit')).toBeTruthy();
    expect(screen.queryByTestId('machine-builder')).toBeNull();
  });
});
