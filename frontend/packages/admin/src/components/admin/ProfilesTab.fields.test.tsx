/**
 * EVERY ELEMENT OF AN ASSISTANT'S PAGE IS A CONTROL, JSON WITH ITS EDIT PATH, OR READ-ONLY WITH WHAT DRIVES IT
 * (SPEC-ADMIN-CONSOLE "Assistants", the owner's rule).
 *
 * What it proves:
 *   - the draft is edited in place, section by section, and its model selects offer only the models the classification selects;
 *   - every behavior-affecting field of the active version renders (context sources, workflows, welcome,
 *     onboarding, messages, boundary, tested instruction, image model, classifier mode), and each one that has
 *     no control says how it is changed;
 *   - the Platform section is present and labeled platform-level and not editable;
 *   - the guardrail selector offers only the classification's catalog and saves through the draft patch;
 *   - the welcome is edited with controls and sent in the draft patch as its workflow (W1), and only once edited;
 *   - what the assistant says has ONE section, Message templates: no legacy Messages section and no separate message
 *     choices, and picking the template a message uses there writes the draft's `messages`; a draft's retired `copy`
 *     lines are explained and cleared, never edited.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import ProfilesTab, { roleTasksFor } from './ProfilesTab';
import * as svc from '../../services/profileService';
import { listOwnership } from '../../services/ownershipService';
import { CapabilityTestProvider } from '../../capabilities';
import { shippedMessageTemplates } from '../../../../../../backend/lambda/src/lib/shipped-message-templates.ts';

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

const PREMIUM: svc.ClassificationCatalog = {
  classification: 'premium',
  models: { text: ['haiku', 'sonnet'], image: ['stability_image_core'], default: 'sonnet' },
  guardrails: [{ key: 'strict', guardrailId: 'gr-strict' }],
  contextSources: [{ key: 'crm', description: 'Accounts' }, { key: 'wiki' }],
  templates: [{ name: 'report', active: 'a'.repeat(64) }],
  workflows: [
    { key: 'report_request', source: 'platform', required: false, initial: 'gathering', states: ['gathering', 'drafting', 'delivered'] },
    { key: 'queue_drain', source: 'platform', required: true, initial: 'triage', states: ['triage', 'done'] },
  ],
  packIntents: ['report_request'],
  topology: { processorTimeout: 120, memorySize: 1024 },
  retrievalReach: ['context/basic/', 'context/premium/'],
  contextBucket: 'ae-company',
  roles: { primary: { contextPrefixes: ['context/basic/', 'context/premium/'] } },
  budgets: { userHourly: 750, globalHourly: 1500 },
};

/** The backend's declared table, as the listing serves it (`profile-field-decisions.ts`). */
const DECISIONS: Record<string, svc.FieldDecision> = {
  modelKey: { kind: 'readonly', drivenBy: 'model-bundle', guide: 'models' },
  models: { kind: 'control' }, tools: { kind: 'control' }, guardrailId: { kind: 'control' }, displayName: { kind: 'control' },
  persona: { kind: 'control' }, contextSources: { kind: 'control' }, welcome: { kind: 'readonly', drivenBy: 'migration', guide: 'welcome' }, eventWorkflows: { kind: 'control' }, copy: { kind: 'readonly', drivenBy: 'migration', guide: 'messages' },
  intentPack: { kind: 'json', command: 'npm run assistant -- draft <assistant> --config <configId> --patch <file.json>', guide: 'personaOrPack' },
  workflows: { kind: 'json', command: 'npm run assistant -- draft <assistant> --config <configId> --patch <file.json>', guide: 'globalWorkflows' },
  confirmBrief: { kind: 'json', command: 'npm run assistant -- draft <assistant> --config <configId> --patch <file.json>', guide: 'globalWorkflows' },
  machines: { kind: 'readonly', drivenBy: 'classification-pack', guide: 'globalWorkflows' },
  onboarding: { kind: 'json', command: 'npm run assistant -- draft <assistant> --config <configId> --patch <file.json>', guide: 'onboarding' },
  boundary: { kind: 'json', command: 'npm run assistant -- draft <assistant> --config <configId> --patch <file.json>', guide: 'boundary' },
  systemPromptAddendum: { kind: 'readonly', drivenBy: 'experiments', guide: 'experiments' },
};

/** A welcome (W1): the assistant-joined workflow whose one step is this opening. */
function welcomeSaying(opening: Record<string, unknown>) {
  return {
    on: 'assistant-joined' as const, initial: 'opening',
    states: { opening: { opening, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' as const } },
  };
}

const BODY: svc.ProfileDefinitionBody = {
  modelKey: 'sonnet',
  models: { default: 'sonnet', classifier: 'default', byIntent: { report_request: { primary: 'sonnet' }, image_generation: { image: { primary: 'stability_image_core' } } } },
  tools: ['search_context'],
  guardrailId: 'gr-strict',
  persona: 'You advise.',
  contextSources: ['crm'],
  workflows: ['report_request'],
  confirmBrief: { image_generation: 'always' },
  eventWorkflows: { welcome: welcomeSaying({ text: 'I am the advisor.', examples: ['How did Q3 close?'] }) },
  onboarding: { greeting: 'Welcome aboard', fields: [{ key: 'team', prompt: 'Which team are you on?' }] },
  copy: { rateLimited: 'Give me a minute.' },
  boundary: 'I do not reach payroll.',
  systemPromptAddendum: 'Be brief.',
};

const ADMIN_CAPS = ['view-profiles', 'edit-profiles', 'activate-profiles', 'manage-assistants', 'manage-ownership'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
    profiles: [ADVISOR], tools: [{ name: 'search_context', category: 'context', changesState: false, description: 'Search', requires: 'nothing' }],
    runtimeAssistants: [], rosterTargets: [],
    classifications: { premium: PREMIUM },
    fieldDecisions: DECISIONS,
  });
  vi.mocked(svc.exportProfile).mockResolvedValue({ body: BODY } as unknown as svc.ProfileManifest);
  vi.mocked(svc.editProfileDraft).mockResolvedValue({ profileName: 'advisor', draftConfigId: 'draft-2' });
  vi.mocked(listOwnership).mockResolvedValue({ assistants: [], teams: ['finance'] });
});

async function openAdvisor() {
  render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
  // The page opens on Behavioral, showing the active version once it has been read.
  await screen.findByTestId('field-displayName');
}

/** Open a section from the page's menu. */
function section(id: string) {
  fireEvent.click(screen.getByTestId(`assistant-nav-${id}`));
  return screen.getByTestId(id === 'behavioral' ? 'assistant-config-identity' : `assistant-section-${id}`);
}

/** Show the draft (the header's toggle), then the section holding one area, and return that area's inline step. */
async function editArea(area: string) {
  if (!screen.queryByTestId('assistant-draft')) fireEvent.click(screen.getByTestId('assistant-mode-draft'));
  await screen.findByTestId('assistant-draft');
  const at: Record<string, string> = {
    identity: 'behavioral', models: 'scope', routing: 'scope', abilities: 'tools', settings: 'settings', welcome: 'workflows', events: 'workflows', messages: 'messages',
  };
  section(at[area]);
  // THE WORKFLOWS SECTION OPENS ON ITS LIST: the welcome is opened from its row.
  if (at[area] === 'workflows') fireEvent.click(await screen.findByTestId('assistant-edit-workflow-welcome'));
  return screen.findByTestId(`draft-step-${area}`);
}

