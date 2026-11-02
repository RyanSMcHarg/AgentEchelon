/**
 * AN EXPERIMENT TURN SERVES AN UNMODIFIED VERSION, ITS ROUTES INCLUDED (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5).
 *
 * A turn that serves a version - an enrolled experiment arm under the live identity, or a duel side - is
 * answered through that version's `models.byIntent` and base model exactly as the live assistant answers
 * through its own. No model is forced beside the version: a duel side used to answer every intent on its
 * version's base model (`resolvedModel`), so a routed intent never reached its route and an `intent`
 * experiment's candidate, which differs only in that route, answered like the control.
 *
 * Driven through the processor's own pieces: the strategy built from the served version
 * (`buildIntentStrategy`), the real resolver, and the processor's rule for what an experiment may force
 * (`experimentModelOverride`). The last block pins that the handler composes them that way, and that an
 * image model hosted outside AWS is gated by the classification the turn answers in.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from '../helpers/strip-comments';
import { getModelCatalog, bedrockInvokeId } from '../../lib/config/model-strategy';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { buildIntentStrategy } from '../../lambda/src/lib/active-profile';
import { resolveModelForIntent } from '../../lambda/src/lib/model-resolver';
import { resolveTurnImageGenModelId } from '../../lambda/src/lib/async-processor-core';

process.env.PROFILE_NAME = process.env.PROFILE_NAME || 'concierge';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { experimentModelOverride } = require('../../lambda/src/assistant-async-processor');

const catalog = getModelCatalog('us-east-1', '123456789012');

/** The model a turn of `intent` is answered on when it serves `version`, as the processor composes it. */
function servedModel(version: { models: Record<string, unknown> } | undefined, intent: string, resolvedModel?: string): string {
  const strategy = buildIntentStrategy(version?.models as never) ?? [];
  const base = (version?.models as { default?: string } | undefined)?.default;
  const premium = defaultProfileRegistry.modelsOf('premium')!;
  const resolution = resolveModelForIntent(intent, 'premium', catalog, strategy, base ? { ...premium, default: base } : premium);
  return experimentModelOverride({ variantProfile: version, resolvedModel }) || resolution.primaryModelId;
}

const CONTROL = { models: { default: 'opus', byIntent: { code_generation: { primary: 'opus', fallback: 'sonnet' }, general: { primary: 'opus' } } } };
// An `intent` experiment's candidate: one route's primary changed, everything else the control's.
const CANDIDATE = { models: { default: 'opus', byIntent: { code_generation: { primary: 'sonnet', fallback: 'sonnet' }, general: { primary: 'opus' } } } };

describe('a served version answers through its routes', () => {
  it('an intent experiment\'s candidate answers its intent on its route, cheaper than the base included', () => {
    expect(servedModel(CANDIDATE, 'code_generation')).toBe(bedrockInvokeId(catalog.sonnet));
    expect(servedModel(CONTROL, 'code_generation')).toBe(bedrockInvokeId(catalog.opus));
  });

  it('every other intent answers the same in both arms', () => {
    expect(servedModel(CANDIDATE, 'general')).toBe(servedModel(CONTROL, 'general'));
  });

  it('a duel side handed a stale resolvedModel beside its version still answers through its route', () => {
    expect(servedModel(CANDIDATE, 'code_generation', bedrockInvokeId(catalog.opus))).toBe(bedrockInvokeId(catalog.sonnet));
  });

  it('only a model-only variant of an experiment armed before versions were pinned still forces a model', () => {
    expect(experimentModelOverride({ resolvedModel: 'model-x' })).toBe('model-x');
    expect(experimentModelOverride({ variantProfile: CONTROL, resolvedModel: 'model-x' })).toBeUndefined();
  });
});

describe('an image model hosted outside AWS answers exactly where its classification selects it', () => {
  it('is served in a classification that selects it, with no profile switch, and withheld in one that does not', () => {
    const base = { intent: 'image_generation', classification: 'premium', profileImageModelKey: 'openai_gpt_image_1' };
    expect(defaultProfileRegistry.selectsModel('premium', 'openai_gpt_image_1')).toBe(true);
    expect(resolveTurnImageGenModelId(base)).toBe('gpt-image-1');
    expect(resolveTurnImageGenModelId({ ...base, classification: 'standard' })).toBeUndefined();
    // An AWS-hosted image model follows the same selection.
    expect(resolveTurnImageGenModelId({ ...base, profileImageModelKey: 'nova_canvas' })).toBeTruthy();
  });
});

