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
import {
  type TaskStateMachine,
  type TerminalKind,
  type AwaitedPartyRef,
  DEFAULT_TASK_STATE_MACHINES,
  validateTaskStateMachines,
} from './task-state-machines.js';

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
  /** Lowercase substrings for the no-LLM keyword classifier (a keyword-mode profile / LLM-classifier failure). */
  keywords: string[];
  /** How a turn of this intent is delivered. Domain intents are usually PLACEHOLDER_UPDATE
   *  (one generated reply, updated in place) or TASK_MULTI_STEP (a tracked multi-step task). */
  delivery: IntentDeliveryClass;
  /** Optional per-intent response shaping. Forwarded in the event to
   *  the processor (D2). Omitted ⇒ the processor's default budget. `maxTokens` is clamped to the
   *  per-classification ceiling and the reasoning-turn floor at resolve time. */
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
  /**
   * Task state machines keyed by taskType (SPEC-TASK-STATE-TRANSITIONS §4). Optional and
   * per-deployment: absent ⇒ the platform DEFAULT_TASK_STATE_MACHINES. A deployment may override
   * a subset; the accessor (`taskStateMachines`) merges its overrides over the defaults so the
   * work-item types (place_item, action_item) survive a pack that only tunes the domain machines.
   */
  machines?: Record<string, TaskStateMachine>;
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
      // Reserve this for STRUCTURED / BULK extraction that is genuinely multi-step work (a table, list,
      // spreadsheet, or dataset). A request for a SINGLE fact or figure the assistant can state in a
      // sentence ("what was our Q2 ARR?") is GENERAL, answered inline — routing it to a TASK_MULTI_STEP
      // defers the answer behind a task instead of just stating it (the premium-ARR failure mode). See
      // docs/design/decisions/018-company-context-tool-and-extraction-boundary.md.
      description:
        'User wants to extract or export MULTIPLE records or STRUCTURED data — a table, list, spreadsheet, ' +
        'or dataset — from sources, databases, APIs, or documents (e.g. "extract the churn-risk accounts as a ' +
        'table", "export the roster"). A request for a SINGLE fact or figure that can be answered in a ' +
        'sentence (e.g. "what was our Q2 ARR?") is GENERAL, not data_extraction.',
      keywords: [
        'extract', 'export data', 'as a table', 'as a spreadsheet', 'as a csv',
        'list all', 'pull the', 'data from', 'dataset',
        // Bulk-retrieval verbs scoped with "the" so they match "retrieve the logs" / "fetch the
        // records" (structured/bulk) but NOT a single-fact question ("what was our Q2 ARR?"), keeping
        // the ADR-018 boundary (docs/design/decisions/018-company-context-tool-and-extraction-boundary.md).
        'query the', 'fetch the', 'retrieve the',
      ],
      delivery: 'TASK_MULTI_STEP',
    },
    {
      // Image generation as a NORMAL capability + intent (DESIGN-MULTI-ASSISTANT-TURN-ENGINE,
      // "image generation must become a normal capability"): an assistant whose profile grants an
      // image model produces an IMAGE on a request that asks for one — in a battle or not. Declared
      // BEFORE report_generation so its keywords WIN for an image ask: "generate an image" contains
      // report_generation's 'generate', and classifyByPackKeywords returns the first-listed match.
      // delivery PLACEHOLDER_UPDATE (one generated reply, updated in place — not a multi-step task).
      key: 'image_generation',
      description:
        'User wants the assistant to GENERATE, create, draw, or produce an IMAGE / picture / ' +
        'illustration / logo from a text description (e.g. "generate an image of a mountain lake", ' +
        '"draw a robot", "make a picture of ..."). NOT a request to analyze or describe an existing image.',
      keywords: [
        'generate an image', 'create an image', 'make an image', 'draw ',
        'generate a picture', 'make a picture', 'an image of', 'picture of', 'image of a',
      ],
      delivery: 'PLACEHOLDER_UPDATE',
    },
    {
      // Code generation is its own intent, not a flavour of report_generation. It has a dedicated
      // RouteKey in the model strategy (and the admin Experiments tab offers it), which is only
      // reachable if the classifier can actually emit it — `IntentDef.key` doubles as the
      // INTENT_ROUTE_STRATEGY key. Without this entry a deployment could pin a code-specialist
      // model and never have it selected.
      //
      // Declared BEFORE report_generation for the same reason image_generation is: "generate a
      // TypeScript function" contains report_generation's very broad 'generate', and
      // classifyByPackKeywords returns the FIRST-listed match.
      //
      // delivery PLACEHOLDER_UPDATE, deliberately not TASK_MULTI_STEP: a code request has a direct
      // answer, and deferring it behind a tracked task is the ADR-018 failure mode (the user waits
      // on a task for something the assistant could simply have written).
      key: 'code_generation',
      description:
        'User wants the assistant to WRITE or MODIFY code — a function, class, script, query, ' +
        'configuration, or test — in a programming language (e.g. "write a function that reverses a ' +
        'string", "implement a retry wrapper", "refactor this to use async/await"). Diagnosing a ' +
        'failure or an error message is guided_troubleshooting, not code_generation.',
      // Deliberately few. The classifier is the LLM — it reads `description`; these run only when
      // the LLM classifier is unavailable or a profile opts into keyword mode. A long keyword list
      // buys nothing on the shipped path and costs real bytes against the SSM Standard-tier
      // parameter limit (4096 chars) that the seeded per-deployment packs live inside.
      keywords: ['write a function', 'write code', 'implement a', 'unit test', 'refactor this'],
      delivery: 'PLACEHOLDER_UPDATE',
    },
    {
      // The review counterpart. Separate from code_generation because the useful model for critique
      // is not always the useful model for authoring, which is exactly what a per-intent route is
      // for. Also declared before report_generation ('review' co-occurs with 'summary'/'analysis').
      key: 'code_review',
      description:
        'User wants the assistant to REVIEW, critique, or assess existing code they have supplied — ' +
        'correctness, style, security, or performance (e.g. "review this pull request", "is this ' +
        'function correct?", "what is wrong with this code?"). Writing new code is code_generation; ' +
        'diagnosing a runtime failure is guided_troubleshooting.',
      keywords: ['code review', 'review this code', 'review my code', 'critique this code'],
      delivery: 'PLACEHOLDER_UPDATE',
    },
    {
      // The last RouteKey without an intent. Like the code intents, `strategic_analysis` is a route
      // in the model strategy and a selectable option in the admin Experiments tab, so leaving it
      // unclassifiable made it dead config.
      //
      // KEYWORDS ARE DELIBERATELY NARROW. report_generation already owns the bare word 'analysis',
      // and the existing suite sends "Analyze the pros and cons of microservices vs monolithic" -
      // which is a report_generation TASK_MULTI_STEP turn today. Claiming generic analysis phrasing
      // here would silently re-route those turns to a different delivery class, changing behaviour
      // for every deployment that never asked for it. These keywords name STRATEGY work
      // specifically; broadening them is a deliberate product decision, not a naming tidy-up.
      key: 'strategic_analysis',
      description:
        'User wants strategic or business judgement — a competitive or market assessment, a business ' +
        'case, a go-to-market or roadmap decision, a build-vs-buy call (e.g. "what is our competitive ' +
        'position", "make the business case for X"). A factual write-up or formatted document is ' +
        'report_generation; a technical comparison is general.',
      keywords: ['strategic', 'competitive analysis', 'business case', 'go-to-market'],
      delivery: 'PLACEHOLDER_UPDATE',
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
  // kept; anything else is dropped (not silently lost). Clamping to classification ceiling / reasoning
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

const TERMINAL_KINDS: readonly TerminalKind[] = ['success', 'failure', 'handoff'];

/**
 * Coerce and validate the optional `machines` block from a parsed pack object. Never throws — a
 * malformed machines block logs LOUDLY and yields `undefined` so the deployment falls back to the
 * DEFAULT machines rather than shipping an unreachable state (SPEC-TASK-STATE-TRANSITIONS §4), while
 * intent classification is never taken down with it.
 */
function coerceMachinesConfig(raw: unknown): Record<string, TaskStateMachine> | undefined {
  if (raw === undefined) return undefined;
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('machines must be an object keyed by taskType');
    }
    const out: Record<string, TaskStateMachine> = {};
    for (const [name, m] of Object.entries(raw as Record<string, unknown>)) {
      if (!m || typeof m !== 'object') throw new Error(`machine "${name}" is not an object`);
      const mr = m as Record<string, unknown>;
      if (typeof mr.initial !== 'string' || !mr.initial.trim()) throw new Error(`machine "${name}" has no initial state`);
      if (!mr.states || typeof mr.states !== 'object' || Array.isArray(mr.states)) {
        throw new Error(`machine "${name}" has no states object`);
      }
      const states: Record<string, TaskStateMachine['states'][string]> = {};
      for (const [stateName, sd] of Object.entries(mr.states as Record<string, unknown>)) {
        if (!sd || typeof sd !== 'object') throw new Error(`machine "${name}" state "${stateName}" is not an object`);
        const sr = sd as Record<string, unknown>;
        const transitions = Array.isArray(sr.transitions)
          ? sr.transitions.filter((t): t is string => typeof t === 'string')
          : (() => { throw new Error(`machine "${name}" state "${stateName}" transitions must be an array`); })();
        const terminal =
          typeof sr.terminal === 'string' && (TERMINAL_KINDS as readonly string[]).includes(sr.terminal)
            ? (sr.terminal as TerminalKind)
            : undefined;
        // WHO THE STEP AWAITS, in either accepted form (SPEC-TASK-STATE-TRANSITIONS §12.6). Carried
        // through as declared rather than normalized here: `awaitedPartyOf` is the single reader, and
        // rewriting a pack's declaration on the way in would make the stored pack and the merged view
        // two different documents. An unknown party is left to `validateTaskStateMachines` below, which
        // refuses the whole block loudly rather than admitting a reference nothing resolves.
        const awaits = sr.awaits && typeof sr.awaits === 'object' && !Array.isArray(sr.awaits)
          ? (sr.awaits as AwaitedPartyRef)
          : undefined;
        // THE THREE BEHAVIOURAL FLAGS, CARRIED. Dropping them made a pack-declared machine a
        // different document from the one its author wrote, and silently: `delivers` decides whether
        // a deliverable is packaged as a file, so a pack-declared document workflow shipped every
        // report as chat text - exactly the defect `delivers` was introduced to remove, reappearing
        // one layer up in the coercion. `resolvedByOneResponse` and `requires` are both rendered into
        // the turn's prompt, so a pack lost the "one answer completes this" and "this step needs"
        // instructions it declared.
        //
        // AND CARRYING THEM IS WHAT MAKES VALIDATION MEAN ANYTHING HERE. The rules below run on the
        // object this loop builds, so while these fields were stripped, "requires needs an awaited
        // party" and "requires cannot coexist with resolvedByOneResponse" passed VACUOUSLY for every
        // pack: the validator was handed a state that no longer declared the thing it checks. A pack
        // that declares an invalid combination is now refused loudly, whole-block, like any other
        // invalid pack - which is the point. A block that reverts to the platform defaults is a
        // deployment the operator can diagnose; a block quietly missing the field that decides
        // delivery is not.
        const requires = Array.isArray(sr.requires)
          ? sr.requires.filter((r): r is string => typeof r === 'string')
          : undefined;
        states[stateName] = {
          transitions,
          ...(terminal ? { terminal } : {}),
          ...(awaits ? { awaits } : {}),
          ...(sr.awaitsUser === true ? { awaitsUser: true } : {}),
          ...(requires?.length ? { requires } : {}),
          ...(sr.resolvedByOneResponse === true ? { resolvedByOneResponse: true } : {}),
          ...(sr.delivers === true ? { delivers: true } : {}),
          ...(typeof sr.prompt === 'string' ? { prompt: sr.prompt } : {}),
          ...(typeof sr.placeholder === 'string' ? { placeholder: sr.placeholder } : {}),
        };
      }
      out[name] = { initial: mr.initial.trim(), states };
    }
    // Validate the merged view the runtime will actually use, so a partial override cannot leave a
    // default machine shadowed by an unreachable one.
    const merged = { ...DEFAULT_TASK_STATE_MACHINES, ...out };
    validateTaskStateMachines(merged);
    return out;
  } catch (err) {
    console.error('[IntentPack] Invalid `machines` block — falling back to DEFAULT machines:', err);
    return undefined;
  }
}

