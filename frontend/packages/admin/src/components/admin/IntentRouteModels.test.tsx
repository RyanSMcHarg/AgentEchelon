/**
 * AN INTENT'S MODELS AS ITS CARD EDITS THEM (`IntentRouteModels.tsx`, ADR-064 decisions C, D and 5): a text model and an
 * image model apart, each with a fallback of its own kind; an image model offered where a step produces an image or the
 * intent needs one; a step override of the step's own kind, removed when cleared; a route with nothing left in it
 * removed; and a validation refusal placed by its structured params, never by its text. The image-model rule is the
 * write path's own (`backend/lambda/src/lib/image-route.ts`), imported rather than copied.
 */
import { describe, it, expect } from 'vitest';
import type { ClassificationCatalog, RouteError } from '../../services/profileService';
import * as backendRules from '../../../../../../backend/lambda/src/lib/image-route.ts';
import {
  cardRefusals, fallbacksFor, isImageModelKey, modelsOfKind, offersImageModel, refusalsFor, stepKind, withImageModel, withPrimary, withRoute,
  withStepModel, withTextModel,
} from './IntentRouteModels';

const catalog = {
  models: { text: ['haiku', 'sonnet'], image: ['stability_image_core', 'stability_image_ultra'] },
  workflows: [
    { key: 'image_generation', source: 'platform', required: false, initial: 'gather', states: [], steps: [
      { key: 'gather', transitions: ['generate'] }, { key: 'generate', produces: 'image', transitions: [] },
    ] },
    { key: 'report', source: 'platform', required: false, initial: 'drafting', states: [], steps: [{ key: 'drafting', produces: 'document', transitions: [] }] },
  ],
} as unknown as ClassificationCatalog;

describe('an intent card\'s models', () => {
  it('decides what an image model is by the write path\'s rule', () => {
    expect(isImageModelKey).toBe(backendRules.isImageModelKey);
  });

  it('offers text and image models apart, a fallback of the same kind and never the primary', () => {
    expect(modelsOfKind('text', catalog)).toEqual(['haiku', 'sonnet']);
    expect(modelsOfKind('image', catalog)).toEqual(['stability_image_core', 'stability_image_ultra']);
    expect(fallbacksFor('image', 'stability_image_core', catalog)).toEqual(['stability_image_ultra']);
    expect(fallbacksFor('text', 'sonnet', catalog)).toEqual(['haiku']);
  });

  it('offers an image model where a step produces an image or the intent needs one, and nowhere else', () => {
    expect(offersImageModel({ key: 'image_generation', machine: 'image_generation' }, catalog)).toBe(true);
    expect(offersImageModel({ key: 'logo', needs: 'image' }, catalog)).toBe(true);
    expect(offersImageModel({ key: 'report', machine: 'report', needs: 'document' }, catalog)).toBe(false);
    expect(stepKind({ produces: 'image' })).toBe('image');
    expect(stepKind({ produces: 'document' })).toBe('text');
  });

  it('writes the text model, the image part and a step override in their own places', () => {
    let r = withTextModel(undefined, { primary: 'sonnet', fallback: 'haiku' });
    r = withImageModel(r, { primary: 'stability_image_core' });
    r = withStepModel(r, 'gather', { primary: 'haiku' });
    expect(r).toEqual({ primary: 'sonnet', fallback: 'haiku', image: { primary: 'stability_image_core' }, steps: { gather: { primary: 'haiku' } } });
    expect(withStepModel(r, 'gather', undefined)).not.toHaveProperty('steps');
    expect(withPrimary({ primary: 'sonnet', fallback: 'haiku' }, 'haiku')).toEqual({ primary: 'haiku' });
    expect(withPrimary({ primary: 'sonnet' }, '')).toBeUndefined();
  });

  it('removes a route with nothing left in it, and never writes models.image', () => {
    const models = withRoute({ default: 'sonnet', byIntent: { general: { primary: 'haiku' } } }, 'image_generation', withImageModel(undefined, { primary: 'stability_image_core' }));
    expect(models).toEqual({ default: 'sonnet', byIntent: { general: { primary: 'haiku' }, image_generation: { image: { primary: 'stability_image_core' } } } });
    expect(withRoute(models, 'image_generation', withImageModel(models.byIntent!.image_generation, undefined)).byIntent).toEqual({ general: { primary: 'haiku' } });
    expect(models).not.toHaveProperty('image');
  });

  it('places a refusal by its params: on the card, on a step, or on the card when its step is not listed', () => {
    const details: RouteError[] = [
      { code: 'image_model_as_text', path: "models.byIntent['image_generation']", message: 'x', params: { intent: 'image_generation', model: 'stability_image_core' } },
      { code: 'step_model_kind', path: "models.byIntent['image_generation'].steps['generate'].primary", message: 'x', params: { intent: 'image_generation', state: 'generate', model: 'sonnet', kind: 'image' } },
      { code: 'step_not_declared', path: "models.byIntent['image_generation'].steps['draw']", message: 'x', params: { intent: 'image_generation', state: 'draw', states: 'gather, generate' } },
      { code: 'required_tool_not_allowed', path: "workflows['report'].steps['drafting'].requiresTool", message: 'x', params: { workflow: 'report', state: 'drafting', tool: 'search_kb' } },
    ];
    const card = { key: 'image_generation', machine: 'image_generation' };
    expect(refusalsFor(details, card, 'generate').map((d) => d.code)).toEqual(['step_model_kind']);
    expect(cardRefusals(details, card, ['gather', 'generate']).map((d) => d.code)).toEqual(['image_model_as_text', 'step_not_declared']);
    expect(refusalsFor(details, { key: 'report', machine: 'report' }, 'drafting').map((d) => d.code)).toEqual(['required_tool_not_allowed']);
    expect(refusalsFor(details, { key: 'general' })).toEqual([]);
  });
});
