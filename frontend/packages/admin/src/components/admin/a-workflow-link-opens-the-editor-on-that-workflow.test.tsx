/**
 * A WORKFLOW LINK OPENS THE ASSISTANT'S WORKFLOW EDITOR ON THAT WORKFLOW (`WorkflowEditorLink`, `assistantLinks.ts`).
 *
 * What it proves:
 *   - `?admin=profiles&assistant=<a>&workflow=<name>` or `&task=<machine>` is the link's URL, read back the same, and
 *     dropped when the console leaves the assistant;
 *   - the Assistants tab opened on such a link shows that assistant's Workflows section, on that workflow:
 *     an event workflow in the draft's builder where there is a draft the person may edit, never starting one;
 *     the same workflow marked and open in the active version's list for a person who cannot edit;
 *     a name no event workflow carries as the intent's entry; a task machine's key as that machine's steps; and an
 *     intent's key with a step as the machine the intent runs (resolved from the served intents, never from the step's
 *     name), that step marked in the read-only steps and selected in the draft's builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listOwnership } from '../../services/ownershipService';
import { CapabilityTestProvider } from '../../capabilities';
import { SHIPPED_EVENT_WORKFLOWS } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { workflowEditorFromUrl, workflowEditorSearch, withoutWorkflowEditorParams, type WorkflowEditorLink } from './assistantLinks';

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

const listing = (over: Partial<svc.ProfileListing> = {}) => ({
  profileName: 'ops-premium', displayName: 'Ops', activeVersion: 2, hasDraft: true, draftConfigId: 'draft-1',
  versions: [{ version: 2, configId: 'cfg-2', active: true }],
  classification: 'premium', role: 'ops', ownerTeam: 'ops', origin: 'deployed', ...over,
}) as unknown as svc.ProfileListing;

const PREMIUM: svc.ClassificationCatalog = {
  classification: 'premium', models: { text: ['sonnet'], image: [], default: 'sonnet' },
  workflows: [{ key: 'report_generation', source: 'classification' }] as unknown as svc.ClassificationCatalog['workflows'],
  retrievalReach: [], roles: { ops: { contextPrefixes: [] } },
};
const BODY: svc.ProfileDefinitionBody = { modelKey: 'sonnet', eventWorkflows: { 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'] } };

const EDITOR = ['view-profiles', 'edit-profiles', 'activate-profiles', 'manage-assistants', 'manage-ownership'];
const READER = ['view-profiles'];

function withListing(over: Partial<svc.ProfileListing> = {}) {
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
    profiles: [listing(over)], tools: [], runtimeAssistants: [], rosterTargets: [], classifications: { premium: PREMIUM }, fieldDecisions: {},
  } as unknown as Awaited<ReturnType<typeof svc.listProfilesAndTools>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  withListing();
  vi.mocked(svc.exportProfile).mockResolvedValue({ body: BODY } as unknown as svc.ProfileManifest);
  vi.mocked(svc.listMessageTemplates).mockResolvedValue({ assistant: 'ops-premium', classification: 'premium', templates: [], family: {} as never });
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['ops'] });
});

function openOn(link: WorkflowEditorLink, caps = EDITOR) {
  render(<CapabilityTestProvider capabilities={caps}><ProfilesTab initialAssistant={link.assistant} linkedWorkflow={link} /></CapabilityTestProvider>);
}

describe('the link', () => {
  it('names the assistant and one workflow or task machine, and reads back the same', () => {
    const wf = workflowEditorSearch({ assistant: 'ops-premium', workflow: 'ops-room' });
    expect(wf).toBe('?admin=profiles&assistant=ops-premium&workflow=ops-room');
    expect(workflowEditorFromUrl(wf)).toEqual({ assistant: 'ops-premium', workflow: 'ops-room' });
    const task = workflowEditorSearch({ assistant: 'ops-premium', task: 'report_generation' });
    expect(task).toBe('?admin=profiles&assistant=ops-premium&task=report_generation');
    expect(workflowEditorFromUrl(task)).toEqual({ assistant: 'ops-premium', task: 'report_generation' });
    expect(workflowEditorFromUrl('?admin=profiles')).toBeNull();
    expect(withoutWorkflowEditorParams(`${wf}&as=x`)).toBe('?admin=profiles&as=x');
    const step = workflowEditorSearch({ assistant: 'ops-premium', workflow: 'report_generation', step: 'gather' });
    expect(step).toBe('?admin=profiles&assistant=ops-premium&workflow=report_generation&step=gather');
    expect(workflowEditorFromUrl(step)).toEqual({ assistant: 'ops-premium', workflow: 'report_generation', step: 'gather' });
    expect(withoutWorkflowEditorParams(step)).toBe('?admin=profiles');
    // Effectiveness's own step rides with its intent and is left alone.
    expect(withoutWorkflowEditorParams('?admin=effectiveness&intent=x&step=gather')).toBe('?admin=effectiveness&intent=x&step=gather');
  });
});

describe('the editor opens on the linked workflow', () => {
  it('an event workflow opens in the draft\'s builder for a person who may edit, without starting a draft', async () => {
    openOn({ assistant: 'ops-premium', workflow: 'ops-room' });
    await screen.findByTestId('assistant-draft');
    const step = await screen.findByTestId('draft-step-events');
    await waitFor(() => expect((within(step).getByTestId('event-workflow-select') as HTMLSelectElement).value).toBe('ops-room'));
    expect(svc.createProfileVersion).not.toHaveBeenCalled();
  });

  it('with no draft, the active version\'s list marks it and the link starts none', async () => {
    withListing({ hasDraft: false, draftConfigId: undefined });
    openOn({ assistant: 'ops-premium', workflow: 'ops-room' });
    const item = await screen.findByTestId('assistant-workflow-own-ops-room');
    await waitFor(() => expect(item).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByTestId('assistant-workflow-own-ops-room-details')).toHaveAttribute('open');
    expect(screen.queryByTestId('draft-step-events')).toBeNull();
    expect(svc.createProfileVersion).not.toHaveBeenCalled();
  });

  it('a person who cannot edit reads it marked in the active version, not in the draft', async () => {
    openOn({ assistant: 'ops-premium', workflow: 'ops-room' }, READER);
    const item = await screen.findByTestId('assistant-workflow-own-ops-room');
    await waitFor(() => expect(item).toHaveAttribute('aria-current', 'true'));
    expect(screen.queryByTestId('assistant-draft')).toBeNull();
  });

  it('a name no event workflow carries opens the intent\'s entry', async () => {
    openOn({ assistant: 'ops-premium', workflow: 'report_generation' }, READER);
    const entry = await screen.findByTestId('workflow-intent-report_generation');
    await waitFor(() => expect(entry).toHaveAttribute('aria-current', 'true'));
  });

  it('a name carrying a quote or a bracket opens the Workflows section rather than failing the page', async () => {
    const failures: unknown[] = [];
    const onError = (e: ErrorEvent) => { failures.push(e.error); e.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      openOn({ assistant: 'ops-premium', workflow: 'say "hi"] [x' }, READER);
      await screen.findByTestId('assistant-performance-links');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Workflows' })).toHaveAttribute('aria-current'));
      await new Promise((r) => setTimeout(r, 0));
      expect(failures).toEqual([]);
      expect(screen.getByTestId('assistant-performance-links')).toBeTruthy();
    } finally {
      window.removeEventListener('error', onError);
    }
  });

  it('a name an object inherits (constructor, toString) names no event workflow, and the draft\'s builder stays up', async () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const failures: unknown[] = [];
      const onError = (e: ErrorEvent) => { failures.push(e.error); e.preventDefault(); };
      window.addEventListener('error', onError);
      try {
        const { unmount } = render(<CapabilityTestProvider capabilities={EDITOR}><ProfilesTab initialAssistant="ops-premium" linkedWorkflow={{ assistant: 'ops-premium', workflow: name }} /></CapabilityTestProvider>);
        await screen.findByTestId('assistant-performance-links');
        await waitFor(() => expect(screen.getByRole('button', { name: 'Workflows' })).toHaveAttribute('aria-current'));
        await new Promise((r) => setTimeout(r, 0));
        expect(failures).toEqual([]);
        expect(screen.queryByTestId('draft-step-events')).toBeNull();
        unmount();
      } finally {
        window.removeEventListener('error', onError);
      }
    }
  });

  it('opens once: leaving the assistant and opening it again shows it as any other', async () => {
    openOn({ assistant: 'ops-premium', task: 'report_generation' }, READER);
    await screen.findByTestId('assistant-machine-view');
    fireEvent.click(screen.getByRole('button', { name: '← Assistants' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Open (Ops|ops-premium)$/ }));
    await screen.findByTestId('assistant-performance-links');
    expect(screen.queryByTestId('assistant-machine-view')).toBeNull();
  });

  it('a task machine\'s key opens that machine\'s steps', async () => {
    openOn({ assistant: 'ops-premium', task: 'report_generation' }, READER);
    const view = await screen.findByTestId('assistant-machine-view');
    expect(within(view).getByRole('heading', { level: 3 })).toHaveTextContent('report_generation');
  });
});

describe('an intent\'s step opens the intent\'s machine on that step', () => {
  // The intent `reporting` runs the machine `report_generation`: the machine is found from the intent, never from a step's name.
  const MACHINE = { initial: 'gather', states: { gather: { transitions: ['done'] }, done: { transitions: [] } } };
  const WITH_INTENT: svc.ClassificationCatalog = {
    ...PREMIUM,
    workflows: [{ key: 'report_generation', source: 'classification', steps: [
      { key: 'gather', transitions: ['done'] }, { key: 'done', transitions: [], terminal: 'success' },
    ] }] as unknown as svc.ClassificationCatalog['workflows'],
    intents: [{ key: 'reporting', description: '', multiStep: true, machine: 'report_generation' }] as unknown as svc.ClassificationCatalog['intents'],
  };
  function withCatalog(over: Partial<svc.ProfileListing> = {}) {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [listing(over)], tools: [], runtimeAssistants: [], rosterTargets: [],
      classifications: { premium: WITH_INTENT }, fieldDecisions: {},
    } as unknown as Awaited<ReturnType<typeof svc.listProfilesAndTools>>);
  }

  it('the read-only steps mark the linked step', async () => {
    withCatalog({ hasDraft: false, draftConfigId: undefined });
    openOn({ assistant: 'ops-premium', workflow: 'reporting', step: 'gather' }, READER);
    const view = await screen.findByTestId('assistant-machine-view');
    expect(within(view).getByRole('heading', { level: 3 })).toHaveTextContent('report_generation');
    await waitFor(() => expect(screen.getByTestId('assistant-machine-step-gather')).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByTestId('assistant-machine-step-done')).not.toHaveAttribute('aria-current');
  });

  it('an intent that runs no machine opens its entry, not a machine named like the step', async () => {
    withCatalog({ hasDraft: false, draftConfigId: undefined });
    openOn({ assistant: 'ops-premium', workflow: 'general', step: 'report_generation' }, READER);
    await screen.findByTestId('assistant-section-workflows');
    expect(screen.queryByTestId('assistant-machine-view')).toBeNull();
  });

  it('the draft\'s builder opens with the linked step selected', async () => {
    withCatalog();
    vi.mocked(svc.exportProfile).mockResolvedValue({
      body: { ...BODY, intentPack: { machines: { report_generation: MACHINE } } },
    } as unknown as svc.ProfileManifest);
    openOn({ assistant: 'ops-premium', workflow: 'reporting', step: 'gather' });
    await screen.findByTestId('assistant-machine-editor');
    await waitFor(() => expect(screen.getByTestId('mb-node-gather')).toHaveAttribute('aria-pressed', 'true'));
  });
});
