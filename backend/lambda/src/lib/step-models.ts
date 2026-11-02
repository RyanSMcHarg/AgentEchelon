/**
 * A STEP OF AN INTENT'S WORKFLOW AND THE MODEL IT RUNS ON (ADR-064 decisions 2, B, C and D).
 *
 * A route is keyed by its intent and carries a text model, an image model (`image`) and per-step overrides
 * (`steps`, keyed by a state of the intent's task machine). A turn bound to a task runs on the step's override when
 * the route names one, on the task intent's route when the step delivers the intent's work (a document or an image),
 * and otherwise on the message's own intent. What a step produces is the machine's statement (`produces`, with the
 * retired `delivers: true` read as `produces: 'document'` only where a stored machine still says it).
 *
 * Pure, so the write path, the resolver, the grant and the console's mirror decide the same way.
 */
import type { ModelRoute, RouteError } from './image-route.js';
import { isImageModelKey } from './image-route.js';
import type { TaskStateMachine } from './task-state-machines.js';

/** What a step hands over: an answer in the conversation, an image, or a document. */
export type StepOutput = 'text' | 'image' | 'document';
export const STEP_OUTPUTS: readonly StepOutput[] = ['text', 'image', 'document'];

/** The kind of model a step runs on: an image step on an image model, every other step on a text model. */
export type ModelKind = 'text' | 'image';

/** Which rule chose a turn's model (ADR-064 decision 4, `model_from`). */
export type ModelFrom = 'experiment' | 'version_rule' | 'context_rule' | 'step' | 'route' | 'general' | 'base';

/** A route keyed by its intent: the text model, the image model and the per-step overrides. */
export interface IntentRoute {
  /** The text model. Absent on a route that names only an image model (the shipped `image_generation`). */
  primary?: string;
  fallback?: string;
  image?: ModelRoute;
  steps?: Record<string, ModelRoute>;
}

/** What a state produces, as its machine declares it (`produces`, absent meaning text). */
export function stepOutputOf(def: { produces?: unknown } | undefined): StepOutput {
  return def?.produces === 'image' || def?.produces === 'document' ? def.produces : 'text';
}

/** Whether a step delivers its intent's work: a document or an image. */
export function stepDelivers(output: StepOutput | undefined): boolean {
  return output === 'document' || output === 'image';
}

/** The kind of model a step of this output runs on. */
export function modelKindOf(output: StepOutput | undefined): ModelKind {
  return output === 'image' ? 'image' : 'text';
}

/**
 * THE MODEL A STEP THE TASK ENTERED MID-TURN RUNS ON (ADR-064 decision B), with that model's fallback and the rule that
 * chose it. The loop moves onto it, and the turn's follow-on calls (a correction before delivery) and its record
 * (`bedrock_model`, `model_from`) follow the model that wrote the reply.
 */
export interface StepModelChoice {
  modelId: string;
  fallbackModelId?: string | null;
  /** The rule that chose the model: `step` for the version's override of the step, else the task intent's route. */
  from: ModelFrom | string;
}

/**
 * WHETHER A STEP THE TASK ENTERS MID-TURN HAS A MODEL OF ITS OWN: the route's choice for it where the version overrides
 * the step, or where the step delivers a document. Undefined keeps the loop on the model it is on. (An image step is
 * drawn by its step action on the route's image part, never by the text loop.)
 */
export function enteredStepModel(
  routed: { from: string; primaryModelId: string; fallbackModelId?: string | null },
  produces: StepOutput,
): StepModelChoice | undefined {
  if (routed.from !== 'step' && produces !== 'document') return undefined;
  return { modelId: routed.primaryModelId, fallbackModelId: routed.fallbackModelId ?? null, from: routed.from };
}

/**
 * WHETHER THE DOCUMENT OF A STEP THE TASK ENTERS IS WRITTEN ON THAT STEP'S MODEL rather than on the move into it (ADR-064
 * decision B): the step produces a document, it has a model of its own (`enteredStepModel`), and that model is not the one
 * the turn is running on. The move is then accepted without the document and the loop, which moves onto the step's model,
 * writes it there (`deliver_document`). Where the models are the same the document rides the move, as it always has, so
 * the common path costs no extra call.
 */
export function documentWrittenOnStep(
  produces: StepOutput,
  stepChoice: StepModelChoice | undefined,
  runningModelId: string,
): boolean {
  return produces === 'document' && Boolean(stepChoice?.modelId) && stepChoice!.modelId !== runningModelId;
}

/**
 * THE MODEL A TURN ENDED ON, which its follow-on calls run on and its record names (ADR-064 decision B): the model and
 * fallback the turn started on, unless the task entered a step with a model of its own mid-turn, and then that step's
 * model, its fallback and the rule that chose it. `task_step` stays the step the turn started in; `task_state` names
 * the step it entered.
 */
