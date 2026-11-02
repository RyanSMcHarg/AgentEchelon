/**
 * CREATING AN ASSISTANT IS ONE WIZARD IN VISIBLE STEPS (owner decisions, 2026-10-23, 2026-10-24 and 2026-10-29).
 *
 * What it proves: the seven steps are listed with the assistant page's section names, and the current one is marked;
 * the first step cannot be left until it is complete; each field reads label, help, then control, in the page's words;
 * what needs a deploy (a new classification or role) is said behind the step's help with the guides, not
 * a field; a live preview shows every choice so far; after the create the wizard waits for the build and reads the
 * listing again when asked, with no timer; the starting point says what the first draft will hold (the classification's intents, workflows and
 * templates; a file's source and intents; the copied assistant and version) and is sent with the create; a file
 * that is not a profile is refused before anything is sent, and a file fills in the models it names that the
 * classification selects; a copy offers only assistants in the same classification; the classifier model is
 * chosen from the classification's models or the platform classifier, and is not sent when keywords classify;
 * turns per hour is optional and sent only when set; only the models the chosen classification selects are
 * offered, from the catalog the listing serves when it carries one; a refused create shows each reason; an admin
 * may leave the owner unset and creates on the admin route; a team member's owner is their own team, and the
 * create goes on that team's route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import CreateAssistantFlow from './CreateAssistantFlow';
import { createAssistant } from '../../services/rosterService';
import type { ClassificationCatalog } from '../../services/profileService';
import { setClassificationsForTest } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';
import { DOC_SECTIONS } from '../../config/docLinks';

vi.mock('../../services/rosterService', () => ({ createAssistant: vi.fn() }));

const targets = [
  { classification: 'basic', roles: ['primary'] },
  { classification: 'premium', roles: ['primary', 'ops'] },
];

const catalogs: Record<string, ClassificationCatalog> = {
  basic: { classification: 'basic', models: { text: ['haiku'], image: [] }, retrievalReach: [], roles: {} },
  premium: {
    classification: 'premium',
    models: { text: ['sonnet', 'opus'], image: [] },
    packIntents: ['account_review', 'escalation'],
    workflows: [
      { key: 'queue_drain', source: 'platform', required: true, initial: 'triage', states: ['triage', 'done'] },
      { key: 'report_generation', source: 'platform', required: false, initial: 'gather', states: ['gather', 'deliver'] },
      { key: 'quarterly_report', source: 'classification', required: false, initial: 'gather', states: ['gather', 'deliver'] },
    ],
    templates: [{ name: 'quarterly-account-review', active: 'abc' }],
    retrievalReach: [],
    roles: {},
  },
};

const copySources = [
  { profileName: 'advisor', label: 'Advisor', classification: 'premium', activeVersion: 4 },
  { profileName: 'concierge', label: 'Concierge', classification: 'basic', activeVersion: 2 },
];

const manifest = {
  schemaVersion: 1,
  kind: 'assistant-profile',
  profileName: 'advisor',
  provenance: { sourceVersion: 4 },
  body: {
    displayName: 'Advisor',
    modelKey: 'opus',
    models: { default: 'opus', classifier: 'sonnet' },
    intentPack: { intents: [{ key: 'account_review' }, { key: 'pricing' }] },
    welcome: { title: 'Hello' },
    persona: 'You advise.',
  },
};

beforeEach(() => setClassificationsForTest(SAMPLE_CLASSIFICATIONS));
afterEach(() => setClassificationsForTest(null));
beforeEach(() => vi.mocked(createAssistant).mockReset().mockResolvedValue({ assistantId: 'x', status: 'provisioning' }));

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const select = (label: string) => screen.getByLabelText(label) as unknown as HTMLSelectElement;
const values = (s: HTMLSelectElement) => [...s.options].map((o) => o.value).filter(Boolean);
const startWith = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }));
const identity = (id = 'finance-advisor', name = 'Finance') => {
  fireEvent.change(field('Identifier'), { target: { value: id } });
  fireEvent.change(field('Assistant name'), { target: { value: name } });
};
/** The first step, filled in, then on to the starting point and models. */
const toCan = (id?: string, name?: string) => { identity(id, name); next(); };
const createButton = () => screen.getByRole('button', { name: 'Create assistant' });
const chooseFirstModel = () => {
  const model = select('Default model');
  fireEvent.change(model, { target: { value: values(model)[0] } });
  return values(model)[0];
};
const upload = (text: string, name = 'advisor.json') => fireEvent.change(
  screen.getByLabelText('Choose a profile file for the new assistant'),
  { target: { files: [new File([text], name, { type: 'application/json' })] } },
);

