/**
 * WHAT ONE ASSISTANT'S SESSION MAY REACH, INSIDE ITS CLASSIFICATION AND ROLE (tenet P4).
 *
 * The acting role is the classification's boundary and its `role` tag is the assistant role's. Two
 * assistants of one classification and role used to reach exactly the same data. The vend now narrows
 * each session to what the assistant's approved definition declares, by passing session policies: the
 * effective permission is the acting role, its boundary and these policies together, so a session can
 * only ever narrow, never widen.
 *
 * The policies are a bounded catalog of customer-managed policies the classification stack creates, one
 * per edge (`AssistantGrant-{classification}-{edge}`). This module decides WHICH edges a definition
 * selects; the stack decides what each edge grants. Keeping the decision a pure function means the vend,
 * the tests and a reviewer read the same rule.
 *
 * WHAT IS NARROWED:
 * - company context (`context/`), selected by the `company-docs` context source or the
 *   `load_company_context` tool;
 * - the platform's self-knowledge (`platform-knowledge/`), selected by `load_platform_info`;
 * - deployment telemetry (CloudWatch reads), selected by `read_deployment_health` and still conditioned
 *   on the `ops` role tag by the acting role;
 * - text models: the classification's routed set (its intent strategy, its default and the utility
 *   model, computed at synth) plus what the definition and a running experiment variant name;
 * - image models: every image route's primary and fallback (`image-route.ts`), and a variant's.
 *
 * Everything else a turn does (the conversation, turn state, attachments, invokes) is in `base`, which
 * every session gets.
 *
 * A DEFINITION THAT DECLARES NOTHING SELECTS EVERYTHING. The compiled seed leaves `tools` and `models`
 * unset, which the processor reads as "all tools" and "the routed set", so the session matches.
 */
import { imageModelKeysOf, textRouteModelKeysOf, type ImageRouteSource } from './image-route.js';

/**
 * A ROUTE THAT ONLY SPEAKS (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1c). A service that posts as an
 * assistant outside a turn (a notice, a duel's placeholder, a join message) records its decision under an id
 * with this prefix, and the vend gives that session exactly one edge, `speak`: the messaging calls those
 * services make, and nothing a turn reaches. The prefix is what IAM reads: a shared service may write only
 * keys that start with it (`dynamodb:LeadingKeys`), so it can never obtain a turn's session.
 */
export const SPEAK_ROUTE_PREFIX = 'speak-';
export const SPEAK_EDGE: GrantEdge = 'speak';
/**
 * The messaging calls a speaking service makes on its session: post, read back and edit its own notice,
 * and, for share's join recap, list who is in the room and read its history. Every one is still bearer-
 * pinned to the assistant's bot and limited to its classification's rooms by the acting role. Pinned by a
 * test over every speak client.
 *
 * `DescribeChannel` is the classification-boundary read: the router reads the conversation as the
 * assistant before it speaks there (`resolveChannelClassification`), so a router that posts on a speak
 * route needs it, or every first turn in a container is refused at the boundary. Read-only, and the acting
 * role already allows it on its own classification's conversations.
 */
export const SPEAK_ACTIONS = [
  'chime:SendChannelMessage', 'chime:UpdateChannelMessage', 'chime:GetChannelMessage',
  'chime:ListChannelMessages', 'chime:ListChannelMemberships', 'chime:DescribeChannel',
] as const;

export function isSpeakRoute(routeId: string): boolean {
  return typeof routeId === 'string' && routeId.startsWith(SPEAK_ROUTE_PREFIX);
}

/**
 * THE ROUTER'S OWN SESSION for a turn: the decision it records under this prefix before the turn is
 * classified, and uses for the conversation calls it makes as the routed assistant (the placeholder, a
 * refusal, a handover notice). The model and data run on the processor's session, under the turn's own
 * id, which carries any experiment variant.
 */
export const ROUTER_ROUTE_PREFIX = 'route-';

export function isRouterRoute(routeId: string): boolean {
  return typeof routeId === 'string' && routeId.startsWith(ROUTER_ROUTE_PREFIX);
}

/** IAM's limit on managed policy ARNs passed to one `AssumeRole`. */
export const MAX_SESSION_POLICIES = 10;

export type GrantEdge = string;

/** The fields of a definition that decide reach. Read inline from SSM; bodies offloaded to S3 never do. */
export interface GrantDefinition {
  modelKey?: string;
  models?: {
    default?: string;
    classifier?: string;
    /** Each route's text model, image part and step overrides (ADR-064), every model of which the narrowing walks. */
    byIntent?: Record<string, { primary?: string; fallback?: string; image?: { primary: string; fallback?: string }; steps?: Record<string, { primary: string; fallback?: string }> } | undefined>;
    /** Retired and refused at write; walked so a stored value never widens a session it cannot reach. */
    image?: string;
  };
  tools?: string[];
  contextSources?: string[];
}

/** What a running experiment variant adds for this turn, recorded by the router in the routing record. */
export interface GrantVariant {
  modelKeys?: string[];
  imageModelKey?: string;
  /** A `profileRef` variant runs its whole version, so its definition replaces the assistant's. */
  definition?: GrantDefinition;
}

