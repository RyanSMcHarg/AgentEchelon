/**
 * Intent pack — the per-deployment intent taxonomy (configurable, like ASSISTANT_SYSTEM_PROMPT).
 *
 * AgentEchelon is generic; the *domain* intents an assistant recognizes belong to the deployment,
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
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { coerceAnswerGuidance, answerGuidanceErrors } from './intent-answer.js';
import { unknownTools } from './tool-registry.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import {
  type TaskStateMachine,
  type TerminalKind,
  type AwaitedPartyRef,
  DEFAULT_TASK_STATE_MACHINES,
  isPlatformMachineKey,
  validateTaskStateMachines,
  ADVANCE_TASK_STATE_TOOL_NAME,
  DELIVER_DOCUMENT_TOOL_NAME,
} from './task-state-machines.js';
import { OPEN_NEW_REQUEST_TOOL_NAME } from './new-request-tool.js';
import { sessionClient } from './assistant-session.js';
import { getClassificationPack, putClassificationPack, type BodyStoreDeps, type ProfileBodyRef } from './profile-bodies.js';
import {
  INTENT_NEEDS, DEFAULT_INTENT_PACK, PLATFORM_INTENT_NEEDS, applyExtends, resolveStoredPack,
  type IntentDeliveryClass, type IntentNeed, type IntentDef, type ResponseSettings, type ResponseVerbosity, type IntentPack,
  type StoredIntentDef, type StoredIntentPack,
} from './intent-pack-taxonomy.js';

/** The intents every assistant has, regardless of domain. Their string values are stable
 *  (consumers compare against `IntentType.GREETING` etc.).
 *
 *  `conversation_summary` IS A PLATFORM CAPABILITY, NOT A REPORT. Summarizing or
 *  catching someone up on the conversation they are in is something every assistant does from the
 *  conversation itself, so no pack declares it, none can drop it, and it is never refused
 *  (DESIGN-CAPABILITY-REFUSAL). Without it, "summarize what we discussed" read as `report_generation`
 *  - a deliverable - and an assistant that offers no reports refused it.
 *
 *  `set_preference` AND `show_preferences` ARE PLATFORM CAPABILITIES TOO. A reply
 *  preference describes the person, not the assistant, so every assistant sets and lists them the same
 *  way; the router stores the value (lib/config/reply-preferences.ts) and the assistant says what
 *  happened in its own voice.
 *
 *  `off_topic` IS A LABEL EVERY ASSISTANT NEEDS. A request unrelated to anything the
 *  assistant offers, and not ordinary conversation, was `general` and left to the model to decline, so it
 *  was neither counted nor reliably declined. Classified on its own, the turn is recorded as off topic and
 *  the assistant is told to decline it (intent-answer.ts). */
export const UNIVERSAL_INTENT_KEYS = ['greeting', 'acknowledgment', 'general', 'conversation_summary', 'set_preference', 'show_preferences', 'off_topic'] as const;

/**
 * THE INTENTS THAT LET AN ASSISTANT OPEN AND MANAGE WORK.
 *
 * A pack inherits the platform taxonomy with `extends: 'default'`; WITHOUT it a pack REPLACES the
 * taxonomy. So an operator writing a domain pack and omitting one word produces an assistant that
 * cannot classify a request as work at all: no multi-step task, no queue drain. Nothing fails, and
 * every turn answers as a one-shot reply.
 *
 * THIS IS A CHECK, NOT AN INJECTION, and it was an injection first. Adding the intent to every pack
 * regardless delivered the guarantee and broke a different one: three separate suites assert that a
 * replacing pack contains EXACTLY what it declares, and one asserts that a recipe deployment's
 * classifier prompt carries no troubleshooting line. Those are not incidental - a deployment authoring
 * its own taxonomy is the feature `extends` exists to provide, and injecting into an authored pack is
 * the same silent substitution this codebase has spent its history removing.
 *
 * SO IT IS ENFORCED WHERE THERE IS A WRITE PATH TO ENFORCE IT ON: a pack carried by a profile VERSION
 * goes through `manage-profiles`, and one that replaces the taxonomy without a work-management intent
 * is refused there with a message that names the fix.
 *
 * THE DEPLOYMENT PARAMETER CANNOT BE GUARDED THE SAME WAY, and saying so is better than implying
 * otherwise: `{SSM_ROOT}/assistant/{classification}/assistant-intent-pack` is written by CDK context,
 * by `seed-demo`, or by hand, and none of those is a path this code sits on. For that seam it is an
 * authoring rule (HOW-TO-ADD-OR-MANAGE-A-PROFILE 2.9), not an enforced one.
 */
export const WORK_MANAGEMENT_INTENT_KEYS = ['guided_troubleshooting'] as const;
export type UniversalIntentKey = (typeof UNIVERSAL_INTENT_KEYS)[number];

// THE TAXONOMY ITSELF (the intent definitions, the default pack, the inheritance rule, the needs and the refused
// platform intents) is pure and lives in `intent-pack-taxonomy.ts`, so the console resolves a pack the same way.
export {
  INTENT_NEEDS, DEFAULT_INTENT_PACK, PLATFORM_INTENT_NEEDS, needsOf, refusedPlatformIntents, resolveStoredPack,
  type IntentDeliveryClass, type IntentNeed, type IntentDef, type ResponseVerbosity, type ResponseSettings, type IntentPack,
  type StoredIntentDef, type StoredIntentPack,
} from './intent-pack-taxonomy.js';

