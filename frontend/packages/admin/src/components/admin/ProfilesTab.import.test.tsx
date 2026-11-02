/**
 * AN IMPORT LANDS ON THE ASSISTANT IT IS OFFERED FROM, AND ONLY AFTER A PREVIEW (SPEC-PORTABLE-PROFILES §5).
 *
 * What it proves:
 *   - the assistant list offers no import: a list-level control could not say which assistant would get
 *     the manifest, and the server landed it on whatever the manifest named;
 *   - the Versions group's import reads the chosen file first and shows where it came from (its assistant,
 *     display name, version, config id, source instance) and what will happen (a draft of THIS assistant,
 *     replacing a draft that exists), and nothing is sent until the preview is confirmed;
 *   - confirming sends this assistant as the target, whatever the manifest's own name;
 *   - Cancel writes nothing; a file that is not a manifest is refused before any request;
 *   - a refusal from the server is shown with each of its reasons.
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
}));
vi.mock('../../services/rosterService', () => ({ listTeamRoster: vi.fn(), createAssistant: vi.fn(), retireAssistant: vi.fn() }));
vi.mock('../../services/ownershipService', () => ({ listOwnership: vi.fn(), setOwnership: vi.fn() }));

const listing = (over: Record<string, unknown> = {}) => ({
  profileName: 'finance-advisor', displayName: 'Finance', activeVersion: 1, hasDraft: false, versions: [],
  classification: 'premium', role: 'primary', ownerTeam: 'finance', origin: 'console', ...over,
}) as unknown as svc.ProfileListing;

/** A manifest exported from ANOTHER assistant (`advisor`), which is the case the target exists for. */
const ADVISOR_MANIFEST = {
  schemaVersion: 1,
  kind: 'assistant-profile',
  profileName: 'advisor',
  body: { displayName: 'Advisor', modelKey: 'sonnet' },
  provenance: { sourceProfileName: 'advisor', sourceVersion: 4, exportedConfigId: 'cfg-0123456789abcdef', instanceId: 'prod-east' },
  exportedAt: '2026-10-01T12:00:00.000Z',
  contentHash: 'h',
};

const serve = (profile: svc.ProfileListing) => {
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({ profiles: [profile], tools: [], runtimeAssistants: [], rosterTargets: [] });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.exportProfile).mockResolvedValue({ body: { modelKey: 'sonnet', tools: [] } } as unknown as svc.ProfileManifest);
  vi.mocked(svc.importProfile).mockResolvedValue({ imported: 'finance-advisor', configId: 'c2', landedAs: 'draft' });
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['finance'] });
});

const renderTab = (capabilities = ['view-profiles', 'edit-profiles', 'activate-profiles']) =>
  render(<CapabilityTestProvider capabilities={capabilities}><ProfilesTab /></CapabilityTestProvider>);

const openFinance = async () => {
  renderTab();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Finance' }));
  // Export and import sit in the Versions section.
  fireEvent.click(await screen.findByTestId('assistant-nav-versions'));
  await screen.findByTestId('import-version');
};

const choose = (content: string, name = 'advisor-profile-manifest.json') => {
  const input = screen.getByLabelText('Import a version for Finance') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([content], name, { type: 'application/json' })] } });
};

describe('the assistant list', () => {
  it('offers no import control', async () => {
    serve(listing());
    renderTab();
    await screen.findByRole('button', { name: 'Open Finance' });
    expect(screen.queryByText(/import/i)).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe("the Versions group's import", () => {
  it('previews the source and the target, and sends this assistant as the target only on confirm', async () => {
    serve(listing());
    await openFinance();
    choose(JSON.stringify(ADVISOR_MANIFEST));
    const preview = await screen.findByTestId('import-preview');
    // WHERE IT CAME FROM.
    expect(screen.getByTestId('import-source')).toHaveTextContent('advisor');
    expect(preview).toHaveTextContent('Advisor');
    expect(preview).toHaveTextContent('v4');
    expect(preview).toHaveTextContent('cfg-01234567');
    expect(preview).toHaveTextContent('prod-east');
    expect(preview).toHaveTextContent('Exported');
    expect(preview).toHaveTextContent('advisor-profile-manifest.json');
    // WHAT WILL HAPPEN, naming this assistant.
    expect(screen.getByTestId('import-target')).toHaveTextContent('Becomes a draft of Finance. Nothing is activated until you activate the draft.');
    expect(screen.queryByTestId('import-replaces-draft')).toBeNull();
    // NOTHING IS SENT UNTIL CONFIRMED.
    expect(svc.importProfile).not.toHaveBeenCalled();

    const loads = vi.mocked(svc.listProfilesAndTools).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Import as draft' }));
    await waitFor(() => expect(svc.importProfile).toHaveBeenCalledTimes(1));
    expect(svc.importProfile).toHaveBeenCalledWith(ADVISOR_MANIFEST, 'finance-advisor');
    expect(await screen.findByText('Imported as a draft of Finance. Activate the draft to use it.')).toBeTruthy();
    expect(screen.queryByTestId('import-preview')).toBeNull();
    // The view reloads, so the landed draft shows.
    await waitFor(() => expect(vi.mocked(svc.listProfilesAndTools).mock.calls.length).toBeGreaterThan(loads));
  });

  it('says the import replaces the draft when one exists', async () => {
    serve(listing({ hasDraft: true, draftConfigId: 'd1' }));
    await openFinance();
    choose(JSON.stringify(ADVISOR_MANIFEST));
    expect(await screen.findByTestId('import-replaces-draft')).toHaveTextContent('Finance already has a draft. Importing replaces it.');
  });

  it('writes nothing on Cancel', async () => {
    serve(listing());
    await openFinance();
    choose(JSON.stringify(ADVISOR_MANIFEST));
    await screen.findByTestId('import-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(svc.importProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['a file that is not JSON', 'not json at all'],
    ['JSON that is not a manifest', JSON.stringify({ hello: 'world' })],
    ['a manifest of another kind', JSON.stringify({ ...ADVISOR_MANIFEST, kind: 'something-else' })],
    ['a manifest with no body', JSON.stringify({ ...ADVISOR_MANIFEST, body: undefined })],
  ])('refuses %s before any request', async (_what, content) => {
    serve(listing());
    await openFinance();
    choose(content, 'notes.json');
    expect(await screen.findByTestId('import-refused')).toHaveTextContent('This file is not a profile manifest, so nothing was imported.');
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(svc.importProfile).not.toHaveBeenCalled();
  });

  it("shows the server's refusal with each of its reasons", async () => {
    vi.mocked(svc.importProfile).mockRejectedValue(Object.assign(new Error('manifest rejected'), {
      body: { error: 'manifest rejected', errors: ['ownerTeam is not part of a profile: ownership is changed through manage-ownership, with a reason'] },
    }));
    serve(listing());
    await openFinance();
    choose(JSON.stringify(ADVISOR_MANIFEST));
    await screen.findByTestId('import-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Import as draft' }));
    const refused = await screen.findByTestId('import-refused');
    expect(refused).toHaveTextContent('The import was refused: manifest rejected');
    expect(refused).toHaveTextContent('ownerTeam is not part of a profile');
    // The preview stays, so the person can cancel or choose another file.
    expect(screen.getByTestId('import-preview')).toBeTruthy();
  });
});
