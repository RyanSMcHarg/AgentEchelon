/**
 * AN ASSISTANT'S VERSION CONTROLS SAY WHAT THEY START FROM, AND A TEAM'S NEW ASSISTANT OPENS WITHOUT A
 * SIGN-OUT (ADR-048, SPEC-ADMIN-CONSOLE FR0f, FR48).
 *
 * What it proves:
 *   - with an active version, the header's draft toggle is "Edit" and says it copies the active version; with
 *     none, it is "Start first draft" and says the draft starts from the classification's defaults; a
 *     session without edit-profiles is told why there is no control rather than shown a dead one;
 *   - Validate renders only for a session holding view-profiles, the capability its route needs;
 *   - the header's Effectiveness and Conversations links name the assistant, and Effectiveness its version;
 *   - a team member whose session does not yet name an active assistant on their team's roster has the
 *     session re-issued once, and not again on the next load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listTeamRoster } from '../../services/rosterService';
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

const listing = (over: Record<string, unknown>) => ({
  profileName: 'finance-advisor', displayName: 'Finance', activeVersion: 1, hasDraft: false, versions: [],
  classification: 'premium', role: 'primary', ownerTeam: 'finance', origin: 'console', ...over,
}) as unknown as svc.ProfileListing;

const serve = (profile: svc.ProfileListing) => {
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({ profiles: [profile], tools: [], runtimeAssistants: [], rosterTargets: [] });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.exportProfile).mockResolvedValue({ body: { modelKey: 'sonnet', tools: [] } } as unknown as svc.ProfileManifest);
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['finance'] });
});

const open = async (capabilities: string[], props: React.ComponentProps<typeof ProfilesTab> = {}) => {
  render(<CapabilityTestProvider capabilities={capabilities}><ProfilesTab {...props} /></CapabilityTestProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Finance' }));
};

describe('the draft toggle says what a new draft starts from', () => {
  it('copies the active version when there is one, and shows the draft in place', async () => {
    serve(listing({ activeVersion: 2 }));
    await open(['view-profiles', 'edit-profiles']);
    const control = await screen.findByTestId('new-version');
    expect(control).toHaveTextContent('Edit');
    expect(control.getAttribute('title')).toContain('Copies the active version into a draft');
    fireEvent.click(control);
    await waitFor(() => expect(svc.createProfileVersion).toHaveBeenCalledWith('finance-advisor'));
  });

  it("starts a first draft from the classification's defaults when there is no version", async () => {
    serve(listing({ activeVersion: null }));
    await open(['view-profiles', 'edit-profiles']);
    const control = await screen.findByTestId('new-version');
    expect(control).toHaveTextContent('Start first draft');
    expect(control.getAttribute('title')).toContain("starts from its classification's defaults");
    expect(screen.getByTestId('assistant-mode-active')).toBeDisabled();
  });

  it('explains its absence to a session without edit-profiles', async () => {
    serve(listing({ activeVersion: 2 }));
    await open(['view-profiles']);
    expect(await screen.findByTestId('new-version-not-held')).toHaveTextContent('needs the edit-profiles capability');
    expect(screen.queryByTestId('new-version')).toBeNull();
  });
});

describe('Validate', () => {
  it('renders on the draft banner for a session holding view-profiles', async () => {
    serve(listing({ hasDraft: true }));
    await open(['view-profiles', 'edit-profiles', 'activate-profiles']);
    fireEvent.click(await screen.findByTestId('assistant-mode-draft'));
    expect(await screen.findByRole('button', { name: 'Validate' })).toBeTruthy();
  });

  it('is absent without view-profiles', async () => {
    serve(listing({ hasDraft: true }));
    await open(['edit-profiles', 'activate-profiles']);
    fireEvent.click(await screen.findByTestId('assistant-mode-draft'));
    await screen.findByRole('button', { name: /^Activate draft/ });
    expect(screen.queryByRole('button', { name: 'Validate' })).toBeNull();
  });
});

describe('the performance links', () => {
  it('open Effectiveness for the active version and Conversations, each narrowed to the assistant', async () => {
    serve(listing({}));
    const onOpenLink = vi.fn();
    await open(['view-profiles'], { onOpenLink });
    const effectiveness = await screen.findByTestId('assistant-link-effectiveness');
    expect(effectiveness).toHaveTextContent('Effectiveness for v1');
    // A real URL, so it opens in a new tab or can be sent to someone.
    expect(effectiveness.getAttribute('href')).toBe('?admin=effectiveness&as=finance-advisor&ver=1');
    fireEvent.click(effectiveness);
    expect(onOpenLink).toHaveBeenCalledWith({ tab: 'effectiveness', assistant: 'finance-advisor', version: 1 });
    fireEvent.click(screen.getByTestId('assistant-link-conversations'));
    expect(onOpenLink).toHaveBeenCalledWith({ tab: 'conversations', assistant: 'finance-advisor' });
  });
});

describe("a team member's new assistant", () => {
  it('re-issues the session once when the roster shows an active assistant the session does not name', async () => {
    vi.mocked(listTeamRoster).mockResolvedValue({
      team: 'ops',
      runtimeAssistants: [{ assistant: 'ops-new', classification: 'premium', role: 'primary', status: 'active', ownerTeam: 'ops' }],
      rosterTargets: [],
    } as never);
    const reissue = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <CapabilityTestProvider capabilities={['view-profiles', 'manage-assistants']} role="team-members" teams={['ops']} assistants={[]} reissue={reissue}>
        <ProfilesTab />
      </CapabilityTestProvider>,
    );
    await waitFor(() => expect(reissue).toHaveBeenCalledTimes(1));
    // A refresh that still finds it unnamed (its owner tag was not written) does not ask again.
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(listTeamRoster).toHaveBeenCalledTimes(2));
    rerender(
      <CapabilityTestProvider capabilities={['view-profiles', 'manage-assistants']} role="team-members" teams={['ops']} assistants={[]} reissue={reissue}>
        <ProfilesTab />
      </CapabilityTestProvider>,
    );
    expect(reissue).toHaveBeenCalledTimes(1);
  });

  it('does not re-issue for an assistant still being built, or one the session already names', async () => {
    vi.mocked(svc.listOwnedProfiles).mockResolvedValue({ profiles: [], tools: [] } as never);
    vi.mocked(listTeamRoster).mockResolvedValue({
      team: 'ops',
      runtimeAssistants: [
        { assistant: 'ops-building', classification: 'premium', role: 'primary', status: 'provisioning', ownerTeam: 'ops' },
        { assistant: 'ops-owned', classification: 'premium', role: 'primary', status: 'active', ownerTeam: 'ops' },
      ],
      rosterTargets: [],
    } as never);
    const reissue = vi.fn().mockResolvedValue(true);
    render(
      <CapabilityTestProvider capabilities={['view-profiles', 'manage-assistants']} role="team-members" teams={['ops']} assistants={['ops-owned']} reissue={reissue}>
        <ProfilesTab />
      </CapabilityTestProvider>,
    );
    await waitFor(() => expect(listTeamRoster).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Refresh' });
    expect(reissue).not.toHaveBeenCalled();
  });
});
