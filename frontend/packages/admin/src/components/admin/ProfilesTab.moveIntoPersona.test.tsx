/**
 * THE TESTED INSTRUCTION, AND MOVING IT INTO THE PERSONA (SPEC-ADMIN-CONSOLE "Assistants").
 *
 * What it proves:
 *   - the version's `systemPromptAddendum` is labeled as an experiment's tested instruction, and its help says that how
 *     the assistant answers in general belongs in the persona's How to answer section;
 *   - Move into the persona saves the draft once, with the instruction as the last item of the How to answer section
 *     and the addendum cleared (`null`), or with the section added where the persona has none;
 *   - a persona that would pass its length cap, or a version with no persona of its own, is refused with a message and
 *     nothing is saved;
 *   - the action is offered on a draft carrying an instruction to a session that may edit, and to nobody else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listOwnership } from '../../services/ownershipService';
import { CapabilityTestProvider } from '../../capabilities';

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

const ADVISOR = {
  profileName: 'advisor', displayName: 'Advisor', activeVersion: 3, hasDraft: true, draftConfigId: 'draft-1',
  versions: [{ version: 3, configId: 'cfg-3', active: true }],
  classification: 'premium', role: 'primary', ownerTeam: 'finance', origin: 'deployed', deployedTurnLimit: 60, deployedClassifierMode: 'llm',
} as unknown as svc.ProfileListing;

const PREMIUM = {
  classification: 'premium',
  models: { text: ['sonnet'], image: [], default: 'sonnet' },
  guardrails: [], contextSources: [], templates: [], workflows: [], packIntents: [],
  topology: { processorTimeout: 120, memorySize: 1024 }, retrievalReach: [], contextBucket: 'ae-attachments', roles: {},
  budgets: { userHourly: 750, globalHourly: 1500 },
} as unknown as svc.ClassificationCatalog;

const DECISIONS: Record<string, svc.FieldDecision> = {
  persona: { kind: 'control' }, displayName: { kind: 'control' },
  systemPromptAddendum: { kind: 'readonly', drivenBy: 'experiments', guide: 'experiments' },
};

const INSTRUCTION = 'Keep every reply under 80 words.';
const WITH_SECTION = 'You advise.\n\nHow to answer:\n- Cite the figure.';
const ACTIVE: svc.ProfileDefinitionBody = { modelKey: 'sonnet', persona: WITH_SECTION, systemPromptAddendum: INSTRUCTION };

/** The draft the page reads; each test sets it. */
let draftBody: svc.ProfileDefinitionBody = ACTIVE;

beforeEach(() => {
  vi.clearAllMocks();
  draftBody = ACTIVE;
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
    profiles: [ADVISOR], tools: [], runtimeAssistants: [], rosterTargets: [],
    classifications: { premium: PREMIUM }, fieldDecisions: DECISIONS,
  });
  vi.mocked(svc.exportProfile).mockImplementation(async (_name, version) =>
    ({ body: version === 'draft' ? draftBody : ACTIVE }) as unknown as svc.ProfileManifest);
  vi.mocked(svc.editProfileDraft).mockResolvedValue({ profileName: 'advisor', draftConfigId: 'draft-2' });
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['finance'] });
});

async function open(capabilities: string[]) {
  render(<CapabilityTestProvider capabilities={capabilities}><ProfilesTab /></CapabilityTestProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
  await screen.findByTestId('field-systemPromptAddendum');
}

async function openDraft(capabilities = ['view-profiles', 'edit-profiles', 'activate-profiles']) {
  await open(capabilities);
  fireEvent.click(screen.getByTestId('assistant-mode-draft'));
  await screen.findByTestId('assistant-draft');
  await screen.findByTestId('draft-step-identity');
}

describe('the tested instruction', () => {
  it('is labeled as what an experiment tests, and says general answer style belongs in the persona', async () => {
    await open(['view-profiles']);
    const row = screen.getByTestId('field-systemPromptAddendum');
    expect(screen.getByText('Tested instruction (from an experiment)')).toBeInTheDocument();
    expect(row.textContent).toContain('A short instruction an experiment is testing on top of the persona');
    expect(row.textContent).toContain("How the assistant answers in general belongs in the persona's How to answer section");
    expect(row.textContent).toContain('Keep every reply under 80 words');
    expect(row.textContent).not.toContain('three bullet points');
  });
});

describe('Move into the persona', () => {
  it('adds the instruction as the last item of the How to answer section and clears it, in one draft save', async () => {
    await openDraft();
    fireEvent.click(within(screen.getByTestId('field-systemPromptAddendum')).getByTestId('move-into-persona-button'));
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalledTimes(1));
    expect(vi.mocked(svc.editProfileDraft).mock.calls[0]).toEqual(['advisor', {
      persona: `${WITH_SECTION}\n- ${INSTRUCTION}`,
      systemPromptAddendum: null,
    }]);
  });

  it('adds a How to answer section at the end of a persona that has none', async () => {
    draftBody = { ...ACTIVE, persona: 'You advise.' };
    await openDraft();
    fireEvent.click(screen.getByTestId('move-into-persona-button'));
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalledTimes(1));
    expect(vi.mocked(svc.editProfileDraft).mock.calls[0][1]).toEqual({
      persona: `You advise.\n\nHow to answer:\n- ${INSTRUCTION}`,
      systemPromptAddendum: null,
    });
  });

  it('refuses a move that would pass the persona length cap, and saves nothing', async () => {
    draftBody = { ...ACTIVE, persona: `How to answer:\n- ${'x'.repeat(19980)}` };
    await openDraft();
    fireEvent.click(screen.getByTestId('move-into-persona-button'));
    const refused = await screen.findByTestId('move-into-persona-refused');
    expect(refused).toHaveAttribute('role', 'alert');
    expect(refused.textContent).toMatch(/over the limit of 20,000/);
    expect(svc.editProfileDraft).not.toHaveBeenCalled();
  });

  it('refuses a version with no persona of its own, which answers with the classification persona', async () => {
    draftBody = { modelKey: 'sonnet', systemPromptAddendum: INSTRUCTION };
    await openDraft();
    fireEvent.click(screen.getByTestId('move-into-persona-button'));
    expect((await screen.findByTestId('move-into-persona-refused')).textContent).toContain('no persona of its own');
    expect(svc.editProfileDraft).not.toHaveBeenCalled();
  });

  it('waits while the persona holds an edit not yet saved', async () => {
    await openDraft();
    fireEvent.change(screen.getByTestId('draft-persona'), { target: { value: 'Edited.' } });
    expect(screen.getByTestId('move-into-persona-button')).toBeDisabled();
    expect(screen.getByTestId('move-into-persona').textContent).toContain('Save or reset the edit to the persona first');
  });

  it('is not offered on the active version', async () => {
    await open(['view-profiles', 'edit-profiles']);
    expect(screen.queryByTestId('move-into-persona')).toBeNull();
  });

  it('is not offered on a draft that carries no instruction', async () => {
    draftBody = { modelKey: 'sonnet', persona: WITH_SECTION };
    await openDraft();
    expect(screen.queryByTestId('move-into-persona')).toBeNull();
  });

  it('is not offered to a session that may not edit', async () => {
    await openDraft(['view-profiles']);
    expect(screen.getByTestId('field-systemPromptAddendum').textContent).toContain(INSTRUCTION);
    expect(screen.queryByTestId('move-into-persona')).toBeNull();
  });
});