const save = (step: HTMLElement) => fireEvent.click(within(step).getByRole('button', { name: /Save draft edits/ }));

const optionValues = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);


/** The welcome's opening text box, in the workflows builder: the built-in welcome copied in where the draft has none. */
async function welcomeOpening(field: 'text' | 'examples' = 'text'): Promise<HTMLTextAreaElement> {
  const edit = screen.queryByTestId('assistant-edit-workflow-welcome');
  if (edit) fireEvent.click(edit);
  const step = await screen.findByTestId('draft-step-events');
  const list = within(step).queryByTestId('wfb-view-list');
  if (list) fireEvent.click(list);
  const box = step.querySelector(`[data-testid$="-opening-${field}"]`) as HTMLTextAreaElement | null;
  if (!box) throw new Error('no welcome opening in the workflows builder');
  return box;
}

describe('the draft editor, in place', () => {
  it('offers only the models the classification selects, text and image apart (test 12)', async () => {
    await openAdvisor();
    const step = await editArea('models');
    expect((screen.getByTestId('draft-base-model') as HTMLSelectElement).value).toBe('sonnet');
    expect(optionValues(screen.getByTestId('draft-base-model'))).toEqual(['', 'haiku', 'sonnet']);
    expect(optionValues(screen.getByTestId('draft-classifier-model'))).toEqual(['default', 'haiku', 'sonnet']);
    // A card's text model offers the text models the classification selects and the base model, never an image model;
    // its image model offers the image models only.
    expect(optionValues(screen.getByTestId('draft-route-report_request-primary'))).toEqual(['', 'default', 'haiku', 'sonnet']);
    expect(optionValues(screen.getByTestId('draft-route-image_generation-image'))).toEqual(['', 'stability_image_core']);
    expect((screen.getByTestId('draft-route-image_generation-image') as HTMLSelectElement).value).toBe('stability_image_core');
    expect(optionValues(screen.getByTestId('draft-route-image_generation-image-fallback'))).toEqual(['']);
    expect(optionValues(screen.getByTestId('draft-route-report_request-fallback'))).toEqual(['', 'haiku']);
    // An intent that draws nothing is offered no image model.
    expect(screen.queryByTestId('intent-image-report_request')).toBeNull();
    // Bounded by the classification, said in the field's help.
    expect(step.textContent).toMatch(/Widening the choice needs a deploy/);
  });

  it('saves an image model in the route\'s image part, and a text fallback that becomes the primary is dropped', async () => {
    await openAdvisor();
    const step = await editArea('models');
    fireEvent.change(screen.getByTestId('draft-route-report_request-fallback'), { target: { value: 'haiku' } });
    fireEvent.change(screen.getByTestId('draft-route-report_request-primary'), { target: { value: 'haiku' } });
    expect((screen.getByTestId('draft-route-report_request-fallback') as HTMLSelectElement).value).toBe('');
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    const models = vi.mocked(svc.editProfileDraft).mock.calls[0][1].models!;
    expect(models.byIntent).toEqual({
      report_request: { primary: 'haiku' },
      image_generation: { image: { primary: 'stability_image_core' } },
    });
    expect(models).not.toHaveProperty('image');
  });

  it('clears a route, and a route with nothing left in it is removed', async () => {
    await openAdvisor();
    const step = await editArea('models');
    fireEvent.change(screen.getByTestId('draft-route-image_generation-image'), { target: { value: '' } });
    expect((screen.getByTestId('draft-route-image_generation-image') as HTMLSelectElement).value).toBe('');
    fireEvent.change(screen.getByTestId('draft-route-report_request-primary'), { target: { value: '' } });
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    const models = vi.mocked(svc.editProfileDraft).mock.calls[0][1].models!;
    expect(models.byIntent).toEqual({});
    expect(models).not.toHaveProperty('image');
  });

  it('offers only the classification\'s guardrails and saves the choice through the draft patch (test 14)', async () => {
    await openAdvisor();
    const step = await editArea('settings');
    const select = screen.getByTestId('draft-guardrail');
    expect(optionValues(select)).toEqual(['', 'gr-strict']);
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toContain('strict');
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.change(select, { target: { value: 'gr-strict' } });
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    const patch = vi.mocked(svc.editProfileDraft).mock.calls[0][1];
    expect(patch.guardrailId).toBe('gr-strict');
    // Only what was edited travels: the welcome, the messages and the tools were not touched.
    expect(patch).not.toHaveProperty('tools');
    expect(patch).not.toHaveProperty('eventWorkflows');
    expect(patch).not.toHaveProperty('welcome');
    expect(patch).not.toHaveProperty('copy');
  });

  it('says where the guardrail is defined while the active version shows', async () => {
    await openAdvisor();
    section('settings');
    expect(screen.getByTestId('field-guardrail').textContent).toMatch(/Guardrails are defined at deploy/);
    expect(screen.getByTestId('guardrail-edit-path')).toBeTruthy();
  });

  it('edits the welcome in the workflows builder and sends it in the draft patch as its workflow', async () => {
    await openAdvisor();
    const step = await editArea('events');
    fireEvent.change(await welcomeOpening(), { target: { value: 'I am the finance advisor.' } });
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    const patch = vi.mocked(svc.editProfileDraft).mock.calls[0][1];
    expect(patch.eventWorkflows?.welcome).toEqual(welcomeSaying({ text: 'I am the finance advisor.', examples: ['How did Q3 close?'] }));
    expect(patch).not.toHaveProperty('welcome');
    expect(patch).not.toHaveProperty('copy');
  });

  it('WHAT THE ASSISTANT SAYS HAS ONE SECTION: Message templates, with no Messages section and no separate message choices', async () => {
    vi.mocked(svc.listMessageTemplates).mockResolvedValue({
      assistant: 'advisor', classification: 'premium', family: {},
      templates: [{ name: 'member-welcome', kind: 'message', description: 'x', shipped: shippedMessageTemplates().get('member-welcome')!.source }],
    });
    await openAdvisor();
    const step = await editArea('messages');
    expect(screen.getAllByTestId('message-templates')).toHaveLength(1);
    expect(screen.queryByTestId('draft-copy')).toBeNull();
    expect(screen.queryByTestId('draft-message-choices')).toBeNull();
    expect(screen.queryByTestId('message-choices')).toBeNull();
    // Picking the template a message is said from writes the draft's `messages`.
    fireEvent.click(await screen.findByTestId('message-template-open-member-welcome'));
    fireEvent.change(await screen.findByTestId('message-choice-pick'), { target: { value: '@shipped' } });
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    expect(vi.mocked(svc.editProfileDraft).mock.calls[0][1].messages).toEqual({ 'member-welcome': '@shipped' });
  });

  it('explains a draft\'s retired copy lines, names the migration, and clears them; it never edits them', async () => {
    await openAdvisor();
    const step = await editArea('messages');
    const note = screen.getByTestId('draft-retired-copy');
    expect(note.textContent).toContain('rateLimited');
    expect(note.textContent).toContain('npm run migrate-legacy-copy');
    expect(within(note).queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByTestId('draft-retired-copy-clear'));
    fireEvent.click(screen.getByTestId('draft-retired-copy-clear-confirm-button'));
    expect(screen.queryByTestId('draft-retired-copy')).toBeNull();
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    expect(vi.mocked(svc.editProfileDraft).mock.calls[0][1].copy).toBeNull();
  });

  it('sends the selected context sources, in the order chosen', async () => {
    await openAdvisor();
    const step = await editArea('abilities');
    const box = screen.getByTestId('draft-context-sources');
    fireEvent.click(within(box).getByRole('checkbox', { name: /wiki/ }));
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    expect(vi.mocked(svc.editProfileDraft).mock.calls[0][1].contextSources).toEqual(['crm', 'wiki']);
  });
});

