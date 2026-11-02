/**
 * AN INTENT'S MODELS, AS ITS CARD EDITS THEM (ADR-064 decisions C, D and 5; SPEC-ADMIN-CONSOLE FR60).
 *
 * A route is keyed by its intent and carries a text model (`primary`, `fallback`), an image model (`image`) and per-step
 * overrides (`steps`, keyed by a state of the intent's workflow). The card offers a text model and fallback from the text
 * models the classification selects, an image model and fallback from its image models where the intent's workflow has a
 * step that produces an image or the intent needs one, and, per step, an override of the step's own kind. An image model
 * is never offered as a text model, and nothing here writes the retired `models.image`.
 *
 * THE RULES ARE THE BACKEND'S OWN (`backend/lambda/src/lib/image-route.ts`): which key is an image model and when a
 * fallback is sound. The console imports that pure module rather than restating it, so the editor and the write path
 * decide the same way. A validation refusal is placed by its structured `{ code, path, params }` and worded through the
 * console's own message keys, never by reading the server's English (tenet D11).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogIntent, ClassificationCatalog, IntentRoute, MachineStep, ProfileModels, RouteError } from '../../services/profileService';
import { IMAGE_ROUTE_KEY, isImageModelKey } from '../../../../../../backend/lambda/src/lib/image-route.ts';

export { IMAGE_ROUTE_KEY, isImageModelKey };

type ModelPair = { primary: string; fallback?: string };

/** The machine's steps as the catalog serves them, or none when the intent runs no workflow. */
export function machineStepsOf(catalog: ClassificationCatalog | undefined, machine: string | undefined): MachineStep[] {
  if (!machine) return [];
  return catalog?.workflows?.find((w) => w.key === machine)?.steps ?? [];
}

/** Whether an intent's card offers an image model: a step of its workflow produces an image, or the intent needs one. */
export function offersImageModel(intent: Pick<CatalogIntent, 'key' | 'needs'> & { machine?: string }, catalog: ClassificationCatalog | undefined): boolean {
  if (intent.needs === 'image') return true;
  if (intent.key === IMAGE_ROUTE_KEY && !intent.machine) return true;
  return machineStepsOf(catalog, intent.machine).some((s) => s.produces === 'image');
}

/** The kind of model a step runs on: an image step on an image model, every other step on a text model. */
export function stepKind(step: Pick<MachineStep, 'produces'>): 'text' | 'image' {
  return step.produces === 'image' ? 'image' : 'text';
}

/** The models a select of this kind offers: the classification's text models, or its image models. */
export function modelsOfKind(kind: 'text' | 'image', catalog: ClassificationCatalog | undefined): string[] {
  return kind === 'image' ? catalog?.models.image ?? [] : (catalog?.models.text ?? []).filter((m) => !isImageModelKey(m));
}

/** A fallback's choices: the same kind as its primary, never the primary itself. */
export function fallbacksFor(kind: 'text' | 'image', primary: string | undefined, catalog: ClassificationCatalog | undefined): string[] {
  return modelsOfKind(kind, catalog).filter((m) => m !== primary);
}

/** A pair after its primary changes: a fallback that is the new primary is dropped. Empty clears the pair. */
export function withPrimary(pair: Partial<ModelPair> | undefined, primary: string): ModelPair | undefined {
  if (!primary) return undefined;
  const fallback = pair?.fallback && pair.fallback !== primary ? pair.fallback : undefined;
  return { primary, ...(fallback ? { fallback } : {}) };
}

/** A route with nothing left in it is no route: a removed text model, image model and every override leave the key gone. */
function pruned(route: IntentRoute): IntentRoute | undefined {
  const out: IntentRoute = {};
  if (route.primary) { out.primary = route.primary; if (route.fallback) out.fallback = route.fallback; }
  if (route.image?.primary) out.image = route.image;
  if (route.steps && Object.keys(route.steps).length) out.steps = route.steps;
  return Object.keys(out).length ? out : undefined;
}

/** The bundle with `intent`'s route replaced (or removed, when nothing is left in it). */
export function withRoute(models: ProfileModels | undefined, intent: string, route: IntentRoute | undefined): ProfileModels {
  const byIntent = { ...(models?.byIntent ?? {}) };
  const next = route ? pruned(route) : undefined;
  if (next) byIntent[intent] = next; else delete byIntent[intent];
  return { ...(models ?? {}), byIntent };
}

/** The route with its text model set (or cleared). */
export function withTextModel(route: IntentRoute | undefined, pair: ModelPair | undefined): IntentRoute {
  const { primary: _p, fallback: _f, ...rest } = route ?? {};
  return { ...rest, ...(pair ?? {}) };
}

/** The route with its image model set (or cleared). */
export function withImageModel(route: IntentRoute | undefined, pair: ModelPair | undefined): IntentRoute {
  const { image: _i, ...rest } = route ?? {};
  return { ...rest, ...(pair ? { image: pair } : {}) };
}

/** The route with one step's override set, or removed when cleared. */
export function withStepModel(route: IntentRoute | undefined, state: string, pair: ModelPair | undefined): IntentRoute {
  const steps = { ...(route?.steps ?? {}) };
  if (pair) steps[state] = pair; else delete steps[state];
  const { steps: _s, ...rest } = route ?? {};
  return { ...rest, ...(Object.keys(steps).length ? { steps } : {}) };
}

/**
 * THE REFUSALS THAT BELONG TO ONE CARD, OR ONE OF ITS STEPS, read from the server's structured fields: a refusal whose
 * params name this intent (or, for a workflow's required tool, this card's workflow) and, for a step, that state.
 */
export function refusalsFor(details: readonly RouteError[] | undefined, card: { key: string; machine?: string }, state?: string): RouteError[] {
  return (details ?? []).filter((d) => {
    const p = d.params ?? {};
    const mine = p.intent === card.key || (!!card.machine && p.workflow === card.machine);
    if (!mine) return false;
    return state === undefined ? !p.state : p.state === state;
  });
}

/** A card's own refusals, and any naming a step its workflow does not list, which has no step to sit under. */
export function cardRefusals(details: readonly RouteError[] | undefined, card: { key: string; machine?: string }, stepKeys: readonly string[]): RouteError[] {
  const steps = new Set(stepKeys);
  return [
    ...refusalsFor(details, card),
    ...(details ?? []).filter((d) => {
      const p = d.params ?? {};
      return (p.intent === card.key || (!!card.machine && p.workflow === card.machine)) && !!p.state && !steps.has(p.state);
    }),
  ];
}

/** One structured refusal, worded through the console's message keys; the server's English stands only where no key exists. */
export const RouteRefusal: React.FC<{ error: RouteError }> = ({ error }) => {
  const { t } = useTranslation();
  const p = error.params ?? {};
  const key = error.code === 'step_not_declared' && !p.states ? 'step_not_declared_no_workflow' : error.code;
  return (
    <li data-testid={`route-refusal-${error.code}`} data-path={error.path}>
      {t(`admin.assistantPage.routeError.${key}`, { ...p, defaultValue: error.message })}
    </li>
  );
};

/** The refusals anchored under a card or step, as an alert list. */
export const RouteRefusals: React.FC<{ errors: RouteError[]; testId: string }> = ({ errors, testId }) => {
  if (!errors.length) return null;
  return <ul className="admin-error" role="alert" data-testid={testId}>{errors.map((e) => <RouteRefusal key={`${e.code}:${e.path}`} error={e} />)}</ul>;
};
