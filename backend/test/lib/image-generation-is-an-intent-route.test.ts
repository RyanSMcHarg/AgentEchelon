/**
 * IMAGE GENERATION IS AN INTENT ROUTE (`lambda/src/lib/image-route.ts`).
 *
 * Any intent whose route in `models.byIntent` names an image model generates an image, with a primary and a
 * fallback like every other intent. The route's model decides the kind, so the text resolver never sees an
 * image model, and a version that still carries the legacy `models.image` serves exactly what it did.
 *
 * Pinned here: the write path (kinds, allowlist, legacy), the text resolver's filter, the worker's route
 * resolution, the fallback decision, the grant, and the experiment recipe.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { validateBody } from '../../lambda/src/lib/profile-lifecycle';
import {
  buildIntentStrategy,
  confineModelsToClassification,
  defaultImageRoute,
  imageIntentRouteKeysOf,
  serializeSeedDefinition,
  validateDefinitionBody,
  DEFAULT_IMAGE_FALLBACK_MODEL,
  DEFAULT_IMAGE_MODEL,
  type ProfileDefinitionBody,
} from '../../lambda/src/lib/active-profile';
import { imagePrimaryForIntent, imagePrimaryOf, imageRouteFor, routeKindError, textRoutesOf } from '../../lambda/src/lib/image-route';
import { resolveTurnImageGenModelId, resolveTurnImageRoute } from '../../lambda/src/lib/async-processor-core';
import { turnNeedsImage } from '../../lambda/src/lib/intent-pack';
import {
  IMAGE_GEN_MODELS,
  imageGenRegionFor,
  invokeImageGenWithFallback,
  isImageGenFallbackEligible,
  type ImageGenInvokeResult,
} from '../../lambda/src/lib/image-gen-models';
import { grantEdgesFor, type GrantCatalog } from '../../lambda/src/lib/assistant-grant';
import { variantDeltaOf, controlMismatch, imageRouteKeyOf } from '../../lambda/src/manage-profiles';

const CATALOG = getModelCatalog('us-east-1', '123456789012');
const CORE = IMAGE_GEN_MODELS.stability_image_core.bedrockModelId;
const ULTRA = IMAGE_GEN_MODELS.stability_image_ultra.bedrockModelId;
const body = (models: Record<string, unknown>) => ({ modelKey: 'opus', models: { default: 'opus', ...models } }) as ProfileDefinitionBody;
const errs = (b: ProfileDefinitionBody, classification = 'premium') => validateBody(b, CATALOG, undefined, classification);

describe('the write path: an image route is a route whose model is an image model', () => {
  it('accepts an image route with a primary and a fallback, on image_generation and on any other intent', () => {
    const b = body({ byIntent: {
      image_generation: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } },
      diagram: { image: { primary: 'stability_image_ultra' } },
      general: { primary: 'sonnet', fallback: 'haiku' },
    } });
    expect(errs(b).filter((e) => /model|kind/.test(e))).toEqual([]);
  });

  it('refuses the legacy models.image, naming the route’s image part', () => {
    expect(errs(body({ image: 'stability_image_core' }))).toContain("models.image is retired; name the image model as models.byIntent['image_generation'].image.primary");
  });

  it('refuses an image part with a text model, and an image model named as a text model', () => {
    const text = errs(body({ byIntent: { image_generation: { image: { primary: 'stability_image_core', fallback: 'haiku' } } } }));
    expect(text.some((e) => e.includes(".image.fallback must be an image model"))).toBe(true);
    const image = errs(body({ byIntent: { general: { primary: 'haiku', fallback: 'stability_image_core' } } }));
    expect(image.some((e) => e.includes('as its text model'))).toBe(true);
  });

  it('refuses an image part whose fallback is its primary', () => {
    const e = validateDefinitionBody(body({ byIntent: { image_generation: { image: { primary: 'stability_image_core', fallback: 'stability_image_core' } } } }));
    expect(e.some((x) => x.includes('both primary and fallback'))).toBe(true);
  });

  it('refuses an unknown model key and an image model the classification does not allow', () => {
    expect(errs(body({ byIntent: { image_generation: { primary: 'not_a_model' } } }))
      .some((e) => e.includes("models.byIntent['image_generation']"))).toBe(true);
    expect(errs(body({ byIntent: { image_generation: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } } } }), 'basic')
      .some((e) => e.includes("models.byIntent['image_generation'].image.primary"))).toBe(true);
  });

  it('accepts a text model for an image intent: its text steps run on it (ADR-064)', () => {
    expect(errs(body({ byIntent: { image_generation: { primary: 'opus', image: { primary: 'stability_image_core' } } } })).filter((e) => /model/.test(e))).toEqual([]);
  });

  it('routeKindError leaves a text route alone', () => {
    expect(routeKindError('general', { primary: 'sonnet', fallback: 'haiku' })).toBeNull();
    expect(routeKindError('general', { primary: 'sonnet', fallback: 'default' })).toBeNull();
  });
});

describe('the text resolver is never handed an image model', () => {
  it('buildIntentStrategy carries only the text routes', () => {
    const strategy = buildIntentStrategy({ byIntent: {
      general: { primary: 'sonnet' },
      image_generation: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } },
    } });
    expect(strategy?.map((r) => r.intent)).toEqual(['general']);
    expect(textRoutesOf({ a: { image: { primary: 'stability_image_core' } }, b: { primary: 'haiku' } })).toEqual({ b: { primary: 'haiku' } });
  });

  it('confinement holds an image route to image models', () => {
    const { models, dropped } = confineModelsToClassification({
      byIntent: { image_generation: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } } },
    }, 'premium');
    expect(dropped).toEqual([]);
    expect(models?.byIntent?.image_generation).toEqual({ image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } });
    expect(confineModelsToClassification({ byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } }, 'basic').models?.byIntent).toEqual({});
  });
});

describe('the legacy models.image is retired (ADR-064 decision 2)', () => {
  it('is not read: an image model is chosen only in the image part of a route', () => {
    expect(imageRouteFor({ image: 'stability_image_core' }, 'image_generation')).toBeUndefined();
    expect(imagePrimaryOf({ image: 'stability_image_core', byIntent: { image_generation: { image: { primary: 'stability_image_ultra' } } } })).toBe('stability_image_ultra');
  });
});

describe('the worker resolves a turn\'s image route from its intent\'s route', () => {
  const premium = { classification: 'premium' };

  it('an image route on an intent not called image_generation produces an image', () => {
    const r = resolveTurnImageRoute({ ...premium, intent: 'diagram', models: { byIntent: { diagram: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } } } } });
    expect(r).toEqual({ primaryId: CORE, fallbackId: ULTRA });
  });

  it('a text route is a text turn', () => {
    expect(resolveTurnImageRoute({ ...premium, intent: 'general', models: { byIntent: { general: { primary: 'haiku' } } } })).toEqual({});
  });

  it('the image model of the seed serves image_generation where no version is served', () => {
    expect(resolveTurnImageGenModelId({ ...premium, intent: 'image_generation', profileImageModelKey: 'stability_image_core' })).toBe(CORE);
  });

  it('an experiment variant\'s image model takes no fallback: its failure is the variant\'s result', () => {
    const r = resolveTurnImageRoute({
      ...premium, intent: 'image_generation', experimentImageModelKey: 'stability_image_ultra',
      models: { byIntent: { image_generation: { image: { primary: 'stability_image_core', fallback: 'nova_canvas' } } } },
    });
    expect(r).toEqual({ primaryId: ULTRA });
  });

  it('a classification allowed no image model resolves none', () => {
    expect(resolveTurnImageRoute({ classification: 'basic', intent: 'image_generation', models: { byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } } })).toEqual({});
  });
});

describe('the fallback serves model-side failures only', () => {
  const ok = (modelId: string): ImageGenInvokeResult => ({ images: ['png'], guardrailIntervened: false, retryCount: 0, modelId });
  const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(name), { name, ...extra });
  const opts = () => ({});

  it.each([
    ['ServiceUnavailableException'], ['ModelNotReadyException'], ['ModelTimeoutException'], ['AccessDeniedException'],
    ['ResourceNotFoundException'], ['ThrottlingException'], ['InternalServerException'],
  ])('%s → the fallback produces the image, and the result names it', async (name) => {
    const invoke = jest.fn(async (id: string) => { if (id === CORE) throw named(name); return ok(id); });
    const onFallback = jest.fn();
    const r = await invokeImageGenWithFallback({ primaryModelId: CORE, fallbackModelId: ULTRA, prompt: 'a cat', optionsFor: opts, invoke, onFallback });
    expect(r.modelId).toBe(ULTRA);
    expect(r.wasFallback).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a ValidationException (a malformed request, or a prompt the content filters blocked)', named('ValidationException', { $metadata: { httpStatusCode: 400 } })],
    ['a provider content-policy refusal', new Error('invokeImageGenModel: openai returned HTTP 400: content_policy_violation')],
    ['an empty prompt', new Error('shapeImageGenRequest: empty prompt')],
  ])('%s is final: the fallback is never asked', async (_why, error) => {
    const invoke = jest.fn(async () => { throw error; });
    await expect(invokeImageGenWithFallback({ primaryModelId: CORE, fallbackModelId: ULTRA, prompt: 'x', optionsFor: opts, invoke })).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a guardrail intervention is an answer, not a failure', async () => {
    const invoke = jest.fn(async (id: string) => ({ ...ok(id), images: [], guardrailIntervened: true }));
    const r = await invokeImageGenWithFallback({ primaryModelId: CORE, fallbackModelId: ULTRA, prompt: 'x', optionsFor: opts, invoke });
    expect(r).toMatchObject({ modelId: CORE, wasFallback: false, guardrailIntervened: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a route with no fallback (the legacy field) ends on the primary\'s error', async () => {
    const error = named('ServiceUnavailableException');
    const invoke = jest.fn(async () => { throw error; });
    await expect(invokeImageGenWithFallback({ primaryModelId: CORE, prompt: 'x', optionsFor: opts, invoke })).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a fallback with no guardrail in its region is not run unmoderated', async () => {
    const error = named('ServiceUnavailableException');
    const invoke = jest.fn(async () => { throw error; });
    const optionsFor = (id: string) => (id === CORE ? {} : undefined);
    await expect(invokeImageGenWithFallback({ primaryModelId: CORE, fallbackModelId: ULTRA, prompt: 'x', optionsFor, invoke })).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('little time left: the fallback is not tried, and the reason is reported', async () => {
    const error = named('ServiceUnavailableException');
    const invoke = jest.fn(async (id: string) => { if (id === CORE) throw error; return ok(id); });
    const onFallbackSkipped = jest.fn();
    await expect(invokeImageGenWithFallback({
      primaryModelId: CORE, fallbackModelId: ULTRA, prompt: 'x', optionsFor: () => ({ requestTimeoutMs: 60_000 }), invoke,
      remainingMs: () => 30_000, replyMarginMs: 5_000, onFallbackSkipped,
    })).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(onFallbackSkipped.mock.calls[0][0].reason).toContain('65000ms');
  });

  it('enough time left: the fallback is tried', async () => {
    const invoke = jest.fn(async (id: string) => { if (id === CORE) throw named('ModelTimeoutException'); return ok(id); });
    const onFallbackSkipped = jest.fn();
    const r = await invokeImageGenWithFallback({
      primaryModelId: CORE, fallbackModelId: ULTRA, prompt: 'x', optionsFor: () => ({ requestTimeoutMs: 60_000 }), invoke,
      remainingMs: () => 70_000, replyMarginMs: 5_000, onFallbackSkipped,
    });
    expect(r).toMatchObject({ modelId: ULTRA, wasFallback: true });
    expect(onFallbackSkipped).not.toHaveBeenCalled();
  });

  it('classifies the module\'s own model-side errors and a wrapped legacy lockout', () => {
    expect(isImageGenFallbackEligible(Object.assign(new Error('invokeImageGenModel: timed out after 60000ms'), { imageGenModelSide: true }))).toBe(true);
    expect(isImageGenFallbackEligible(Object.assign(new Error('LEGACY-locked'), { cause: named('AccessDeniedException') }))).toBe(true);
    expect(isImageGenFallbackEligible({ name: 'X', $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isImageGenFallbackEligible(named('ValidationException'))).toBe(false);
    expect(isImageGenFallbackEligible(undefined)).toBe(false);
  });
});

describe('the grant, the seed and the experiment recipe read image routes', () => {
  const catalog: GrantCatalog = {
    edges: new Set(['base', 'models-opus', 'image-stability_image_core', 'image-stability_image_ultra']),
    alwaysModelKeys: [],
    defaultImageModelKey: 'stability_image_core',
  };

  it('grants both models of an image route, and the legacy field', () => {
    const route = grantEdgesFor({ models: { default: 'opus', byIntent: { diagram: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } } } } }, undefined, catalog);
    expect(route).toEqual(expect.arrayContaining(['image-stability_image_core', 'image-stability_image_ultra']));
    expect(grantEdgesFor({ models: { default: 'opus', image: 'stability_image_core' } }, undefined, catalog)).toContain('image-stability_image_core');
  });

  it('the default image route is image_generation with an aws-bedrock fallback, where the classification allows it', () => {
    expect(defaultImageRoute('premium')).toEqual({ image_generation: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } } });
    expect(defaultImageRoute('basic')).toEqual({});
    for (const k of ['stability_image_core', 'stability_image_ultra'] as const) {
      expect(IMAGE_GEN_MODELS[k].hosting).toBe('aws-bedrock');
    }
  });

  it('an experiment\'s image model is the image_generation route\'s primary, compared against the live route', () => {
    const exp = { experimentType: 'intent', intent: 'image_generation', variants: [
      { variantId: 'control', imageGenModelKey: 'stability_image_core' },
      { variantId: 'treatment', imageGenModelKey: 'stability_image_ultra' },
    ] };
    expect(variantDeltaOf(exp, 'treatment').patch.models?.byIntent).toEqual({ image_generation: { image: { primary: 'stability_image_ultra' } } });
    expect(controlMismatch(exp, body({ byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } }), 'premium')).toBeNull();
    expect(controlMismatch(exp, body({ byIntent: { image_generation: { image: { primary: 'stability_image_ultra' } } } }), 'premium')).toContain('image model');
  });
});

describe('every intent that needs an image is an image intent, whatever it is called', () => {
  const logoPack = {
    extends: 'default' as const,
    intents: [{ key: 'logo', description: 'Design a logo.', needs: 'image' as const }],
  };

  it('the seed routes every pack intent that needs an image to the default image route', () => {
    expect(imageIntentRouteKeysOf(logoPack).sort()).toEqual(['image_generation', 'logo']);
    expect(imageIntentRouteKeysOf(undefined)).toEqual(['image_generation']);
    expect(defaultImageRoute('premium', ['logo'])).toEqual({ logo: { image: { primary: 'stability_image_core', fallback: 'stability_image_ultra' } } });
    const seeded = JSON.parse(serializeSeedDefinition('advisor', undefined, logoPack)!).models.byIntent;
    expect(seeded.logo).toEqual({ image: { primary: DEFAULT_IMAGE_MODEL, fallback: DEFAULT_IMAGE_FALLBACK_MODEL } });
    expect(seeded.image_generation).toEqual({ image: { primary: DEFAULT_IMAGE_MODEL, fallback: DEFAULT_IMAGE_FALLBACK_MODEL } });
  });

  it('a pack intent that declares needs: image is held to an image model (the worker\'s fail-fast reads this)', () => {
    expect(turnNeedsImage({ intent: 'logo', need: 'image' })).toBe(true);
    expect(turnNeedsImage({ intent: 'image_generation' })).toBe(true);
    expect(turnNeedsImage({ intent: 'logo' })).toBe(false);
    expect(turnNeedsImage({ intent: 'general' })).toBe(false);
    // Such a turn with no image route of its own takes `image_generation`'s, else none (and then fails).
    expect(resolveTurnImageRoute({ classification: 'premium', intent: 'logo', need: 'image', models: { byIntent: { image_generation: { image: { primary: 'stability_image_core' } } } } }))
      .toEqual({ primaryId: CORE });
    expect(resolveTurnImageRoute({ classification: 'premium', intent: 'logo', need: 'image', models: { byIntent: { general: { primary: 'haiku' } } } }))
      .toEqual({});
  });
});

describe('readers name the image model of the route actually served', () => {
  const models = { byIntent: { image_generation: { image: { primary: 'nova_canvas' } }, logo: { image: { primary: 'stability_image_ultra' } } } };

  it('imagePrimaryOf reads the named route; imagePrimaryForIntent falls back to image_generation', () => {
    expect(imagePrimaryOf(models, 'logo')).toBe('stability_image_ultra');
    expect(imagePrimaryOf(models)).toBe('nova_canvas');
    expect(imagePrimaryForIntent(models, 'logo')).toBe('stability_image_ultra');
    expect(imagePrimaryForIntent(models, 'diagram')).toBe('nova_canvas');
    expect(imagePrimaryForIntent({ byIntent: { general: { primary: 'haiku' } } }, 'general')).toBeUndefined();
  });

  it('the route a variant\'s delta writes is the route an experiment\'s readers resolve', () => {
    const exp = { experimentType: 'intent', intent: 'image_generation', variants: [
      { variantId: 'control', imageGenModelKey: 'stability_image_core' },
      { variantId: 'treatment', imageGenModelKey: 'stability_image_ultra' },
    ] };
    const written = variantDeltaOf(exp, 'treatment').patch.models;
    expect(imagePrimaryForIntent(written, imageRouteKeyOf(exp))).toBe('stability_image_ultra');
    expect(imageRouteKeyOf({ experimentType: 'base_model', intent: 'image_generation' })).toBe('image_generation');
  });
});

describe('an image route resolves each model\'s guardrail in one place', () => {
  it('a primary with no guardrail in its region refuses the turn, naming the region, and generates nothing', async () => {
    const invoke = jest.fn();
    await expect(invokeImageGenWithFallback({ primaryModelId: CORE, fallbackModelId: ULTRA, prompt: 'x', optionsFor: () => undefined, invoke }))
      .rejects.toThrow(`image generation blocked: no content guardrail available in ${imageGenRegionFor(IMAGE_GEN_MODELS.stability_image_core)}`);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('the worker resolves an image model\'s guardrail only through the invoker\'s optionsFor', () => {
    const src = readFileSync(join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    expect(src.match(/imageGuardrailFor\(/g)).toHaveLength(1);
  });
});