export interface GrantCatalog {
  /** Every edge the classification stack created, by name. */
  edges: ReadonlySet<GrantEdge>;
  /** Text model keys every turn may need whatever the definition says: the classification's routed set. */
  alwaysModelKeys: readonly string[];
  /**
   * The image model the SEED preselects, granted only when no definition can be read and the seed is
   * served. Empty for a classification the catalog allows no image model. A definition that names no
   * image model gets none: no default an assistant did not choose.
   */
  defaultImageModelKey: string;
}

const SENTINEL = 'default';

function declaredModelKeys(def: GrantDefinition): string[] {
  const keys: string[] = [];
  const add = (k?: string) => { if (k && k !== SENTINEL) keys.push(k); };
  add(def.models?.default ?? def.modelKey);
  add(def.models?.classifier);
  // Every text model a route names, its step overrides included (ADR-064): an image model is an image edge (`grantEdgesFor`).
  for (const k of textRouteModelKeysOf(def.models as ImageRouteSource | undefined)) add(k);
  return keys;
}

/**
 * The edges a definition selects, as names. `definition` null means none could be read and the seed
 * is served, which selects everything.
 */
export function grantEdgesFor(
  definition: GrantDefinition | null,
  variant: GrantVariant | undefined,
  catalog: GrantCatalog,
): GrantEdge[] {
  const def = variant?.definition ?? definition;
  const has = (e: GrantEdge) => catalog.edges.has(e);
  const edges = new Set<GrantEdge>(['base']);
  // The platform utility model, for platform utility work (the first-turn title) on every session, whatever the
  // definition selects. Added before the model budget below, so it counts against IAM's limit.
  if (has('utility')) edges.add('utility');

  const allTools = !def || def.tools === undefined;
  const tools = new Set(def?.tools ?? []);
  const sources = def?.contextSources;
  if (allTools || tools.has('load_company_context') || sources === undefined || sources.includes('company-docs')) edges.add('context');
  if (allTools || tools.has('load_platform_info')) edges.add('platform');
  if (allTools || tools.has('read_deployment_health')) edges.add('telemetry');

  // Every image model the definition names: each image route's primary and fallback, and the legacy field.
  const imageKeys = def ? imageModelKeysOf(def.models as ImageRouteSource | undefined) : [catalog.defaultImageModelKey];
  for (const k of [...imageKeys, variant?.imageModelKey]) {
    if (k && has(`image-${k}`)) edges.add(`image-${k}`);
  }

  // TEXT MODELS. Only keys this classification has an edge for: a disallowed pick is degraded to the
  // classification default by the resolver, and the default is in the routed set.
  const declaresModels = !!def && (def.models !== undefined || def.modelKey !== undefined);
  const modelKeys = new Set<string>(catalog.alwaysModelKeys);
  if (def && declaresModels) for (const k of declaredModelKeys(def)) modelKeys.add(k);
  for (const k of variant?.modelKeys ?? []) modelKeys.add(k);
  const modelEdges = [...modelKeys].map((k) => `models-${k}`).filter(has);
  const everyModel = [...catalog.edges].filter((e) => e.startsWith('models-') && e !== 'models-all' && e !== 'models-cn');
  // models-all when nothing narrows it, when the set already is every model, or when the edges would
  // pass IAM's limit on session policies. Each of those grants exactly the classification's boundary.
  const budget = MAX_SESSION_POLICIES - edges.size - (has('models-cn') ? 1 : 0);
  if (!declaresModels || modelEdges.length >= everyModel.length || modelEdges.length > budget) {
    edges.add('models-all');
  } else {
    for (const e of modelEdges) edges.add(e);
  }
  if (has('models-cn')) edges.add('models-cn');
  return [...edges].filter((e) => e === 'base' || has(e));
}

/** The reach-deciding fields of a definition-shaped value, or undefined when it has none. */
export function grantDefinitionOf(value: unknown): GrantDefinition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const out: GrantDefinition = {};
  if (typeof v.modelKey === 'string') out.modelKey = v.modelKey;
  if (v.models && typeof v.models === 'object') out.models = v.models as GrantDefinition['models'];
  if (Array.isArray(v.tools)) out.tools = v.tools.filter((t): t is string => typeof t === 'string');
  if (Array.isArray(v.contextSources)) out.contextSources = v.contextSources.filter((t): t is string => typeof t === 'string');
  return out;
}

/** What a turn's experiment or battle variant adds, as the router records it; undefined when there is none. */
export function variantGrantOf(args: { modelKey?: string; imageModelKey?: string; profile?: unknown }): GrantVariant | undefined {
  const definition = args.profile ? grantDefinitionOf(args.profile) : undefined;
  if (!args.modelKey && !args.imageModelKey && !definition) return undefined;
  return {
    ...(args.modelKey ? { modelKeys: [args.modelKey] } : {}),
    ...(args.imageModelKey ? { imageModelKey: args.imageModelKey } : {}),
    ...(definition ? { definition } : {}),
  };
}