let cachedPack: IntentPack | null = null;
let cachedRaw: string | undefined;

// The pack JSON can exceed AWS Lambda's 4 KB total env-var budget (the historical home for small
// config like ASSISTANT_SYSTEM_PROMPT). So a deployment may instead point `ASSISTANT_INTENT_PACK_PARAM`
// at an SSM parameter holding the JSON, or a pointer to the JSON on the body store
// (`classification-packs/{classification}/`); the handler hydrates it once at cold start. Hydrated value
// takes precedence over the inline `ASSISTANT_INTENT_PACK` env (which remains valid for small packs).
let ssmPackRaw: string | undefined;
let ssmHydrated = false;

/** The active raw pack JSON: SSM-hydrated value if present, else the inline env var. */
function rawPackSource(): string | undefined {
  return ssmPackRaw ?? process.env.ASSISTANT_INTENT_PACK?.trim() ?? undefined;
}

/**
 * The pointer a classification's `assistant-intent-pack` parameter holds when its pack is on the body
 * store, or undefined when the value is an inline pack.
 *
 * TWO SHAPES ARE READ, ONE IS WRITTEN. Every writer (CDK, `seed-demo`) puts the body in S3 and the
 * pointer in the parameter, which takes the pack's size off the parameter's value limit. A parameter
 * written before that, or by hand, holds the pack itself, and it keeps reading with no migration. The two
 * cannot be confused: a pack is an array or an object with `intents`, a pointer is `{ ref: { key,
 * configId } }` and nothing else.
 */
export function packPointerOf(value: string | undefined): ProfileBodyRef | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { ref, intents } = parsed as { ref?: { key?: unknown; configId?: unknown }; intents?: unknown };
  if (intents !== undefined || !ref || typeof ref.key !== 'string' || typeof ref.configId !== 'string') return undefined;
  return { key: ref.key, configId: ref.configId };
}

/** The parameter value a writer stores for a pack it has put on the body store. */
export function packPointerValue(ref: ProfileBodyRef): string {
  return JSON.stringify({ ref: { key: ref.key, configId: ref.configId } });
}

/**
 * Write a classification's pack the way every operator-side writer does: the body to the classification's
 * own pack prefix first, then the pointer to `{ssmRoot}/assistant/{classification}/assistant-intent-pack`.
 * The order is the guarantee that a parameter never names a body that is not there; a failed body write
 * leaves the parameter as it was.
 *
 * `ifAbsent` leaves an existing parameter alone and writes nothing, body included, so a seeder never
 * replaces a pack an operator set at deploy. Returns whether it wrote.
 *
 * Bounded by `MAX_INTENT_PACK_BYTES`, refused with the measurement named before anything is written.
 */
export async function writeClassificationPack(
  ssm: Pick<SSMClient, 'send'>,
  ssmRoot: string,
  classification: string,
  packJson: string,
  bodies: BodyStoreDeps,
  opts: { ifAbsent?: boolean } = {},
): Promise<boolean> {
  const bytes = Buffer.byteLength(packJson, 'utf8');
  if (bytes > MAX_INTENT_PACK_BYTES) {
    throw new Error(
      `the ${classification} intent pack is ${bytes} bytes, over the ${MAX_INTENT_PACK_BYTES}-byte limit on a whole `
      + 'pack. Trim the per-intent `instructions` and the workflow step prompts first.',
    );
  }
  // A platform machine is the platform's (ADR-066 decision 2): refused here as a version's is at draft, and never read
  // from a pack at runtime either (`taskStateMachines`).
  let declared: unknown;
  try { declared = (JSON.parse(packJson) as { machines?: unknown })?.machines; } catch { declared = undefined; }
  const platformKeys = declared && typeof declared === 'object' ? Object.keys(declared).filter(isPlatformMachineKey) : [];
  if (platformKeys.length) {
    throw new Error(`the ${classification} intent pack declares platform machines (${platformKeys.join(', ')}), which a pack may not declare or override`);
  }
  const name = `${ssmRoot}/assistant/${classification}/assistant-intent-pack`;
  if (opts.ifAbsent) {
    try {
      await ssm.send(new GetParameterCommand({ Name: name }));
      return false;
    } catch (err) {
      if ((err as { name?: string })?.name !== 'ParameterNotFound') throw err;
    }
  }
  const ref = await putClassificationPack(classification, packJson, bodies);
  await ssm.send(new PutParameterCommand({
    Name: name,
    Value: packPointerValue(ref),
    Type: 'String',
    Tier: 'Intelligent-Tiering',
    Overwrite: !opts.ifAbsent,
  }));
  return true;
}

/** The classification a `.../assistant/{classification}/assistant-intent-pack` parameter name belongs to. */
export function classificationOfPackParam(name: string): string | undefined {
  return /\/assistant\/([^/]+)\/assistant-intent-pack$/.exec(name)?.[1];
}

/**
 * A classification pack parameter's value as the pack JSON it stands for: an inline pack is returned as
 * it is, and a pointer is followed through the body store (`getClassificationPack`, which refuses a key
 * outside this classification's prefix and a body whose hash is not its content id).
 *
 * ONE implementation for every reader of the parameter (the router, the processor, the task service,
 * the item list, the profile write path, the classifier replay), so none of them can be the one that
 * reads a pointer as a malformed pack and quietly serves the platform default.
 */
