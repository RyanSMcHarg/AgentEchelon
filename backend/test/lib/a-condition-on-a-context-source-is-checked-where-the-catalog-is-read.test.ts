/**
 * A CONDITION ON A CONTEXT SOURCE IS CHECKED WHERE THE CATALOG IS READ (ADR-060 slice 1e, decision 3's first layer).
 *
 * A routing rule, a `messages` entry and a task machine may decide on a `ctx:` field. Where a check runs without the
 * classification's catalog (`routingRuleErrors` on every patch, `messageTemplateErrors`, a machine's own validation at
 * every load) the `ctx:` keys are left to the check that reads it, and only those keys are held there, so no reason is
 * said twice: a version's conditions at validate, activate, a variant and import (`versionConditionErrors`, through
 * the catalog reader `versionVariableErrors` already uses, so no grant is added), and a pack's machines at its
 * classification's synth (`machineCatalogConditionErrors`). A field the catalog does not publish, publishes as member
 * text, or types against its operator is refused there; a catalog that cannot be read refuses the version.
 *
 * The console receives the same table validation builds (`publishedVariables`, served on the classification catalog
 * the profile listing already returns), so its picker offers what a version may name and says whether each may decide.
 */
const mockAdvance = jest.fn();
jest.mock('../../lambda/src/lib/task-store', () => ({
  ...jest.requireActual('../../lambda/src/lib/task-store'),
  advanceTaskStateTo: (...args: unknown[]) => mockAdvance(...args),
}));

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  buildSourceTable,
  catalogEntryForVariables,
  publishedVariables,
  sourceLookup,
  tableFromPublished,
  versionLookup,
  whenErrors,
  whenReadsCatalog,
  withUnreadCatalog,
  type VariableCatalogEntry,
} from '../../lambda/src/lib/variables';
import { routingRuleErrors } from '../../lambda/src/lib/active-profile';
import { versionConditionErrors } from '../../lambda/src/lib/profile-lifecycle';
import { machineCatalogConditionErrors, validateTaskStateMachine, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { classificationCatalog } from '../../lambda/src/lib/classification-catalog';
import { handleAdvanceTaskStateTool } from '../../lambda/src/lib/task-tools';
import { turnCallSite } from '../../lambda/src/lib/context-sources-runtime';
import { authorizeTransition } from '../../lambda/src/lib/task-state-machines';
import { PROFILE_FIELD_DECISIONS } from '../../lambda/src/lib/profile-field-decisions';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { assistantsOf } from '../helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from '../helpers/synth';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const ROOT = '/agent-echelon';
const CLASSIFICATIONS = ['basic', 'standard', 'premium'];

/** A catalog with an operator-trust deal stage, a member-trust note on it, and a number. */
const DEAL: VariableCatalogEntry = {
  key: 'x-deal', title: 'Deal desk', trust: 'operator', availability: 'always', describesPerson: false,
  fields: { stage: { type: 'string' }, amount: { type: 'number' }, note: { type: 'string', trust: 'member' } },
};
const TABLE = buildSourceTable({ catalog: [catalogEntryForVariables(DEAL)], classifications: CLASSIFICATIONS });
const FIXED = sourceLookup(buildSourceTable({ catalog: [], classifications: CLASSIFICATIONS }));
const readDeal = async () => [DEAL];

const models = profiles.modelsOf('standard')!;
const catalogKeys = getModelCatalog('us-east-1', '123456789012');
const textModel = models.selected.find((k) => (catalogKeys as Record<string, unknown>)[k]) ?? models.default;

describe('a check without the catalog leaves ctx: keys to the one that reads it, and that one holds only them', () => {
  it('deferred skips a ctx: key, by name or through a variable, and still holds every other key', () => {
    const stage = { stage: { source: 'ctx:x-deal.stage' } };
    const lookup = withUnreadCatalog(versionLookup(buildSourceTable({ catalog: [], classifications: CLASSIFICATIONS }), stage), stage);
    expect(whenErrors({ 'ctx:x-deal.stage': 'won' }, FIXED, { catalog: 'deferred' })).toEqual([]);
    expect(whenErrors({ stage: 'won' }, lookup, { catalog: 'deferred' })).toEqual([]);
    expect(whenErrors({ 'ctx:x-deal.stage': 'won', 'conversation:topic': 'x' }, FIXED, { catalog: 'deferred' }).join()).toMatch(/member text/);
    // Without the option a ctx: key the fixed table does not hold is refused, as before.
    expect(whenErrors({ 'ctx:x-deal.stage': 'won' }, FIXED).join()).toMatch(/not a source this classification publishes/);
  });

  it('only holds the ctx: keys, against the catalog, and says nothing of the shape the other check refuses', () => {
    const lookup = sourceLookup(TABLE);
    expect(whenErrors({ 'ctx:x-deal.stage': 'won', 'conversation:topic': 'x' }, lookup, { catalog: 'only' })).toEqual([]);
    expect(whenErrors({ 'ctx:x-deal.note': 'x' }, lookup, { catalog: 'only' }).join()).toMatch(/member text/);
    expect(whenErrors({ 'ctx:x-deal.stage': { op: 'gt', value: 1 } }, lookup, { catalog: 'only' }).join()).toMatch(/gt applies to a number only/);
    expect(whenErrors({ 'ctx:x-deal.amount': { op: 'gt', value: 1000 } }, lookup, { catalog: 'only' })).toEqual([]);
    expect(whenErrors({ 'ctx:x-other.stage': 'won' }, lookup, { catalog: 'only' }).join()).toMatch(/not a source this classification publishes/);
    expect(whenErrors([], lookup, { catalog: 'only' })).toEqual([]);
    expect(whenErrors('nonsense', lookup, { catalog: 'only' })).toEqual([]);
  });

  it('whenReadsCatalog names a condition that must be read against the catalog', () => {
    expect(whenReadsCatalog({ 'conversation:type': 'ops' }, FIXED)).toBe(false);
    expect(whenReadsCatalog([{ 'conversation:type': 'ops' }, { 'ctx:x-deal.stage': 'won' }], FIXED)).toBe(true);
  });
});

describe('a routing rule and a messages entry decide on a context source once the catalog is read', () => {
  it('a patch no longer refuses a ctx: rule outright; the shape and every other key are still held', () => {
    expect(routingRuleErrors([{ when: { 'ctx:x-deal.stage': 'won' }, model: textModel }])).toEqual([]);
    expect(routingRuleErrors([{ when: { 'ctx:x-deal.stage': 'won', 'conversation:topic': 'x' }, model: textModel }]).join()).toMatch(/member text/);
  });

  it('versionConditionErrors accepts an operator field, and refuses member text, an unpublished field and a wrong operator', async () => {
    const rule = (when: unknown) => ({ models: { routing: [{ when, model: textModel }] } }) as never;
    expect(await versionConditionErrors(rule({ 'ctx:x-deal.stage': 'won' }), 'p', readDeal)).toEqual([]);
    expect(await versionConditionErrors(rule({ 'ctx:x-deal.note': 'x' }), 'p', readDeal)).toEqual([expect.stringMatching(/^models\.routing\[0\]\.when: .*member text/)]);
    expect(await versionConditionErrors(rule({ 'ctx:x-other.stage': 'won' }), 'p', readDeal)).toEqual([expect.stringMatching(/not a source this classification publishes/)]);
    expect(await versionConditionErrors(rule({ 'ctx:x-deal.stage': { op: 'lt', value: 3 } }), 'p', readDeal)).toEqual([expect.stringMatching(/lt applies to a number only/)]);
  });

  it('a messages entry is held through the version\'s variables, at the audience its message is said to', async () => {
    const body = (when: unknown) => ({
      variables: { stage: { source: 'ctx:x-deal.stage' }, note: { source: 'ctx:x-deal.note' } },
      messages: { 'turn-failed': [{ template: 'a', when }, { template: 'b' }] },
    }) as never;
    expect(await versionConditionErrors(body({ stage: 'won' }), 'p', readDeal)).toEqual([]);
    expect(await versionConditionErrors(body({ note: 'x' }), 'p', readDeal)).toEqual([expect.stringMatching(/^messages\.turn-failed\[0\]\.when: "note" is member text/)]);
  });

  it('reads the catalog only when a condition names it, and refuses when it cannot be read or was not given', async () => {
    const reader = jest.fn(readDeal);
    expect(await versionConditionErrors({ models: { routing: [{ when: { 'signal:userLanguage': 'fr' }, model: textModel }] } } as never, 'p', reader)).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
    const ctxRule = { models: { routing: [{ when: { 'ctx:x-deal.stage': 'won' }, model: textModel }] } } as never;
    expect(await versionConditionErrors(ctxRule, 'p', async () => { throw new Error('gone'); })).toEqual([expect.stringMatching(/could not be read \(gone\); refusing/)]);
    expect(await versionConditionErrors(ctxRule, 'p')).toEqual([expect.stringMatching(/no context source catalog was given/)]);
  });

  it('runs at validate, activate, a variant and import, beside the variables check (source)', () => {
    const lifecycle = read('lib/profile-lifecycle.ts');
    expect(lifecycle.match(/versionConditionErrors\((body|merged), profileName, readContextCatalog\)/g)).toHaveLength(3);
    expect(read('lib/profile-manifest.ts')).toMatch(/versionConditionErrors\(body, targetName, opts\.contextSourceCatalog\)/);
  });
});

describe("a task machine's ctx: condition is held at its classification's synth", () => {
  const machine = (when: unknown): TaskStateMachine => ({
    initial: 'open',
    states: {
      open: { transitions: ['escalated', 'done'], edgeWhen: { escalated: when as never } },
      escalated: { transitions: ['done'] },
      done: { transitions: [], terminal: 'success' },
    },
  });

  it('a machine validates with a ctx: condition left to the catalog check', () => {
    expect(() => validateTaskStateMachine('m', machine({ 'ctx:x-deal.stage': 'won' }))).not.toThrow();
    expect(() => validateTaskStateMachine('m', machine({ 'conversation:topic': 'x' }))).toThrow(/member text/);
  });

  it('machineCatalogConditionErrors refuses an unpublished field and member text, naming machine and state', () => {
    const lookup = sourceLookup(TABLE);
    expect(machineCatalogConditionErrors({ m: machine({ 'ctx:x-deal.stage': 'won' }) }, lookup)).toEqual([]);
    expect(machineCatalogConditionErrors({ m: machine({ 'ctx:x-deal.note': 'x' }) }, lookup))
      .toEqual([expect.stringMatching(/^machine "m" state "open" edgeWhen "escalated": .*member text/)]);
    expect(machineCatalogConditionErrors({ m: machine({ 'ctx:x-other.stage': 'x' }) }, lookup).join()).toMatch(/not a source this classification publishes/);
  });

  it('a pack whose machine decides on a field the classification does not publish fails synth', () => {
    const pack = JSON.stringify({
      intents: [{ key: 'deal_review', description: 'Review a deal', keywords: ['deal'] }],
      machines: { deal_flow: machine({ 'ctx:x-not-published.stage': 'won' }) },
    });
    const app = new cdk.App({ context: { assistantIntentPack: pack } });
    expect(() => assistantsOf('basic')(app, 'AgentEchelonAssistants-basic', CLASSIFICATION_TEST_PROPS as never))
      .toThrow(/machine conditions are refused against this classification's context-source catalog: machine "deal_flow"/);
  });
});

describe('a step whose condition does not hold is refused to the turn that asked, naming no value', () => {
  const GATED: TaskStateMachine = {
    initial: 'open',
    states: {
      open: { transitions: ['escalate', 'done'], edgeWhen: { escalate: { 'conversation:type': 'incident' } } },
      escalate: { transitions: ['done'] },
      done: { transitions: [], terminal: 'success' },
    },
  };
  it('the advance tool returns condition_not_met to the asking turn, with the legal moves and without the value', async () => {
    mockAdvance.mockImplementation(async (a: { task: { taskState: string }; toState: string; conditionValues?: Record<string, unknown> }) =>
      authorizeTransition('gated', a.task.taskState, a.toState, { gated: GATED }, { conditionValues: a.conditionValues as never }));
    const out = await handleAdvanceTaskStateTool({
      task: { taskId: 't', channelArn: 'arn:c', taskType: 'gated', taskState: 'open', status: 'in_progress', details: {} } as never,
      input: { to_state: 'escalate', reason: 'r' },
      machines: { gated: GATED },
      variables: { lookup: FIXED, values: { 'conversation:type': 'general' }, callSite: turnCallSite('p', 'c') },
    });
    expect(out.payload).toMatchObject({ ok: false, error: 'condition_not_met', legal_transitions: ['done'] });
    expect(String(out.payload.message)).toContain('"escalate"');
    expect(JSON.stringify(out.payload)).not.toMatch(/general|incident/);
  });
});

describe('the console receives the table validation builds', () => {
  it('lists every source with its type, trust and whether it may decide, and rebuilds the same table', () => {
    const published = publishedVariables(TABLE);
    const stage = published.sources.find((s) => s.source === 'ctx:x-deal.stage')!;
    const note = published.sources.find((s) => s.source === 'ctx:x-deal.note')!;
    expect(stage).toMatchObject({ type: 'string', trust: 'operator', mayDecide: true, describesPerson: false });
    expect(note).toMatchObject({ trust: 'member', mayDecide: false });
    expect(published.sources.find((s) => s.source === 'person:displayName')).toMatchObject({ trust: 'member', mayDecide: false, mentionable: true });
    // The console's inline validation reads the rebuilt table and says what the server says.
    const rebuilt = sourceLookup(tableFromPublished(JSON.parse(JSON.stringify(published))));
    for (const when of [{ 'ctx:x-deal.note': 'x' }, { 'ctx:x-deal.stage': 'won' }, { 'person:clearance': { op: 'gt', value: 1 } }]) {
      expect(whenErrors(when, rebuilt)).toEqual(whenErrors(when, sourceLookup(TABLE)));
    }
  });

  it('classificationCatalog serves it from the catalog and intake parameters the console route already reads', async () => {
    const store = fakeSsmStore();
    await store.client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/standard/context-sources`, Value: JSON.stringify([DEAL]), Type: 'String' }));
    await store.client.send(new PutParameterCommand({
      Name: `${ROOT}/assistant/standard/onboarding-intake`, Type: 'String',
      Value: JSON.stringify({ fields: [{ key: 'company', prompt: 'Company?', required: true }] }),
    }));
    const lambda = { send: async () => ({}) } as never;
    const c = await classificationCatalog(store.client, lambda, ROOT, 'standard', Object.keys(catalogKeys));
    expect(c.variables.sources.find((s) => s.source === 'ctx:x-deal.stage')).toMatchObject({ trust: 'operator', mayDecide: true });
    expect(c.variables.facts).toEqual(['company']);
    // An unreadable catalog leaves the fixed sources and no ctx: source.
    const empty = await classificationCatalog(fakeSsmStore().client, lambda, ROOT, 'standard', Object.keys(catalogKeys));
    expect(empty.variables.sources.some((s) => s.source.startsWith('ctx:'))).toBe(false);
    expect(empty.variables.sources.some((s) => s.source === 'conversation:type')).toBe(true);
  });

  it('messages is edited with a console control; variables stays a draft patch with its guide', () => {
    expect(PROFILE_FIELD_DECISIONS.messages).toEqual({ kind: 'control' });
    expect(PROFILE_FIELD_DECISIONS.variables).toMatchObject({ kind: 'json', guide: 'variables' });
  });
});
