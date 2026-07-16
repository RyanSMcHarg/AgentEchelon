/**
 * Intent pack — the per-deployment intent taxonomy (configurable, like ASSISTANT_SYSTEM_PROMPT).
 *
 * AgentEchelon is generic; the *domain* intents an assistant recognises belong to the deployment,
 * not the platform. A generic enterprise assistant cares about troubleshooting / data-extraction /
 * report-generation; a different vertical (legal, healthcare, field-service, …) cares about an
 * entirely different set of domain intents. Baking either set into the platform
 * is wrong — so the taxonomy is data, supplied per deployment via `ASSISTANT_INTENT_PACK` (a JSON
 * array of intent definitions). Absent/invalid ⇒ the DEFAULT pack, which mirrors the historical
 * enterprise intents so existing deployments are unchanged.
 *
 * Three UNIVERSAL intents — greeting, acknowledgment, general — are domain-independent and always
 * present; a pack only declares its *domain* intents. The classifier (intent-classifier.ts) builds
 * its LLM category list + keyword fallback from the pack; delivery-options.ts maps a classified
 * intent key → delivery option through the pack. The resolved intent key is also a RoutingContext
 * signal (rule 3, INTENT_ROUTE_STRATEGY) — so a deployment's own intents drive model resolution.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/** The three intents every assistant has, regardless of domain. Their string values are stable
 *  (consumers compare against `IntentType.GREETING` etc.). */
export const UNIVERSAL_INTENT_KEYS = ['greeting', 'acknowledgment', 'general'] as const;
export type UniversalIntentKey = (typeof UNIVERSAL_INTENT_KEYS)[number];

export type IntentDeliveryClass = 'DIRECT' | 'PLACEHOLDER_UPDATE' | 'TASK_MULTI_STEP';

export interface IntentDef {
  /** Stable key — the classified intent value + INTENT_ROUTE_STRATEGY key (e.g. 'report_generation'). */
  key: string;
  /** One line the LLM classifier sees describing when this intent applies. */
  description: string;
  /** Lowercase substrings for the no-LLM keyword fallback (basic tier / LLM failure). */
  keywords: string[];
  /** How a turn of this intent is delivered. Domain intents are usually PLACEHOLDER_UPDATE
   *  (one generated reply, updated in place) or TASK_MULTI_STEP (a tracked multi-step task). */
  delivery: IntentDeliveryClass;
  /** Optional per-intent response shaping. Forwarded in the event to
   *  the processor (D2). Omitted ⇒ the processor's default budget. `maxTokens` is clamped to the
   *  per-tier ceiling and the reasoning-turn floor at resolve time. */
  maxTokens?: number;
  verbosity?: ResponseVerbosity;
}

export type ResponseVerbosity = 'tight' | 'normal' | 'long';

/** Per-intent response shaping resolved for a classified intent (forwarded in the event, D2). */
export interface ResponseSettings {
  maxTokens?: number;
  verbosity?: ResponseVerbosity;
}

export interface IntentPack {
  /** Domain intents only — the universal three are added implicitly. */
  intents: IntentDef[];
}

/**
 * DEFAULT pack — the historical enterprise taxonomy. Keeping it as the default makes the pack
 * refactor a no-op for any deployment that doesn't set `ASSISTANT_INTENT_PACK` (back-compat
 * invariant, covered by intent-pack.test.ts).
 */
export const DEFAULT_INTENT_PACK: IntentPack = {
  intents: [
    {
      key: 'guided_troubleshooting',
      description:
        'User needs help diagnosing or fixing a problem, error resolution, step-by-step debugging, system issues',
      keywords: [
        'error', 'broken', 'not working', 'issue', 'problem', 'bug',
        'fix', 'troubleshoot', 'debug', 'crash', 'fail', 'help me with',
      ],
      delivery: 'TASK_MULTI_STEP',
    },
    {
      key: 'data_extraction',
      description:
        'User wants to extract, transform, query, or pull specific data from sources, databases, APIs, or documents',
      keywords: [
        'extract', 'pull data', 'query', 'get data', 'fetch',
        'export data', 'data from', 'retrieve', 'look up',
      ],
      delivery: 'TASK_MULTI_STEP',
    },
    {
      key: 'report_generation',
      description:
        'User wants to create a report, summary, analysis document, dashboard data, or formatted output',
      keywords: [
        'report', 'generate', 'summary', 'analysis', 'dashboard',
        'create a report', 'compile', 'document', 'format',
      ],
      delivery: 'TASK_MULTI_STEP',
    },
  ],
};