function renderFlow(over: Partial<React.ComponentProps<typeof CreateAssistantFlow>> = {}) {
  const onCreated = vi.fn();
  render(<CreateAssistantFlow targets={targets} ownerTeams={['finance', 'ops']} isAdmin catalogs={catalogs}
    copySources={copySources} onCreated={onCreated} onCancel={vi.fn()} {...over} />);
  return onCreated;
}

describe('the steps', () => {
  it('lists every step and marks the current one', () => {
    renderFlow();
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['Classification and name', 'Starting point and models', 'Behavioral', 'Workflows', 'Scope and models', 'Tools and context', 'Review and activate']);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('create-step-heading')).toHaveTextContent('Step 1 of 7: Classification and name');
  });

  it('keeps the introduction to the wizard behind a ? control', () => {
    renderFlow();
    expect(screen.queryByText(/built in the background with a first draft/)).toBeNull();
    fireEvent.click(screen.getByTestId('create-help'));
    expect(screen.getByTestId('create-help-panel')).toHaveTextContent('built in the background with a first draft');
    expect(screen.getByTestId('create-help')).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows every choice so far in a live preview', () => {
    renderFlow();
    identity('finance-advisor', 'Finance');
    const preview = screen.getByTestId('create-preview');
    expect(preview).toHaveTextContent('finance-advisor');
    expect(preview).toHaveTextContent('Finance');
  });

  it('explains behind its help that a new classification or role is a deploy, and links the guides', () => {
    renderFlow();
    expect(screen.queryByTestId('create-deploy-step')).toBeNull();
    fireEvent.click(screen.getByTestId('create-deploy-help'));
    const step = screen.getByTestId('create-deploy-step');
    expect(step).toHaveTextContent('one classification for its whole life');
    expect(step).toHaveTextContent('tools, context, tags and IAM role');
    expect(within(step).getByRole('link', { name: /Adding a classification/ })).toHaveAttribute('href', DOC_SECTIONS.addClassification);
    expect(within(step).getByRole('link', { name: /Adding a role/ })).toHaveAttribute('href', DOC_SECTIONS.addRole);
    // It is not a field: nothing in it takes input.
    expect(within(step).queryByRole('textbox')).toBeNull();
    expect(within(step).queryByRole('combobox')).toBeNull();
  });

  it('offers only the roles the chosen classification declares', () => {
    renderFlow();
    fireEvent.change(field('Classification'), { target: { value: 'premium' } });
    expect(within(select('Role')).getAllByRole('option').map((o) => o.textContent)).toEqual(['primary', 'ops']);
  });

  it('does not leave the first step until the identifier and name are valid', () => {
    renderFlow();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    identity('Bad Name');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.change(field('Identifier'), { target: { value: 'finance-advisor' } });
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('asks for turns per hour only with the starting point and models, as an optional field', () => {
    renderFlow();
    expect(screen.queryByLabelText('Turns per hour')).toBeNull();
    toCan();
    chooseFirstModel();
    expect(createButton()).toBeEnabled();
    fireEvent.change(field('Turns per hour'), { target: { value: '0' } });
    expect(createButton()).toBeDisabled();
    fireEvent.change(field('Turns per hour'), { target: { value: '20' } });
    expect(createButton()).toBeEnabled();
  });

  it('offers only the models the served catalog allows for the classification, for the classifier and the default model', () => {
    renderFlow();
    fireEvent.change(field('Classification'), { target: { value: 'premium' } });
    toCan();
    expect(values(select('Default model'))).toEqual(['sonnet', 'opus']);
    expect(values(select('Classifier model'))).toEqual(['default', 'sonnet', 'opus']);
    expect(select('Classifier model').value).toBe('default');
  });

  it('turns the classifier model off while keywords classify', () => {
    renderFlow();
    toCan();
    fireEvent.change(select('Intent classification'), { target: { value: 'keyword' } });
    expect(select('Classifier model')).toBeDisabled();
    expect(screen.getByText('Not used while intents are decided by keyword rules.')).toBeTruthy();
  });

  it('reads each field as label, help, then control, in the words and order of the assistant page', () => {
    renderFlow();
    const name = field('Assistant name');
    expect(document.getElementById(name.getAttribute('aria-describedby')!)).toHaveTextContent('Shown in chat beside each message');
    toCan();
    const classifier = select('Classifier model');
    const model = select('Default model');
    expect(document.getElementById(classifier.getAttribute('aria-describedby')!)).toHaveTextContent('Reads each message first and decides which intent the message is.');
    expect(document.getElementById(model.getAttribute('aria-describedby')!)).toHaveTextContent('Answers any intent without a route of its own.');
    // The classifier comes before the default model, in the order a message meets them.
    expect(classifier.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...model.closest('.admin-stacked-field')!.children].map((e) => e.tagName)).toEqual(['LABEL', 'SPAN', 'SELECT']);
  });
});

