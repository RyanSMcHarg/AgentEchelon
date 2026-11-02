/**
 * A DELIVERING STEP DECLARES THE TEMPLATE ITS DOCUMENT FOLLOWS (SPEC-DOCUMENT-TEMPLATES FR3, FR3a, FR4, FR5).
 *
 * The platform runs what the workflow DECLARES. A state that delivers names one template, or offers a
 * choice; validation refuses a template anywhere else; the requirements step records the person's choice
 * as a need with its source, constrained to the declared names; the delivering step loads the RECORDED
 * choice (or the declared default), never one the model picks; and the step's guidance, including the
 * guidance returned with an advance, carries the template's structure.
 */
const mockAdvance = jest.fn();
jest.mock('../../lambda/src/lib/task-store', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store'),
  advanceTaskStateTo: (...args: unknown[]) => mockAdvance(...args),
}));

import {
  DEFAULT_TASK_STATE_MACHINES,
  validateTaskStateMachine,
  resolveStateTemplate,
  type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import { handleAdvanceTaskStateTool, taskToolSpecsFor, templateForDelivery } from '../../lambda/src/lib/task-tools';
import { buildTaskSystemPrompt } from '../../lambda/src/lib/task-step-prompt';
import { parseTemplate, type TurnTemplates } from '../../lambda/src/lib/document-template';
import type { Task } from '../../lambda/src/lib/task-tracking';

/**
 * The platform's report workflow with its own `report` template taken off its delivering steps, so each
 * case below declares exactly the template it is about. The platform declaration itself is asserted last.
 */
const platformReport = DEFAULT_TASK_STATE_MACHINES.report_generation;
const report: TaskStateMachine = {
  ...platformReport,
  states: Object.fromEntries(Object.entries(platformReport.states).map(([k, { template: _t, ...def }]) => [k, def])),
};

/** The shipped report workflow with a choice of formats on its delivering steps. */
const withChoice = (defaultTemplate?: string): TaskStateMachine => ({
  ...report,
  states: {
    ...report.states,
    generating: { ...report.states.generating, templates: ['full-review', 'one-page'], ...(defaultTemplate ? { defaultTemplate } : {}) },
    revising: { ...report.states.revising, templates: ['full-review', 'one-page'], ...(defaultTemplate ? { defaultTemplate } : {}) },
  },
});

const tpl = (name: string, description: string, body: string) => ({
  name,
  contentHash: name === 'full-review' ? 'a'.repeat(64) : 'b'.repeat(64),
  template: parseTemplate(`---\n${JSON.stringify({ name, description })}\n---\n${body}`),
});
const TEMPLATES: TurnTemplates = {
  'full-review': tpl('full-review', 'A full quarterly review', '# Review\n\n## Summary\n\n## Metrics\n\n| A | B | C |\n|---|---|---|\n'),
  'one-page': tpl('one-page', 'A one-page summary', '# Summary\n\n## Highlights\n'),
};

const taskAt = (state: string, details: Record<string, unknown> = {}): Task => ({
  taskId: 't1', channelArn: 'arn:c', taskType: 'report_generation', taskState: state, status: 'in_progress', details,
} as Task);

const COLLECTED = [
  { need: 'the subject', value: 'Coastal Health Q3', source: 'message', evidence: 'Coastal Health' },
  { need: 'the audience', value: 'leadership', source: 'message', evidence: 'for leadership' },
  { need: 'the length or format', value: 'one page', source: 'message', evidence: 'one page' },
];

describe('validation: a template is declared on a delivering step, and nowhere else (FR4)', () => {
  const machine = (generating: Record<string, unknown>, collecting: Record<string, unknown> = {}): TaskStateMachine => ({
    ...report,
    states: {
      ...report.states,
      collecting_requirements: { ...report.states.collecting_requirements, ...collecting },
      generating: { ...report.states.generating, ...generating },
    },
  });

  it('accepts a single template and a choice with a default', () => {
    expect(() => validateTaskStateMachine('r', machine({ template: 'full-review' }))).not.toThrow();
    expect(() => validateTaskStateMachine('r', machine({ template: `full-review@${'c'.repeat(64)}` }))).not.toThrow();
    expect(() => validateTaskStateMachine('r', withChoice('one-page'))).not.toThrow();
  });

  it.each([
    ['on a step that does not deliver', { ...report, states: { ...report.states, drafting_outline: { ...report.states.drafting_outline, template: 'x' } } }, /declares a template but does not deliver/],
    ['both forms at once', machine({ template: 'a', templates: ['b', 'c'] }), /both template and templates/],
    ['a name that is not one', machine({ template: 'Not A Name' }), /not a template name/],
    ['a default outside the list', machine({ templates: ['a', 'b'], defaultTemplate: 'c' }), /not one of its templates/],
    ['the same template twice', machine({ templates: ['a', 'a'] }), /same template twice/],
    ['a choice with nobody asked', machine({ templates: ['a', 'b'] }, { requires: undefined, presented: undefined }), /nobody is asked to choose/],
  ])('refuses a template %s', (_label, m, message) => {
    expect(() => validateTaskStateMachine('r', m as TaskStateMachine)).toThrow(message);
  });
});

describe('the choice is a need of the requirements step, an enum of the declared names (FR3a)', () => {
  beforeEach(() => mockAdvance.mockReset().mockResolvedValue({ ok: true, from: 'collecting_requirements', to: 'drafting_outline' }));

  it('offers `template` as an enum of exactly the declared names, required where there is no default', () => {
    const [spec] = taskToolSpecsFor('report_generation', { report_generation: withChoice() }, 'collecting_requirements');
    const json = spec.toolSpec.inputSchema.json as unknown as { properties: Record<string, any>; required: string[] };
    expect(json.properties.template.properties.name.enum).toEqual(['full-review', 'one-page']);
    expect(json.properties.template.properties.source.enum).toEqual(['message', 'context']);
    expect(json.required).toContain('template');

    const [withDefault] = taskToolSpecsFor('report_generation', { report_generation: withChoice('one-page') }, 'collecting_requirements');
    expect((withDefault.toolSpec.inputSchema.json as unknown as { required: string[] }).required).not.toContain('template');
    expect(withDefault.toolSpec.description).toContain('"one-page" is used');
  });

  it('offers nothing new to a workflow with no choice', () => {
    const [spec] = taskToolSpecsFor('report_generation', DEFAULT_TASK_STATE_MACHINES, 'collecting_requirements');
    expect((spec.toolSpec.inputSchema.json as unknown as { properties: Record<string, unknown> }).properties.template).toBeUndefined();
  });

  it('refuses to leave the requirements step with no choice recorded and no default', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('collecting_requirements'), machines: { report_generation: withChoice() },
      input: { to_state: 'drafting_outline', reason: 'confirmed', collected: COLLECTED },
    });
    expect(out.result).toMatchObject({ ok: false, error: 'requirement_unsourced' });
    expect(out.payload.missing).toEqual(['template']);
    expect(out.payload.message).toContain('"full-review", "one-page"');
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('refuses a name the workflow does not declare, and a choice with no evidence', async () => {
    for (const template of [{ name: 'made-up', source: 'message', evidence: 'x' }, { name: 'one-page', source: 'message', evidence: '' }]) {
      const out = await handleAdvanceTaskStateTool({
        task: taskAt('collecting_requirements'), machines: { report_generation: withChoice('one-page') },
        input: { to_state: 'drafting_outline', reason: 'confirmed', collected: COLLECTED, template },
      });
      expect(out.payload.missing).toEqual(['template']);
    }
  });

  it('records the choice with its source and evidence, like every need', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('collecting_requirements'), machines: { report_generation: withChoice() },
      input: {
        to_state: 'drafting_outline', reason: 'confirmed', collected: COLLECTED,
        template: { name: 'one-page', source: 'message', evidence: 'just the one-pager please' },
      },
    });
    expect(out.result.ok).toBe(true);
    expect(out.details?.requirements).toMatchObject({ template: 'one-page' });
    expect(out.details?.collectedRequirements).toMatchObject({
      template: { value: 'one-page', source: 'message', evidence: 'just the one-pager please' },
    });
  });

  it('lets the step go with no choice when a default is declared', async () => {
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('collecting_requirements'), machines: { report_generation: withChoice('one-page') },
      input: { to_state: 'drafting_outline', reason: 'confirmed', collected: COLLECTED },
    });
    expect(out.result.ok).toBe(true);
  });
});