export async function resolvePackParameterValue(
  value: string | undefined,
  classification: string,
  deps?: BodyStoreDeps,
): Promise<string | undefined> {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const ref = packPointerOf(trimmed);
  if (!ref) return trimmed;
  return (await getClassificationPack(ref, classification, deps)).trim();
}

/**
 * Hydrate the pack from SSM once (no-op if `ASSISTANT_INTENT_PACK_PARAM` is unset or already done).
 * Call early in the handler, before any classification. A fetch failure logs and leaves the env /
 * DEFAULT path intact — a transient SSM hiccup must never break classification.
 *
 * ONCE PER CONTAINER, pointer or not. A pointer costs one S3 read on the cold start that hydrates it and
 * none on any later turn, the same cost profile the inline value had in SSM.
 */
export async function hydrateIntentPackFromSsm(
  deps?: { getParameter: (name: string) => Promise<string | undefined>; bodies?: BodyStoreDeps },
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
      const ssm = sessionClient(SSMClient, { region: process.env.AWS_REGION || 'us-east-1', requestHandler: BOUNDED_REQUEST_HANDLER });
      const resp = await ssm.send(new GetParameterCommand({ Name: param }));
      value = resp.Parameter?.Value;
    }
    if (packPointerOf(value?.trim())) {
      const classification = classificationOfPackParam(param);
      if (!classification) throw new Error(`${param} holds a pack pointer but names no classification`);
      value = await resolvePackParameterValue(value, classification, deps?.bodies);
    }
    if (value && value.trim()) {
      ssmPackRaw = value.trim();
      cachedPack = null; // force re-parse with the hydrated value
      cachedRaw = undefined;
    }
  } catch (err) {
    // AN ABSENT PARAMETER IS "NOT SET", not a failure: the classification's pack is an optional seam, read
    // only when a profile version carries no pack of its own, and a deployment may leave it unwritten.
    if ((err as { name?: string })?.name === 'ParameterNotFound') return;
    console.error('[IntentPack] SSM hydrate failed; using env/DEFAULT:', err);
  }
}

/**
 * Coerce one entry into only the fields it ACTUALLY DECLARES, leaving the rest undefined.
 *
 * The distinction between "declared" and "defaulted" is the whole of partial override. `coerceIntentDef`
 * below fills absent fields with platform defaults, which is right for a standalone intent and wrong for
 * an override: an entry that says `{ key: 'report_generation', instructions: '...' }` would acquire
 * `delivery: 'PLACEHOLDER_UPDATE'` and silently turn a tracked multi-step report into a one-shot reply.
 * That is not hypothetical - `intent-pack-extends.test.ts` overrode `report_generation` with no
 * `delivery` and asserted only the description, so the flip passed unnoticed.
 */