describe('the starting point', () => {
  it('offers the classification defaults, a profile file and a copy, and says what the defaults hold', () => {
    renderFlow();
    fireEvent.change(field('Classification'), { target: { value: 'premium' } });
    toCan();
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['defaults', 'manifest', 'copy']);
    expect(screen.getByRole('radio', { name: /Classification defaults/ })).toBeChecked();
    const contents = screen.getByTestId('create-start-contents');
    expect(within(contents).getByTestId('create-start-intents')).toHaveTextContent('account_review, escalation');
    // Every assistant's workflows are apart from the ones it can open, and labeled platform-level and not editable.
    const required = screen.getByTestId('create-workflow-groups-required');
    expect(required).toHaveTextContent('queue_drain');
    expect(required).toHaveTextContent('Platform-level, not editable');
    expect(required).not.toHaveTextContent('report_generation');
    const optional = screen.getByTestId('create-workflow-groups-optional');
    expect(optional).toHaveTextContent('report_generation');
    expect(optional).toHaveTextContent("quarterly_report (this classification's)");
    expect(optional).not.toHaveTextContent('queue_drain');
    expect(contents).toHaveTextContent('quarterly-account-review');
    // How it is edited afterward is behind the step's help, with the format guide.
    fireEvent.click(screen.getByTestId('create-start-help'));
    expect(screen.getByText(/Intents and onboarding are edited as JSON/)).toBeTruthy();
    expect(screen.getByText(/Profile file format/)).toBeTruthy();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toContain(DOC_SECTIONS.portability);
  });

  it('says a classification with no pack starts on the platform intents', () => {
    renderFlow();
    toCan();
    expect(screen.getByTestId('create-start-intents')).toHaveTextContent("The platform's intents");
  });

  it('needs a file before it creates, and refuses one that is not a profile without sending anything', async () => {
    renderFlow();
    toCan();
    chooseFirstModel();
    startWith(/Upload a profile file/);
    expect(createButton()).toBeDisabled();
    upload('{"not":"a manifest"}', 'notes.json');
    await waitFor(() => expect(screen.getByTestId('create-file-refused')).toBeTruthy());
    expect(createButton()).toBeDisabled();
    expect(createAssistant).not.toHaveBeenCalled();
  });

  it('summarizes a file, fills in the models the classification selects, and sends it as the starting point', async () => {
    renderFlow();
    fireEvent.change(field('Classification'), { target: { value: 'premium' } });
    toCan('advisor-two', 'Advisor2');
    startWith(/Upload a profile file/);
    upload(JSON.stringify(manifest));
    await waitFor(() => expect(screen.getByTestId('create-start-source')).toHaveTextContent('advisor v4'));
    expect(screen.getByTestId('create-start-intents')).toHaveTextContent('account_review, pricing');
    expect(screen.getByText(/Checked against premium when you create the assistant/)).toBeTruthy();
    expect(screen.getByTestId('create-models-from-file')).toBeTruthy();
    expect(select('Default model').value).toBe('opus');
    expect(select('Classifier model').value).toBe('sonnet');
    expect(screen.getByTestId('create-review-start')).toHaveTextContent('Upload a profile file');
    fireEvent.click(createButton());
    await waitFor(() => expect(createAssistant).toHaveBeenCalledTimes(1));
    const [request] = vi.mocked(createAssistant).mock.calls[0];
    expect(request.startingPoint).toEqual({ kind: 'manifest', manifest });
    expect(request.descriptor).toEqual({ modelKey: 'opus', classifierMode: 'llm', classifierModelKey: 'sonnet' });
    // The name was decided in the first step, so the name chosen there is the one sent, whatever the file names.
    expect(request.displayName).toBe('Advisor2');
  });

  it('does not fill in a model from a file that the classification does not select', async () => {
    renderFlow();
    toCan();
    startWith(/Upload a profile file/);
    upload(JSON.stringify(manifest));
    await waitFor(() => expect(screen.getByTestId('create-start-source')).toBeTruthy());
    expect(select('Default model').value).toBe('');
    expect(select('Classifier model').value).toBe('default');
  });

  it('offers a copy of an assistant in the same classification only, and sends which one', async () => {
    renderFlow();
    fireEvent.change(field('Classification'), { target: { value: 'premium' } });
    toCan();
    chooseFirstModel();
    startWith(/Copy an existing assistant/);
    expect(createButton()).toBeDisabled();
    expect(values(select('Assistant to copy'))).toEqual(['advisor']);
    fireEvent.change(select('Assistant to copy'), { target: { value: 'advisor' } });
    expect(screen.getByTestId('create-start-source')).toHaveTextContent('Advisor, active version v4');
    fireEvent.click(createButton());
    await waitFor(() => expect(createAssistant).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createAssistant).mock.calls[0][0].startingPoint).toEqual({ kind: 'copy', from: 'advisor' });
  });

  it('says when nothing in the classification can be copied', () => {
    renderFlow({ copySources: [] });
    toCan();
    chooseFirstModel();
    startWith(/Copy an existing assistant/);
    expect(screen.getByTestId('create-copy-none')).toHaveTextContent('No assistant in basic that you manage has an active version to copy.');
    expect(createButton()).toBeDisabled();
  });
});