describe('a candidate served under the live identity narrows the session to its own declared reach', () => {
  // The router records the served version as the turn's routed variant (`variantGrantOf`), and the vend
  // narrows the session from it (`grantEdgesFor`), inside the edges the classification stack created.
  const catalogEdges = {
    edges: new Set(['base', 'context', 'platform', 'telemetry', 'models-all', 'models-haiku', 'models-sonnet', 'models-opus', 'models-gpt_oss_120b']),
    alwaysModelKeys: ['haiku'],
    defaultImageModelKey: '',
  };
  const live = { modelKey: 'opus', models: { default: 'opus', byIntent: { general: { primary: 'opus' } } }, tools: ['load_company_context'] };
  const candidate = { modelKey: 'opus', models: { default: 'opus', byIntent: { general: { primary: 'opus' }, code_generation: { primary: 'sonnet' } } }, tools: [] as string[], contextSources: [] as string[] };

  it('reaches the candidate\'s routed model and not the live version\'s tools', () => {
    const { grantEdgesFor, variantGrantOf } = jest.requireActual('../../lambda/src/lib/assistant-grant');
    const edges: string[] = grantEdgesFor(live, variantGrantOf({ modelKey: 'opus', profile: candidate }), catalogEdges);
    expect(edges).toEqual(expect.arrayContaining(['base', 'models-opus', 'models-sonnet', 'models-haiku']));
    expect(edges).not.toContain('models-all');
    expect(edges).not.toContain('context');
    // And the live version's own session keeps what the live version declares.
    expect(grantEdgesFor(live, undefined, catalogEdges)).toContain('context');
  });
});

describe('the processor composes them that way', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'assistant-async-processor.ts'), 'utf8'));
  it('the turn\'s model is the override, else the served version\'s own resolution', () => {
    expect(code).toMatch(/const experimentModelId = experimentModelOverride\(event\);/);
    expect(code).toMatch(/const effectiveModel = experimentModelId \|\| resolution\.primaryModelId;/);
    expect(code).not.toMatch(/variantBedrockModelId/);
  });
  it('a served version is attributed to its own number, carried beside it, never guessed', () => {
    // A definition does not carry its parameter version, so the number rides the dispatch (`variantVersion`)
    // and the attribution stamps whatever the resolved version holds.
    expect(code).toMatch(/\? \{ \.\.\.resolveFromDefinition\(await hydrateBodies\(event\.variantProfile\), turnProfileName\), version: event\.variantVersion \}/);
    expect(code).toMatch(/profileAttribution: \{[\s\S]{0,400}\.\.\.\(active\.version !== undefined && \{ profileVersion: active\.version \}\)/);
  });
  it('the router hands the number on with the version on every path that serves one', () => {
    const router = stripComments(fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8'));
    for (const from of ['battleSide.selfVariant?.variantVersion', 'enrolledResolution.variantVersion', 'experiment.variantVersion']) {
      expect(router).toContain(`resolvedVariantVersion = ${from};`);
    }
    expect(router).toMatch(/\.\.\.\(resolvedVariantProfile && resolvedVariantVersion !== undefined && \{ variantVersion: resolvedVariantVersion \}\)/);
    // Round 2 re-resolves the side and drops a number the payload carried.
    expect(router).toMatch(/variantVersion: _payloadVersionNumber/);
    expect(router).toMatch(/\.\.\.\(self\?\.variantVersion !== undefined && \{ variantVersion: self\.variantVersion \}\)/);
    const orchestrator = stripComments(fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'battle-orchestrator.ts'), 'utf8'));
    expect(orchestrator).toMatch(/variantVersion: selfVariant\.variantVersion/);
  });
  it('the image model is gated by the classification it answers in, and by no version switch', () => {
    expect(code).toMatch(/resolveTurnImageRoute\(\{[\s\S]*?classification: CLASSIFICATION,/);
    expect(code).not.toMatch(/externalProviderAllowed/);
  });
});