function coerceDeclaredFields(raw: unknown): StoredIntentDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key.trim() : '';
  if (!key || (UNIVERSAL_INTENT_KEYS as readonly string[]).includes(key)) return null; // skip empty / universal overrides
  const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : undefined;
  const summary = typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : undefined;
  const keywords = Array.isArray(r.keywords)
    ? r.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.toLowerCase())
    : undefined;
  const delivery: IntentDeliveryClass | undefined =
    r.delivery === 'DIRECT' || r.delivery === 'TASK_MULTI_STEP' || r.delivery === 'PLACEHOLDER_UPDATE'
      ? r.delivery
      : undefined;
  const maxTokens =
    typeof r.maxTokens === 'number' && Number.isFinite(r.maxTokens) && r.maxTokens > 0
      ? Math.floor(r.maxTokens)
      : undefined;
  const verbosity: ResponseVerbosity | undefined =
    r.verbosity === 'tight' || r.verbosity === 'normal' || r.verbosity === 'long' ? r.verbosity : undefined;
  const instructions = typeof r.instructions === 'string' && r.instructions.trim()
    ? r.instructions.trim()
    : undefined;
  const tools = Array.isArray(r.tools)
    ? r.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    : undefined;
  const needs: IntentNeed | undefined =
    (INTENT_NEEDS as readonly unknown[]).includes(r.needs) ? (r.needs as IntentNeed) : undefined;
  const answer = coerceAnswerGuidance(r.answer);
  return {
    key,
    ...(description !== undefined ? { description } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(verbosity !== undefined ? { verbosity } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(needs !== undefined ? { needs } : {}),
    ...(answer !== undefined ? { answer } : {}),
    ...(typeof r.summary === 'string' && r.summary.trim() ? { summary: r.summary.trim() } : {}),
  };
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
  // kept; anything else is dropped (not silently lost). Clamping to classification's token limit / reasoning
  // floor happens at resolve time in the processor, not here.
  const maxTokens =
    typeof r.maxTokens === 'number' && Number.isFinite(r.maxTokens) && r.maxTokens > 0
      ? Math.floor(r.maxTokens)
      : undefined;
  const verbosity: ResponseVerbosity | undefined =
    r.verbosity === 'tight' || r.verbosity === 'normal' || r.verbosity === 'long' ? r.verbosity : undefined;
  // Trimmed, and empty reads as absent: a pack authored through an editor that writes "" for an
  // untouched field must not put a blank instruction block into every prompt of that intent.
  const instructions = typeof r.instructions === 'string' && r.instructions.trim()
    ? r.instructions.trim()
    : undefined;
  // Coerced to strings only. The INTERSECTION with the profile allowlist happens at the write path
  // (which holds both halves) and again at resolve time, so a bad entry here narrows to nothing rather
  // than widening anything.
  const tools = Array.isArray(r.tools)
    ? r.tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
    : undefined;
  const needs: IntentNeed | undefined =
    (INTENT_NEEDS as readonly unknown[]).includes(r.needs) ? (r.needs as IntentNeed) : undefined;
  const answer = coerceAnswerGuidance(r.answer);
  return {
    key,
    description,
    keywords,
    delivery,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(verbosity !== undefined ? { verbosity } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(needs !== undefined ? { needs } : {}),
    ...(answer !== undefined ? { answer } : {}),
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
    return coerceMachinesStrict(raw);
  } catch (err) {
    console.error('[IntentPack] Invalid `machines` block — falling back to DEFAULT machines:', err);
    return undefined;
  }
}

/**
 * A VERSION'S OWN MACHINES, CHECKED ON THE WRITE PATH (ADR-066 decisions 1 and 6): the same coercion and the same graph
 * validation a classification's pack runs (`coerceMachinesStrict`, `validateTaskStateMachines` over the merged view), so
 * a machine a version declares is held to the rules a deployed one is. Returns the reason it is refused, or [].
 * Whether a key is the platform's, and whether a step's tools are the version's, are the caller's questions.
 */
export function versionMachinesErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  try {
    coerceMachinesStrict(raw);
    return [];
  } catch (err) {
    return [`intentPack.machines: ${(err as Error).message}`];
  }
}

/** Coerce a `machines` block and validate the merged view the runtime runs; throws on the first problem. */
function coerceMachinesStrict(raw: unknown): Record<string, TaskStateMachine> {
  {
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
        // THE THREE BEHAVIORAL FLAGS, CARRIED. Dropping them made a pack-declared machine a
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
          ...(sr.produces !== undefined ? { produces: sr.produces as 'text' | 'image' | 'document' } : {}),
          // Carried so validation refuses the retired field by name rather than dropping it unseen.
          ...(sr.delivers !== undefined ? { delivers: sr.delivers as boolean } : {}),
          // `presented` is enforced by the runtime (`advance_task_state` refuses to leave the step on
          // the turn it was entered), so dropping it here would turn a declared checkpoint into the
          // model's judgement with nothing to say so - the same defect `delivers` had one line up.
          ...(sr.presented === true ? { presented: true } : {}),
          // WHEN A PRESENTED STEP ASKS, AND WHAT A COMPLETE BRIEF NAMES (ADR-064 decision G), carried as written so a
          // malformed value reaches `validateTaskStateMachines` and is refused by name; dropping either would confirm a
          // brief the pack's author declared complete, or skip a confirmation they declared always.
          ...(sr.confirm !== undefined ? { confirm: sr.confirm as 'always' | 'when-incomplete' } : {}),
          ...(sr.brief !== undefined ? { brief: sr.brief as string[] } : {}),
          ...(typeof sr.prompt === 'string' ? { prompt: sr.prompt } : {}),
          ...(typeof sr.placeholder === 'string' ? { placeholder: sr.placeholder } : {}),
          // `label` IS THE ONE A PERSON READS, and it was the field this loop still dropped.
          //
          // `getTaskLabel` step 1 reads `machines[type].states[state].label` (async-processor-core.ts),
          // so a pack that named its own states never reached step 1 and the person saw step 3's
          // reshaping of the state KEY instead of the author's own word - in English-derived reshaping
          // rather than the deployment's language. That is precisely the defect `label` was added to
          // remove, reappearing one layer up in the coercion, exactly as `delivers` did above.
          //
          // It was missed because the earlier fix was scoped to the FLAGS: the guard is still named
          // `a-pack-machine-keeps-its-flags`, and `label` is not a flag. The test now asserts over the
          // whole declared surface instead of a remembered list, so the next field added to
          // `TaskStateDef` cannot be dropped here quietly either.
          ...(typeof sr.label === 'string' && sr.label.trim() ? { label: sr.label.trim() } : {}),
          // A DECLARED REOPEN, carried as written. A malformed value is passed through rather than
          // dropped so `validateTaskStateMachines` below refuses the block loudly: dropping it would
          // turn a revisable workflow into a final one with nothing to say so.
          // Passed through WHOLE, entries included: filtering out a non-string entry would turn
          // `[{ state: 'revising' }]` into `[]` and the workflow final with nothing said.
          ...(sr.reopens !== undefined ? { reopens: sr.reopens as string[] } : {}),
          // THE DOCUMENT TEMPLATE A DELIVERING STEP FOLLOWS (SPEC-DOCUMENT-TEMPLATES FR3), carried as
          // written for the reason `reopens` is: a malformed value reaches `validateTaskStateMachines`,
          // which refuses the block loudly, where dropping it would deliver an unshaped document with
          // nothing to say the declaration was lost.
          ...(sr.template !== undefined ? { template: sr.template as string } : {}),
          ...(sr.templates !== undefined ? { templates: sr.templates as string[] } : {}),
          ...(sr.defaultTemplate !== undefined ? { defaultTemplate: sr.defaultTemplate as string } : {}),
          // THE STEP'S TOOLS AND ITS ACTION (SPEC-TASK-STATE-TRANSITIONS FR28, FR29), carried as written
          // for the same reason. Dropping `tools` would widen a step the author narrowed, and dropping
          // `action` would leave a deterministic step waiting on a model that was told nothing about it.
          ...(sr.tools !== undefined ? { tools: sr.tools as string[] } : {}),
          ...(sr.requiresTool !== undefined ? { requiresTool: sr.requiresTool as string[] } : {}),
          ...(sr.action !== undefined ? { action: sr.action as TaskStateMachine['states'][string]['action'] } : {}),
          ...(sr.onSuccess !== undefined ? { onSuccess: sr.onSuccess as string } : {}),
          ...(sr.onFailure !== undefined ? { onFailure: sr.onFailure as string } : {}),
          // THE STEP'S CONDITIONS (ADR-060 decision 6), carried as written for the same reason: dropping a `when` would
          // authorize a move its author gated, and a malformed one reaches `validateTaskStateMachines`, which refuses it.
          ...(sr.when !== undefined ? { when: sr.when as TaskStateMachine['states'][string]['when'] } : {}),
          ...(sr.edgeWhen !== undefined ? { edgeWhen: sr.edgeWhen as TaskStateMachine['states'][string]['edgeWhen'] } : {}),
          // THE CARD'S CHOICES AND A RESTING STEP (ADR-063 decisions 2 and 5), carried as written: dropping `choices` would take
          // the card from a step its author offered one on, and dropping `rests` would let an idle assistant take up a step its
          // author held. A malformed one reaches `validateTaskStateMachines`, which refuses it.
          ...(sr.choices !== undefined ? { choices: sr.choices as string[] } : {}),
          ...(sr.rests !== undefined ? { rests: sr.rests as boolean } : {}),
          // THE DECLARED MOVE, THE NOTICE ON ENTRY AND THE TYPED VALUES (ADR-067 G39, WT23, WT22), carried as written:
          // dropping `auto` would stall a step its author moved on, `notice` would lose a message its author said on entry,
          // and `records` would leave a condition reading a value nothing recorded. A malformed one is refused at validation.
          ...(sr.auto !== undefined ? { auto: sr.auto as string } : {}),
          ...(sr.notice !== undefined ? { notice: sr.notice as TaskStateMachine['states'][string]['notice'] } : {}),
          ...(sr.records !== undefined ? { records: sr.records as TaskStateMachine['states'][string]['records'] } : {}),
          // THE REQUESTER'S MOVES (WT114): dropping them would take from the requester a reschedule its author offered.
          ...(sr.requesterMoves !== undefined ? { requesterMoves: sr.requesterMoves as string[] } : {}),
        };
      }
      out[name] = { initial: mr.initial.trim(), states };
    }
    // Validate the merged view the runtime will actually use, so a partial override cannot leave a
    // default machine shadowed by an unreachable one.
    const merged = { ...DEFAULT_TASK_STATE_MACHINES, ...out };
    validateTaskStateMachines(merged);
    return out;
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
  cachedPack = parseIntentPack(raw);
  return cachedPack;
}