describe('the delivering step loads the RECORDED choice (FR3a)', () => {
  const recorded = (name: string) => ({ collectedRequirements: { template: { value: name, source: 'message', evidence: name } } });

  it('resolves the recorded choice, else the default, else asks', () => {
    expect(resolveStateTemplate(withChoice(), 'generating', recorded('one-page'))).toEqual({ ref: { name: 'one-page' }, chosen: true });
    expect(resolveStateTemplate(withChoice('full-review'), 'generating', {})).toEqual({ ref: { name: 'full-review' }, chosen: false });
    expect(resolveStateTemplate(withChoice(), 'generating', {})).toEqual({ choiceRequired: true, names: ['full-review', 'one-page'] });
    // A value that is not a declared name is not a choice.
    expect(resolveStateTemplate(withChoice('full-review'), 'generating', recorded('rogue'))).toMatchObject({ ref: { name: 'full-review' } });
  });

  it('hands the recorded template to the delivery, and a revision keeps it', async () => {
    mockAdvance.mockReset().mockResolvedValue({ ok: true, from: 'drafting_outline', to: 'generating' });
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('drafting_outline', recorded('one-page')), machines: { report_generation: withChoice('full-review') }, templates: TEMPLATES,
      input: {
        to_state: 'generating', reason: 'approved', document: '# Summary\n\n## Highlights\n\nGood quarter.',
        collected: [{ need: 'approval of the outline, or what to change about it', value: 'yes', source: 'message', evidence: 'looks good' }],
      },
    });
    expect(out.template).toMatchObject({ loaded: { name: 'one-page' }, state: 'generating', chosen: true });

    const revising = templateForDelivery({ machine: withChoice('full-review'), state: 'revising', details: recorded('one-page'), templates: TEMPLATES });
    expect(revising).toMatchObject({ ok: true, loaded: { name: 'one-page' } });
  });

  it('records a new choice on a revision, which the next delivery then loads', async () => {
    mockAdvance.mockReset().mockResolvedValue({ ok: true, from: 'generating', to: 'revising' });
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('generating', recorded('one-page')), machines: { report_generation: withChoice('full-review') }, templates: TEMPLATES,
      input: {
        to_state: 'revising', reason: 'wants the full one', document: '# Review\n\n## Summary\n\n## Metrics\n\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |',
        template: { name: 'full-review', source: 'message', evidence: 'give me the full review instead' },
      },
    });
    expect(out.template).toMatchObject({ loaded: { name: 'full-review' }, chosen: true });
    expect(out.details?.requirements).toMatchObject({ template: 'full-review' });
  });

  it('refuses a delivery whose template could not be loaded, naming it, and moves nothing', async () => {
    mockAdvance.mockReset();
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('drafting_outline'), templates: { 'full-review': { name: 'full-review', error: 'no version is active' } },
      machines: { report_generation: { ...report, states: { ...report.states, generating: { ...report.states.generating, template: 'full-review' } } } },
      input: {
        to_state: 'generating', reason: 'approved', document: '# R',
        collected: [{ need: 'approval of the outline, or what to change about it', value: 'yes', source: 'message', evidence: 'ok' }],
      },
    });
    expect(out.result).toMatchObject({ ok: false, error: 'template_unavailable' });
    expect(String(out.payload.message)).toContain('no version is active');
    expect(mockAdvance).not.toHaveBeenCalled();
  });
});

