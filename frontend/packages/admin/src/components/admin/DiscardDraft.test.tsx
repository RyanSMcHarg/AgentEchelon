/**
 * A DRAFT IS DISCARDED BEHIND A CONFIRM THAT NAMES WHAT IS LOST (SPEC-PORTABLE-PROFILES FR18).
 *
 * What it proves: Discard draft is offered to a person who may edit, and to nobody else; the confirm names the areas
 * the draft changes from the active version, or all of it while nothing is active, and any area's unsaved edit it drops
 * too; Cancel sends nothing; on the assistant's page a confirmed discard sends the configId the draft was loaded from,
 * closes the draft and offers Edit again; a draft saved since is kept, the reason is shown and the page reloads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiscardDraft } from './DraftControls';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listOwnership } from '../../services/ownershipService';
import { CapabilityTestProvider } from '../../capabilities';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  listMessageTemplates: vi.fn().mockResolvedValue({ assistant: 'advisor', classification: 'premium', templates: [], family: {} }),
  listProfilesAndTools: vi.fn(),
  exportProfile: vi.fn(),
  discardProfileDraft: vi.fn(),
  createProfileVersion: vi.fn(),
}));
vi.mock('../../services/rosterService', () => ({ listTeamRoster: vi.fn(), createAssistant: vi.fn(), retireAssistant: vi.fn() }));
vi.mock('../../services/ownershipService', () => ({ listOwnership: vi.fn(), setOwnership: vi.fn() }));

const ACTIVE: svc.ProfileDefinitionBody = { modelKey: 'sonnet', displayName: 'Advisor', persona: 'You advise.', tools: [] };
const DRAFT: svc.ProfileDefinitionBody = { ...ACTIVE, persona: 'You advise briefly.', variables: { team: { source: 'fact:team', fallback: 'your team' } } };
function Cards({ onDiscard, active = ACTIVE, canEdit = true, unsaved }: {
  onDiscard: () => void; active?: svc.ProfileDefinitionBody | null; canEdit?: boolean; unsaved?: string[];
}) {
  return <DiscardDraft draft={DRAFT} active={active} busy={false} canEdit={canEdit} unsaved={unsaved} onDiscard={onDiscard} />;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('the control', () => {
  it('asks first, naming the areas the draft changes, and Cancel sends nothing', () => {
    const onDiscard = vi.fn();
    render(<Cards onDiscard={onDiscard} />);
    fireEvent.click(screen.getByTestId('draft-discard'));
    expect(screen.getByRole('alertdialog', { name: 'Discard this draft?' })).toBeTruthy();
    expect(screen.getByTestId('draft-discard-lost')).toHaveTextContent('Changes to Name and persona, Variables are lost.');
    fireEvent.click(screen.getByTestId('draft-discard-cancel'));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.queryByTestId('draft-discard-confirm')).toBeNull();
  });

  it('discards once confirmed', () => {
    const onDiscard = vi.fn();
    render(<Cards onDiscard={onDiscard} />);
    fireEvent.click(screen.getByTestId('draft-discard'));
    fireEvent.click(screen.getByTestId('draft-discard-confirm-button'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('says all of it is lost while nothing is active', () => {
    render(<Cards onDiscard={vi.fn()} active={null} />);
    fireEvent.click(screen.getByTestId('draft-discard'));
    expect(screen.getByTestId('draft-discard-lost')).toHaveTextContent(/Everything in the draft is lost/);
  });

  it('is not offered to a person who may not edit the draft', () => {
    render(<Cards onDiscard={vi.fn()} canEdit={false} />);
    expect(screen.queryByTestId('draft-discard')).toBeNull();
  });
});

describe('an unsaved edit', () => {
  it('is named in the confirm, since discarding drops it with the draft', () => {
    render(<Cards onDiscard={vi.fn()} unsaved={['Welcome']} />);
    fireEvent.click(screen.getByTestId('draft-discard'));
    expect(screen.getByTestId('draft-discard-unsaved')).toHaveTextContent('Unsaved edits to Welcome are lost too.');
  });
});

describe("on the assistant's page", () => {
  const listing = (over: Record<string, unknown>) => ({
    profileName: 'advisor', displayName: 'Advisor', activeVersion: 1, versions: [],
    classification: 'premium', role: 'primary', origin: 'console', ...over,
  }) as unknown as svc.ProfileListing;
  const serve = (...answers: svc.ProfileListing[]) => {
    for (const p of answers) vi.mocked(svc.listProfilesAndTools).mockResolvedValueOnce({ profiles: [p], tools: [], runtimeAssistants: [], rosterTargets: [] });
  };
  const open = async () => {
    vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: [] });
    vi.mocked(svc.exportProfile).mockImplementation(async (_n, v) => ({
      body: v === 'draft' ? DRAFT : ACTIVE, provenance: { exportedConfigId: v === 'draft' ? 'cfg-seen' : 'cfg-active' },
    }) as unknown as svc.ProfileManifest);
    render(<CapabilityTestProvider capabilities={['view-profiles', 'edit-profiles', 'activate-profiles']}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    // The draft is one toggle away in the header, and its banner holds Discard.
    fireEvent.click(await screen.findByTestId('assistant-mode-draft'));
    await screen.findByTestId('draft-discard');
  };

  it('sends the configId the draft was loaded from, closes the draft, and offers Edit again', async () => {
    serve(listing({ hasDraft: true, draftConfigId: 'cfg-seen' }), listing({ hasDraft: false }));
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({ profiles: [listing({ hasDraft: false })], tools: [], runtimeAssistants: [], rosterTargets: [] });
    vi.mocked(svc.discardProfileDraft).mockResolvedValue({ profileName: 'advisor', discarded: true, configId: 'cfg-seen' });
    await open();
    fireEvent.click(screen.getByTestId('draft-discard'));
    fireEvent.click(screen.getByTestId('draft-discard-confirm-button'));
    await waitFor(() => expect(svc.discardProfileDraft).toHaveBeenCalledWith('advisor', 'cfg-seen'));
    expect(await screen.findByTestId('draft-discarded')).toHaveTextContent('The draft was discarded.');
    await waitFor(() => expect(screen.queryByTestId('assistant-draft')).toBeNull());
    expect(screen.getByTestId('new-version')).toHaveTextContent('Edit');
  });

  it('keeps a draft saved since, says why, and reloads', async () => {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({ profiles: [listing({ hasDraft: true, draftConfigId: 'cfg-seen' })], tools: [], runtimeAssistants: [], rosterTargets: [] });
    vi.mocked(svc.discardProfileDraft).mockRejectedValue(Object.assign(new Error('changed'), {
      status: 409, body: { code: 'DRAFT_CHANGED', configId: 'cfg-newer', error: 'saved again' },
    }));
    await open();
    const loads = vi.mocked(svc.listProfilesAndTools).mock.calls.length;
    fireEvent.click(screen.getByTestId('draft-discard'));
    fireEvent.click(screen.getByTestId('draft-discard-confirm-button'));
    expect(await screen.findByTestId('draft-discard-refused')).toHaveTextContent('it was saved again after this page loaded it');
    await waitFor(() => expect(vi.mocked(svc.listProfilesAndTools).mock.calls.length).toBeGreaterThan(loads));
    expect(screen.getByTestId('assistant-draft')).toBeTruthy();
  });
});
