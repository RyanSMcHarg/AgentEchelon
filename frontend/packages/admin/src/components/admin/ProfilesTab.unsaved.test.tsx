/**
 * AN UNSAVED EDIT ON AN ASSISTANT'S PAGE IS KEPT UNTIL IT IS SAVED, RESET OR KNOWINGLY DROPPED (SPEC-ADMIN-CONSOLE FR56).
 *
 * What it proves: an area's edit survives switching sections, the Active/Draft toggle, and another area's save (which
 * reloads the draft); the menu marks the section holding one; saving one area sends only that area's fields; Reset
 * drops only that area's edit; leaving the assistant and activating the draft each ask first, naming the area whose
 * edit would be lost, and do nothing when the person declines. A reload (after a save, or after Edit starts a draft) keeps
 * the section that is open rather than replacing the page with the loading line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
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
  listMessageTemplates: vi.fn().mockResolvedValue({ assistant: 'advisor', classification: 'premium', templates: [], family: {} }),
}));
vi.mock('../../services/rosterService', () => ({ listTeamRoster: vi.fn(), createAssistant: vi.fn(), retireAssistant: vi.fn(), setTurnLimit: vi.fn() }));
vi.mock('../../services/ownershipService', () => ({ listOwnership: vi.fn(), setOwnership: vi.fn() }));

const PREMIUM: svc.ClassificationCatalog = {
  classification: 'premium', models: { text: ['haiku', 'sonnet'], image: [] }, retrievalReach: [], roles: {},
};
const BODY: svc.ProfileDefinitionBody = {
  modelKey: 'sonnet', displayName: 'Advisor', persona: 'You advise.', tools: [], models: { default: 'sonnet', classifier: 'default' },
};
const ADMIN_CAPS = ['view-profiles', 'edit-profiles', 'activate-profiles', 'manage-assistants', 'manage-ownership'];

/** The draft's configId, which a save moves on, so the page reloads the draft as it does after a real save. */
let draftId = 'draft-1';
const listing = () => ({
  profileName: 'advisor', displayName: 'Advisor', activeVersion: 3, hasDraft: true, draftConfigId: draftId,
  versions: [{ version: 3, configId: 'cfg-3', active: true }], classification: 'premium', role: 'primary', origin: 'deployed',
}) as unknown as svc.ProfileListing;

let confirm: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  draftId = 'draft-1';
  vi.mocked(svc.listProfilesAndTools).mockImplementation(async () => ({
    profiles: [listing()], tools: [], runtimeAssistants: [], rosterTargets: [], classifications: { premium: PREMIUM }, fieldDecisions: {},
  }));
  vi.mocked(svc.exportProfile).mockImplementation(async (_n, v) => ({
    body: BODY, provenance: { exportedConfigId: v === 'draft' ? draftId : 'cfg-3' },
  }) as unknown as svc.ProfileManifest);
  vi.mocked(svc.editProfileDraft).mockImplementation(async () => { draftId = `draft-${Number(draftId.slice(6)) + 1}`; return { profileName: 'advisor', draftConfigId: draftId }; });
  vi.mocked(svc.activateProfileDraft).mockResolvedValue({ profileName: 'advisor', activeVersion: 4 } as never);
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: [] });
  confirm = vi.spyOn(window, 'confirm');
});
afterEach(() => confirm.mockRestore());

/** Open the advisor's draft on Behavioral, and write a persona there without saving it. */
async function editPersona() {
  render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
  fireEvent.click(await screen.findByTestId('assistant-mode-draft'));
  const persona = await screen.findByTestId('draft-persona');
  fireEvent.change(persona, { target: { value: 'You advise briefly.' } });
}
const persona = async () => (await screen.findByTestId('draft-persona') as HTMLTextAreaElement).value;
const nav = (s: string) => fireEvent.click(screen.getByTestId(`assistant-nav-${s}`));

