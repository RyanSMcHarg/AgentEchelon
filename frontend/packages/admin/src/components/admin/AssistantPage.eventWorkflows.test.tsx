/**
 * EVERY EVENT WORKFLOW OF THE SERVING VERSION IS READ ON THE ASSISTANT'S PAGE (SPEC-ADMIN-CONSOLE "Assistants", Workflows).
 *
 * What it proves:
 *   - the Workflows section lists every event workflow the active version declares, welcomes and the rest, each with the
 *     event that starts it in words, its rooms and its steps in order;
 *   - a welcome shows what it says, composed by the router's composer: a text opening with the room's event summary as a
 *     marked placeholder, and a structured opening with its examples as the list a person sees;
 *   - each is read-only, and Edit in a draft opens the draft's Workflows section with the builder on that workflow;
 *   - an assistant with none says so, and says it welcomes through onboarding where its version declares an intake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listOwnership } from '../../services/ownershipService';
import { CapabilityTestProvider } from '../../capabilities';
import { OPS_WELCOME } from '../../../../../../backend/demo/welcomes';
import { PLATFORM_EVENT_WORKFLOWS } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

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
  previewWorkflowRun: vi.fn(),
}));
vi.mock('../../services/rosterService', () => ({ listTeamRoster: vi.fn(), createAssistant: vi.fn(), retireAssistant: vi.fn(), setTurnLimit: vi.fn() }));
vi.mock('../../services/ownershipService', () => ({ listOwnership: vi.fn(), setOwnership: vi.fn() }));

const listing = (profileName: string, displayName: string, over: Partial<svc.ProfileListing> = {}) => ({
  profileName, displayName, activeVersion: 2, hasDraft: true, draftConfigId: 'draft-1',
  versions: [{ version: 2, configId: 'cfg-2', active: true }],
  classification: 'premium', role: 'ops', ownerTeam: 'ops', origin: 'deployed', ...over,
}) as unknown as svc.ProfileListing;

const PREMIUM: svc.ClassificationCatalog = {
  classification: 'premium', models: { text: ['sonnet'], image: [], default: 'sonnet' }, workflows: [],
  retrievalReach: [], roles: { ops: { contextPrefixes: [] } },
};

/** The ops assistant's serving version: the seeded welcomes, and a room an event opens. */
const OPS_BODY: svc.ProfileDefinitionBody = {
  modelKey: 'sonnet', eventWorkflows: { ...OPS_WELCOME, 'ops-room': PLATFORM_EVENT_WORKFLOWS['ops-room'] },
};
const BODIES: Record<string, svc.ProfileDefinitionBody> = {
  'ops-premium': OPS_BODY,
  concierge: { modelKey: 'sonnet', onboarding: { greeting: 'Welcome', fields: [{ key: 'team', prompt: 'Which team?' }] } },
  quiet: { modelKey: 'sonnet' },
};

const ADMIN_CAPS = ['view-profiles', 'edit-profiles', 'activate-profiles', 'manage-assistants', 'manage-ownership'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
    profiles: [listing('ops-premium', 'Ops'), listing('concierge', 'Concierge', { hasDraft: false }), listing('quiet', 'Quiet')],
    tools: [], runtimeAssistants: [], rosterTargets: [], classifications: { premium: PREMIUM }, fieldDecisions: {},
  } as unknown as Awaited<ReturnType<typeof svc.listProfilesAndTools>>);
  vi.mocked(svc.exportProfile).mockImplementation(async (name) => ({ body: BODIES[name] }) as unknown as svc.ProfileManifest);
  vi.mocked(svc.listMessageTemplates).mockResolvedValue({ assistant: 'ops-premium', classification: 'premium', templates: [], family: {} as never });
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['ops'] });
});

/** Open an assistant and its Workflows section, showing the serving version. */
async function openWorkflows(displayName: string) {
  render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
  fireEvent.click(await screen.findByRole('button', { name: `Open ${displayName}` }));
  fireEvent.click(await screen.findByTestId('assistant-nav-workflows'));
  return screen.findByTestId('assistant-section-workflows');
}