let cachedPack: IntentPack | null = null;
let cachedRaw: string | undefined;

// The pack JSON can exceed AWS Lambda's 4 KB total env-var budget (the historical home for small
// config like ASSISTANT_SYSTEM_PROMPT). So a deployment may instead point `ASSISTANT_INTENT_PACK_PARAM`
// at an SSM parameter holding the JSON; the handler hydrates it once at cold start. Hydrated value
// takes precedence over the inline `ASSISTANT_INTENT_PACK` env (which remains valid for small packs).
let ssmPackRaw: string | undefined;
let ssmHydrated = false;

/** The active raw pack JSON: SSM-hydrated value if present, else the inline env var. */
function rawPackSource(): string | undefined {
  return ssmPackRaw ?? process.env.ASSISTANT_INTENT_PACK?.trim() ?? undefined;
}

/**
 * Hydrate the pack from SSM once (no-op if `ASSISTANT_INTENT_PACK_PARAM` is unset or already done).
 * Call early in the handler, before any classification. A fetch failure logs and leaves the env /
 * DEFAULT path intact — a transient SSM hiccup must never break classification.
 */
export async function hydrateIntentPackFromSsm(
  deps?: { getParameter: (name: string) => Promise<string | undefined> },
): Promise<void> {
  if (ssmHydrated) return;
  ssmHydrated = true;
  const param = process.env.ASSISTANT_INTENT_PACK_PARAM?.trim();
  if (!param) return;
  try {
    let value: string | undefined;
    if (deps) {
      value = await deps.getParameter(param);
    } else {
      const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });
      const resp = await ssm.send(new GetParameterCommand({ Name: param }));
      value = resp.Parameter?.Value;
    }
    if (value && value.trim()) {
      ssmPackRaw = value.trim();
      cachedPack = null; // force re-parse with the hydrated value
      cachedRaw = undefined;
    }
  } catch (err) {
    console.error('[IntentPack] SSM hydrate failed; using env/DEFAULT:', err);
  }
}

/** Validate one entry parsed from JSON into an IntentDef (or null to drop it). */
function coerceIntentDef(raw: unknown): IntentDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key.trim() : '';
  if (!key || (UNIVERSAL_INTENT_KEYS as readonly string[]).includes(key)) return null; // skip empty / universal overrides
  const description = typeof r.description === 'string' ? r.description.trim() : '';
  const keywords = Array.isArray(r.keywords)
    ? r.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.toLowerCase())
    : [];
  const delivery: IntentDeliveryClass =
    r.delivery === 'DIRECT' || r.delivery === 'TASK_MULTI_STEP' ? r.delivery : 'PLACEHOLDER_UPDATE';
  // Per-intent response shaping (optional). A positive integer maxTokens + a known verbosity are
  // kept; anything else is dropped (not silently lost). Clamping to tier ceiling / reasoning
  // floor happens at resolve time in the processor, not here.
  const maxTokens =
    typeof r.maxTokens === 'number' && Number.isFinite(r.maxTokens) && r.maxTokens > 0
      ? Math.floor(r.maxTokens)
      : undefined;
  const verbosity: ResponseVerbosity | undefined =
    r.verbosity === 'tight' || r.verbosity === 'normal' || r.verbosity === 'long' ? r.verbosity : undefined;
  return {
    key,
    description,
    keywords,
    delivery,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(verbosity !== undefined ? { verbosity } : {}),
  };
}

/**
 * The active intent pack. Parsed once from `ASSISTANT_INTENT_PACK` (a JSON array of IntentDef, or
 * an object `{ intents: [...] }`). Any parse/shape error logs and falls back to DEFAULT — a bad
 * pack must never break classification.
 */