describe('the active version, section by section (test 13)', () => {
  it('renders every behavior-affecting field', async () => {
    await openAdvisor();
    expect(screen.getByTestId('field-boundary').textContent).toContain('I do not reach payroll.');
    expect(screen.getByTestId('field-systemPromptAddendum').textContent).toContain('Be brief.');
    expect(screen.getByTestId('field-persona').textContent).toContain('11 characters');

    section('workflows');
    // When a workflow confirms a complete request (ADR-064 decision G): the version's setting, and the command that edits it.
    expect(screen.getByTestId('field-confirm-brief').textContent).toContain('image_generation always');
    expect(screen.getByTestId('edit-path-confirmBrief').textContent).toContain('npm run assistant -- draft');
    // The platform's workflows (the queue's) in their own read-only section, and a request's workflows under When someone asks.
    expect(within(screen.getByTestId('workflows-platform-section')).getByText('queue_drain')).toBeTruthy();
    expect(screen.getByTestId('workflows-platform-section').textContent).toContain('Every assistant has this workflow');
    expect(screen.getByTestId('field-machines').textContent).toContain('report_request');
    expect(within(screen.getByTestId('field-machines')).queryByText('queue_drain')).toBeNull();
    expect(screen.getByTestId('field-welcome').textContent).toContain('I am the advisor.');
    expect(screen.getByTestId('field-onboarding').textContent).toContain('Which team are you on?');
    // A version stored before message templates shows its retired lines, and how they move.
    expect(screen.getByTestId('field-copy').textContent).toContain('rateLimited');
    expect(screen.getByTestId('edit-path-copy').textContent).toContain('npm run migrate-legacy-copy');
    expect(screen.getByTestId('field-templates').textContent).toContain('report');

    section('scope');
    // The image model reads on its intent's own card, as the Image model, apart from the text model.
    expect(screen.getByTestId('intent-image_generation-image-model').textContent).toContain('stability_image_core');
    expect(screen.getByTestId('intent-image-image_generation').textContent).toContain('Image model');
    expect(screen.getByTestId('field-classifierMode').textContent).toContain('llm');
    // Classification first, its mode then its model; the default model opens Intents, above the intent list.
    const inOrder = ['field-classifierMode', 'field-classifierModel', 'field-defaultModel', 'assistant-intents'].map((id) => screen.getByTestId(id));
    inOrder.slice(1).forEach((el, i) => expect(inOrder[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
    expect(screen.getByTestId('assistant-intents').textContent).toContain('report_request');

    section('tools');
    expect(screen.getByTestId('field-contextSources').textContent).toContain('crm');
    // The company documents are in context only where the version's tools offer load_company_context: this one's do not.
    expect(screen.getByTestId('field-companyDocuments').textContent).toContain('tools do not include load_company_context');
    expect(screen.getByTestId('field-retrievalReach').textContent).toContain('context/premium/');
    // Each prefix is named with its bucket and linked to it in the S3 console.
    const reach = within(screen.getByTestId('field-retrievalReach')).getByRole('link', { name: 'ae-company/context/premium/' });
    expect(reach.getAttribute('href')).toContain('ae-company');
    expect(reach.getAttribute('href')).toContain(`prefix=${encodeURIComponent('context/premium/')}`);

    section('settings');
    expect(screen.getByTestId('field-topology').textContent).toContain('120s');
    expect(screen.getByTestId('field-budgets').textContent).toContain('750');
  });

  it('stacks every field as label, help, then value', async () => {
    await openAdvisor();
    const dd = screen.getByTestId('field-boundary');
    const kids = [...dd.children];
    expect(kids[0].className).toBe('admin-field-hint');
    expect(kids[1].className).toBe('admin-config-value');
  });

  it('says how each field without a control is changed', async () => {
    await openAdvisor();
    expect(screen.getByTestId('edit-path-systemPromptAddendum').textContent).toMatch(/experiment/i);
    section('workflows');
    for (const f of ['onboarding']) expect(screen.getByTestId(`edit-path-${f}`).textContent, f).toMatch(/npm run assistant -- draft/);
    // A version cannot define a task workflow: they are the platform's and the classification pack's, changed by a deploy.
    expect(screen.getByTestId('edit-path-machines').textContent).toMatch(/Read-only/i);
    expect(screen.getByTestId('edit-path-machines').textContent).toContain("the classification's intent pack");
    expect(screen.getByTestId('field-templates').textContent).toMatch(/npm run template -- put\|activate\|rollback\|list\|check premium/);
    // The retired copy lines are not a control: the page says nothing reads them and how they move.
    expect(screen.getByTestId('edit-path-copy').textContent).toContain('Retired');
    // Fields with a control carry no "edited as JSON" line, and a version with no retired welcome shows none.
    expect(screen.queryByTestId('edit-path-eventWorkflows')).toBeNull();
    expect(screen.queryByTestId('field-retired-welcome')).toBeNull();
    section('scope');
    expect(screen.getByTestId('edit-path-intentPack').textContent).toMatch(/npm run assistant -- draft/);
    expect(screen.getByTestId('field-classifierMode').textContent).toMatch(/deploy\.config\.json/);
    section('settings');
    expect(screen.getByTestId('assistant-rate-limit').textContent).toMatch(/rateLimitPerHour in deploy\.config\.json/);
    expect(screen.getByTestId('field-topology').textContent).toMatch(/Assistants-premium/);
    expect(screen.getByTestId('field-budgets').textContent).toMatch(/Set in deploy\.config\.json/);
    section('variables');
    expect(screen.getByTestId('draft-variables')).toBeTruthy();
  });

  it('states classification and role as facts fixed for life, not as settings', async () => {
    await openAdvisor();
    expect(within(screen.getByTestId('assistant-config-identity')).getByTestId('fixed-for-life').textContent)
      .toMatch(/Fixed for the assistant's life\. A new classification or role needs a deploy\./);
  });

  it('shows the Platform section, labeled platform-level and not editable, with a guide per behavior', async () => {
    await openAdvisor();
    section('workflows');
    const platform = screen.getByTestId('assistant-config-platform');
    expect(within(platform).getByRole('heading').textContent).toMatch(/Platform-level, not editable/);
    for (const id of ['taskLifecycle', 'turnQueue', 'triage', 'queueManagement', 'deliveryCheck']) {
      expect(within(within(platform).getByTestId(`platform-${id}`)).getAllByRole('link').length, id).toBeGreaterThan(0);
    }
    expect(within(platform).queryAllByRole('button')).toHaveLength(0);
    expect(within(platform).queryAllByRole('combobox')).toHaveLength(0);
  });

  it('offers the turn limit as a control only for a console-created assistant', async () => {
    await openAdvisor();
    section('tools');
    expect(screen.queryByTestId('turn-limit-input')).toBeNull();
  });

  it('names no intents, workflows, sources or tools as the version\'s until the version is read', async () => {
    vi.mocked(svc.exportProfile).mockReturnValue(new Promise(() => {}));
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    await screen.findByTestId('assistant-config-identity');
    for (const s of ['scope', 'workflows', 'tools']) {
      const card = section(s);
      expect(card.textContent, s).toContain('Loading configuration');
      expect(card.textContent, s).not.toContain('report_request');
      expect(card.textContent, s).not.toContain('None');
    }
  });

  it('says a version that could not be read could not be read, rather than that it carries nothing', async () => {
    vi.mocked(svc.exportProfile).mockRejectedValue(new Error('export failed'));
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    await screen.findByTestId('assistant-config-identity');
    await waitFor(() => expect(section('scope').textContent).toContain('Could not be read'));
    expect(section('scope').textContent).not.toContain('report_request');
  });

  it('shows the classification\'s pack for a version that was read and carries none', async () => {
    const { intentPack: _none, ...noPack } = BODY as svc.ProfileDefinitionBody & { intentPack?: unknown };
    vi.mocked(svc.exportProfile).mockResolvedValue({ body: noPack } as unknown as svc.ProfileManifest);
    await openAdvisor();
    section('scope');
    expect(screen.getByTestId('assistant-intents').textContent).toContain('report_request');
    expect(screen.getByTestId('field-intentPack').textContent).toContain('carries no intent pack');
  });
});

describe('moving around an assistant page', () => {
  it('opens one section at a time from the menu, without leaving the assistant or adding a history entry', async () => {
    await openAdvisor();
    const historyLength = window.history.length;
    const hash = window.location.hash;
    const menu = screen.getByRole('navigation', { name: 'Configuration sections' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Workflows' }));
    expect(window.history.length).toBe(historyLength);
    expect(window.location.hash).toBe(hash);
    expect(screen.getByTestId('field-welcome')).toBeTruthy();
    expect(screen.queryByTestId('field-displayName')).toBeNull();
    expect(within(menu).getByRole('button', { name: 'Workflows' }).getAttribute('aria-current')).toBe('page');
    // THE ADDRESS SAYS WHERE: the assistant and its section, so the view can be linked to.
    const q = new URLSearchParams(window.location.search);
    expect(q.get('assistant')).toBe('advisor');
    expect(q.get('section')).toBe('workflows');
  });

  it('a link opens the assistant on the section it names, and leaving for the list takes both out of the address', async () => {
    window.history.replaceState({}, '', '/?admin=profiles&assistant=advisor&section=workflows');
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab initialAssistant="advisor" /></CapabilityTestProvider>);
    const menu = await screen.findByRole('navigation', { name: 'Configuration sections' });
    expect(within(menu).getByRole('button', { name: 'Workflows' }).getAttribute('aria-current')).toBe('page');
    // BACK, as the browser takes it, to the list.
    window.history.replaceState({}, '', '/?admin=profiles');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(await screen.findByRole('button', { name: 'Open Advisor' })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('section')).toBeNull();
  });

  it('opens the assistant it is handed, so Back from that assistant\'s analytics lands on it rather than the list', async () => {
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab initialAssistant="advisor" /></CapabilityTestProvider>);
    expect(await screen.findByTestId('field-displayName')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Advisor' })).toBeNull();
  });
});

describe('workflows by ownership', () => {
  it('keeps the platform workflows in a closed expandable, and copies one into the draft under its own name', async () => {
    await openAdvisor();
    section('workflows');
    expect(screen.getByTestId('assistant-workflow-own-welcome')).toHaveTextContent("Advisor's");
    expect(screen.getByTestId('workflows-platform-details')).not.toHaveAttribute('open');
    const platform = screen.getByTestId('assistant-workflow-platform-incident-watch');
    expect(platform).toHaveTextContent('Shipped');
    // The active version is read-only: nothing copies in until the draft shows.
    expect(within(platform).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByTestId('assistant-mode-draft'));
    fireEvent.click(await screen.findByTestId('assistant-copy-incident-watch'));
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    const wfs = vi.mocked(svc.editProfileDraft).mock.calls[0][1].eventWorkflows!;
    expect(Object.keys(wfs).sort()).toEqual(['incident-watch', 'welcome']);
    expect(wfs['incident-watch'].on).toBe('alarm-state-changed');
  });

  it('says which platform workflows run by default and which run only once copied in', async () => {
    await openAdvisor();
    section('workflows');
    expect(screen.queryByTestId('assistant-workflow-platform-welcome')).toBeNull();
    expect(within(screen.getByTestId('workflows-group-person-joined')).getByTestId('assistant-workflow-platform-join-recap-runs')).toHaveTextContent('Runs by default');
    expect(within(screen.getByTestId('workflows-shipped')).queryByTestId('assistant-workflow-platform-join-recap')).toBeNull();
    for (const name of ['ops-room', 'opening-and-subject', 'incident-watch', 'chase-unredeemed']) {
      expect(screen.getByTestId(`assistant-workflow-platform-${name}-runs`)).toHaveTextContent('Runs only once copied into a version');
    }
  });

  it('a platform welcome copied over the version\'s own replaces it once confirmed, and is not copied when refused', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      await openAdvisor();
      section('workflows');
      fireEvent.click(screen.getByTestId('assistant-mode-draft'));
      fireEvent.click(await screen.findByTestId('assistant-copy-opening-and-subject'));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toMatch(/Replace welcome with a copy of opening-and-subject\?/);
      expect(svc.editProfileDraft).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByTestId('assistant-copy-opening-and-subject'));
      await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
      expect(Object.keys(vi.mocked(svc.editProfileDraft).mock.calls[0][1].eventWorkflows!)).toEqual(['opening-and-subject']);
    } finally {
      confirm.mockRestore();
    }
  });

  it('leaving a workflow with an unsaved canvas edit asks first, and leaving drops it before a copy is saved', async () => {
    await openAdvisor();
    await editArea('events');
    // The welcome opens on its own form; its steps are on the builder in Workflow mode.
    const workflowMode = screen.queryByTestId('welcome-mode-workflow');
    if (workflowMode) fireEvent.click(workflowMode);
    fireEvent.keyDown(await screen.findByTestId('wfb-node-opening'), { key: 'ArrowDown' });
    // Back to the list: the moved step is unsaved, so leaving asks first, and leaving drops it.
    fireEvent.click(screen.getByTestId('welcome-focus-back'));
    expect(screen.getByTestId('workflow-leave-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('workflow-leave-confirm-button'));
    expect(screen.queryByTestId('assistant-nav-workflows-unsaved')).toBeNull();
    fireEvent.click(await screen.findByTestId('assistant-copy-incident-watch'));
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    const patch = vi.mocked(svc.editProfileDraft).mock.calls[0][1];
    expect(Object.keys(patch.eventWorkflows!)).toContain('incident-watch');
    expect(patch.layout?.welcome?.opening).toBeUndefined();
  });
});

describe('intents and task workflows', () => {
  const STEPS: svc.MachineStep[] = [
    { key: 'gathering', awaits: 'requester', requires: ['the subject'], transitions: ['drafting'], prompt: 'Ask for the subject.' },
    { key: 'drafting', produces: 'document', templates: ['report'], transitions: ['delivered'] },
    { key: 'delivered', terminal: 'success', transitions: [], reopens: ['drafting'] },
  ];
  beforeEach(() => {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [ADVISOR], tools: [], runtimeAssistants: [], rosterTargets: [],
      classifications: {
        premium: {
          ...PREMIUM,
          workflows: [{ ...PREMIUM.workflows![0], steps: STEPS }, PREMIUM.workflows![1]],
          intents: [{ key: 'report_request', description: 'User wants a report.', summary: 'A report, delivered as a document', instructions: 'Confirm the subject.', multiStep: true, machine: 'report_request' }],
        },
      },
      fieldDecisions: DECISIONS,
    });
  });

  // AN INTENT CARD LINKS TO ITS WORKFLOWS ENTRY (WT97).
  it('a multi-step intent\'s card opens the Workflows list at its entry, marked', async () => {
    await openAdvisor();
    section('scope');
    fireEvent.click(screen.getByTestId('intent-workflows-report_request'));
    const entry = await screen.findByTestId('workflow-intent-report_request');
    expect(entry.getAttribute('aria-current')).toBe('true');
    expect(entry.className).toContain('admin-workflow-item-focus');
    expect(screen.getByTestId('workflows-group-intents')).toBeTruthy();
  });

  it('shows each intent as a card with its purpose, instructions, machine, model and performance link', async () => {
    const onOpenLink = vi.fn();
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab onOpenLink={onOpenLink} /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    await screen.findByTestId('field-displayName');
    section('scope');
    const card = screen.getByTestId('intent-card-report_request');
    expect(screen.getByTestId('intent-purpose-report_request')).toHaveTextContent('User wants a report.');
    // One way to the workflow: the multi-step marker is a label, and the card's one control opens the Workflows entry.
    expect(screen.getByTestId('intent-machine-report_request').tagName).toBe('SPAN');
    expect(card).toHaveTextContent('Confirm the subject.');
    expect(card).toHaveTextContent('sonnet');
    expect(screen.getByTestId('intent-machine-report_request')).toHaveTextContent('Multi-step: report_request');
    const perf = screen.getByTestId('intent-performance-report_request');
    expect(perf.getAttribute('href')).toBe('?admin=effectiveness&as=advisor&intent=report_request');
    fireEvent.click(perf);
    expect(onOpenLink).toHaveBeenCalledWith({ tab: 'effectiveness', assistant: 'advisor', intent: 'report_request' });
  });

  it('opens an intent\'s task workflow from its Workflows entry and lists each step, then returns to the list', async () => {
    await openAdvisor();
    section('workflows');
    // Edit sits beside View steps on the row, so an intent's workflow is edited straight from the list.
    expect(within(screen.getByTestId('workflow-intent-report_request')).getByTestId('assistant-edit-machine-report_request')).toHaveTextContent('Edit');
    fireEvent.click(screen.getByTestId('assistant-machine-report_request'));
    const view = screen.getByTestId('assistant-machine-view');
    expect(view).toHaveTextContent('Shipped');
    expect(view).toHaveTextContent('Answers report_request.');
    expect(screen.getByTestId('assistant-machine-step-gathering')).toHaveTextContent('Waits on the requester');
    expect(screen.getByTestId('assistant-machine-step-gathering')).toHaveTextContent('Needs before moving on: the subject');
    expect(screen.getByTestId('assistant-machine-step-gathering')).toHaveTextContent('Ask for the subject.');
    expect(screen.getByTestId('assistant-machine-step-drafting')).toHaveTextContent('Advisor works');
    expect(screen.getByTestId('assistant-machine-step-drafting')).toHaveTextContent('Delivers a document: report');
    expect(screen.getByTestId('assistant-machine-step-delivered')).toHaveTextContent('Done');
    expect(screen.getByTestId('assistant-machine-step-delivered')).toHaveTextContent('Reopens to drafting');
    fireEvent.click(screen.getByTestId('assistant-machine-back'));
    expect(screen.getByTestId('workflow-intent-report_request')).toBeTruthy();
  });
});

describe('an intent\'s models where its steps are (ADR-064 decision 5)', () => {
  const IMAGE_STEPS: svc.MachineStep[] = [
    { key: 'gather', awaits: 'requester', transitions: ['confirm'] },
    { key: 'confirm', awaits: 'requester', transitions: ['generate'] },
    { key: 'generate', produces: 'image', action: 'generate_image', transitions: ['revise'] },
    { key: 'revise', awaits: 'requester', transitions: ['generate', 'done'] },
    { key: 'done', terminal: 'success', transitions: [] },
  ];
  const REPORT_STEPS: svc.MachineStep[] = [
    { key: 'gathering', awaits: 'requester', requiresTool: ['search_context'], transitions: ['drafting'] },
    { key: 'drafting', produces: 'document', templates: ['report'], transitions: ['delivered'] },
    { key: 'delivered', terminal: 'success', transitions: [] },
  ];
  const WITH_STEPS: svc.ProfileDefinitionBody = {
    ...BODY,
    models: { default: 'sonnet', byIntent: { report_request: { primary: 'sonnet', steps: { drafting: { primary: 'haiku' } } }, image_generation: { image: { primary: 'stability_image_core' } } } },
  };
  beforeEach(() => {
    vi.mocked(svc.exportProfile).mockResolvedValue({ body: WITH_STEPS } as unknown as svc.ProfileManifest);
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [ADVISOR], tools: [], runtimeAssistants: [], rosterTargets: [],
      classifications: {
        premium: {
          ...PREMIUM,
          workflows: [
            { key: 'report_request', source: 'platform', required: false, initial: 'gathering', states: REPORT_STEPS.map((s) => s.key), steps: REPORT_STEPS },
            { key: 'image_generation', source: 'platform', required: false, initial: 'gather', states: IMAGE_STEPS.map((s) => s.key), steps: IMAGE_STEPS },
          ],
          packIntents: ['report_request', 'image_generation'],
          intents: [
            { key: 'report_request', description: 'A report.', multiStep: true, machine: 'report_request', needs: 'document' },
            { key: 'image_generation', description: 'A picture.', multiStep: true, machine: 'image_generation', needs: 'image' },
          ],
          platformIntents: [{ key: 'greeting', answersThroughGeneral: true }, { key: 'general', answersThroughGeneral: true }, { key: 'off_topic', answersThroughGeneral: true }],
        },
      },
      fieldDecisions: DECISIONS,
    });
  });

  it('lists each step with what it produces and the model it uses, the route\'s by default', async () => {
    await openAdvisor();
    section('scope');
    expect(screen.getByTestId('intent-step-image_generation-gather-produces')).toHaveTextContent('Answers in text');
    expect(screen.getByTestId('intent-step-image_generation-generate-produces')).toHaveTextContent('Produces an image');
    // Each step names the model the runtime's resolution (`stepModelOf`) picks, and the rule that picked it.
    expect(screen.getByTestId('intent-step-image_generation-gather-model')).toHaveTextContent('Claude Sonnet 4.6, the base model');
    expect(screen.getByTestId('intent-step-image_generation-generate-model')).toHaveTextContent("the intent's image model");
    expect(screen.getByTestId('intent-step-report_request-drafting-produces')).toHaveTextContent('Delivers a document');
    expect(screen.getByTestId('intent-step-report_request-drafting-model')).toHaveTextContent('Claude Haiku 4.5, its own model');
    // A terminal step runs no model, so it has no row.
    expect(screen.queryByTestId('intent-step-image_generation-done')).toBeNull();
    // A required tool shows beside the step.
    expect(screen.getByTestId('intent-step-report_request-gathering-requires-tool')).toHaveTextContent('search_context');
    // The image model shows where a step produces an image, and not on an intent that draws nothing.
    expect(screen.getByTestId('intent-image_generation-image-model')).toHaveTextContent('stability_image_core');
    expect(screen.queryByTestId('intent-image-report_request')).toBeNull();
    // A step links to its own Effectiveness breakdown.
    expect(screen.getByTestId('intent-step-performance-image_generation-generate').getAttribute('href'))
      .toBe('?admin=effectiveness&as=advisor&intent=image_generation&step=generate');
  });

  it('a step override offers only models of the step\'s kind, and clearing it removes the key', async () => {
    await openAdvisor();
    const step = await editArea('models');
    expect(optionValues(screen.getByTestId('draft-step-image_generation-gather'))).toEqual(['', 'haiku', 'sonnet']);
    // An image step takes no model of its own: the turn's image route draws it, so it offers no select.
    expect(screen.queryByTestId('draft-step-image_generation-generate')).toBeNull();
    expect(screen.getByTestId('intent-step-image_generation-generate-model')).toHaveTextContent("the intent's image model");
    fireEvent.change(screen.getByTestId('draft-step-image_generation-gather'), { target: { value: 'haiku' } });
    fireEvent.change(screen.getByTestId('draft-step-report_request-drafting'), { target: { value: '' } });
    // The edit is held as the area's unsaved edit until saved, as every area's is.
    expect(screen.getByTestId('draft-step-models-unsaved')).toBeTruthy();
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    expect(vi.mocked(svc.editProfileDraft).mock.calls[0][1].models!.byIntent).toEqual({
      report_request: { primary: 'sonnet' },
      image_generation: { image: { primary: 'stability_image_core' }, steps: { gather: { primary: 'haiku' } } },
    });
  });

  it('lists the platform intents read-only, with where each is answered in this version', async () => {
    await openAdvisor();
    section('scope');
    const group = screen.getByTestId('assistant-platform-intents');
    expect(within(group).getByTestId('platform-intent-greeting-answers')).toHaveTextContent('Answers through the general route');
    expect(within(group).getByTestId('platform-intent-off_topic-answers')).toHaveTextContent('Answers through the general route');
    expect(within(group).queryByRole('combobox')).toBeNull();
    expect(within(group).getByTestId('platform-intent-off_topic-about')).toHaveTextContent('The assistant declines it.');
  });

  it('anchors each refusal Validate returns under the card or step it names, worded by the console', async () => {
    vi.mocked(svc.validateProfileDraft).mockResolvedValueOnce({
      profileName: 'advisor', valid: false, configId: 'draft-1',
      errors: ['server words A', 'server words B', 'server words C'],
      errorDetails: [
        { code: 'step_model_kind', path: "models.byIntent['image_generation'].steps['generate'].primary", message: 'server words A', params: { intent: 'image_generation', state: 'generate', model: 'sonnet', kind: 'image' } },
        { code: 'image_model_as_text', path: "models.byIntent['report_request']", message: 'server words B', params: { intent: 'report_request', model: 'stability_image_core' } },
        { code: 'required_tool_not_allowed', path: "workflows['report_request'].steps['gathering'].requiresTool", message: 'server words C', params: { workflow: 'report_request', state: 'gathering', tool: 'search_context' } },
      ],
    });
    await openAdvisor();
    await editArea('models');
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    const onStep = await screen.findByTestId('intent-step-refusals-image_generation-generate');
    expect(onStep).toHaveTextContent('The generate step produces image, and sonnet is not that kind of model.');
    expect(onStep).not.toHaveTextContent('server words');
    expect(screen.getByTestId('intent-refusals-report_request')).toHaveTextContent('stability_image_core is an image model and is named as the text model of report_request');
    expect(screen.getByTestId('intent-step-refusals-report_request-gathering')).toHaveTextContent('requires search_context');
    // The flat list beside Validate still says every refusal.
    expect(screen.getByTestId('draft-refused')).toHaveTextContent('server words A');
  });
});

