/**
 * IMAGE GENERATION IS AN INTENT LIKE ANY OTHER: a route in `models.byIntent` whose model is an image model.
 *
 * One intent or many may generate an image (`image_generation`, and whatever a pack adds, such as `diagram`
 * or `logo`). What makes a turn an image turn is its route's MODEL: a route naming an image model
 * (`IMAGE_MODEL_KEYS`) produces an image with its primary, and with its fallback when the primary fails on
 * the model side; a route naming a text model answers in text. A route's primary and fallback are always
 * the same kind, which the write path validates.
 *
 * THE LEGACY FIELD. A version written before image routes carries its image model as `models.image`. It is
 * read as the primary of the `image_generation` route when that intent has no image route of its own, so
 * such a version serves exactly what it always did. The console writes the route on its next save.
 *
 * Pure, and free of SDK imports, so every reader (the write path, the grant, the experiment comparisons,
 * the worker, the text resolver's filter) decides the kind the same way.
 */
import { IMAGE_MODEL_KEYS } from '../../../lib/config/model-catalog.js';

/** The intent whose route the legacy `models.image` stands for. */
export const IMAGE_ROUTE_KEY = 'image_generation';

export interface ModelRoute {
  primary: string;
  fallback?: string;
}

/** The fields of a models bundle this module reads: each route's text model, its image part and its step overrides. */
export interface ImageRouteSource {
  byIntent?: Record<string, ({ primary?: string; fallback?: string } & { image?: ModelRoute; steps?: Record<string, ModelRoute> }) | undefined>;
  image?: string;
}

/** Whether a model key names an image model. */
export function isImageModelKey(key: string | undefined): boolean {
  return !!key && (IMAGE_MODEL_KEYS as readonly string[]).includes(key);
}

/** Whether a route generates an image: its primary is an image model. */
export function isImageRoute(route: Partial<ModelRoute> | undefined): boolean {
  return isImageModelKey(route?.primary);
}

/**
 * The image route serving `routeKey`, or undefined when that intent answers in text. The intent's own
 * route when it names an image model; for `image_generation` with no route of its own, the legacy
 * `models.image` as the primary.
 */
export function imageRouteFor(models: ImageRouteSource | undefined, routeKey: string | undefined): ModelRoute | undefined {
  if (!models || !routeKey) return undefined;
  // THE ROUTE'S IMAGE PART (ADR-064 decision C). A route naming an image model as its text primary, and the legacy
  // `models.image`, are refused at write and nothing stored is migrated, so neither is read.
  const part = models.byIntent?.[routeKey]?.image;
  if (!part || !isImageModelKey(part.primary)) return undefined;
  return { primary: part.primary, ...(isImageModelKey(part.fallback) && part.fallback !== part.primary ? { fallback: part.fallback } : {}) };
}

/**
 * The primary of the image route serving `routeKey` (by default `image_generation`, the legacy field
 * included): the image model a version names for that intent, or undefined when that intent answers in text.
 */
export function imagePrimaryOf(models: ImageRouteSource | undefined, routeKey: string = IMAGE_ROUTE_KEY): string | undefined {
  return imageRouteFor(models, routeKey)?.primary;
}

/**
 * The image model a turn of `routeKey` is served by: that intent's own image route's primary, else the
 * `image_generation` route's, which an intent that needs an image and has no image route of its own takes.
 * What a duel side, an experiment arm and the router's grant name, so each names the model actually served.
 */
export function imagePrimaryForIntent(models: ImageRouteSource | undefined, routeKey: string | undefined): string | undefined {
  return (routeKey ? imagePrimaryOf(models, routeKey) : undefined) ?? imagePrimaryOf(models);
}

/** The routes that answer in text: the only ones a text resolver is ever handed. */
export function textRoutesOf<R extends Partial<ModelRoute>>(byIntent: Record<string, R>): Record<string, R> {
  return Object.fromEntries(Object.entries(byIntent).filter(([, r]) => !!r?.primary && !isImageRoute(r))) as Record<string, R>;
}

/**
 * Every image model key a bundle names: each image route's primary and fallback, each route's `image` part, each step
 * override naming an image model (ADR-064), and the legacy field. The grant and the write path walk the same set.
 */
