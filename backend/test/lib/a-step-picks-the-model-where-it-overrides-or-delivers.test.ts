/**
 * ADR-064 DECISION B: A TURN TAKES ITS MODEL FROM ITS MESSAGE'S INTENT, EXCEPT WHERE THE TASK'S STEP OVERRIDES IT OR
 * DELIVERS THE INTENT'S WORK.
 *
 * In a report task whose `report_generation` and `general` routes differ: a "looks good" turn in the confirming step
 * (`drafting_outline`, which produces text) runs on the general route; the generating step (which delivers a document)
 * runs on the report route; a step override wins over both; and the plan says which rule chose (`model_from`). An
 * override naming a model the classification does not select is passed over, the write path refuses a step its
 * workflow does not declare and a model of the wrong kind, the turn's record carries the task's type, the step it
 * started in and what chose its model, and migration 092 lands those as columns.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveModelPlan, routedModel } from '../../lambda/src/lib/resolve-model-plan';
import { buildIntentStrategy } from '../../lambda/src/lib/active-profile';
import { stepRouteErrors, stepOutputOf, taskIntentOf, routeModelKeys } from '../../lambda/src/lib/step-models';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { buildAnalyticsMetadata } from '../../lambda/src/lib/analytics-metadata';
import { getModelCatalog, type BackendModelDefinition, type BackendModelKey } from '../../lib/config/model-strategy';

const catalog = getModelCatalog('us-east-1', '111122223333') as Record<BackendModelKey, BackendModelDefinition>;
const premium = { selected: ['haiku', 'sonnet', 'opus'], default: 'opus' };
const routes = {
  general: { primary: 'haiku' },
  acknowledgment: { primary: 'haiku' },
  report_generation: { primary: 'sonnet', fallback: 'opus' },
};
const strategy = buildIntentStrategy({ byIntent: routes })!;
const report = DEFAULT_TASK_STATE_MACHINES.report_generation;
const deps = { catalog, strategy, models: premium, routes };
const turn = (intent: string, step: string, routesOver = routes) => resolveModelPlan({
  classification: 'premium', intent, continuesActiveWork: true,
  task: { intent: 'report_generation', step, produces: stepOutputOf(report.states[step]) },
}, { ...deps, routes: routesOver });

describe('a turn takes its model from its message, its step override, or its delivering step (decision B)', () => {
  it('a "looks good" in the confirming step runs on the general route, not the report route', () => {
    expect(stepOutputOf(report.states.drafting_outline)).toBe('text');
    const plan = turn('acknowledgment', 'drafting_outline');
    expect(plan.ref.modelKey).toBe('haiku');
    expect(plan.modelFrom).toBe('general');
  });

  it('the generating step, which delivers the document, runs on the report route', () => {
    expect(stepOutputOf(report.states.generating)).toBe('document');
    const plan = turn('acknowledgment', 'generating');
    expect(plan.ref.modelKey).toBe('sonnet');
    expect(plan.fallback?.modelKey).toBe('opus');
    expect(plan.modelFrom).toBe('route');
  });

  it('a step override wins over both, and only for its own step', () => {
    const withOverride = { ...routes, report_generation: { ...routes.report_generation, steps: { drafting_outline: { primary: 'opus' } } } };
    expect(turn('acknowledgment', 'drafting_outline', withOverride)).toMatchObject({ ref: { modelKey: 'opus' }, modelFrom: 'step' });
    expect(turn('acknowledgment', 'generating', withOverride)).toMatchObject({ ref: { modelKey: 'sonnet' }, modelFrom: 'route' });
    expect(turn('acknowledgment', 'collecting_requirements', withOverride)).toMatchObject({ ref: { modelKey: 'haiku' }, modelFrom: 'general' });
  });

  it('an override naming a model the classification does not select is passed over, never served', () => {
    const outside = { ...routes, report_generation: { ...routes.report_generation, steps: { drafting_outline: { primary: 'gpt_oss_120b' } } } };
    expect(turn('acknowledgment', 'drafting_outline', outside)).toMatchObject({ ref: { modelKey: 'haiku' }, modelFrom: 'general' });
  });

  it('a turn bound to no task runs on its own intent, and an experiment or a routing rule is recorded as what chose', () => {
    const plain = resolveModelPlan({ classification: 'premium', intent: 'report_generation' }, deps);
    expect(plain).toMatchObject({ ref: { modelKey: 'sonnet' }, modelFrom: 'route' });
    const exp = resolveModelPlan({ classification: 'premium', intent: 'general', experimentModelId: 'x-model' }, deps);
    expect(exp.modelFrom).toBe('experiment');
    const ruled = resolveModelPlan({ classification: 'premium', intent: 'general' }, { ...deps, rules: [{ when: { 'signal:userLanguage': 'zh' }, model: 'sonnet' }], holds: () => true });
    expect(ruled).toMatchObject({ ref: { modelKey: 'sonnet' }, modelFrom: 'version_rule', routed: { primaryModelKey: 'haiku' } });
  });

  it('routedModel is the plan\'s baseline, so one resolver decides every turn', () => {
    expect(routedModel({ classification: 'premium', intent: 'off_topic' }, deps).from).toBe('general');
    expect(routedModel({ classification: 'premium', intent: 'general' }, deps).from).toBe('route');
    expect(routedModel({ classification: 'premium', intent: 'recipe_lookup' }, deps).from).toBe('base');
  });

  it('a declared intent\'s task routes by its type; a platform machine\'s by the intent that opened it', () => {
    const declared = new Set(['report_generation', 'general']);
    expect(taskIntentOf('report_generation', declared, undefined, 'acknowledgment')).toBe('report_generation');
    expect(taskIntentOf('queued_request', declared, 'report_generation', 'general')).toBe('report_generation');
    expect(taskIntentOf('queued_request', declared, undefined, 'general')).toBe('general');
  });
});

describe('the write path refuses a step its workflow does not declare and a model of the wrong kind', () => {
  it('names the workflow\'s steps when a state is not one of them', () => {
    const errs = stepRouteErrors('report_generation', { primary: 'sonnet', steps: { gather: { primary: 'haiku' } } }, report);
    expect(errs).toEqual([expect.objectContaining({
      code: 'step_not_declared',
      path: "models.byIntent['report_generation'].steps['gather']",
      message: expect.stringContaining('its steps are collecting_requirements, drafting_outline, generating, revising, completed'),
    })]);
  });

  it('refuses an image model on a text step', () => {
    const errs = stepRouteErrors('report_generation', { primary: 'sonnet', steps: { generating: { primary: 'stability_image_core' } } }, report);
    expect(errs.map((e) => e.code)).toEqual(['step_model_kind']);
    expect(errs[0].message).toBe("`steps['generating']` names the image model `stability_image_core` on a step that produces text");
  });

  it('refuses a step override on an intent that runs no workflow', () => {
    expect(stepRouteErrors('general', { primary: 'haiku', steps: { x: { primary: 'haiku' } } }, undefined)[0].code).toBe('step_not_declared');
  });

  it('every model a route names is walked: text, image and steps', () => {
    expect(routeModelKeys({ primary: 'haiku', fallback: 'sonnet', image: { primary: 'stability_image_core' }, steps: { a: { primary: 'opus' } } }).sort())
      .toEqual(['haiku', 'opus', 'sonnet', 'stability_image_core']);
  });
});

describe('the turn records what chose its model, and Aurora lands it as columns (decision 4)', () => {
  it('stamps the task type, the step it started in, the model kind and the rule', () => {
    const m = buildAnalyticsMetadata({ messageNumber: 1, role: 'assistant', modelChoice: { taskType: 'report_generation', turnStep: 'generating', modelKind: 'text', modelFrom: 'route' } });
    expect(m).toMatchObject({ taskType: 'report_generation', turnStep: 'generating', modelKind: 'text', modelFrom: 'route' });
  });

  it('migration 092 adds the four columns to messages and exchanges and drops the unwritten original_intent', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../lambda/src/analytics-aurora/schema/092-a-turn-records-what-chose-its-model.sql'), 'utf8');
    for (const table of ['messages', 'exchanges']) {
      for (const [col, type] of [['task_type', 'VARCHAR(64)'], ['task_step', 'VARCHAR(32)'], ['model_kind', 'VARCHAR(8)'], ['model_from', 'VARCHAR(16)']]) {
        expect(sql).toMatch(new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS ${col}\\s+${type.replace(/[()]/g, '\\$&')};`));
      }
    }
    expect(sql).toContain('ALTER TABLE exchanges DROP COLUMN IF EXISTS original_intent;');
    const archival = fs.readFileSync(path.join(__dirname, '../../lambda/src/analytics-aurora/kinesis-archival.ts'), 'utf8');
    expect(archival).not.toMatch(/original_intent\s*(=|,)/);
    expect(archival).toContain('am.task_type, am.task_step, am.model_kind, am.model_from');
  });

  it('the processor resolves every turn through resolveModelPlan, once, and never calls the intent resolver directly', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
    expect(src.match(/resolveModelPlan\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/resolveModelForIntent\(/);
  });
});