describe('activating a draft', () => {
  it('shows each reason a refused activation gives beside the button, not in a banner off screen', async () => {
    vi.mocked(svc.activateProfileDraft).mockRejectedValueOnce(Object.assign(new Error('activate refused'), {
      body: { errors: ['intentPack.machines is not read from a profile version', 'models.byIntent routes a key no intent reaches'] },
    }));
    await openAdvisor();
    fireEvent.click(screen.getByTestId('assistant-mode-draft'));
    fireEvent.click(await screen.findByRole('button', { name: /^Activate draft as v4/ }));
    const refused = await screen.findByTestId('draft-refused');
    expect(within(screen.getByTestId('assistant-draft')).getByTestId('draft-refused')).toBe(refused);
    expect(refused).toHaveTextContent('The draft was not activated:');
    // Activate's own refusal never holds the button back: the server reads every check again on the next click.
    expect(screen.getByRole('button', { name: /^Activate draft as v4/ })).toBeEnabled();
    expect(within(refused).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'intentPack.machines is not read from a profile version', 'models.byIntent routes a key no intent reaches',
    ]);
  });
});

describe('the draft, before and after a first activation', () => {
  const DRAFT: svc.ProfileDefinitionBody = { ...BODY, persona: 'You advise from the draft.', eventWorkflows: { welcome: welcomeSaying({ text: 'Draft welcome.' }) } };
  const exportsBy = () => vi.mocked(svc.exportProfile).mockImplementation(async (_name, version) =>
    ({ body: version === 'draft' ? DRAFT : BODY } as unknown as svc.ProfileManifest));
  const listing = (over: Partial<svc.ProfileListing>) => vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
    profiles: [{ ...ADVISOR, ...over }],
    tools: [{ name: 'search_context', category: 'context', changesState: false, description: 'Search', requires: 'nothing' }],
    runtimeAssistants: [], rosterTargets: [], classifications: { premium: PREMIUM },
  } as unknown as Awaited<ReturnType<typeof svc.listProfilesAndTools>>);

  it('shows the draft, edited in place, while nothing is active, and says so', async () => {
    exportsBy();
    listing({ activeVersion: null, versions: [] });
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    expect(await screen.findByTestId('assistant-draft')).toHaveTextContent('Editing the first draft of Advisor.');
    expect(screen.getByTestId('assistant-mode-active')).toBeDisabled();
    await waitFor(() => expect((screen.getByTestId('draft-persona') as HTMLTextAreaElement).value).toBe('You advise from the draft.'));
    section('workflows');
    expect(screen.getByTestId('field-welcome').textContent).toContain('Draft welcome.');
  });

  it('shows what is serving, and the draft one toggle away, kept when switching back', async () => {
    exportsBy();
    listing({});
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    await waitFor(() => expect(screen.getByTestId('field-persona').textContent).toContain('11 characters'));
    expect(screen.queryByTestId('assistant-draft')).toBeNull();
    // The draft differs in the persona and the welcome: two sections, each marked in the menu.
    await waitFor(() => expect(screen.getByTestId('assistant-mode-draft')).toHaveTextContent('Draft (2 changed)'));
    fireEvent.click(screen.getByTestId('assistant-mode-draft'));
    expect(await screen.findByTestId('assistant-nav-behavioral-changed')).toBeTruthy();
    expect(screen.getByTestId('assistant-nav-workflows-changed')).toBeTruthy();
    expect(screen.queryByTestId('assistant-nav-scope-changed')).toBeNull();
    expect((screen.getByTestId('draft-persona') as HTMLTextAreaElement).value).toBe('You advise from the draft.');
    expect(vi.mocked(svc.exportProfile)).toHaveBeenCalledWith('advisor', 'draft');
    fireEvent.click(screen.getByTestId('assistant-mode-active'));
    expect(screen.queryByTestId('assistant-draft')).toBeNull();
    expect(screen.getByTestId('draft-kept')).toBeTruthy();
  });

  it('holds each section\'s controls in that section while the draft shows', async () => {
    exportsBy();
    listing({});
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    fireEvent.click(await screen.findByTestId('assistant-mode-draft'));
    await screen.findByTestId('draft-step-identity');
    for (const [s, controls] of [
      ['behavioral', ['draft-name', 'draft-persona']], ['scope', ['draft-base-model', 'draft-classifier-model']],
      ['tools', ['draft-tools', 'draft-context-sources']], ['settings', ['draft-guardrail']], ['workflows', ['workflows-new']], ['messages', ['message-templates']],
    ] as const) {
      const card = section(s);
      for (const c of controls) expect(within(card).getAllByTestId(c).length, `${s}: ${c}`).toBeGreaterThan(0);
    }
    // Variables are explained, not edited: no save there.
    expect(within(section('variables')).queryByRole('button', { name: /Save draft edits/ })).toBeNull();
  });

  it('starts a draft from the header when there is none', async () => {
    exportsBy();
    listing({ hasDraft: false, draftConfigId: undefined });
    vi.mocked(svc.createProfileVersion).mockResolvedValue({} as never);
    render(<CapabilityTestProvider capabilities={ADMIN_CAPS}><ProfilesTab /></CapabilityTestProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Advisor' }));
    const edit = await screen.findByTestId('new-version');
    expect(edit).toHaveTextContent('Edit');
    fireEvent.click(edit);
    await waitFor(() => expect(svc.createProfileVersion).toHaveBeenCalledWith('advisor'));
  });
});