export function imageModelKeysOf(models: ImageRouteSource | undefined): string[] {
  const keys = new Set<string>();
  const add = (k: string | undefined) => { if (isImageModelKey(k)) keys.add(k as string); };
  add(models?.image);
  for (const r of Object.values(models?.byIntent ?? {})) {
    if (!r) continue;
    if (isImageRoute(r)) { add(r.primary); add(r.fallback); }
    add(r.image?.primary); add(r.image?.fallback);
    for (const s of Object.values(r.steps ?? {})) { add(s?.primary); add(s?.fallback); }
  }
  return [...keys];
}

/** Every text model key a bundle's routes name: each text route's primary and fallback and each text step override. */
export function textRouteModelKeysOf(models: ImageRouteSource | undefined): string[] {
  const keys = new Set<string>();
  const add = (k: string | undefined) => { if (k && k !== 'default' && !isImageModelKey(k)) keys.add(k); };
  for (const r of Object.values(models?.byIntent ?? {})) {
    if (!r) continue;
    if (!isImageRoute(r)) { add(r.primary); add(r.fallback); }
    for (const s of Object.values(r.steps ?? {})) { add(s?.primary); add(s?.fallback); }
  }
  return [...keys];
}

/**
 * A STRUCTURED VALIDATION ERROR the console anchors to the card or step it names (tenet D11): a stable `code`, the
 * `path` of the field it refuses, the `params` the console's message key fills, and the English `message` the flat list
 * and the CLI print. The console never reads `message` to decide where an error belongs or what it says.
 */
export interface RouteError { code: string; path: string; message: string; params?: Record<string, string> }

/**
 * Why a route mixes kinds or repeats itself, or null when it is sound: an image model is named in the route's image
 * part, never as its text model; an image part names image models; a fallback is the same kind as its primary and a
 * different model.
 */
export function routeKindErrorDetail(intent: string, route: Partial<ModelRoute> & { image?: Partial<ModelRoute> }): RouteError | null {
  const path = `models.byIntent['${intent}']`;
  // AN IMAGE MODEL IS NAMED IN THE ROUTE'S IMAGE PART (ADR-064 decision C), never as its text model.
  if (isImageModelKey(route.primary) || isImageModelKey(route.fallback)) {
    const model = (isImageModelKey(route.primary) ? route.primary : route.fallback) as string;
    return {
      code: 'image_model_as_text', path, params: { intent, model },
      message: `models.byIntent['${intent}'] names the image model '${model}' as its text model; name it as models.byIntent['${intent}'].image.primary`,
    };
  }
  if (route.image) {
    if (!isImageModelKey(route.image.primary)) {
      return { code: 'image_part_not_image', path: `${path}.image.primary`, params: { intent, part: 'primary' }, message: `models.byIntent['${intent}'].image.primary must be an image model` };
    }
    if (route.image.fallback && !isImageModelKey(route.image.fallback)) {
      return { code: 'image_part_not_image', path: `${path}.image.fallback`, params: { intent, part: 'fallback' }, message: `models.byIntent['${intent}'].image.fallback must be an image model` };
    }
    if (route.image.fallback && route.image.fallback === route.image.primary) {
      return {
        code: 'fallback_is_primary', path: `${path}.image.fallback`, params: { intent, model: route.image.fallback },
        message: `models.byIntent['${intent}'].image names '${route.image.fallback}' as both primary and fallback; an image route's fallback must be a different model`,
      };
    }
  }
  const fallback = route.fallback;
  if (!route.primary || !fallback || fallback === 'default') return null;
  if (isImageModelKey(route.primary) !== isImageModelKey(fallback)) {
    return {
      code: 'route_kinds_mixed', path: `${path}.fallback`, params: { intent, primary: route.primary, fallback },
      message: `models.byIntent['${intent}'] mixes kinds: its primary '${route.primary}' is a${isImageModelKey(route.primary) ? 'n image' : ' text'} model `
        + `and its fallback '${fallback}' is a${isImageModelKey(fallback) ? 'n image' : ' text'} model; a fallback must be the same kind as its primary`,
    };
  }
  if (isImageModelKey(route.primary) && fallback === route.primary) {
    return {
      code: 'fallback_is_primary', path: `${path}.fallback`, params: { intent, model: fallback },
      message: `models.byIntent['${intent}'] names '${fallback}' as both primary and fallback; an image route's fallback must be a different model`,
    };
  }
  return null;
}

/** The message of {@link routeKindErrorDetail}, or null when the route is sound. */
export function routeKindError(intent: string, route: Partial<ModelRoute> & { image?: Partial<ModelRoute> }): string | null {
  return routeKindErrorDetail(intent, route)?.message ?? null;
}
