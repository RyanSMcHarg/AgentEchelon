/**
 * A REFUSAL ACTIVATE GAVE NEVER HOLDS ACTIVATE BACK (SPEC-ADMIN-CONSOLE "Assistants", ADR-065).
 *
 * What it proves:
 *   - a golden set refusal is shown beside the button as Activate's, and the button stays clickable, because the server
 *     reads the gate again on every activation;
 *   - once the golden panel reads the gate as passing, the refusal is cleared, and Activate activates;
 *   - Validate's own refusal still holds Activate back until the draft changes;
 *   - Validate's success says the draft passes Validate, not that it is ready, and names the golden set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  readGoldenGate: vi.fn(),
  startGoldenRun: vi.fn(),
}));
vi.mock('../../services/rosterService', () => ({ listTeamRoster: vi.fn(), createAssistant: vi.fn(), retireAssistant: vi.fn() }));
vi.mock('../../services/ownershipService', () => ({ listOwnership: vi.fn(), setOwnership: vi.fn() }));

const ADVISOR = {
  profileName: 'advisor', displayName: 'Advisor', activeVersion: 3, hasDraft: true, draftConfigId: 'draft-1', draftBasedOnVersion: 3,
  versions: [{ version: 3, configId: 'cfg-3', active: true }],
  classification: 'premium', role: 'primary', ownerTeam: 'finance', origin: 'deployed',
} as unknown as svc.ProfileListing;

const BODY = { modelKey: 'sonnet', persona: 'You advise.' } as svc.ProfileDefinitionBody;

const refusing: svc.GoldenGateReading = {
  profileName: 'advisor', draftConfigId: 'draft-1', available: true,
  gate: { entries: 2, regressionEntries: 2, answeredEntries: 2, run: null },
  outcome: { proceed: false, code: 'GOLDEN_RUN_REQUIRED', params: { count: 2 }, error: 'run it first' },
};
const passing: svc.GoldenGateReading = {
  ...refusing,
  outcome: { proceed: true, note: 'passed' },
};

const CAPS = ['view-profiles', 'edit-profiles', 'activate-profiles'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({ profiles: [ADVISOR], tools: [], runtimeAssistants: [], rosterTargets: [] });
  vi.mocked(svc.exportProfile).mockResolvedValue({ body: BODY, provenance: { exportedConfigId: 'draft-1' } } as unknown as svc.ProfileManifest);
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['finance'] });
});

async function openDraft() {
  render(<CapabilityTestProvider capabilities={CAPS}><ProfilesTab /></CapabilityTestProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
  fireEvent.click(await screen.findByTestId('assistant-mode-draft'));
  await screen.findByTestId('assistant-draft');
}

const activateButton = () => screen.getByRole('button', { name: /^Activate draft as v4/ });

describe('a golden set refusal at Activate', () => {
  it('is shown as Activate\'s, keeps Activate clickable, and is cleared once the gate reads as passing', async () => {
    vi.mocked(svc.readGoldenGate).mockResolvedValueOnce(refusing).mockResolvedValue(passing);
    vi.mocked(svc.activateProfileDraft)
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { body: { code: 'GOLDEN_RUN_REQUIRED', params: { count: 2 } } }))
      .mockResolvedValueOnce({ profileName: 'advisor', version: 4, configId: 'draft-1' } as never);
    await openDraft();
    await screen.findByTestId('golden-run-needed');
    fireEvent.click(activateButton());
    const refused = await screen.findByTestId('draft-refused');
    expect(refused).toHaveTextContent('The draft was not activated:');
    expect(activateButton()).toBeEnabled();

    // The run passes; the panel reads the gate again, and the refusal it gave is gone.
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByTestId('draft-refused')).toBeNull());
    fireEvent.click(activateButton());
    await waitFor(() => expect(svc.activateProfileDraft).toHaveBeenCalledTimes(2));
  });
});

describe('Validate', () => {
  beforeEach(() => vi.mocked(svc.readGoldenGate).mockResolvedValue(passing));

  it('holds Activate back on its own refusal', async () => {
    vi.mocked(svc.validateProfileDraft).mockResolvedValueOnce({ profileName: 'advisor', valid: false, configId: 'draft-1', errors: ['persona is too long'] });
    await openDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByTestId('draft-refused')).toHaveTextContent('persona is too long');
    expect(activateButton()).toBeDisabled();
  });

  it('says the draft passes Validate and points at the golden set, never that it is ready to activate', async () => {
    vi.mocked(svc.validateProfileDraft).mockResolvedValueOnce({ profileName: 'advisor', valid: true, configId: 'draft-1', errors: [] });
    await openDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    const ok = await screen.findByTestId('draft-valid');
    expect(ok).toHaveTextContent('Passes Validate');
    expect(ok).toHaveTextContent('golden set');
    expect(ok).not.toHaveTextContent('ready to activate');
  });
});

describe('the draft banner', () => {
  beforeEach(() => vi.mocked(svc.readGoldenGate).mockResolvedValue(passing));

  it('names the version the draft was started from, whatever is active now', async () => {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [{ ...ADVISOR, activeVersion: 2, draftBasedOnVersion: 3, versions: [{ version: 3, configId: 'cfg-3', active: false }, { version: 2, configId: 'cfg-2', active: true }] } as unknown as svc.ProfileListing],
      tools: [], runtimeAssistants: [], rosterTargets: [],
    });
    await openDraft();
    expect(screen.getByTestId('assistant-draft')).toHaveTextContent('Editing a draft of v3.');
    expect(screen.getByTestId('assistant-draft')).toHaveTextContent('v2 keeps serving');
  });

  it('names where an imported draft came from', async () => {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [{ ...ADVISOR, draftBasedOnVersion: undefined, draftCreatedFrom: { profileName: 'concierge', version: 7 } } as unknown as svc.ProfileListing],
      tools: [], runtimeAssistants: [], rosterTargets: [],
    });
    await openDraft();
    expect(screen.getByTestId('assistant-draft')).toHaveTextContent('Editing a draft made from concierge v7.');
  });

  it('counts a change to fields no section edits, in the banner and the toggle', async () => {
    vi.mocked(svc.exportProfile).mockImplementation(async (_n, version) => ({
      body: version === 'draft' ? { ...BODY, systemPromptAddendum: 'I do not reach payroll.' } : BODY,
      provenance: { exportedConfigId: version === 'draft' ? 'draft-1' : 'cfg-3' },
    } as unknown as svc.ProfileManifest));
    await openDraft();
    await waitFor(() => expect(screen.getByTestId('assistant-mode-draft')).toHaveTextContent('Draft (other fields changed)'));
    expect(screen.getByTestId('assistant-draft')).toHaveTextContent('Only fields no section edits changed.');
  });
});