describe('the tested instruction', () => {
  it('says what it is for, with an example, and where it comes from', async () => {
    await openAdvisor();
    const row = screen.getByTestId('field-systemPromptAddendum');
    expect(row.textContent).toContain('Keep replies under 80 words');
    expect(row.textContent).toContain('Set by experiments');
  });
});

describe('saving the draft', () => {
  it('shows the saved values once the saved draft has loaded, rather than the values from before the save', async () => {
    let saved = false;
    vi.mocked(svc.exportProfile).mockImplementation(async (_name, version) => {
      if (version !== 'draft') return { body: BODY } as unknown as svc.ProfileManifest;
      // The saved draft arrives after the listing that names its new id, as it does against a deployment.
      if (saved) await new Promise((r) => setTimeout(r, 20));
      return {
        body: { ...BODY, eventWorkflows: { welcome: welcomeSaying({ text: saved ? 'Saved welcome.' : 'Old welcome.' }) } },
        provenance: { exportedConfigId: saved ? 'draft-2' : 'draft-1' },
      } as unknown as svc.ProfileManifest;
    });
    await openAdvisor();
    const step = await editArea('events');
    await waitFor(async () => expect((await welcomeOpening()).value).toBe('Old welcome.'));
    fireEvent.change(await welcomeOpening(), { target: { value: 'Saved welcome.' } });
    vi.mocked(svc.editProfileDraft).mockImplementation(async () => {
      saved = true;
      vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
        ...(await vi.mocked(svc.listProfilesAndTools).getMockImplementation()!()),
        profiles: [{ ...ADVISOR, draftConfigId: 'draft-2' }],
      } as unknown as Awaited<ReturnType<typeof svc.listProfilesAndTools>>);
      return { profileName: 'advisor', draftConfigId: 'draft-2' };
    });
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    // The inline controls re-seed from the saved draft once it has loaded.
    await waitFor(async () => expect((await welcomeOpening()).value).toBe('Saved welcome.'));
  });
});

