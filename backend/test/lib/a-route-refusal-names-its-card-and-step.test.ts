/**
 * A ROUTE REFUSAL NAMES THE CARD AND STEP IT BELONGS TO (ADR-064 decision 5, SPEC-ADMIN-CONSOLE FR60).
 *
 * Validate returns, beside its flat list of messages, each route refusal as `{ code, path, params, message }`, so the
 * console anchors it to the intent card or workflow step it names and words it through its own message keys, never by
 * reading the message (tenet D11). The structured refusals are produced by the same functions as the flat messages, so
 * the two never disagree. The console's Platform intents group is served from the resolver's own list.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { createDraft, editDraft, routeErrorDetails, validateBody, validateDraft } from '../../lambda/src/lib/profile-lifecycle';
import { __clearActiveProfileCache } from '../../lambda/src/lib/active-profile';
import { routeKindError, routeKindErrorDetail } from '../../lambda/src/lib/image-route';
import { stepRouteErrors } from '../../lambda/src/lib/step-models';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { ANSWERS_THROUGH_GENERAL } from '../../lambda/src/lib/model-resolver';
import { UNIVERSAL_INTENT_KEYS } from '../../lambda/src/lib/intent-pack';
import { platformIntents } from '../../lambda/src/lib/classification-catalog';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const NAME = 'ops-premium';
const CATALOG = getModelCatalog('us-east-1', '123456789012');

beforeEach(() => __clearActiveProfileCache());

describe('each route refusal carries a code, a path and its params', () => {
  it('a retired key, the retired models.image and an image model named as text', () => {
    const details = routeErrorDetails({
      image: 'nova_canvas',
      byIntent: { general_qa: { primary: 'haiku' }, diagram: { primary: 'nova_canvas' } },
    } as never);
    expect(details.map(({ code, path, params }) => ({ code, path, params }))).toEqual([
      { code: 'legacy_image_field', path: 'models.image', params: { intent: 'image_generation' } },
      { code: 'retired_route_key', path: "models.byIntent['general_qa']", params: { intent: 'general_qa', now: 'general' } },
      { code: 'image_model_as_text', path: "models.byIntent['diagram']", params: { intent: 'diagram', model: 'nova_canvas' } },
    ]);
  });

  it('the structured refusals say what the flat list says', () => {
    const models = { byIntent: { general_qa: { primary: 'haiku' }, diagram: { primary: 'nova_canvas' }, image_generation: { image: { primary: 'nova_canvas', fallback: 'nova_canvas' } } } };
    const flat = validateBody({ modelKey: 'haiku', models } as never, CATALOG);
    for (const d of routeErrorDetails(models as never)) expect(flat).toContain(d.message);
  });

  it('a route kind refusal is anchored to the field it refuses', () => {
    const d = routeKindErrorDetail('image_generation', { image: { primary: 'nova_canvas', fallback: 'nova_canvas' } });
    expect(d).toMatchObject({ code: 'fallback_is_primary', path: "models.byIntent['image_generation'].image.fallback", params: { intent: 'image_generation', model: 'nova_canvas' } });
    expect(routeKindError('image_generation', { image: { primary: 'nova_canvas', fallback: 'nova_canvas' } })).toBe(d!.message);
    expect(routeKindErrorDetail('general', { primary: 'haiku', fallback: 'sonnet' })).toBeNull();
  });

  it('a step refusal names the intent, the state and the declared steps or the model and its kind', () => {
    const machine = DEFAULT_TASK_STATE_MACHINES.image_generation;
    const [undeclared] = stepRouteErrors('image_generation', { steps: { draw: { primary: 'haiku' } } }, machine);
    expect(undeclared).toMatchObject({
      code: 'step_not_declared', path: "models.byIntent['image_generation'].steps['draw']",
      params: { intent: 'image_generation', state: 'draw', states: Object.keys(machine.states).join(', ') },
    });
    const [kind] = stepRouteErrors('image_generation', { steps: { generate: { primary: 'sonnet' } } }, machine);
    expect(kind).toMatchObject({ code: 'step_model_kind', path: "models.byIntent['image_generation'].steps['generate'].primary", params: { state: 'generate', model: 'sonnet', kind: 'image' } });
  });
});

describe('a route may only override a step', () => {
  it('names no text model of its own, and a fallback with no primary is still refused', () => {
    const ok = validateBody({ modelKey: 'haiku', models: { byIntent: { report_generation: { steps: { drafting_outline: { primary: 'sonnet' } } } } } } as never, CATALOG);
    expect(ok.filter((e) => e.includes("report_generation"))).toEqual([]);
    const bad = validateBody({ modelKey: 'haiku', models: { byIntent: { report_generation: { fallback: 'haiku', steps: { drafting_outline: { primary: 'sonnet' } } } } } } as never, CATALOG);
    expect(bad).toContain("models.byIntent['report_generation'].primary must be a non-empty modelKey");
  });
});

describe('validate returns them beside the flat list', () => {
  it('a draft whose route overrides a state its workflow does not declare', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, 'admin');
    await editDraft(client, ROOT, NAME, { models: { byIntent: { report_generation: { steps: { drafting: { primary: 'default' } } } } } } as never, 'admin');
    const res = await validateDraft(client, ROOT, NAME, CATALOG);
    const detail = res.errorDetails?.find((e) => e.code === 'step_not_declared');
    expect(detail).toMatchObject({ path: "models.byIntent['report_generation'].steps['drafting']", params: { intent: 'report_generation', state: 'drafting' } });
    expect(res.errors).toContain(detail!.message);
  });
});

describe('the Platform intents group', () => {
  it('lists every universal intent and platform_question, each answering through general as the resolver does', () => {
    const rows = platformIntents();
    expect(rows.map((r) => r.key)).toEqual([...UNIVERSAL_INTENT_KEYS, 'platform_question']);
    for (const r of rows) expect(r.answersThroughGeneral).toBe(ANSWERS_THROUGH_GENERAL.includes(r.key));
    expect(ANSWERS_THROUGH_GENERAL.every((k) => rows.some((r) => r.key === k))).toBe(true);
  });
});