/**
 * The active intent pack. Parsed once from `ASSISTANT_INTENT_PACK` (a JSON array of IntentDef, or
 * an object `{ intents: [...], machines?: {...}, extends?: 'default' }`). Any parse/shape error logs
 * and falls back to DEFAULT — a bad pack must never break classification.
 *
 * `extends: 'default'` inherits the platform taxonomy and adds to it; without it the pack REPLACES
 * the taxonomy outright, which stays the default so a deployment can still remove an intent.
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
    const declared = (list as unknown[])
      .map(coerceIntentDef)
      .filter((d): d is IntentDef => d !== null);
    if (declared.length === 0) throw new Error('no valid intents after coercion');
    // `extends: 'default'` — carry only what this deployment ADDS, and inherit the platform taxonomy
    // for the rest. Opt-in, so a pack without it REPLACES exactly as before: that is what lets a
    // deployment drop a default intent it does not want, and changing it silently would take that away.
    //
    // Why it exists: a per-deployment pack lives in ONE SSM Standard-tier parameter (4096 characters),
    // and copying the platform defaults into it spent 3183 of them before a deployment expressed
    // anything of its own. Three classifications each paid that toll, and the largest was 356 over the
    // limit - which surfaced as the seed dying part way through, after the earlier classifications had
    // already been written. Inheriting instead of copying is what makes the budget stop being the
    // binding constraint on how much a deployment can say.
    //
    // Own intents come FIRST, then any default whose key was not overridden - the same order the
    // seeder used when it inlined them, so the classifier prompt is unchanged for a migrated pack.
    const extendsDefault = !Array.isArray(parsed)
      && (parsed as Record<string, unknown>)?.extends === 'default';
    const intents = extendsDefault
      ? [...declared, ...DEFAULT_INTENT_PACK.intents.filter((d) => !declared.some((o) => o.key === d.key))]
      : declared;
    const machines = Array.isArray(parsed)
      ? undefined
      : coerceMachinesConfig((parsed as Record<string, unknown>)?.machines);
    cachedPack = machines ? { intents, machines } : { intents };
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
 * override here. The AgentHandler forwards this in the event; the processor clamps it to the classification
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
 * Clamp a requested per-intent `maxTokens` to the classification ceiling and reasoning floor (P3, pure). The
 * forwarded per-intent budget WINS but can never exceed the classification ceiling; absent ⇒ the ceiling
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
 * The task state machines for the active pack (SPEC-TASK-STATE-TRANSITIONS §4). The deployment's
 * declared machines are merged OVER the platform defaults, so a pack that overrides only the domain
 * machines keeps the work-item defaults (place_item, action_item). Absent ⇒ the defaults verbatim.
 */
export function taskStateMachines(
  pack: IntentPack = getIntentPack(),
): Record<string, TaskStateMachine> {
  return pack.machines ? { ...DEFAULT_TASK_STATE_MACHINES, ...pack.machines } : DEFAULT_TASK_STATE_MACHINES;
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