describe('what the scope section says serves, read as the runtime reads it', () => {
  it('saves Classification default as models with no base model, and reads the classification default back', async () => {
    await openAdvisor();
    const step = await editArea('models');
    fireEvent.change(screen.getByTestId('draft-base-model'), { target: { value: '' } });
    save(step);
    await waitFor(() => expect(svc.editProfileDraft).toHaveBeenCalled());
    // No `default` key at all: `editDraft` then sets `modelKey` to the sentinel, and the turn serves the classification's.
    expect('default' in vi.mocked(svc.editProfileDraft).mock.calls[0][1].models!).toBe(false);
  });

  it('names the classification default a version that follows it serves on', async () => {
    vi.mocked(svc.exportProfile).mockResolvedValue({ body: { ...BODY, modelKey: 'default', models: { classifier: 'default', byIntent: BODY.models!.byIntent } } } as unknown as svc.ProfileManifest);
    await openAdvisor();
    section('scope');
    expect(screen.getByTestId('field-defaultModel')).toHaveTextContent('Classification default: sonnet');
  });

  it('marks a workflow the version leaves out of its selection, and its intent as opening none', async () => {
    vi.mocked(svc.exportProfile).mockResolvedValue({ body: { ...BODY, workflows: ['image_generation'] } } as unknown as svc.ProfileManifest);
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [ADVISOR], tools: [], runtimeAssistants: [], rosterTargets: [],
      classifications: { premium: { ...PREMIUM, intents: [{ key: 'report_request', description: 'A report.', multiStep: true, machine: 'report_request', tools: ['search_context', 'not_allowed'] }] } },
      fieldDecisions: DECISIONS,
    });
    await openAdvisor();
    section('scope');
    expect(screen.getByTestId('intent-machine-report_request')).toHaveTextContent('not selected, so it opens no workflow');
    // The pack intent's tools, within the version's allowlist.
    expect(screen.getByTestId('intent-tools-report_request')).toHaveTextContent('Tools offered here: search_context');
    expect(screen.getByTestId('intent-tools-report_request')).not.toHaveTextContent('not_allowed');
    section('workflows');
    expect(screen.getByTestId('assistant-machine-report_request-selected')).toHaveTextContent('Not selected');
    // The queue's workflow is never removed by a selection: it sits in the Platform section, which offers no selection at all.
    expect(within(screen.getByTestId('workflows-platform-section')).getByText('queue_drain')).toBeTruthy();
    expect(screen.queryByTestId('assistant-machine-queue_drain-selected')).toBeNull();
  });
});