export function getIntentPack(): IntentPack {
  const raw = rawPackSource();
  if (cachedPack && cachedRaw === raw) return cachedPack;
  cachedRaw = raw;

  if (!raw) {
    cachedPack = DEFAULT_INTENT_PACK;
    return cachedPack;
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.intents) ? parsed.intents : null;
    if (!list) throw new Error('expected an array or { intents: [...] }');
    const intents = (list as unknown[])
      .map(coerceIntentDef)
      .filter((d): d is IntentDef => d !== null);
    if (intents.length === 0) throw new Error('no valid intents after coercion');
    cachedPack = { intents };
  } catch (err) {
    console.error('[IntentPack] Invalid ASSISTANT_INTENT_PACK — falling back to DEFAULT:', err);
    cachedPack = DEFAULT_INTENT_PACK;
  }
  return cachedPack;
}

/** Test seam — reset the memoised pack + SSM hydration (e.g. between unit tests that set the env). */
export function _resetIntentPackCache(): void {
  cachedPack = null;
  cachedRaw = undefined;
  ssmPackRaw = undefined;
  ssmHydrated = false;
}

/** The classifier's category block (domain intents only — universal three are added by the caller). */
export function intentPackCategoryLines(pack: IntentPack = getIntentPack()): string {
  return pack.intents.map((d) => `- ${d.key.toUpperCase()}: ${d.description}`).join('\n');
}

/** Keyword fallback: first domain intent whose keyword appears in the message, else null. */
export function classifyByPackKeywords(message: string, pack: IntentPack = getIntentPack()): string | null {
  const m = message.toLowerCase();
  for (const d of pack.intents) {
    if (d.keywords.some((kw) => m.includes(kw))) return d.key;
  }
  return null;
}

/** Delivery class for an intent key (universal keys handled here; domain keys via the pack). */
export function deliveryClassForIntent(intent: string, pack: IntentPack = getIntentPack()): IntentDeliveryClass {
  if (intent === 'greeting' || intent === 'acknowledgment') return 'DIRECT';
  if (intent === 'general') return 'PLACEHOLDER_UPDATE';
  const def = pack.intents.find((d) => d.key === intent);
  return def?.delivery ?? 'PLACEHOLDER_UPDATE';
}

/**
 * Per-intent response shaping for a classified intent key (P3 / D2). Domain intents read their
 * `maxTokens`/`verbosity` from the pack; universal keys (greeting/acknowledgment/general) have no
 * override here. The AgentHandler forwards this in the event; the processor clamps it to the tier
 * ceiling + reasoning floor. Empty object ⇒ the processor uses its default budget.
 */
export function responseSettingsForIntent(
  intent: string,
  pack: IntentPack = getIntentPack(),
): ResponseSettings {
  const def = pack.intents.find((d) => d.key === intent);
  if (!def) return {};
  return {
    ...(def.maxTokens !== undefined ? { maxTokens: def.maxTokens } : {}),
    ...(def.verbosity !== undefined ? { verbosity: def.verbosity } : {}),
  };
}

/**
 * Clamp a requested per-intent `maxTokens` to the tier ceiling and reasoning floor (P3, pure). The
 * forwarded per-intent budget WINS but can never exceed the tier ceiling; absent ⇒ the ceiling
 * (today's default). Reasoning turns keep a higher floor (the chain-of-thought eats the budget).
 */
export function clampResponseMaxTokens(
  requested: number | undefined,
  ceiling: number,
  reasoning: boolean,
): number {
  let v = typeof requested === 'number' && requested > 0 ? Math.min(requested, ceiling) : ceiling;
  if (reasoning) v = Math.max(v, 4000);
  return v;
}

/** All valid classified keys for the active pack (universal + domain) — used to validate LLM output. */
export function knownIntentKeys(pack: IntentPack = getIntentPack()): Set<string> {
  return new Set<string>([...UNIVERSAL_INTENT_KEYS, ...pack.intents.map((d) => d.key)]);
}

/**
 * The active pack's raw JSON source (SSM-hydrated value if present, else the inline env), or
 * undefined when neither is set (⇒ the DEFAULT pack). Exposed for config-identity (P4): the raw pack
 * — which already carries each intent's per-intent response settings — is the intentPack component of
 * `configId`. Undefined here means the deployment runs the platform DEFAULT pack.
 */
export function activeIntentPackRaw(): string | undefined {
  return rawPackSource();
}