/**
 * Parse one pack's raw JSON, with the same coercion and the same fallback to DEFAULT as the active
 * pack. Exported for a reader that serves several classifications at once and so cannot use the
 * single hydrated pack this module caches (`user-tasks-api` lists one person's items across every
 * conversation, and each classification declares its own machines).
 */
export function parseIntentPack(raw: string | undefined): IntentPack {
  if (!raw) return DEFAULT_INTENT_PACK;
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.intents) ? parsed.intents : null;
    if (!list) throw new Error('expected an array or { intents: [...] }');
    // Declared fields only, so `applyExtends` can tell an override from a restatement.
    const declared = (list as unknown[])
      .map(coerceDeclaredFields)
      .filter((d): d is StoredIntentDef => d !== null);
    const extendsDefault = !Array.isArray(parsed)
      && (parsed as Record<string, unknown>)?.extends === 'default';
    // An inheriting pack may add no intent of its own (`validateIntentPackBody`): it is the platform taxonomy.
    if (declared.length === 0 && !extendsDefault) throw new Error('no valid intents after coercion');
    const intents = applyExtends(declared, extendsDefault);
    const machines = Array.isArray(parsed)
      ? undefined
      : coerceMachinesConfig((parsed as Record<string, unknown>)?.machines);
    return machines ? { intents, machines } : { intents };
  } catch (err) {
    console.error('[IntentPack] Invalid ASSISTANT_INTENT_PACK — falling back to DEFAULT:', err);
    return DEFAULT_INTENT_PACK;
  }
}

/**
 * VALIDATE A PACK A WRITER IS ASKING TO STORE, returning the reasons it is unacceptable.
 *
 * WHY NOT `parseIntentPack`. That one is a READ path and falls back to DEFAULT on anything it cannot
 * make sense of, deliberately: a deployment whose parameter is corrupt keeps classifying rather than
 * losing every turn. A WRITE path must do the opposite. Silently storing a version whose pack coerced
 * away to the defaults would publish an assistant that answers nothing like the one the operator
 * described, with the console showing their text back to them.
 *
 * Returns [] when the pack is storable. Shape only - whether the ROUTES agree with these keys is the
 * caller's question, because only the caller holds the `models.byIntent` map.
 */