// ADR-067 STAGE 1: ONE WORKFLOWS LIST, GROUPED BY WHAT STARTS EACH WORKFLOW.
const follows = (a: HTMLElement, b: HTMLElement) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('a request\'s workflow is shown with the task it assigns', () => {
  it('lists, under each multi-step intent, the task its workflow assigns and that task\'s states', async () => {
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [ADVISOR], tools: [], runtimeAssistants: [], rosterTargets: [],
      classifications: { premium: { ...PREMIUM, intents: [{ key: 'report_request', description: 'A report.', multiStep: true, machine: 'report_request' }] } },
      fieldDecisions: DECISIONS,
    });
    await openAdvisor();
    section('workflows');
    const tasks = await screen.findByTestId('workflow-intent-report_request-tasks');
    expect(tasks).toHaveTextContent('report_request');
    expect(tasks).toHaveTextContent('→');
  });
});

describe('a-role-task-is-checked-and-listed (WT78)', () => {
  it('lists the requests another assistant\'s workflow makes of this assistant\'s role, by intent, assistant, workflow and step', async () => {
    const OPS = {
      ...ADVISOR, profileName: 'ops-premium', displayName: 'Ops', role: 'ops',
      activeRoleTasks: [{ workflow: 'ops-room', step: 'first-look', role: 'primary', machine: 'report_request' }],
    } as unknown as svc.ProfileListing;
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [ADVISOR, OPS], tools: [], runtimeAssistants: [], rosterTargets: [],
      classifications: { premium: PREMIUM }, fieldDecisions: DECISIONS,
    });
    await openAdvisor();
    section('workflows');
    const row = await screen.findByTestId('role-task-ops-room-first-look');
    expect(row).toHaveTextContent('report_request');
    expect(row).toHaveTextContent('Ops asks for report_request (in ops-room, step first-look)');
    expect(screen.queryByTestId('role-tasks-none')).toBeNull();
  });

  it('roleTasksFor reads only other assistants of the same classification, for this role', () => {
    const listing = (p: Record<string, unknown>) => p as unknown as svc.ProfileListing;
    const tasks = roleTasksFor([
      listing({ profileName: 'advisor', classification: 'premium', role: 'primary', activeRoleTasks: [{ workflow: 'self', step: 's', role: 'primary', machine: 'x' }] }),
      listing({ profileName: 'ops', displayName: 'Ops', classification: 'premium', role: 'ops', activeRoleTasks: [{ workflow: 'w', step: 'a', role: 'primary', machine: 'm' }, { workflow: 'w', step: 'b', role: 'other', machine: 'n' }] }),
      listing({ profileName: 'elsewhere', classification: 'standard', role: 'ops', activeRoleTasks: [{ workflow: 'w2', step: 'c', role: 'primary', machine: 'o' }] }),
    ], { profileName: 'advisor', classification: 'premium', role: 'primary' });
    expect(tasks).toEqual([{ assistant: 'Ops', workflow: 'w', step: 'a', machine: 'm' }]);
  });
});

