/**
 * AN EVENT WORKFLOW, READ: WHAT A WELCOME SAYS, AND ITS STEPS IN ORDER (SPEC-ADMIN-CONSOLE "Assistants", Workflows).
 *
 * What it proves:
 *   - one workflow's welcome is read from that workflow (`welcomeSays`), with its opening whatever its shape: a text
 *     opening with `{{eventSummary}}`, a structured opening of orientation fields, and one typed for a kind of room;
 *   - the preview is the router's composer: a structured opening reads as `composeOpening` composes it, examples as the
 *     list a person sees; a text opening with each field the room fills shown as a marked placeholder, never invented;
 *     an opening that sets nothing is the deployment's or the built-in opening; a welcome with no opening step greets
 *     from its steps;
 *   - a workflow's steps read in the order a run reaches them, with the template, prompt, role or machine each names.
 */
import { describe, it, expect } from 'vitest';
import { previewOpening, welcomeSays, workflowSteps } from './eventWorkflowPreview';
import { welcomeFor } from './welcomeWorkflow';
import { OPS_WELCOME, ADVISOR_WELCOME } from '../../../../../../backend/demo/welcomes';
import { PLATFORM_EVENT_WORKFLOWS, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { composeOpening, selectOpening } from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';

const mark = (field: string) => `‹${field}›`;

/** A welcome whose one step is this opening, in the rooms `types` names. */
const opens = (opening: Record<string, unknown>, types?: string[], prompt?: string): EventWorkflow => ({
  on: 'assistant-joined', ...(types ? { types } : {}), initial: 'opening',
  states: prompt ? {
    opening: { opening, onSuccess: 'ask', onFailure: 'ask' },
    ask: { prompt: { template: prompt }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  } : {
    opening: { opening, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
});

describe('what one welcome says', () => {
  it('reads the opening of a typed text welcome and of a structured welcome from the workflow itself', () => {
    expect(welcomeSays(OPS_WELCOME['welcome-ops']).opening?.text).toMatch(/^This conversation is open for an operations issue\.\n\{\{eventSummary\}\}\n/);
    expect(welcomeSays(OPS_WELCOME.welcome).opening).toMatchObject({ companyName: 'Stratum Technologies', examples: expect.arrayContaining(['Which alarms are in alarm, and what do they cover?']) });
    expect(welcomeSays(ADVISOR_WELCOME['welcome-ops-team']).runs).toBe(false);
  });

  it('agrees with the welcome a kind of room selects, for every seeded welcome', () => {
    for (const [name, wf] of Object.entries({ ...OPS_WELCOME })) {
      const selected = welcomeFor(OPS_WELCOME, wf.types?.[0] ?? '');
      expect(selected.name).toBe(name);
      expect(selected.opening).toEqual(welcomeSays(wf).opening);
    }
  });

  it('reads a welcome named for a blank room type, which a kind-of-room lookup cannot select', () => {
    const wf = opens({ text: 'Hello there.' }, ['']);
    expect(welcomeFor({ odd: wf }, wf.types?.[0] ?? '').opening).toBeUndefined();
    expect(welcomeSays(wf).opening?.text).toBe('Hello there.');
  });
});

describe('the opening, previewed with the router\'s composer', () => {
  it('composes a structured opening exactly as the router does, examples as a list', () => {
    const p = previewOpening(OPS_WELCOME.welcome, mark, 'ops');
    expect(p.source).toBe('fields');
    const own = selectOpening(welcomeSays(OPS_WELCOME.welcome).opening)!;
    expect(p.content).toBe(composeOpening(undefined, own.orientation!).content);
    expect(p.content).toMatch(/^Hi - I'm your assistant at Stratum Technologies, an enterprise SaaS company/);
    expect(p.content).toContain('A few things you can try:\n- What is the error rate across the deployment right now?\n- Which functions are slowest, and since when?');
    expect(p.placeholders).toEqual([]);
  });

  it('shows each field the room fills as a marked placeholder, and keeps every line', () => {
    const p = previewOpening(OPS_WELCOME['welcome-ops'], mark, 'ops');
    expect(p.source).toBe('text');
    expect(p.content).toBe([
      'This conversation is open for an operations issue.',
      '‹eventSummary›',
      'I can read this deployment\'s metrics and alarm state - ask me what is happening and I will start there.',
    ].join('\n'));
    expect(p.placeholders).toEqual(['eventSummary']);
  });

  it('says the assistant\'s own role, and marks a version variable and an unknown role in place', () => {
    const wf = opens({ text: 'I am the {{role}} assistant.\nThis is {{room.title}}.\n{{examples}}', examples: ['Try this'] });
    expect(previewOpening(wf, mark, 'ops').content).toBe('I am the ops assistant.\nThis is ‹room.title›.\n- Try this');
    const unknown = previewOpening(wf, mark);
    expect(unknown.content.split('\n')[0]).toBe('I am the ‹role› assistant.');
    expect(unknown.placeholders).toEqual(['role', 'room.title']);
  });

  it('names the prompt turn that follows the opening', () => {
    expect(previewOpening(opens({ text: 'Hi.' }, undefined, 'welcome-ask'), mark).prompt).toBe('welcome-ask');
  });

  it('shows the built-in opening for one that sets nothing, and none for a welcome that greets from its steps', () => {
    const empty = previewOpening(PLATFORM_EVENT_WORKFLOWS.welcome, mark);
    expect(empty.source).toBe('deployment');
    expect(empty.content).toBe(composeOpening(undefined, {}).content);
    const steps = previewOpening(PLATFORM_EVENT_WORKFLOWS['opening-and-subject'], mark);
    expect(steps).toMatchObject({ source: 'steps', content: '' });
  });
});

describe('a workflow\'s steps, in the order a run reaches them', () => {
  it('reads each step with what it names, the end last', () => {
    expect(workflowSteps(PLATFORM_EVENT_WORKFLOWS['ops-room'])).toEqual([
      { key: 'opening', kind: 'send', names: 'ops-room-opening' },
      { key: 'greet-lead', kind: 'send', names: 'ops-lead-welcome' },
      { key: 'first-look', kind: 'agent', names: 'ops-first-look', as: 'ops' },
      { key: 'done', kind: 'end', disposition: 'success' },
    ]);
    expect(workflowSteps(opens({ text: 'Hi.' }, undefined, 'welcome-ask')).map((s) => s.kind)).toEqual(['opening', 'prompt', 'end']);
  });

  it('lists a step no edge reaches after the rest', () => {
    const wf = opens({ text: 'Hi.' });
    wf.states.stray = { send: { to: 'room', template: 'x' }, onSuccess: 'done' };
    expect(workflowSteps(wf).map((s) => s.key)).toEqual(['opening', 'done', 'stray']);
  });
});