export function modelTheTurnEndedOn(
  start: { model: string; fallbackModelId: string | null; modelFrom: string },
  entered: StepModelChoice | undefined,
): { model: string; fallbackModelId: string | null; modelFrom: string } {
  if (!entered) return start;
  return { model: entered.modelId, fallbackModelId: entered.fallbackModelId ?? null, modelFrom: entered.from };
}

/**
 * THE INTENT A TASK'S STEPS ARE CONFIGURED UNDER, AND THE WORK ITS TURNS ARE ATTRIBUTED TO (ADR-064 decisions B and I):
 * its type when that type is an intent the served pack declares; else the intent the request that opened it was
 * classified as (`Task.openingIntent`), because a platform machine (`queued_request`, `queue_drain`, ...) is not an
 * intent; else, for a task no classified request opened, the turn's classified intent.
 */
export function taskIntentOf(
  taskType: string | undefined,
  declaredIntents: ReadonlySet<string>,
  openingIntent: string | undefined,
  classifiedIntent: string | undefined,
): string | undefined {
  if (taskType && declaredIntents.has(taskType)) return taskType;
  return openingIntent || classifiedIntent;
}

/** Every model key a route names: its text, image and step models, primaries and fallbacks. */
export function routeModelKeys(route: Partial<IntentRoute> | undefined): string[] {
  if (!route) return [];
  const keys = [route.primary, route.fallback, route.image?.primary, route.image?.fallback];
  for (const s of Object.values(route.steps ?? {})) keys.push(s?.primary, s?.fallback);
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && !!k && k !== 'default'))];
}

/** A structured validation error the console anchors to the card or step it names (`{ code, path }`, tenet D11). */
export type { RouteError };

/**
 * WHY A ROUTE'S STEP OVERRIDES ARE REFUSED as written against the intent's machine: each names a state the workflow
 * declares, its models are the kind the step produces, and its fallback is the same kind as its primary. An intent
 * with no machine has no steps to override. Shape errors (`steps` not a map, an empty primary) are the body
 * validator's.
 */
export function stepRouteErrors(intent: string, route: Partial<IntentRoute> | undefined, machine: TaskStateMachine | undefined): RouteError[] {
  const errs: RouteError[] = [];
  const steps = route?.steps;
  if (!steps || typeof steps !== 'object') return errs;
  const states = machine ? Object.keys(machine.states) : [];
  for (const [state, step] of Object.entries(steps)) {
    const path = `models.byIntent['${intent}'].steps['${state}']`;
    if (!machine || !machine.states[state]) {
      errs.push({
        code: 'step_not_declared', path,
        params: machine ? { intent, state, states: states.join(', ') } : { intent, state },
        message: machine
          ? `\`steps['${state}']\` names a state the \`${intent}\` workflow does not declare; its steps are ${states.join(', ')}`
          : `\`steps['${state}']\` names a step, and \`${intent}\` runs no workflow; a single-turn intent is configured by its route`,
      });
      continue;
    }
    const kind = modelKindOf(stepOutputOf(machine.states[state]));
    for (const [label, key] of [['primary', step?.primary], ['fallback', step?.fallback]] as const) {
      if (!key || key === 'default') continue;
      if (isImageModelKey(key) !== (kind === 'image')) {
        errs.push({
          code: 'step_model_kind', path: `${path}.${label}`,
          params: { intent, state, model: key, kind },
          message: `\`steps['${state}']\` names the ${kind === 'image' ? 'text' : 'image'} model \`${key}\` on a step that produces ${kind === 'image' ? 'an image' : 'text'}`,
        });
      }
    }
  }
  return errs;
}

/** The shape errors of a route's `steps` map: each entry `{ primary, fallback? }` with non-empty keys. */
export function stepShapeErrors(intent: string, steps: unknown): string[] {
  if (steps === undefined) return [];
  if (typeof steps !== 'object' || steps === null || Array.isArray(steps)) return [`models.byIntent['${intent}'].steps must be a map of state -> { primary, fallback? }`];
  const errs: string[] = [];
  for (const [state, step] of Object.entries(steps as Record<string, unknown>)) {
    const s = step as { primary?: unknown; fallback?: unknown } | null;
    if (!state) errs.push(`models.byIntent['${intent}'].steps has an empty state name`);
    if (!s || typeof s !== 'object' || typeof s.primary !== 'string' || !s.primary) errs.push(`models.byIntent['${intent}'].steps['${state}'].primary must be a non-empty modelKey`);
    else if (s.fallback !== undefined && (typeof s.fallback !== 'string' || !s.fallback)) errs.push(`models.byIntent['${intent}'].steps['${state}'].fallback must be a non-empty modelKey`);
  }
  return errs;
}
