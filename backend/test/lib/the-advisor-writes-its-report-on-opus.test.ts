/**
 * THE SHIPPED ADVISOR ANSWERS ON SONNET AND WRITES A REPORT ON OPUS (ADR-064 decision D).
 *
 * The seeded version carries `models.byIntent.report_generation.steps` for the two states that write the document
 * (`generating`, `revising`), from `AssistantProfile.routes`, which also puts the report route's text model on Sonnet. Resolved the way the processor resolves a turn
 * (`resolveModelPlan` over the version's routes, its base model in the classification's selection), the document
 * steps run on Opus chosen by `step`, and a report's bookkeeping steps run on the base model. The seed passes the
 * version validators, stays inside premium's selection, and names only states the workflow it runs declares.
 */
import { serializeSeedDefinition, buildIntentStrategy, validateDefinitionBody, confineModelsToClassification, type ProfileDefinition } from '../../lambda/src/lib/active-profile';
import { resolveModelPlan, stepModelOf } from '../../lambda/src/lib/resolve-model-plan';
import { enteredStepModel, stepOutputOf, stepRouteErrors } from '../../lambda/src/lib/step-models';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { DEFAULT_PROFILES_CONFIG, validateProfilesConfig } from '../../lib/config/profiles';
import { getModelCatalog, type BackendModelDefinition, type BackendModelKey } from '../../lib/config/model-strategy';
import { stratumIntentPack } from '../../../demo/stratum-company/intent-packs';

const catalog = getModelCatalog('us-east-1', '111122223333') as Record<BackendModelKey, BackendModelDefinition>;
const report = DEFAULT_TASK_STATE_MACHINES.report_generation;
const DOCUMENT_STEPS = Object.entries(report.states).filter(([, s]) => stepOutputOf(s) === 'document').map(([n]) => n);
const OTHER_STEPS = Object.keys(report.states).filter((n) => !DOCUMENT_STEPS.includes(n));

function seeded(withPack: boolean): ProfileDefinition {
  const raw = withPack ? serializeSeedDefinition('advisor', undefined, stratumIntentPack('premium')) : serializeSeedDefinition('advisor');
  return JSON.parse(raw!) as ProfileDefinition;
}

/** A report task's turn in `step`, resolved as the processor resolves it. */
function turnIn(def: ProfileDefinition, step: string, intent = 'report_generation') {
  const selection = defaultProfileRegistry.modelsOf('premium')!;
  return resolveModelPlan({
    classification: 'premium', intent, continuesActiveWork: true,
    task: { intent: 'report_generation', step, produces: stepOutputOf(report.states[step]) },
  }, {
    catalog,
    strategy: buildIntentStrategy(def.models)!,
    models: { ...selection, default: def.modelKey },
    enabled: true,
    routes: def.models?.byIntent,
  });
}

describe('the shipped advisor', () => {
  it('declares Sonnet as its base and Opus on the report steps that write the document', () => {
    expect(DOCUMENT_STEPS.sort()).toEqual(['generating', 'revising']);
    const advisor = DEFAULT_PROFILES_CONFIG.profiles.find((p) => p.name === 'advisor')!;
    expect(advisor.modelKey).toBe('sonnet');
    expect(advisor.routes?.report_generation?.primary).toBe('sonnet');
    expect(Object.keys(advisor.routes?.report_generation?.steps ?? {}).sort()).toEqual(DOCUMENT_STEPS);
  });

  for (const withPack of [false, true]) {
    describe(withPack ? 'seeded with the demo premium pack' : 'seeded with the platform taxonomy', () => {
      const def = seeded(withPack);

      it('carries the step overrides on its report route, inside premium\'s selection, and passes the validators', () => {
        expect(def.models?.default).toBe('sonnet');
        expect(def.models?.byIntent?.report_generation).toMatchObject({ primary: 'sonnet' });
        expect(def.models?.byIntent?.report_generation?.steps).toEqual({
          generating: { primary: 'opus', fallback: 'sonnet' },
          revising: { primary: 'opus', fallback: 'sonnet' },
        });
        expect(validateDefinitionBody(def)).toEqual([]);
        expect(confineModelsToClassification(def.models, 'premium').dropped).toEqual([]);
        const machine = withPack ? stratumIntentPack('premium').machines!.report_generation : report;
        expect(stepRouteErrors('report_generation', def.models!.byIntent!.report_generation, machine)).toEqual([]);
      });

      it.each(DOCUMENT_STEPS)('runs the document step `%s` on Opus, chosen by its step', (step) => {
        const plan = turnIn(def, step);
        expect(plan.ref.modelKey).toBe('opus');
        expect(plan.fallback?.modelKey).toBe('sonnet');
        expect(plan.modelFrom).toBe('step');
        // A move into the step mid-turn moves the loop onto the step's model.
        expect(enteredStepModel({ from: plan.routed.from, primaryModelId: plan.routed.primaryModelId }, 'document')?.from).toBe('step');
      });

      it.each(OTHER_STEPS)('runs the bookkeeping step `%s` on the base model', (step) => {
        const plan = turnIn(def, step);
        expect(plan.ref.modelKey).toBe('sonnet');
        expect(plan.modelFrom).not.toBe('step');
      });
    });
  }

  it('a step model the classification does not select is refused at synth', () => {
    const profiles = DEFAULT_PROFILES_CONFIG.profiles.map((p) => (p.name === 'advisor'
      ? { ...p, routes: { report_generation: { primary: 'sonnet', steps: { generating: { primary: 'not_a_selected_model' } } } } }
      : p));
    expect(() => validateProfilesConfig({ ...DEFAULT_PROFILES_CONFIG, profiles })).toThrow(/routes 'report_generation.generating' to 'not_a_selected_model'/);
  });
});

describe('the console reads a step\'s model through the processor\'s own resolution (stepModelOf)', () => {
  const def = seeded(true);
  const selection = defaultProfileRegistry.modelsOf('premium')!;
  const preview = (step: string, produces = stepOutputOf(report.states[step])) => stepModelOf({
    classification: 'premium', intent: 'report_generation', step, produces,
    routes: def.models?.byIntent, baseModelKey: def.modelKey, selection, catalog,
  });

  it.each([...DOCUMENT_STEPS, ...OTHER_STEPS])('names for `%s` the model and rule a turn there resolves to', (step) => {
    const plan = turnIn(def, step);
    expect(preview(step)).toEqual({ modelKey: plan.routed.primaryModelKey, fallbackKey: plan.routed.fallbackModelKey ?? undefined, from: plan.routed.from });
  });

  it('an image step names the image route it is drawn on', () => {
    expect(stepModelOf({
      classification: 'premium', intent: 'image_generation', step: 'drawing', produces: 'image',
      routes: def.models?.byIntent, baseModelKey: def.modelKey, selection, catalog, imageModel: { primary: 'stability_image_core' },
    })).toEqual({ modelKey: 'stability_image_core', fallbackKey: undefined, from: 'image' });
  });
});