/**
 * Does this resolved intent set leave the assistant able to open work?
 *
 * Reachability, not membership: an intent opens a task through the ROUTE it resolves to, so the
 * comparison is against route keys - the same mapping the byIntent reconciliation uses.
 */
export function canOpenWork(intents: ReadonlyArray<{ key: string }>): boolean {
  const core = WORK_MANAGEMENT_INTENT_KEYS as readonly string[];
  return intents.some((i) => core.includes(i.key));
}
export function validateIntentPackBody(pack: unknown): string[] {
  const errs: string[] = [];
  if (pack === undefined || pack === null) return errs;
  if (typeof pack !== 'object' || Array.isArray(pack)) {
    return ['intentPack must be an object of the form { intents: [...], machines?: {...} }'];
  }
  const raw = pack as Record<string, unknown>;
  // `extends` decides whether this pack ADDS to the platform taxonomy or REPLACES it, so a typo in it
  // ("defaults", "DEFAULT") silently flips the assistant to a pack of only its own intents - losing
  // every default intent with nothing to show for it. Accept the one legal value, or its absence.
  if (raw.extends !== undefined && raw.extends !== 'default') {
    errs.push(`intentPack.extends must be 'default' or omitted (got ${JSON.stringify(raw.extends)}); `
      + "omitted means this pack REPLACES the platform taxonomy rather than adding to it");
  }
  // AN INTENT PACK DECLARES NO EVENT WORKFLOW (ADR-061 decision 1): a pack is a classification's taxonomy, and an event
  // workflow is one assistant's greeting and follow-up, so it lives on that assistant's version (`eventWorkflows`).
  if (raw.eventWorkflows !== undefined) {
    errs.push("intentPack.eventWorkflows: an intent pack declares no event workflows; they live on an assistant's version (eventWorkflows)");
  }
  if (!Array.isArray(raw.intents)) return [...errs, 'intentPack.intents must be an array of intent definitions'];
  // A PACK THAT INHERITS MAY ADD NO INTENT: `{ extends: 'default', intents: [], machines }` is the platform taxonomy
  // with the version's own machines, which is what a version on the platform pack writes when it edits a machine.
  if (raw.intents.length === 0 && raw.extends !== 'default') errs.push('intentPack.intents must declare at least one intent');
  const seen = new Set<string>();
  raw.intents.forEach((entry, i) => {
    // THE UNIVERSAL CHECK COMES FIRST, because `coerceIntentDef` returns null for a universal key - it
    // is a READ path and skipping such an entry is the right thing there. Coercing first therefore made
    // the specific message below unreachable, and an operator who redeclared `general` was told their
    // intent "is not a valid intent (needs key, description, keywords[], delivery)" while looking at an
    // entry that had all four. Name the real problem.
    const declaredKey = typeof (entry as Record<string, unknown>)?.key === 'string'
      ? ((entry as Record<string, unknown>).key as string).trim()
      : '';
    if ((UNIVERSAL_INTENT_KEYS as readonly string[]).includes(declaredKey)) {
      errs.push(`intentPack.intents[${i}] redeclares the universal intent '${declaredKey}', which every pack already has`);
      return;
    }
    const def = coerceIntentDef(entry);
    if (!def) {
      errs.push(`intentPack.intents[${i}] is not a valid intent (needs key, description, keywords[], delivery)`);
      return;
    }
    // A NEW INTENT MUST SAY WHAT IT IS; an OVERRIDE may say only what it changes.
    //
    // `coerceIntentDef` defaults a missing description to '' and a missing delivery to
    // PLACEHOLDER_UPDATE, so `{ "key": "foo" }` used to store cleanly as a brand-new intent with an
    // EMPTY classifier description - an intent the LLM classifier is shown a blank line for and can
    // therefore never choose. The type comment claimed the write path enforced this; it did not.
    //
    // Scoped to keys that inherit nothing: with `extends: 'default'` a declared platform key is a
    // partial override and its description, keywords and delivery come from the inherited intent.
    const inherits = (raw.extends === 'default')
      && DEFAULT_INTENT_PACK.intents.some((d) => d.key === declaredKey);
    if (!inherits) {
      const e = entry as Record<string, unknown>;
      if (typeof e.description !== 'string' || !e.description.trim()) {
        errs.push(
          `intentPack.intents[${i}] ('${def.key}') declares a NEW intent with no description; the `
          + 'classifier is shown that line, so an intent without one can never be chosen',
        );
      }
      if (!Array.isArray(e.keywords)) {
        errs.push(`intentPack.intents[${i}] ('${def.key}') declares a NEW intent with no keywords[]`);
      }
      if (e.delivery === undefined) {
        errs.push(
          `intentPack.intents[${i}] ('${def.key}') declares a NEW intent with no delivery; it would `
          + "default to PLACEHOLDER_UPDATE, which is a decision worth making rather than inheriting",
        );
      }
    }
    // A DUPLICATE KEY IS A SILENT OVERRIDE, not a harmless repeat: `knownIntentKeys` is a Set and the
    // classifier prompt would list the description twice while only one of them could ever be chosen.
    if (seen.has(def.key)) errs.push(`intentPack.intents[${i}] repeats the key '${def.key}'`);
    seen.add(def.key);
    // Checked against the RAW entry, not the coerced one: coercion drops a non-string `instructions`
    // and filters a malformed `tools`, so validating the coerced value would silently accept the write
    // and store something other than what the operator wrote - the failure this validator exists to
    // prevent (see the header: a write path must not coerce away an operator's text).
    const rawEntry = entry as Record<string, unknown>;
    if (rawEntry.instructions !== undefined) {
      if (typeof rawEntry.instructions !== 'string') {
        errs.push(`intentPack.intents[${i}].instructions must be a string`);
      } else if (rawEntry.instructions.length > MAX_INTENT_INSTRUCTIONS) {
        errs.push(
          `intentPack.intents[${i}].instructions is ${rawEntry.instructions.length} characters, over the `
          + `${MAX_INTENT_INSTRUCTIONS}-character limit; it is prompt weight on every turn of this intent`,
        );
      }
    }
    errs.push(...answerGuidanceErrors(rawEntry.answer, `intentPack.intents[${i}]`));
    if (rawEntry.needs !== undefined && !(INTENT_NEEDS as readonly unknown[]).includes(rawEntry.needs)) {
      errs.push(`intentPack.intents[${i}].needs must be one of ${INTENT_NEEDS.join(', ')}`);
    }
    if (rawEntry.summary !== undefined) {
      if (typeof rawEntry.summary !== 'string') {
        errs.push(`intentPack.intents[${i}].summary must be a string`);
      } else if (rawEntry.summary.length > MAX_INTENT_SUMMARY) {
        errs.push(
          `intentPack.intents[${i}].summary is ${rawEntry.summary.length} characters, over the `
          + `${MAX_INTENT_SUMMARY}-character limit; it is read in a list by somebody deciding who to ask`,
        );
      }
    }
    if (rawEntry.tools !== undefined) {
      if (!Array.isArray(rawEntry.tools) || !rawEntry.tools.every((t) => typeof t === 'string' && t.trim())) {
        errs.push(`intentPack.intents[${i}].tools must be an array of tool names`);
      } else if (new Set(rawEntry.tools as string[]).size !== (rawEntry.tools as string[]).length) {
        errs.push(`intentPack.intents[${i}].tools must not repeat a tool`);
      } else {
        const unknown = unknownTools(rawEntry.tools as string[]);
        if (unknown.length) {
          errs.push(`intentPack.intents[${i}].tools names unknown tool(s): ${unknown.join(', ')}`);
        }
      }
    }
  });
  if (raw.machines !== undefined && (typeof raw.machines !== 'object' || Array.isArray(raw.machines))) {
    errs.push('intentPack.machines must be a map of taskType to a task state machine');
  }
  // The WHOLE pack, not just one intent. Checked last so a pack that is also malformed reports the
  // malformed fields rather than only its size.
  const bytes = Buffer.byteLength(JSON.stringify(pack), 'utf8');
  if (bytes > MAX_INTENT_PACK_BYTES) {
    errs.push(
      `intentPack is ${bytes} bytes, over the ${MAX_INTENT_PACK_BYTES}-byte limit. A pack this size `
      + 'exports into a manifest that import refuses, so the version would store and then fail to move. '
      + 'Trim the per-intent `instructions` first - they are the field that grows.',
    );
  }
  return errs;
}