describe('the serving version\'s event workflows', () => {
  it('lists every one, welcomes and the rest, with its event in words, its rooms and its steps', async () => {
    await openWorkflows('Ops');
    for (const name of ['welcome', 'welcome-ops', 'ops-room']) expect(await screen.findByTestId(`assistant-workflow-own-${name}`)).toBeTruthy();
    expect(screen.getByTestId('workflow-starts-ops-room')).toHaveTextContent('Starts when an event opens a conversation, in ops.');
    expect(screen.getByTestId('workflow-starts-welcome-ops')).toHaveTextContent('Starts when the assistant joins a conversation, in ops.');
    expect(screen.getByTestId('workflow-starts-welcome')).toHaveTextContent('in every conversation no other welcome names.');
    expect(screen.getByTestId('workflow-steps-ops-room')).toHaveTextContent(
      'Steps Send (ops-room-opening) → Send (ops-lead-welcome) → Assistant step as ops (ops-first-look) → End',
    );
    expect(screen.getByTestId('workflow-steps-welcome')).toHaveTextContent('Steps Opening → End');
    // A workflow on another event has no opening to preview.
    expect(screen.queryByTestId('workflow-says-ops-room')).toBeNull();
  });

  it('shows what a text welcome says, the room\'s event summary as a marked placeholder', async () => {
    await openWorkflows('Ops');
    const opening = await screen.findByTestId('workflow-opening-welcome-ops');
    expect(opening.textContent).toContain('This conversation is open for an operations issue.');
    expect(opening.textContent).toContain('‹event summary›');
    expect(opening.textContent).not.toContain('{{eventSummary}}');
    expect(screen.getByTestId('workflow-says-source-welcome-ops')).toHaveTextContent('Its own text');
  });

  it('shows what a structured welcome says, its examples as the list a person sees', async () => {
    await openWorkflows('Ops');
    const opening = await screen.findByTestId('workflow-opening-welcome');
    expect(opening.textContent).toContain('Hi - I\'m your assistant at Stratum Technologies');
    expect(within(opening).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'What is the error rate across the deployment right now?',
      'Which functions are slowest, and since when?',
      'Which alarms are in alarm, and what do they cover?',
    ]);
    expect(screen.getByTestId('workflow-says-source-welcome')).toHaveTextContent('Composed from the fields its opening sets');
  });

  it('is read-only, and Edit in a draft opens the draft\'s builder on that workflow', async () => {
    const card = await openWorkflows('Ops');
    expect(within(card).queryByTestId('draft-step-events')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit ops-room in a draft' }));
    await screen.findByTestId('assistant-draft');
    const step = await screen.findByTestId('draft-step-events');
    await waitFor(() => expect((within(step).getByTestId('event-workflow-select') as HTMLSelectElement).value).toBe('ops-room'));
    expect(vi.mocked(svc.exportProfile)).toHaveBeenCalledWith('ops-premium', 'draft');
  });

  it('starts a draft first when there is none', async () => {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [listing('ops-premium', 'Ops', { hasDraft: false, draftConfigId: undefined })],
      tools: [], runtimeAssistants: [], rosterTargets: [], classifications: { premium: PREMIUM }, fieldDecisions: {},
    } as unknown as Awaited<ReturnType<typeof svc.listProfilesAndTools>>);
    vi.mocked(svc.createProfileVersion).mockResolvedValue({ profileName: 'ops-premium', draftConfigId: 'draft-1' });
    await openWorkflows('Ops');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit welcome-ops in a draft' }));
    await waitFor(() => expect(svc.createProfileVersion).toHaveBeenCalledWith('ops-premium'));
  });
});

describe('an assistant with no event workflows', () => {
  it('says it welcomes through onboarding where its version declares an intake', async () => {
    await openWorkflows('Concierge');
    expect(await screen.findByTestId('event-workflows-none')).toHaveTextContent('Concierge has no event workflows. It welcomes people through onboarding');
  });

  it('says it has none otherwise', async () => {
    await openWorkflows('Quiet');
    expect(await screen.findByTestId('event-workflows-none')).toHaveTextContent('No event workflows.');
  });
});