describe('creating', () => {
  it('an admin may leave the owner unset, and creates on the admin route from the defaults', async () => {
    const onCreated = renderFlow();
    fireEvent.change(field('Classification'), { target: { value: 'premium' } });
    expect(within(screen.getByTestId('create-owner-team')).getByRole('option', { name: 'No team (admins only)' })).toBeTruthy();
    toCan();
    const model = chooseFirstModel();
    expect(screen.getByTestId('create-review')).toHaveTextContent('finance-advisor');
    expect(screen.getByTestId('create-review-start')).toHaveTextContent('Classification defaults');
    fireEvent.click(createButton());
    await waitFor(() => expect(createAssistant).toHaveBeenCalledTimes(1));
    const [request, asTeam] = vi.mocked(createAssistant).mock.calls[0];
    expect(asTeam).toBeUndefined();
    expect(request).toEqual({
      assistantId: 'finance-advisor', classification: 'premium', role: 'primary', displayName: 'Finance',
      descriptor: { modelKey: model, classifierMode: 'llm', classifierModelKey: 'default' },
    });
    expect(onCreated).toHaveBeenCalledWith('finance-advisor');
  });

  it('waits for the build on the next step, and reads the listing again only when asked', async () => {
    const onCheckBuild = vi.fn();
    renderFlow({ onCheckBuild });
    toCan();
    chooseFirstModel();
    fireEvent.click(createButton());
    const building = await screen.findByTestId('create-building');
    expect(building).toHaveTextContent('finance-advisor is being built');
    expect(screen.getByTestId('create-step-heading')).toHaveTextContent('Step 3 of 7: Behavioral');
    expect(onCheckBuild).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('create-check-build'));
    expect(onCheckBuild).toHaveBeenCalledTimes(1);
  });

  it('sends no classifier model while keywords classify', async () => {
    renderFlow();
    toCan();
    chooseFirstModel();
    fireEvent.change(select('Intent classification'), { target: { value: 'keyword' } });
    fireEvent.click(createButton());
    await waitFor(() => expect(createAssistant).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createAssistant).mock.calls[0][0].descriptor).not.toHaveProperty('classifierModelKey');
  });

  it('sends turns per hour in the descriptor when it is set', async () => {
    renderFlow();
    toCan();
    chooseFirstModel();
    fireEvent.change(field('Turns per hour'), { target: { value: '30' } });
    expect(screen.getByTestId('create-review')).toHaveTextContent('30 turns per hour');
    fireEvent.click(createButton());
    await waitFor(() => expect(createAssistant).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createAssistant).mock.calls[0][0].descriptor.rateLimitPerHour).toBe(30);
  });

  it('shows each reason the server refused the create for', async () => {
    vi.mocked(createAssistant).mockRejectedValueOnce(Object.assign(new Error('the starting point cannot be used'), {
      body: { errors: ["models.classifier 'opus' is not available to the target classification 'basic'"] },
    }));
    renderFlow();
    toCan();
    chooseFirstModel();
    fireEvent.click(createButton());
    const refused = await screen.findByTestId('create-refused');
    expect(refused).toHaveTextContent('The assistant was not created:');
    expect(within(refused).getByRole('listitem')).toHaveTextContent("models.classifier 'opus' is not available");
    expect(screen.queryByTestId('create-building')).toBeNull();
  });

  it('a team member with one team creates for that team, on its team route', async () => {
    renderFlow({ ownerTeams: ['ops'], isAdmin: false });
    const owner = screen.getByTestId('create-owner-team');
    expect(within(owner).queryByRole('combobox')).toBeNull();
    expect(owner).toHaveTextContent('Ops team');
    toCan('ops-helper', 'OpsHelper');
    chooseFirstModel();
    fireEvent.click(createButton());
    await waitFor(() => expect(createAssistant).toHaveBeenCalledTimes(1));
    const [request, asTeam] = vi.mocked(createAssistant).mock.calls[0];
    expect(asTeam).toBe('ops');
    expect(request.ownerTeam).toBe('ops');
  });

  it('offers a team member with several teams only those teams, and no unowned choice', () => {
    renderFlow({ ownerTeams: ['finance', 'ops'], isAdmin: false });
    const options = within(screen.getByTestId('create-owner-team')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Finance team', 'Ops team']);
  });
});
