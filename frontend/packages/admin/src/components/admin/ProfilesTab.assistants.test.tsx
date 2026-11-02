/**
 * THE ASSISTANTS TAB: ONE LIST, CONFIGURATION IN GROUPS, OWNERSHIP INSIDE IT, DEPLOY STEPS SAID IN PLACE
 * (owner decision, 2026-10-23).
 *
 * What it proves: an admin's tab reads the one admin listing and shows declared and console-created
 * assistants together, with no runtime section and no separate ownership section; an assistant's
 * configuration is grouped in order under headings, with the owning team in its identity group; what
 * only a deploy changes says so with a link; turns per hour is a limit with what it limits; a team member's
 * tab reads only their own routes (each owned assistant's and each team's roster), and a team that owns
 * nothing is told so and offered the create flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listTeamRoster, createAssistant } from '../../services/rosterService';
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

const OPS = {
  profileName: 'ops-premium', displayName: 'Ops', activeVersion: 2, hasDraft: false, versions: [{ version: 2, configId: 'cfg-2', active: true }],
  classification: 'premium', role: 'ops', ownerTeam: 'ops', origin: 'deployed', deployedTurnLimit: 120,
} as unknown as svc.ProfileListing;
const FINANCE = {
  profileName: 'finance-advisor', displayName: 'Finance', activeVersion: 1, hasDraft: false, versions: [],
  classification: 'premium', role: 'primary', ownerTeam: null, origin: 'console',
} as unknown as svc.ProfileListing;
const ADMIN_CAPS = ['view-profiles', 'edit-profiles', 'activate-profiles', 'manage-assistants', 'manage-ownership'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
    profiles: [OPS, FINANCE], tools: [],
    runtimeAssistants: [{ assistant: 'finance-advisor', classification: 'premium', role: 'primary', status: 'active', displayName: 'Finance' }],
    rosterTargets: [{ classification: 'premium', roles: ['primary', 'ops'] }],
  });
  vi.mocked(svc.exportProfile).mockResolvedValue({ body: { modelKey: 'sonnet', displayName: 'Ops', tools: [] } } as unknown as svc.ProfileManifest);
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['finance', 'ops'] });
});

const renderAs = (capabilities: string[], extra: Partial<React.ComponentProps<typeof CapabilityTestProvider>> = {}) => render(
  <CapabilityTestProvider capabilities={capabilities} {...extra}>
    <ProfilesTab />
  </CapabilityTestProvider>,
);

describe('an admin', () => {
  it('sees one list of every assistant, with no runtime or ownership section', async () => {
    renderAs(ADMIN_CAPS);
    expect(await screen.findByRole('heading', { name: /^Assistants/ })).toBeTruthy();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Open Ops' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Finance' })).toBeTruthy();
    expect(screen.queryByText(/Runtime assistants/i)).toBeNull();
    expect(screen.queryByText('Team ownership')).toBeNull();
    expect(screen.queryByTestId('ownership-panel')).toBeNull();
    expect(screen.queryByTestId('roster-panel')).toBeNull();
  });

  /** The create's first two steps, filled in: classification and name, then starting point and models. */
  const createTaxAdvisor = async () => {
    fireEvent.click(await screen.findByTestId('create-assistant-open'));
    fireEvent.change(screen.getByLabelText('Identifier'), { target: { value: 'tax-advisor' } });
    fireEvent.change(screen.getByLabelText('Assistant name'), { target: { value: 'Tax' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Default model'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }));
  };
  const listing = (status: 'provisioning' | 'active', withProfile = false) => ({
    profiles: [OPS, FINANCE, ...(withProfile ? [{
      profileName: 'tax-advisor', displayName: 'Tax', activeVersion: null, hasDraft: true, draftConfigId: 'draft-tax', versions: [],
      classification: 'premium', role: 'primary', ownerTeam: null, origin: 'console',
    }] : [])], tools: [],
    runtimeAssistants: [
      { assistant: 'finance-advisor', classification: 'premium', role: 'primary', status: 'active', displayName: 'Finance' },
      { assistant: 'tax-advisor', classification: 'premium', role: 'primary', status, displayName: 'Tax' },
    ],
    rosterTargets: [{ classification: 'premium', roles: ['primary', 'ops'] }],
    classifications: { premium: { classification: 'premium', models: { text: ['sonnet'], image: [] }, retrievalReach: [], roles: {} } },
  }) as unknown as Awaited<ReturnType<typeof svc.listProfilesAndTools>>;

  it('says a new assistant is being built while its build runs, and stops saying so once its row shows it ready', async () => {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({ ...listing('active'), runtimeAssistants: listing('active').runtimeAssistants.slice(0, 1) });
    vi.mocked(createAssistant).mockResolvedValue({ assistantId: 'tax-advisor', status: 'provisioning' });
    renderAs(ADMIN_CAPS);
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue(listing('provisioning'));
    await createTaxAdvisor();
    // The wizard waits on its next step; leaving it keeps the notice.
    expect(await screen.findByTestId('create-building')).toHaveTextContent('tax-advisor is being built');
    fireEvent.click(screen.getByRole('button', { name: 'Finish later' }));
    expect(await screen.findByTestId('created-notice')).toHaveTextContent('tax-advisor is being created');
    // The build finished: the next load shows it active, and its row (draft ready) takes over from the notice.
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue(listing('active'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByTestId('created-notice')).toBeNull());
  });

  it('continues the wizard on the new draft once a load shows the build made it, in the page\'s own sections', async () => {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({ ...listing('active'), runtimeAssistants: listing('active').runtimeAssistants.slice(0, 1) });
    vi.mocked(createAssistant).mockResolvedValue({ assistantId: 'tax-advisor', status: 'provisioning' });
    renderAs(ADMIN_CAPS);
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue(listing('provisioning'));
    await createTaxAdvisor();
    await screen.findByTestId('create-building');
    expect(screen.queryByTestId('assistant-setup')).toBeNull();
    // Checking the build reads the listing again; this one shows the assistant with its draft.
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue(listing('active', true));
    fireEvent.click(screen.getByTestId('create-check-build'));
    const setup = await screen.findByTestId('assistant-setup');
    const heading = () => within(setup).getByTestId('setup-step-heading');
    expect(heading()).toHaveTextContent('Step 3 of 7: Behavioral');
    // The page's own editor for the name and persona, not a parallel one.
    expect(within(setup).getByTestId('assistant-config-identity')).toBeTruthy();
    expect(await within(setup).findByTestId('draft-step-identity')).toBeTruthy();
    // An edit on the step is saved on the way to the next, as one patch of that step's areas.
    vi.mocked(svc.editProfileDraft).mockResolvedValue({ profileName: 'tax-advisor', draftConfigId: 'draft-tax-2' });
    fireEvent.change(within(setup).getByTestId('draft-persona'), { target: { value: 'You do taxes.' } });
    expect(within(setup).getByTestId('setup-next')).toHaveTextContent('Save and continue');
    fireEvent.click(within(setup).getByTestId('setup-next'));
    await waitFor(() => expect(heading()).toHaveTextContent('Step 4 of 7: Workflows'));
    expect(svc.editProfileDraft).toHaveBeenCalledWith('tax-advisor', { persona: 'You do taxes.' });
    vi.mocked(svc.editProfileDraft).mockClear();
    expect(within(setup).getByTestId('draft-step-welcome')).toBeTruthy();
    // Nothing edited here: the step moves on without a save.
    fireEvent.click(within(setup).getByTestId('setup-next'));
    expect(heading()).toHaveTextContent('Step 5 of 7: Scope and models');
    expect(svc.editProfileDraft).not.toHaveBeenCalled();
    fireEvent.click(within(setup).getByTestId('setup-next'));
    expect(heading()).toHaveTextContent('Step 6 of 7: Tools and context');
    fireEvent.click(within(setup).getByTestId('setup-next'));
    // The review is the page's draft banner: Discard, Validate and Activate over what the draft sets.
    expect(heading()).toHaveTextContent('Step 7 of 7: Review and activate');
    expect(within(setup).getByTestId('assistant-draft')).toBeTruthy();
    expect(within(setup).getByTestId('draft-diff')).toBeVisible();
    expect(within(setup).getByRole('button', { name: /^Activate draft as v1$/ })).toBeTruthy();
    // Finish later leaves the wizard for the assistant's page, where the same draft carries on.
    fireEvent.click(within(setup).getByTestId('setup-finish-later'));
    expect(screen.queryByTestId('assistant-setup')).toBeNull();
    expect(await screen.findByTestId('assistant-draft')).toBeTruthy();
  });

  it('opens the create flow from the list', async () => {
    renderAs(ADMIN_CAPS);
    fireEvent.click(await screen.findByTestId('create-assistant-open'));
    expect(screen.getByTestId('create-assistant')).toBeTruthy();
  });

  it('sees an assistant in sections, in order, each with a one-line note, one section at a time', async () => {
    renderAs(ADMIN_CAPS);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ops' }));
    const menu = await screen.findByRole('navigation', { name: 'Configuration sections' });
    const items = within(menu).getAllByRole('button').map((b) => b.textContent);
    expect(items).toEqual(['Behavioral', 'Workflows', 'Scope and models', 'Tools and context', 'Variables', 'Versions']);
    expect(within(menu).getAllByRole('listitem')[0]).toHaveTextContent('Name and persona');
    // One section shows: Behavioral first, then whichever the menu opens.
    expect((await screen.findAllByRole('heading', { level: 4 })).map((h) => h.textContent)).toEqual(['Behavioral']);
    fireEvent.click(within(menu).getByRole('button', { name: 'Versions' }));
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Versions']);
  });

  it('finds the owning team inside the identity group, with classification and role shown as facts, not settings', async () => {
    renderAs(ADMIN_CAPS);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ops' }));
    const identity = await screen.findByTestId('assistant-config-identity');
    expect(within(identity).getByTestId('assistant-owner')).toBeTruthy();
    expect(identity).toHaveTextContent('premium');
    expect(identity).toHaveTextContent('ops');
    // An assistant is in one classification for its life and fills a role a deploy created: the page says so
    // as a fact, in the create flow's words and with its guide, and never as a warning bar or a control.
    expect(within(identity).queryByRole('note')).toBeNull();
    expect(within(identity).getByTestId('fixed-for-life')).toHaveTextContent('A new classification or role needs a deploy.');
    expect(within(identity).getByRole('link', { name: /Adding a role/ })).toBeTruthy();
  });

  it('shows turns per hour as a limit, with what it limits', async () => {
    renderAs(ADMIN_CAPS);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Ops' }));
    fireEvent.click(await screen.findByTestId('assistant-nav-tools'));
    const limits = await screen.findByTestId('assistant-config-limits');
    expect(within(limits).getByText('120 turns per hour')).toBeTruthy();
    expect(limits).toHaveTextContent('one person may send this assistant');
    expect(within(limits).queryByRole('note')).toBeNull();
  });
});

describe('a team member', () => {
  it('reads only their own routes, and sees only their own assistants', async () => {
    vi.mocked(svc.listOwnedProfiles).mockResolvedValue({ profiles: [OPS], tools: [], runtimeAssistants: [], rosterTargets: [] });
    vi.mocked(listTeamRoster).mockResolvedValue({ runtimeAssistants: [], rosterTargets: [{ classification: 'premium', roles: ['ops'] }] });
    renderAs(['view-profiles', 'edit-profiles', 'manage-assistants', 'manage-ownership'], { role: 'team-members', assistants: ['ops-premium'], teams: ['ops'] });
    expect(await screen.findByRole('button', { name: 'Open Ops' })).toBeTruthy();
    expect(svc.listProfilesAndTools).not.toHaveBeenCalled();
    expect(listOwnership).not.toHaveBeenCalled();
    expect(svc.listOwnedProfiles).toHaveBeenCalledWith(['ops-premium']);
    expect(listTeamRoster).toHaveBeenCalledWith('ops');
    expect(screen.queryByRole('button', { name: 'Open Finance' })).toBeNull();
    expect(screen.getByTestId('assistants-team-filter')).toHaveTextContent('Ops team');
    // No retire for a team member, and no import on the list: an import lives in one assistant's Versions.
    expect(screen.queryByText('Retire')).toBeNull();
    expect(screen.queryByText(/import/i)).toBeNull();
  });

  it('whose team owns nothing is told so, and offered the create flow for their team', async () => {
    vi.mocked(listTeamRoster).mockResolvedValue({ runtimeAssistants: [], rosterTargets: [{ classification: 'premium', roles: ['ops'] }] });
    renderAs(['view-profiles', 'manage-assistants'], { role: 'team-members', assistants: [], teams: ['ops'] });
    expect(await screen.findByTestId('assistants-empty')).toHaveTextContent('Your team owns no assistants yet.');
    expect(svc.listOwnedProfiles).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('create-assistant-open'));
    expect(screen.getByTestId('create-assistant')).toBeTruthy();
  });
});