/**
 * The domain intent keys a pack RECOGNIZES, for a caller checking that a route names a real intent.
 *
 * Resolved, not merely declared. A pack with `extends: 'default'` declares only its own additions but
 * recognizes the inherited defaults too, so checking a route against the declared list alone would
 * refuse `models.byIntent['guided_troubleshooting']` on a pack that classifies it perfectly well - the
 * mirror image of the bug this reconciliation exists to catch, and a worse one, because it refuses a
 * version an operator is looking at rather than letting a dead route through.
 */
export function intentKeysOf(pack: StoredIntentPack): Set<string> {
  return new Set(resolveStoredPack(pack).intents.map((d) => d.key));
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
 * override here. The AgentHandler forwards this in the event; the processor clamps it to the classification's
 * token limit + reasoning floor. Empty object ⇒ the processor uses its default budget.
 */
/** Upper bound on a single intent's `instructions`. Per-turn prompt weight on the classified path, so
 *  it is bounded for the same reason `MAX_PERSONA_LENGTH` is: an unbounded field here is a latency and
 *  cost decision wearing configuration's clothes. Generous enough for a real procedure. */
export const MAX_INTENT_INSTRUCTIONS = 4000;

/** Upper bound on one intent's person-facing `summary`. Short because it is read in a list, next to
 *  several others, by somebody deciding who to ask rather than studying the assistant. */
export const MAX_INTENT_SUMMARY = 200;

/**
 * How many advertised intents an INTRODUCTION may list.
 *
 * Bounding each line does not bound the list, and the list is the thing a person actually fails to
 * read: the premium demo assistant declares eight intents, and eight items on first contact is a menu,
 * not an introduction. The rest stay reachable by asking, which is a better place for them anyway -
 * somebody asking "what can you do" has opted in to a longer answer.
 *
 * This is also the only defence against unbounded growth. Adding an intent is an edit that changes what
 * every new person reads, forever, and no single edit ever looks like the one that made it worse.
 */
export const MAX_ADVERTISED_IN_INTRODUCTION = 4;

/**
 * Upper bound on the WHOLE serialized pack, which the per-intent limit alone does not give.
 *
 * `MAX_INTENT_INSTRUCTIONS` bounds one intent; nothing bounded how many intents a pack declares, so a
 * pack of ten well-instructed intents reaches 40KB and an export produces a manifest that import
 * refuses (`MAX_MANIFEST_BYTES`) - the version stores fine and only fails when someone tries to move
 * it, which is the worst moment to discover it. Bounded here so the refusal happens at the write, where
 * the operator is looking at what they wrote.
 */
export const MAX_INTENT_PACK_BYTES = 24 * 1024;

/**
 * The per-intent prompt guidance for a classified intent, or undefined when the intent declares none
 * (which is every intent that has not been given any, so this reads as today's behavior).
 */
/**
 * What this assistant ADVERTISES, in declaration order: the intents carrying a person-facing summary.
 *
 * Declaration order, not relevance order, and that is a choice the author can see: the pack is a list
 * an operator wrote, so what they put first is what a person reads first. Ranking it by some computed
 * notion of importance would take that control away and make the introduction unpredictable from the
 * thing the operator is editing.
 */
export function advertisedIntents(
  pack: IntentPack = getIntentPack(),
): Array<{ key: string; summary: string }> {
  return pack.intents
    .filter((d): d is IntentDef & { summary: string } => !!d.summary?.trim())
    .map((d) => ({ key: d.key, summary: d.summary.trim() }));
}

export function instructionsForIntent(
  intent: string,
  pack: IntentPack = getIntentPack(),
): string | undefined {
  return pack.intents.find((d) => d.key === intent)?.instructions;
}

/**
 * The tool allowlist for a turn of this intent: the profile's allowlist NARROWED by the intent's own,
 * never widened.
 *
 * `profileTools` undefined means the profile allows every registered tool, so the intent's list stands
 * alone; otherwise the result is the intersection. An intent naming only tools the profile forbids
 * yields an EMPTY list, which is a turn with no tools rather than a turn with all of them - the safe
 * direction, and the write path refuses that version anyway so it should not be reachable.
 *
 * THE WORKFLOW'S OWN TOOLS STAY WHERE THE PROFILE ALLOWS THEM (`advance_task_state`, `deliver_document`,
 * `open_new_request`): they are how a task moves, not a capability an intent selects, so an intent's `tools` narrows
 * what its turn may reach and leaves its workflow able to move, as a step's `tools` does (`toolsForStep`).
 */
export function toolsForIntent(
  intent: string,
  profileTools: string[] | undefined,
  pack: IntentPack = getIntentPack(),
): string[] | undefined {
  const own = pack.intents.find((d) => d.key === intent)?.tools;
  if (!own) return profileTools;
  const allowed = profileTools ? new Set(profileTools) : undefined;
  const reach = own.filter((t) => !allowed || allowed.has(t));
  const workflow = WORKFLOW_TOOL_NAMES.filter((t) => !reach.includes(t) && (!allowed || allowed.has(t)));
  return [...reach, ...workflow];
}

/** The tools a task moves by, kept on every intent's turn the profile allows them on (`toolsForIntent`). */
const WORKFLOW_TOOL_NAMES: readonly string[] = [ADVANCE_TASK_STATE_TOOL_NAME, DELIVER_DOCUMENT_TOOL_NAME, OPEN_NEW_REQUEST_TOOL_NAME];

/**
 * THE PLATFORM INTENTS THAT ANSWER THROUGH THE `general` ROUTE when a version gives them no route of their own
 * (ADR-064 decision A). Declared in the pure resolver module so it imports nothing; read here beside the needs.
 */
export { ANSWERS_THROUGH_GENERAL, answersThroughGeneral, GENERAL_ROUTE_KEY } from './model-resolver.js';

/**
 * Whether a turn's intent needs an image: its definition in the served pack declares `needs: 'image'`
 * (`need`, from {@link needsOf}), else the platform's need for that intent (`image_generation`). Such a
 * turn is served by an image model or fails, naming why; it never answers in text.
 */
export function turnNeedsImage(input: { intent?: string; need?: string }): boolean {
  return (input.need ?? PLATFORM_INTENT_NEEDS[input.intent ?? '']) === 'image';
}

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
 * Clamp a requested per-intent `maxTokens` to the classification's token limit and reasoning floor (P3, pure). The
 * forwarded per-intent budget WINS but can never exceed the classification's token limit; absent ⇒ the limit
 * (today's default). Reasoning turns keep a higher floor (the chain-of-thought eats the budget).
 */
export function clampResponseMaxTokens(
  requested: number | undefined,
  limit: number,
  reasoning: boolean,
): number {
  let v = typeof requested === 'number' && requested > 0 ? Math.min(requested, limit) : limit;
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
 * machines keeps the work-item defaults. Absent ⇒ the defaults verbatim.
 *
 * A PLATFORM KEY IS NEVER TAKEN FROM A PACK (ADR-066 decision 2): the queue's machines and the work items every
 * assistant shares (`PLATFORM_MACHINE_KEYS`) resolve only from `DEFAULT_TASK_STATE_MACHINES`, the same rule a
 * version is held to, so no classification's pack can change how every assistant interacts.
 */
export function taskStateMachines(
  pack: IntentPack = getIntentPack(),
): Record<string, TaskStateMachine> {
  if (!pack.machines) return DEFAULT_TASK_STATE_MACHINES;
  const own = Object.entries(pack.machines).filter(([k]) => !isPlatformMachineKey(k));
  return { ...DEFAULT_TASK_STATE_MACHINES, ...Object.fromEntries(own) };
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

