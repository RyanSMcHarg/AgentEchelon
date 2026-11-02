/**
 * A VARIABLE GATES WHAT RUNS (ADR-060 slice 1d, decisions 4, 6 and 7; ADR-061 decision 2).
 *
 * A workflow step and each of its edges may carry a `when` over declared variables, and the runtime reads it through
 * the resolver's second layer with the values its call site holds: a step whose `when` does not hold posts nothing,
 * an edge takes its first alternative whose `when` holds, and a task's move is refused where its target's `when` or its
 * edge's does not hold, with a reason that names no value. A member-trust value never decides, even stored around
 * validation. Clearance decides as the set its holder token grants. A message template is chosen by its `when`, and
 * a version's routing rule selects only among the models its classification selects. The router and the processor
 * resolve what their call sites may read and no more: the processor reads `ctx:` values from the sources its turn
 * already resolved, under the grant it already holds, and the router holds no catalog grant at all.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  chooseEdge,
  eventWorkflowErrors,
  runEventWorkflow,
  type EventGate,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import {
  authorizeTransition,
  validateTaskStateMachine,
  type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import { actionVariableValues, bindActionArgs, turnConditionValues } from '../../lambda/src/lib/task-tools';
import {
  buildSourceTable,
  catalogValues,
  clearanceSet,
  decidingValues,
  evaluateWhen,
  sourceLookup,
  turnValues,
  versionLookup,
  whenErrors,
  whenHolds,
  type VariableValue,
} from '../../lambda/src/lib/variables';
import { eventStepCallSite, turnCallSite, welcomeCallSite } from '../../lambda/src/lib/context-sources-runtime';
import { chooseMessageName, chooseMessageTemplate } from '../../lambda/src/lib/message-template';
import { templateUseMisfit } from '../../lambda/src/lib/message-template-selection';
import { parseTemplate } from '../../lambda/src/lib/document-template';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { messagesShapeErrors } from '../../lambda/src/lib/profile-copy-fields';
import { noticeMentionsForMembers } from '../../lambda/src/lib/assistant-notice';
import { templateLine, withMessageTemplates } from '../../lambda/src/lib/message-lines';
import { resolveModelPlan } from '../../lambda/src/lib/resolve-model-plan';
import { routingRuleErrors, confineModelsToClassification } from '../../lambda/src/lib/active-profile';
import { getModelCatalog, INTENT_ROUTE_STRATEGY } from '../../lib/config/model-strategy';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { assistantsOf } from '../helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from '../helpers/synth';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const FIXED = sourceLookup(buildSourceTable({ catalog: [], classifications: ['basic', 'standard', 'premium'] }));
const SUBJECT = 'arn:aws:chime:us-east-1:123456789012:app-instance/app/user/subject-1';

// ── Event workflows: a step's `when` and conditioned edges ────────────────────────────────────────────────────────

/** ADR-061's example: the opening, then a different greeting for a new and a returning subject. */
const WELCOME: EventWorkflow = {
  on: 'assistant-joined',
  initial: 'opening',
  states: {
    opening: {
      send: { to: 'room', template: 'workflow-opening' },
      onSuccess: [
        { to: 'greet-new', when: { 'person:onboarded': false } },
        { to: 'greet-back', when: { 'person:onboarded': true } },
        { to: 'done' },
      ],
      onFailure: 'done',
    },
    'greet-new': { send: { to: 'subject', template: 'workflow-subject-welcome', mention: { name: 'subject' } }, onSuccess: 'done', onFailure: 'done' },
    'greet-back': { send: { to: 'subject', template: 'workflow-subject-welcome', mention: { name: 'subject' } }, when: { 'conversation:type': 'general' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
};

function gate(values: Record<string, VariableValue | undefined>, subjectSettled = true): EventGate {
  return { lookup: FIXED, values, callSite: { identitySettled: false, conversationSettled: false, subjectSettled } };
}

async function run(wf: EventWorkflow, g?: EventGate) {
  const taken = new Set<string>();
  const sent: string[] = [];
  const d: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step) => { if (taken.has(step)) return false; taken.add(step); return true; },
    mentionName: async () => 'Dana',
    send: async (a) => { sent.push(a.step); return true; },
    dispatchAgent: async () => true,
  };
  const ctx: EventRunContext = { event: 'assistant-joined', channelArn: 'arn:ch/channel/c1', subject: SUBJECT, values: {}, ...(g ? { gate: g } : {}) };
  const out = await runEventWorkflow('w', wf, ctx, d);
  return { sent, steps: out.steps };
}

describe('a conditioned edge and a step condition validate (ADR-061 decision 2)', () => {
  it('the welcome example validates: an edge choosing on a fact about the subject, among steps addressed to them', () => {
    expect(eventWorkflowErrors('w', WELCOME)).toEqual([]);
  });

  it('refuses a fact about a person choosing among alternatives the room reads, and member text anywhere', () => {
    const roomChoice = JSON.parse(JSON.stringify(WELCOME));
    roomChoice.states['greet-new'].send = { to: 'room', template: 'workflow-opening' };
    expect(eventWorkflowErrors('w', roomChoice).join('\n')).toMatch(/onSuccess\[0\]\.when: "person:onboarded" describes a person/);
    const member = JSON.parse(JSON.stringify(WELCOME));
    member.states.opening.onSuccess[0].when = { 'conversation:topic': 'x' };
    expect(eventWorkflowErrors('w', member).join('\n')).toMatch(/member text/);
  });

  it('refuses an edge naming an undeclared step, and a when on a terminal step', () => {
    const bad = JSON.parse(JSON.stringify(WELCOME));
    bad.states.opening.onSuccess[0].to = 'nowhere';
    bad.states.done.when = { 'conversation:type': 'ops' };
    const errs = eventWorkflowErrors('w', bad).join('\n');
    expect(errs).toMatch(/onSuccess\[0\]\.to names a declared step/);
    expect(errs).toMatch(/when is on a terminal step/);
  });

  it('refuses a cycle through any alternative', () => {
    const loop = JSON.parse(JSON.stringify(WELCOME));
    loop.states['greet-new'].onSuccess = [{ to: 'opening', when: { 'conversation:type': 'ops' } }, { to: 'done' }];
    expect(eventWorkflowErrors('w', loop).join('\n')).toMatch(/cycle/);
  });
});

describe('the runtime takes the edge whose condition holds (true, false, unresolved)', () => {
  it('true: a returning subject is greeted back', async () => {
    const { sent } = await run(WELCOME, gate({ 'person:onboarded': true, 'conversation:type': 'general' }));
    expect(sent).toEqual(['opening', 'greet-back']);
  });

  it('false: a new subject is greeted as new', async () => {
    const { sent } = await run(WELCOME, gate({ 'person:onboarded': false }));
    expect(sent).toEqual(['opening', 'greet-new']);
  });

  it('unresolved: a failed read, a value not settled here, or no gate at all takes the unconditioned edge', async () => {
    expect((await run(WELCOME, gate({}))).sent).toEqual(['opening']);
    expect((await run(WELCOME, gate({ 'person:onboarded': true }, false))).sent).toEqual(['opening']);
    expect((await run(WELCOME)).sent).toEqual(['opening']);
  });

  it("a step whose own when does not hold posts nothing, is recorded as gated, and the run goes on", async () => {
    const { sent, steps } = await run(WELCOME, gate({ 'person:onboarded': true, 'conversation:type': 'ops' }));
    expect(sent).toEqual(['opening']);
    expect(steps.map((s) => [s.step, s.outcome])).toEqual([['opening', 'posted'], ['greet-back', 'gated']]);
  });

  it('chooseEdge reads a name as written and a list in order', () => {
    expect(chooseEdge('done', () => true)).toBe('done');
    expect(chooseEdge([{ to: 'a', when: { x: 1 } }, { to: 'b', when: { y: 1 } }, { to: 'c' }], (w) => 'y' in (w as object))).toBe('b');
    expect(chooseEdge([{ to: 'a', when: { x: 1 } }, { to: 'c' }], () => false)).toBe('c');
  });
});

describe('a member-trust variable never gates, even stored around validation', () => {
  it('an edge on conversation:topic does not hold though the value matches', async () => {
    const stored: EventWorkflow = JSON.parse(JSON.stringify(WELCOME));
    (stored.states.opening as { onSuccess: unknown }).onSuccess = [{ to: 'greet-new', when: { 'conversation:topic': 'launch' } }, { to: 'done' }];
    expect((await run(stored, gate({ 'conversation:topic': 'launch' }))).sent).toEqual(['opening']);
  });

  it('a fact about a person chooses no edge whose alternatives the room reads, even stored', async () => {
    const stored: EventWorkflow = JSON.parse(JSON.stringify(WELCOME));
    stored.states['greet-new'].send = { to: 'room', template: 'workflow-opening' };
    expect((await run(stored, gate({ 'person:onboarded': false }))).sent).toEqual(['opening']);
  });

  it('a task condition on member text decides nothing: its value is held back before it reaches the store', () => {
    const machine = { initial: 'open', states: { open: { transitions: ['next'], edgeWhen: { next: { 'conversation:topic': 'x' } } }, next: { transitions: [], terminal: 'success' } } } as TaskStateMachine;
    const values = turnConditionValues({
      task: { taskType: 't' } as never, machines: { t: machine },
      variables: { lookup: FIXED, values: { 'conversation:topic': 'x' }, callSite: turnCallSite('p', 'c') },
    });
    expect(values).toEqual({});
    expect(authorizeTransition('t', 'open', 'next', { t: machine }, { conditionValues: values })).toMatchObject({ ok: false, error: 'condition_not_met' });
  });
});

// ── Task machines: `when` and `edgeWhen` in authorizeTransition ──────────────────────────────────────────────────

const GATED: TaskStateMachine = {
  initial: 'open',
  states: {
    open: { transitions: ['escalated', 'ops_path', 'done'], edgeWhen: { ops_path: { 'conversation:type': 'ops' } } },
    escalated: { transitions: ['done'], when: { 'person:clearance': { op: 'has', value: 'premium' } } },
    ops_path: { transitions: ['done'] },
    done: { transitions: [], terminal: 'success' },
  },
};

describe('a task move is refused where its condition does not hold (authorizeTransition)', () => {
  it('validates, and refuses member text, gt on a set, and an edgeWhen on a target that is not a transition', () => {
    expect(() => validateTaskStateMachine('gated', GATED)).not.toThrow();
    const bad = (open: object) => ({ ...GATED, states: { ...GATED.states, open: { ...GATED.states.open, ...open } } });
    expect(() => validateTaskStateMachine('gated', bad({ edgeWhen: { done: { 'conversation:topic': 'x' } } }))).toThrow(/member text/);
    expect(() => validateTaskStateMachine('gated', bad({ edgeWhen: { done: { 'person:clearance': { op: 'gt', value: 1 } } } }))).toThrow(/gt applies to a number only/);
    expect(() => validateTaskStateMachine('gated', bad({ edgeWhen: { nowhere: { 'conversation:type': 'ops' } } }))).toThrow(/not one of its transitions/);
  });

  it('true: the move is authorized', () => {
    expect(authorizeTransition('g', 'open', 'escalated', { g: GATED }, { conditionValues: { 'person:clearance': ['standard', 'premium'] } }))
      .toMatchObject({ ok: true, to: 'escalated' });
    expect(authorizeTransition('g', 'open', 'ops_path', { g: GATED }, { conditionValues: { 'conversation:type': 'ops' } })).toMatchObject({ ok: true });
  });

  it('false: refused as condition_not_met, naming no value, and the legal set is what the conditions admit', () => {
    const out = authorizeTransition('g', 'open', 'escalated', { g: GATED }, { conditionValues: { 'person:clearance': ['standard'] } });
    expect(out).toEqual({ ok: false, error: 'condition_not_met', from: 'open', legal: ['done'] });
    expect(JSON.stringify(out)).not.toMatch(/standard|premium/);
  });

  it('unresolved: no values, or a caller that read none, holds no condition', () => {
    expect(authorizeTransition('g', 'open', 'ops_path', { g: GATED })).toMatchObject({ ok: false, error: 'condition_not_met' });
    expect(authorizeTransition('g', 'open', 'done', { g: GATED })).toMatchObject({ ok: true });
  });

  it('an undeclared edge is still illegal before any condition is read', () => {
    expect(authorizeTransition('g', 'ops_path', 'escalated', { g: GATED }, { conditionValues: { 'person:clearance': ['premium'] } }))
      .toMatchObject({ ok: false, error: 'illegal_transition' });
  });

  it('the turn hands the store the deciding values its machine names, held back by its call site', () => {
    const variables = { lookup: FIXED, values: { 'person:clearance': ['premium'], 'conversation:type': 'ops', 'signal:userLanguage': 'en' }, callSite: turnCallSite('p', 'c') };
    expect(turnConditionValues({ task: { taskType: 'g' } as never, machines: { g: GATED }, variables }))
      .toEqual({ 'person:clearance': ['premium'], 'conversation:type': 'ops' });
    // A person's clearance is not settled where no person is (an event step): it is held back, so `has` does not hold.
    const noPerson = { ...variables, callSite: eventStepCallSite(undefined, false, 'c') };
    expect(turnConditionValues({ task: { taskType: 'g' } as never, machines: { g: GATED }, variables: noPerson })).toEqual({ 'conversation:type': 'ops' });
  });

  it('the advance tool, the task store and a step action outcome all carry the values (source)', () => {
    expect(read('lib/task-tools.ts')).toMatch(/authorizeTransition\(taskType, from, toState, machines, \{ by: 'tool', conditionValues \}\)/);
    expect(read('lib/task-tracking.ts')).toMatch(/conditionValues: args\.conditionValues/);
    expect(read('lib/state-actions.ts')).toMatch(/conditionValues: turnConditionValues\(ctx\)/);
    expect(read('assistant-async-processor.ts')).toMatch(/variables: turnVariables,/);
  });
});

// ── Step action arguments bound to variables ─────────────────────────────────────────────────────────────────

describe('a step action argument bound to a variable is resolved by the processor', () => {
  const action = { tool: 'search_corporate_travel', args: { origin: 'conversation:type', note: 'literal:x' } };
  const variables = { lookup: FIXED, values: { 'conversation:type': 'ops' }, callSite: turnCallSite('p', 'c') };

  it('binds from the turn resolver', () => {
    expect(bindActionArgs(action, {}, variables)).toEqual({ ok: true, args: { origin: 'ops', note: 'x' } });
  });

  it('is unbound, never run on a gap, with no resolver or a value not held', () => {
    expect(bindActionArgs(action, {})).toEqual({ ok: false, arg: 'origin', binding: 'conversation:type' });
    expect(bindActionArgs(action, {}, { ...variables, values: {} })).toMatchObject({ ok: false, arg: 'origin' });
  });

  it('inserts through the resolver: a value not settled at the call site is not handed to the tool', () => {
    const person = { tool: 'search_corporate_travel', args: { origin: 'person:displayName' } };
    expect(actionVariableValues(person, { lookup: FIXED, values: { 'person:displayName': 'Dana' }, callSite: eventStepCallSite(undefined, false, 'c') })).toEqual({});
    expect(actionVariableValues(person, { lookup: FIXED, values: { 'person:displayName': 'Dana' }, callSite: turnCallSite('p', 'c') })).toEqual({ 'person:displayName': 'Dana' });
  });
});

// ── Clearance as a set (decision 7) ──────────────────────────────────────────────────────────────────────────

describe('clearance decides as the set its holder token grants', () => {
  const grantsFor = (t: string) => (t === 'standard' ? ['basic', 'standard'] : t === 'premium-only' ? ['premium'] : []);

  it('has reads membership in the set, with no order between classifications', () => {
    const set = clearanceSet('standard', grantsFor);
    expect(set).toEqual(['basic', 'standard']);
    expect(evaluateWhen({ 'person:clearance': { op: 'has', value: 'basic' } }, { 'person:clearance': set })).toBe(true);
    expect(evaluateWhen({ 'person:clearance': { op: 'has', value: 'premium' } }, { 'person:clearance': set })).toBe(false);
    expect(evaluateWhen({ 'person:clearance': { op: 'has', value: 'basic' } }, { 'person:clearance': clearanceSet('premium-only', grantsFor) })).toBe(false);
  });

  it('an unknown clearance is unresolved: has, exists and ne are all false', () => {
    const unknown = clearanceSet(undefined, grantsFor);
    expect(unknown).toBeUndefined();
    for (const test of [{ op: 'has', value: 'basic' }, { op: 'exists' }, { op: 'ne', value: 'basic' }]) {
      expect(evaluateWhen({ 'person:clearance': test }, { 'person:clearance': unknown })).toBe(false);
    }
    expect(clearanceSet('x', () => { throw new Error('registry'); })).toBeUndefined();
  });

  it('validation refuses gt, an undeclared classification, and clearance choosing a room message', () => {
    expect(whenErrors({ 'person:clearance': { op: 'gt', value: 1 } }, FIXED).join()).toMatch(/gt applies to a number only/);
    expect(whenErrors({ 'person:clearance': { op: 'has', value: 'gold' } }, FIXED).join()).toMatch(/is a set of basic, standard, premium/);
    expect(whenErrors({ 'person:clearance': { op: 'has', value: 'premium' } }, FIXED, { selects: 'room' }).join()).toMatch(/describes a person/);
  });

  it("the processor and the router read it through the deployment's registry, never from sign-in evidence (source)", () => {
    expect(read('assistant-async-processor.ts')).toMatch(/clearance: clearanceSet\(event\.userClearance, \(t\) => defaultProfileRegistry\.grantsFor\(t\)\)/);
    expect(read('router-agent-handler.ts')).toMatch(/clearanceSet\(resolved\?\.clearance, \(t\) => profiles\.grantsFor\(t\)\)/);
  });
});

// ── Message-template choice by `when` ────────────────────────────────────────────────────────────────────────

const OPS_GREETING = parseTemplate([
  '---',
  JSON.stringify({ name: 'ops-member-joined', kind: 'message', description: 'An ops room says who joined.', when: { 'conversation:type': 'ops' }, fields: { name: 'person:displayName' } }),
  '---',
  '# chat',
  '**{{name}}** is on the incident.',
].join('\n'));

describe('a message template is chosen by its when', () => {
  const shipped = shippedMessageTemplate('member-joined');

  it('parses a when on a message, and refuses one on a prompt or a document', () => {
    expect(OPS_GREETING.when).toEqual({ 'conversation:type': 'ops' });
    expect(() => parseTemplate(['---', JSON.stringify({ name: 'p', kind: 'prompt', description: 'p', when: { 'conversation:type': 'ops' } }), '---', '# prompt', 'Say hi.'].join('\n'))).toThrow(/carries no `when`/);
  });

  it('a stored template whose when holds is said; one whose when does not, or is unresolved, passes to the next', () => {
    const holds = (v: Record<string, VariableValue>) => (w: unknown) => whenHolds(w, { lookup: FIXED, values: v, site: { callSite: turnCallSite('p', 'c'), audience: 'room' } });
    expect(chooseMessageTemplate({ shipped, own: OPS_GREETING, holds: holds({ 'conversation:type': 'ops' }) }).origin).toBe('assistant');
    expect(chooseMessageTemplate({ shipped, own: OPS_GREETING, holds: holds({ 'conversation:type': 'general' }) }).origin).toBe('shipped');
    expect(chooseMessageTemplate({ shipped, own: OPS_GREETING }).origin).toBe('shipped');
  });

  it("a version's messages entry chooses the first alternative whose when holds, else the unconditioned one", () => {
    const entry = [{ template: 'ops-joined', when: { 'conversation:type': 'ops' } }, { template: 'plain-joined' }];
    expect(chooseMessageName(entry, (w) => evaluateWhen(w, { 'conversation:type': 'ops' }))).toBe('ops-joined');
    expect(chooseMessageName(entry, (w) => evaluateWhen(w, {}))).toBe('plain-joined');
    expect(chooseMessageName(entry)).toBe('plain-joined');
    expect(chooseMessageName('mine')).toBe('mine');
  });

  it('a messages entry is held to its shape: the last alternative alone carries no when', () => {
    expect(messagesShapeErrors({ 'member-joined': [{ template: 'a', when: { 'conversation:type': 'ops' } }, { template: 'b' }] })).toEqual([]);
    expect(messagesShapeErrors({ 'member-joined': [{ template: 'a', when: { 'conversation:type': 'ops' } }] }).join()).toMatch(/last alternative/);
    expect(messagesShapeErrors({ 'member-joined': [{ template: 'a' }, { template: 'b' }] }).join()).toMatch(/never said/);
  });

  it("a template's when is checked against the audience it is said to: member text and a person fact in a room message are refused", () => {
    const memberWhen = { ...OPS_GREETING, when: { 'conversation:topic': 'x' } };
    expect(templateUseMisfit(memberWhen, { lookup: FIXED, audience: 'room', mentions: ['name'] })).toMatch(/its when: .*member text/);
    const personWhen = { ...OPS_GREETING, when: { 'person:onboarded': true } };
    expect(templateUseMisfit(personWhen, { lookup: FIXED, audience: 'room', mentions: ['name'] })).toMatch(/its when: .*describes a person/);
    expect(templateUseMisfit(OPS_GREETING, { lookup: FIXED, audience: 'room', mentions: ['name'] })).toBeUndefined();
  });
});

// ── Routing rules over signals ─────────────────────────────────────────────────────────────────────────────

describe('a routing rule selects a model the classification selects, by a condition over the signals', () => {
  const catalog = getModelCatalog('us-east-1', '123456789012');
  const models = profiles.modelsOf('standard')!;
  const selected = models.selected.find((k) => k !== models.default && (catalog as Record<string, unknown>)[k])!;
  const unselected = Object.keys(catalog).find((k) => !models.selected.includes(k))!;
  const deps = { catalog, strategy: INTENT_ROUTE_STRATEGY, models };
  const holds = (v: Record<string, VariableValue>) => (w: unknown) => whenHolds(w, { lookup: FIXED, values: v, site: { callSite: turnCallSite('p', 'c'), audience: 'room' } });
  const rules = [{ when: { 'signal:userLanguage': 'fr' }, model: selected }];

  it('the rule fires where its condition holds, and the turn falls back to the classification default', () => {
    const plan = resolveModelPlan({ classification: 'standard' }, { ...deps, rules, holds: holds({ 'signal:userLanguage': 'fr' }) });
    expect(plan.ref.modelKey).toBe(selected);
    expect(plan.routedBy).toBe('version-rule');
  });

  it('does not fire where the condition is false or unresolved, and an empty rule list changes nothing', () => {
    const baseline = resolveModelPlan({ classification: 'standard' }, deps);
    expect(resolveModelPlan({ classification: 'standard' }, { ...deps, rules, holds: holds({ 'signal:userLanguage': 'en' }) }).ref).toEqual(baseline.ref);
    expect(resolveModelPlan({ classification: 'standard' }, { ...deps, rules, holds: holds({}) }).ref).toEqual(baseline.ref);
    expect(resolveModelPlan({ classification: 'standard' }, { ...deps, rules: [], holds: holds({}) })).toEqual(baseline);
  });

  it('never selects a model the classification does not select, and never over an experiment override', () => {
    const plan = resolveModelPlan({ classification: 'standard' }, { ...deps, rules: [{ when: rules[0].when, model: unselected }], holds: holds({ 'signal:userLanguage': 'fr' }) });
    expect(plan.routedBy).toBeUndefined();
    const exp = resolveModelPlan({ classification: 'standard', experimentModelId: 'exp-model' }, { ...deps, rules, holds: holds({ 'signal:userLanguage': 'fr' }) });
    expect(exp.ref.modelId).toBe('exp-model');
  });

  it('validation refuses member text, a fact about the person the room would read through, a rule with no condition, an image model', () => {
    expect(routingRuleErrors([{ when: { 'signal:userLanguage': 'zh' }, model: selected }])).toEqual([]);
    // The language signal is the deployment's declared set (ADR-062 decision 4): a language it does not speak is refused.
    expect(routingRuleErrors([{ when: { 'signal:userLanguage': 'fr' }, model: selected }]).join()).toMatch(/is an enum of en, zh/);
    expect(routingRuleErrors([{ when: { 'conversation:topic': 'x' }, model: selected }]).join()).toMatch(/member text/);
    expect(routingRuleErrors([{ when: { 'person:clearance': { op: 'has', value: 'premium' } }, model: selected }]).join()).toMatch(/describes a person/);
    expect(routingRuleErrors([{ model: selected }]).join()).toMatch(/when is required/);
    expect(routingRuleErrors([{ when: { 'signal:userLanguage': 'fr' }, model: 'stability_image_core' }]).join()).toMatch(/not a text model/);
  });

  it('a rule naming a model the classification does not select is dropped where the version is confined', () => {
    const out = confineModelsToClassification({ routing: [{ when: rules[0].when, model: unselected }, ...rules] }, 'standard');
    expect(out.models?.routing).toEqual(rules);
    expect(out.dropped.join()).toMatch(/models\.routing\[0\]\.model/);
  });
});

// ── What each call site resolves, and what it may not ────────────────────────────────────────────────────────

describe('each call site settles what it may read (subjectSettled per call site)', () => {
  it('a turn settles its sender; the welcome settles a single subject; an event step settles its subject only when addressed to them', () => {
    expect(turnCallSite('p', 'c')).toEqual({ identitySettled: true, conversationSettled: true, subjectSettled: false });
    expect(welcomeCallSite({ focus: 'single', subject: 's', humans: ['s'] } as never).subjectSettled).toBe(true);
    expect(welcomeCallSite({ focus: 'group', subject: '', humans: ['a', 'b'] } as never).subjectSettled).toBe(false);
    expect(eventStepCallSite('s', true, 'c')).toEqual({ identitySettled: false, conversationSettled: true, subjectSettled: true });
    expect(eventStepCallSite('s', false, 'c').subjectSettled).toBe(false);
    expect(eventStepCallSite(undefined, true, 'c').subjectSettled).toBe(false);
  });

  it("the processor reads a source about a person for the person its call site settled, and the router's gate uses the welcome's call site (source)", () => {
    const processor = read('assistant-async-processor.ts');
    expect(processor).toMatch(/eventStepCallSite\(subjectSub, eventStepDef\?\.to === 'subject', event\.channelArn\)/);
    expect(processor).toMatch(/personId: sourcePersonId/);
    expect(processor).toMatch(/const callSite = turnSite;/);
    expect(read('router-agent-handler.ts')).toMatch(/\? welcomeCallSite\(held\.participants\)/);
  });
});

describe('the processor resolves ctx: values from the sources its turn already read', () => {
  const entry = {
    key: 'deal', fields: { stage: { type: 'string' }, amount: { type: 'number' }, won: { type: 'boolean' }, regions: { type: 'string[]' } },
  } as never;

  it('types each value as the catalog declares the field, and reads nothing it was not handed', () => {
    expect(catalogValues([{ entry, values: { stage: 'proposal', amount: '1200', won: 'false', regions: '["emea","apac"]' } }])).toEqual({
      'ctx:deal.stage': 'proposal', 'ctx:deal.amount': 1200, 'ctx:deal.won': false, 'ctx:deal.regions': ['emea', 'apac'],
    });
    expect(catalogValues([{ entry, values: { amount: 'lots', won: 'maybe', regions: 'emea, apac', extra: 'x' } }])).toEqual({ 'ctx:deal.regions': ['emea', 'apac'] });
  });

  it('a turn holds its classification, type, language and, for a person, their clearance, preferences and name', () => {
    expect(turnValues({ classification: 'standard', conversationType: 'ops', userLanguage: 'zh', clearance: ['standard'], preferences: { length: 'brief' }, displayName: 'Dana', catalog: { 'ctx:deal.stage': 'won' } }))
      .toEqual({ 'conversation:classification': 'standard', 'conversation:type': 'ops', 'signal:userLanguage': 'zh', 'person:clearance': ['standard'], 'pref:length': 'brief', 'person:displayName': 'Dana', 'ctx:deal.stage': 'won' });
  });

  it("a line the turn says renders a field bound to a ctx: source through the turn's resolver", () => {
    const own = parseTemplate(['---', JSON.stringify({ name: 'turn-failed', kind: 'message', description: 'x', fields: { stage: 'ctx:deal.stage' } }), '---', '# chat', 'Still at {{stage}}.'].join('\n'));
    const lookup = sourceLookup(buildSourceTable({ catalog: [{ key: 'deal', title: 'Deal', description: '', useWhen: '', type: 'x', trust: 'platform', availability: 'always', maxBytes: 100, describesPerson: false, fields: { stage: { type: 'string' } } } as never] }));
    const copy = withMessageTemplates({ own: new Map([['turn-failed', own]]), classwide: new Map(), resolver: { lookup, values: { 'ctx:deal.stage': 'proposal' }, callSite: turnCallSite('p', 'c') } });
    expect(templateLine('turn-failed', { copy })).toBe('Still at proposal.');
    // The same line where the turn read nothing for the source leaves the line out.
    const unread = withMessageTemplates({ own: new Map([['turn-failed', own]]), classwide: new Map(), resolver: { lookup, values: {}, callSite: turnCallSite('p', 'c') } });
    expect(templateLine('turn-failed', { copy: unread })).toBe('');
  });

  it('the processor builds the resolver from the catalog read it already makes, and renders its fallback and notices through it (source)', () => {
    const processor = read('assistant-async-processor.ts');
    expect(processor).toMatch(/turnCatalogValues = catalogValues\(resolved\);/);
    expect(processor).toMatch(/resolver: \{\n\s+lookup: turnCatalog \? versionLookup\(turnSourceTable, activeProfile\.variables\)/);
    // In the language its readers get (ADR-062 decision 4), then through the resolver.
    expect(processor).toMatch(/localizedTemplate\(fallbackTemplate, \{ copy: versionCopy \}, audience\)/);
    expect(processor).toMatch(/resolverValues\(said, \{ copy: versionCopy \}, audience\)/);
    expect(processor).toMatch(/resolved: resolverValues\(assignedTemplate, \{ copy: versionCopy \}, 'room'\)/);
    // Exactly one catalog read on the turn: the one that was always there.
    expect(processor.match(/context-sources`\)/g)?.length).toBe(1);
  });

  it('the router reads no catalog: a ctx: source is checked as the least-permitting entry and inserts its fallback (source)', () => {
    const router = read('router-agent-handler.ts');
    expect(router).not.toMatch(/readPublishedCatalog|context-sources`/);
    expect(router).toMatch(/lookup: withUnreadCatalog\(versionLookup\(buildSourceTable\(\{ catalog: \[\] \}\), variables\)\)/);
    const lookup = versionLookup(buildSourceTable({ catalog: [] }), { stage: { source: 'ctx:deal.stage' } });
    expect(decidingValues([{ stage: 'won' }], { lookup, values: { 'ctx:deal.stage': 'won' }, site: { callSite: turnCallSite(undefined, 'c'), audience: 'addressed' } })).toEqual({});
  });
});

describe('no new grant: the catalog is read only by the role that always read it (synth)', () => {
  type Resource = { Type: string; Properties?: Record<string, any> };
  let resources: Record<string, Resource>;
  beforeAll(() => {
    const app = new cdk.App({ context: {} });
    const stack = assistantsOf('standard')(app, 'AgentEchelonAssistants-standard', CLASSIFICATION_TEST_PROPS as never);
    resources = (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
  });

  /** Every statement naming the classification's context-source catalog, with the roles it is attached to. */
  function catalogGrants(): Array<{ owner: string; roles: string }> {
    const out: Array<{ owner: string; roles: string }> = [];
    for (const [id, r] of Object.entries(resources)) {
      const docs = r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy'
        ? [r.Properties?.PolicyDocument]
        : r.Type === 'AWS::IAM::Role' ? (r.Properties?.Policies ?? []).map((p: any) => p.PolicyDocument) : [];
      for (const doc of docs) {
        for (const s of doc?.Statement ?? []) {
          if (/assistant\/standard\/context-sources/.test(JSON.stringify(s.Resource ?? ''))) {
            out.push({ owner: id, roles: r.Type === 'AWS::IAM::Role' ? id : JSON.stringify(r.Properties?.Roles ?? r.Properties?.Users ?? []) });
          }
        }
      }
    }
    return out;
  }

  it('one statement grants the catalog read, to the acting role, and neither the router nor the processor role holds it', () => {
    const grants = catalogGrants();
    expect(grants.length).toBe(1);
    expect(grants[0].roles).toMatch(/Acting/);
    expect(grants[0].roles).not.toMatch(/AgentHandlerRole|ProcessorRole/);
  });

  it('a speak session, the router posts on, carries messaging only', () => {
    const { SPEAK_ACTIONS } = require('../../lambda/src/lib/assistant-grant');
    expect((SPEAK_ACTIONS as string[]).every((a) => a.startsWith('chime:'))).toBe(true);
  });
});

// ── A notice's mention checked against live membership ──────────────────────────────────────────────────────

describe("a notice's mention renders only for a member (decision 7)", () => {
  const member = 'arn:aws:chime:us-east-1:123456789012:app-instance/app/user/m1';
  const gone = 'arn:aws:chime:us-east-1:123456789012:app-instance/app/user/gone';

  it('keeps the name of a member and leaves out the name of a person who is not one', () => {
    expect(noticeMentionsForMembers('memberJoined', { name: 'Dana' }, { name: member }, new Set([member])))
      .toEqual({ vars: { name: 'Dana' }, unverified: [], notMembers: [] });
    expect(noticeMentionsForMembers('memberJoined', { name: 'Dana' }, { name: gone }, new Set([member])))
      .toEqual({ vars: {}, unverified: [], notMembers: ['name'] });
  });

  it('reports a mention whose person the caller did not name, and leaves a field that is not a mention alone', () => {
    expect(noticeMentionsForMembers('conversationArchived', { who: 'Ari', date: '2026-10-28' }, undefined, new Set()))
      .toEqual({ vars: { who: 'Ari', date: '2026-10-28' }, unverified: ['who'], notMembers: [] });
  });

  it('the callers name the person, and the router checks the live roster before saying the name (source)', () => {
    const mgmt = read('conversation-management.ts');
    expect(mgmt).toMatch(/people: \{ who: callerArn \}/);
    expect(mgmt).toMatch(/people: \{ name: userArn \}/);
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/noticeMentionsForMembers\(req\.kind, vars, named, members\)/);
    expect(router).toMatch(/if \(!content\.trim\(\)\) return \{ posted: false, reason: 'nothing to say' \};/);
  });
});