describe('a-workflows-list-groups-by-trigger', () => {
  it('lists the welcome first, then the events, then a request\'s workflows, then the platform\'s', async () => {
    await openAdvisor();
    section('workflows');
    const welcome = screen.getByTestId('workflows-group-welcome');
    const events = screen.getByTestId('field-event-workflows');
    const intents = screen.getByTestId('workflows-group-intents');
    const platform = screen.getByTestId('workflows-platform-section');
    expect(follows(welcome, events)).toBe(true);
    expect(follows(events, intents)).toBe(true);
    expect(follows(intents, platform)).toBe(true);
    expect(within(screen.getByTestId('field-welcome')).getByTestId('assistant-workflow-own-welcome')).toBeTruthy();
  });

  it('lists the shipped event workflows once, in the platform expandable, labeled Shipped', async () => {
    await openAdvisor();
    section('workflows');
    const shipped = screen.getByTestId('workflows-shipped');
    expect(within(shipped).getByTestId('assistant-workflow-platform-ops-room')).toHaveTextContent('Shipped');
    // The shipped ops room opens its first look with a task step, whose steps a version edits, so no read-only note.
    expect(within(shipped).queryByTestId('assistant-workflow-ops-room-first-look')).toBeNull();
    expect(within(shipped).getByTestId('assistant-workflow-platform-incident-watch')).toBeTruthy();
    expect(screen.queryByTestId('workflows-group-conversation-opened')).toBeNull();
  });
});

describe('the-platform-section-offers-no-edit-or-copy', () => {
  it('explains what the platform workflows are for and offers only View steps, in the draft too', async () => {
    await openAdvisor();
    section('workflows');
    fireEvent.click(screen.getByTestId('assistant-mode-draft'));
    const platform = await screen.findByTestId('workflows-platform-section');
    expect(platform).toHaveTextContent('queue management');
    const buttons = within(platform).queryAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b).toHaveTextContent('View steps');
    expect(within(platform).queryByTestId(/assistant-copy-/)).toBeNull();
  });
});

describe('an-intents-run-level-is-read-only-in-stage-1', () => {
  it('lists a multi-step request with its workflow, its steps to view and an edit of its task steps', async () => {
    await openAdvisor();
    section('workflows');
    const row = within(screen.getByTestId('field-machines')).getAllByText('report_request')[0].closest('li')!;
    expect(within(row).getByText('View steps')).toBeTruthy();
    expect(within(row).getByText('Edit')).toBeTruthy();
    expect(row).toHaveTextContent('Steps before or after it are edited in a draft');
  });
});