describe('an unsaved edit', () => {
  it('is kept when another section is opened and this one opened again, and the menu marks where it is', async () => {
    await editPersona();
    expect(screen.getByTestId('assistant-nav-behavioral-unsaved')).toHaveTextContent('Unsaved');
    nav('workflows');
    expect(screen.queryByTestId('draft-persona')).toBeNull();
    nav('behavioral');
    expect(await persona()).toBe('You advise briefly.');
    expect(within(screen.getByTestId('draft-step-identity')).getByTestId('draft-step-save')).toBeEnabled();
  });

  it('is kept across the Active/Draft toggle', async () => {
    await editPersona();
    fireEvent.click(screen.getByTestId('assistant-mode-active'));
    expect(screen.queryByTestId('draft-persona')).toBeNull();
    fireEvent.click(screen.getByTestId('assistant-mode-draft'));
    expect(await persona()).toBe('You advise briefly.');
  });

  it('is kept when another area is saved and the draft reloads, and that save sends only its own area', async () => {
    await editPersona();
    nav('workflows');
    fireEvent.change(await screen.findByTestId('draft-welcome-template'), { target: { value: 'I help with taxes.' } });
    fireEvent.click(within(screen.getByTestId('draft-step-welcome')).getByTestId('draft-step-save'));
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalledTimes(1));
    const [, patch] = vi.mocked(svc.editProfileDraft).mock.calls[0];
    expect(Object.keys(patch)).toEqual(['eventWorkflows']);
    // The reload re-reads the draft at its new configId; the welcome's edit is saved, the persona's is still held.
    await waitFor(() => expect(svc.exportProfile).toHaveBeenCalledWith('advisor', 'draft'));
    await waitFor(() => expect(screen.queryByTestId('assistant-nav-workflows-unsaved')).toBeNull());
    // The reload keeps the section that was open.
    expect(screen.getByTestId('draft-step-welcome')).toBeTruthy();
    nav('behavioral');
    expect(await persona()).toBe('You advise briefly.');
  });

  it('is dropped by Reset, for that area only', async () => {
    await editPersona();
    nav('workflows');
    fireEvent.change(await screen.findByTestId('draft-welcome-template'), { target: { value: 'Hello.' } });
    fireEvent.click(within(screen.getByTestId('draft-step-welcome')).getByTestId('draft-step-cancel'));
    expect(screen.queryByTestId('assistant-nav-workflows-unsaved')).toBeNull();
    nav('behavioral');
    expect(await persona()).toBe('You advise briefly.');
  });
});

describe('dropping an unsaved edit asks first', () => {
  it('on leaving the assistant, naming the area, and stays when declined', async () => {
    await editPersona();
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: '← Assistants' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Name and persona'));
    expect(await persona()).toBe('You advise briefly.');
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: '← Assistants' }));
    expect(await screen.findByRole('button', { name: 'Open Advisor' })).toBeTruthy();
  });

  it('leaves without asking when nothing is unsaved', async () => {
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    fireEvent.click(await screen.findByRole('button', { name: '← Assistants' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Open Advisor' })).toBeTruthy();
  });

  it('on activating, which does not activate when declined', async () => {
    await editPersona();
    expect(screen.getByTestId('assistant-draft-unsaved')).toHaveTextContent('Name and persona');
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Activate draft as v4' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Name and persona'));
    expect(svc.activateProfileDraft).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Activate draft as v4' }));
    await waitFor(() => expect(svc.activateProfileDraft).toHaveBeenCalledWith('advisor'));
  });
});

describe('a reload', () => {
  it('keeps the section opened while Edit was starting the draft', async () => {
    let started = false;
    // The reload after Edit takes as long as a real one does, so the page is rendered while it is in flight.
    vi.mocked(svc.listProfilesAndTools).mockImplementation(async () => {
      if (started) await new Promise<void>((r) => { setTimeout(r, 50); });
      return {
      profiles: [{ ...listing(), hasDraft: started }], tools: [], runtimeAssistants: [], rosterTargets: [], classifications: { premium: PREMIUM }, fieldDecisions: {},
      };
    });
    let finish: () => void = () => undefined;
    vi.mocked(svc.createProfileVersion).mockImplementation(() => new Promise((resolve) => { finish = () => { started = true; resolve({} as never); }; }));
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    fireEvent.click(await screen.findByTestId('new-version'));
    nav('workflows');
    finish();
    expect(await screen.findByTestId('draft-step-events')).toBeTruthy();
    expect(screen.getByTestId('assistant-nav-workflows')).toHaveAttribute('aria-current', 'page');
  });
});