describe('the template is rendered into the step guidance, including the guidance returned with an advance (FR5)', () => {
  const single: Record<string, TaskStateMachine> = {
    report_generation: { ...report, states: { ...report.states, generating: { ...report.states.generating, template: 'full-review' } } },
  };

  it('renders the template on the delivering step', () => {
    const prompt = buildTaskSystemPrompt('report_generation', 'generating', single, { templates: TEMPLATES });
    expect(prompt).toContain('## DOCUMENT TEMPLATE: full-review');
    expect(prompt).toContain('a table with exactly 3 columns');
  });

  it('renders nothing for a workflow that declares no template', () => {
    expect(buildTaskSystemPrompt('report_generation', 'generating', { report_generation: report }, { templates: TEMPLATES }))
      .not.toContain('DOCUMENT TEMPLATE');
  });

  it('the platform report workflow declares the shipped `report` template on both delivering steps, and renders it', () => {
    expect(platformReport.states.generating.template).toBe('report');
    expect(platformReport.states.revising.template).toBe('report');
    expect(() => validateTaskStateMachine('report_generation', platformReport)).not.toThrow();
    const loaded = { report: tpl('report', 'A general report', '# Report\n\n## Summary\n\n## Findings\n\n## Sources\n') };
    expect(buildTaskSystemPrompt('report_generation', 'generating', DEFAULT_TASK_STATE_MACHINES, { templates: loaded }))
      .toContain('## DOCUMENT TEMPLATE: report');
  });

  it('lists the formats on the requirements step while nobody has chosen', () => {
    const prompt = buildTaskSystemPrompt('report_generation', 'collecting_requirements', { report_generation: withChoice() }, { templates: TEMPLATES });
    expect(prompt).toContain('- `full-review`: A full quarterly review');
    expect(prompt).toContain('- `one-page`: A one-page summary');
  });

  it('returns the landed step\'s template with the advance, from the choice this advance recorded', async () => {
    mockAdvance.mockReset().mockResolvedValue({ ok: true, from: 'drafting_outline', to: 'generating' });
    const machines = { report_generation: withChoice() };
    const out = await handleAdvanceTaskStateTool({
      task: taskAt('drafting_outline'), machines, templates: TEMPLATES,
      guidanceFor: (taskType, state, details) => buildTaskSystemPrompt(taskType, state, machines, { templates: TEMPLATES, details }),
      input: {
        to_state: 'generating', reason: 'approved', document: '# Summary\n\n## Highlights\n\nGood.',
        collected: [{ need: 'approval of the outline, or what to change about it', value: 'yes', source: 'message', evidence: 'ok' }],
        template: { name: 'one-page', source: 'message', evidence: 'one page please' },
      },
    });
    expect(String(out.payload.guidance)).toContain('## DOCUMENT TEMPLATE: one-page');
  });
});
