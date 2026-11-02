/**
 * Onboarding intake (opt-in, deterministic multi-step welcome).
 *
 * The default welcome is an instant static greeting (see
 * `router-agent-handler.composeWelcome` + SPEC-WELCOME-AND-CONTEXT.md). Some
 * assistants cannot do useful work until they have collected a few structured
 * inputs from the user (a sign-up / profile-building flow). This module is the
 * richer end of the welcome passthrough: a short, SCRIPTED intake that greets,
 * asks for the minimum required inputs one at a time, validates them, confirms
 * the summary, and then hands off to the working assistant.
 *
 * Design choices (all deliberate, mirroring the SPEC-WELCOME-AND-CONTEXT
 * "reference pattern"):
 *
 * - **Deterministic, no Bedrock.** Every intake turn is a scripted question or
 *   a confirmation. Like the static welcome it is instant, predictable, and
 *   testable — no model variance on the highest-visibility surface.
 * - **State in the channel context store, not the Amazon Lex session.** The
 *   cursor + collected values are kept on the conversation's server-only
 *   channel context row (`onboardingIntake`), with the person being onboarded
 *   named as its `subject`. The Lex session was free but only existed when Lex
 *   was the entry, and Lex dropped it after five idle minutes, after which the
 *   next answer was filed under the first question. The engine here is a PURE
 *   function over that state, so it unit-tests without any AWS mock.
 * - **Handoff via channel history.** The intake questions are returned through
 *   Lex, which posts them as the bot's channel messages; the user's answers are
 *   their channel messages. So when the working assistant takes over, the whole
 *   intake Q&A is already in the recent-message window it reads — the collected
 *   context is "available" without a separate store.
 * - **Opt-in.** Disabled unless a deployment supplies an intake config
 *   (`ONBOARDING_INTAKE` env / `ONBOARDING_INTAKE_PARAM` SSM). AgentEchelon
 *   ships it OFF; the generic assistant answers the first turn cold.
 *
 * See docs/GUIDE-ASSISTANT-CONTEXT.md ("Welcome patterns") and
 * docs/SPEC-WELCOME-AND-CONTEXT.md ("The two-tier welcome").
 */

import { templateLine, type VersionWords } from './message-lines.js';
import { classifyConfirmDeclineReply } from './routing-state.js';
import {
  REPLY_PREFERENCES,
  resolvePreferenceAnswer,
} from '../../../lib/config/reply-preferences.js';

/** One field the intake collects. */
export interface IntakeField {
  /** Stable key the collected value is stored under. */
  key: string;
  /** The question shown to the user for this field. */
  prompt: string;
  /** Required fields cannot be skipped; optional ones accept "skip"/blank. */
  required: boolean;
  /**
   * Optional validation regex (source string, case-insensitive). When set, an
   * answer that does not match is rejected and the field is re-asked with
   * `example` as a hint. Applied only to required fields' non-skip answers.
   */
  pattern?: string;
  /** Shown when `pattern` rejects an answer ("e.g. acme.com"). */
  example?: string;
  /**
   * A REPLY PREFERENCE this field sets (`lib/config/reply-preferences.ts`), instead of a fact.
   *
   * The answer must choose one of the preference's declared values; anything else is re-asked with the
   * choices, required or not, because an unresolved answer has nothing to store. What is collected and
   * stored is the VALUE KEY, under the person's `preferences`, so their words never reach a later prompt.
   */
  preference?: string;
  /**
   * WHAT ALREADY ASSERTS THIS FIELD, so the intake does not ask for it.
   *
   * Owner rule (2026-09-03): an intake runs only after the assistant has CHECKED and cannot resolve
   * the field. That makes intake a FALLBACK rather than a gate, so a deployment can declare fields
   * without interrogating people about what it already knows.
   *
   * WHAT DROVE IT: opening a standard conversation, the assistant asked "What company are you with?"
   * in a deployment whose persona opens "You are the internal assistant for Stratum Technologies".
   * Its two fields were `company` and `role` - the two facts the deployment already asserts, since
   * the persona names the company and the CLASSIFICATION is the role claim (standard = employee
   * access, premium = leadership). It then stored the answer as new information, free to contradict
   * the persona.
   *
   *   `persona`         the assistant's own persona states it
   *   `classification`  the conversation's classification IS the claim
   *   `profile`         the person's stored profile already has this key
   *
   * CHECKED IS DELIBERATELY CHEAP (owner decision, 2026-09-14): only what the turn already holds. No
   * tool call, because an intake must not sit in front of a question somebody is waiting on - and a
   * thorough check that consults company docs would do exactly that.
   *
   * Absent means "nothing asserts it", which is the old behaviour: always ask.
   */
  assertedBy?: IntakeAssertion[];
}

/** What can already assert a field, without spending a tool call to find out. */
export const INTAKE_ASSERTIONS = ['persona', 'classification', 'profile'] as const;
export type IntakeAssertion = (typeof INTAKE_ASSERTIONS)[number];

/** What the turn already holds, assembled by the caller from context it has anyway. */
export interface KnownFacts {
  /** True when the assistant has a persona configured that could state a fact. */
  hasPersona?: boolean;
  /** The conversation's classification, when one is resolved. */
  classification?: string | null;
  /**
   * The person's stored profile FACTS (`UserProfile.facts`), keyed by intake field key - not the
   * profile record itself. A completed intake stores its answers under `facts`, so a check against the
   * record's top level looked for `company` beside `personId` and could never find it.
   */
  profileFacts?: Record<string, unknown> | null;
  /** The person's chosen reply preferences (`UserProfile.preferences`), keyed by preference. */
  profilePreferences?: Record<string, unknown> | null;
}

/** Per-deployment intake definition. Absent ⇒ onboarding is disabled. */
export interface IntakeConfig {
  /** Opening line, shown before the first field's prompt. */
  /** The deployment's own opening; absent, the `onboarding-intake` template's greeting. */
  greeting?: string;
  /**
   * The assistant's words the intake's own lines are said in (ADR-062): the corrections, the summary and the
   * completion are the `onboarding-intake` message template, the assistant's own or the shipped one. Set by the
   * caller for a turn; never part of the stored configuration.
   */
  words?: VersionWords;
  /** Ordered fields to collect. Empty ⇒ disabled. */
  fields: IntakeField[];
  /**
   * Closing line once the summary is confirmed. `{name}` interpolates the
   * user's display name when known. Defaults to a generic hand-off.
   */
  completion?: string;
  /**
   * ── AN OFFER, NOT A FORM ──────────────────────────────────────────────────────────────────────
   *
   * One yes/no question whose ANSWER is not a fact to file: accepting produces a piece of copy and
   * declining produces a shorter one. Either way onboarding is complete and the person is never asked
   * again.
   *
   * WHY IT IS NOT A FIELD. A field collects a value, runs a confirmation summary and asks the person
   * to approve what was recorded. There is nothing to approve here, and walking somebody through
   * "Here is what I have: Would you like an overview: yes. Is this correct?" is the kind of form
   * nobody wanted. When `offer` is set it replaces the field flow entirely.
   *
   * THE COPY IS THE DEPLOYMENT'S, all of it. Nothing here is composed from English in the platform,
   * which is the rule the rest of this module follows and the reason an intake can be written in any
   * language the deployment speaks.
   */
  offer?: IntakeOffer;
  /**
   * "STOP ASKING ME", in the deployment's own words. Optional, and empty by default.
   *
   * THE PLATFORM SHIPS NONE, for the reason `IntakeOffer.affirmative` gives: a bail list written in
   * code is one language compiled into a platform whose questions are written in another. A field
   * intake already releases anything ending in a question mark, which needs no vocabulary; this is
   * for a deployment that also wants "no thanks" in its own language to end the form.
   *
   * Matched case-insensitively against the whole trimmed message, so a company called "Stop Loss
   * Reporting" is still an answer.
   */
  bail?: string[];
}

/** A single yes/no offer made once, at the start of a conversation. */
export interface IntakeOffer {
  /** The question. Shown after the welcome, which the offer does not replace. */
  ask: string;
  /**
   * THE WORDS THAT MEAN YES AND NO, IN THE DEPLOYMENT'S OWN LANGUAGE. Required, both of them.
   *
   * THE PLATFORM SHIPS NO ANSWER VOCABULARY, and that is the point. Matching "yes" and "no" in code
   * would compile one language into a platform that asks its question in whatever language the
   * deployment wrote `ask` in - so a Spanish deployment would ask in Spanish and then understand only
   * English, leaving the person unable to answer their own assistant. A deployment that can write the
   * question can write the two answers to it.
   *
   * Matched case-insensitively against the WHOLE trimmed message, so a word appearing inside a longer
   * sentence is not an answer - that sentence is something else the person said, and it is released.
   */
  affirmative: string[];
  negative: string[];
  /** Sent when they accept. This is the substance - the overview itself. */
  onAccept: string;
  /** Sent when they decline. Deliberately short: they said no, so this is an acknowledgement. */
  onDecline: string;
  /**
   * WHAT THEIR ACCESS MEANS, appended to `onAccept` only.
   *
   * `accessHas` when their clearance already reaches beyond this conversation's classification;
   * `accessNeeds` when it does not. Two strings rather than one templated sentence, because the two
   * say opposite things and a deployment should be able to word each on its own terms.
   *
   * OMITTED ENTIRELY WHEN CLEARANCE CANNOT BE RESOLVED, and that is a deliberate refusal rather than
   * a gap. `resolveUserClearance` answers `basic` for ANY failure, so a transient outage would
   * otherwise tell somebody who holds premium that they need to request it. Saying nothing about
   * access is a smaller harm than telling a person something false about their own permissions.
   */
  accessHas?: string;
  accessNeeds?: string;
}

/** Intake progress. */
export interface IntakeState {
  /** Index of the field whose answer we are currently awaiting. */
  cursor: number;
  /** Answers collected so far, keyed by `IntakeField.key`. */
  collected: Record<string, string>;
  /** collecting = asking fields; confirming = awaiting yes/no on the summary. */
  phase: 'collecting' | 'confirming' | 'done';
  /**
   * The keys of the fields THIS intake asks, in order, pinned when it started.
   *
   * `cursor` indexes this list, not the deployment's full field list. The welcome drops asserted fields
   * before asking, so the two lists differ whenever anything is asserted; an answer turn that re-derived
   * the list from the full config filed each answer after a dropped field under the key before it.
   * Pinning the list makes the answer path run the intake the welcome started, whatever has changed
   * since. Absent on an intake stored before the list was pinned (see `intakeAsStarted`).
   */
  asked?: string[];
}

/**
 * Intake progress as stored on the channel context row: the state, plus WHO it belongs to.
 *
 * The subject is what makes the stored row safe to act on. Only the person being onboarded may advance
 * it, so a message from anyone else in the conversation - or a turn the platform wrote to itself - is
 * never taken as an answer.
 */
export interface StoredIntake extends IntakeState {
  subject: string;
}

// Answers that mean "skip this optional field" (case-insensitive, whole-string).
const SKIP_RE = /^(skip|none|n\/?a|na|-)$/i;

/**
 * How long a loaded intake is reused, present OR absent. The same bound `resolveActiveProfile` gives
 * the rest of a profile's SSM-backed config, so writing or changing the parameter reaches new
 * conversations within it, with no cold start.
 *
 * An absent result is held no longer than a present one. Caching "no intake" for the container's warm
 * life meant a deployment that wrote the parameter saw nothing until every warm handler happened to
 * recycle, and a single failed SSM read disabled onboarding for that whole life.
 */
export const INTAKE_CONFIG_TTL_MS = 30_000;

const loadCache: { config: IntakeConfig | null; expiresAt: number } = { config: null, expiresAt: 0 };

/**
 * Resolve the deployment's intake config. Reads inline `ONBOARDING_INTAKE`
 * (JSON) first, then falls back to an SSM parameter named by
 * `ONBOARDING_INTAKE_PARAM`. Returns null (disabled) when neither is set or the
 * JSON is malformed / has no fields. Cached per warm container for
 * `INTAKE_CONFIG_TTL_MS`, including a null result.
 *
 * `ssmGet` is injected so the router can pass its own SSM client; omitted in
 * unit tests (which exercise the pure engine, not the loader).
 */
export async function loadIntakeConfig(
  ssmGet?: (name: string) => Promise<string | undefined>,
): Promise<IntakeConfig | null> {
  const now = Date.now();
  if (loadCache.expiresAt > now) return loadCache.config;
  loadCache.config = await resolveIntakeConfig(ssmGet);
  loadCache.expiresAt = now + INTAKE_CONFIG_TTL_MS;
  return loadCache.config;
}

/** Test hook: clear the warm intake-config cache. */
export function __clearIntakeConfigCache(): void {
  loadCache.expiresAt = 0;
  loadCache.config = null;
}

async function resolveIntakeConfig(
  ssmGet?: (name: string) => Promise<string | undefined>,
): Promise<IntakeConfig | null> {
  const inline = process.env.ONBOARDING_INTAKE?.trim();
  let raw = inline;
  if (!raw) {
    const param = process.env.ONBOARDING_INTAKE_PARAM?.trim();
    if (param && ssmGet) {
      try {
        raw = (await ssmGet(param))?.trim();
      } catch (err) {
        console.warn('[onboarding-intake] SSM config load failed; onboarding disabled:', err);
        return null;
      }
    }
  }
  if (!raw) return null;
  return parseIntakeConfig(raw);
}

/** Parse + validate an intake config JSON string. Returns null when unusable. */
export function parseIntakeConfig(raw: string): IntakeConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[onboarding-intake] config is not valid JSON; onboarding disabled');
    return null;
  }
  const obj = parsed as Partial<IntakeConfig>;
  const fields = Array.isArray(obj?.fields) ? obj.fields : [];
  const clean: IntakeField[] = [];
  for (const f of fields) {
    if (!f || typeof f.key !== 'string' || !f.key.trim() || typeof f.prompt !== 'string' || !f.prompt.trim()) {
      continue; // a field with no key or no prompt is unusable — drop it
    }
    clean.push({
      key: f.key.trim(),
      prompt: f.prompt.trim(),
      required: f.required !== false, // default required
      pattern: typeof f.pattern === 'string' ? f.pattern : undefined,
      example: typeof f.example === 'string' ? f.example : undefined,
      // A preference the registry does not declare is DROPPED, so the field falls back to an ordinary
      // fact rather than collecting answers nothing can resolve.
      preference: typeof f.preference === 'string' && REPLY_PREFERENCES[f.preference] ? f.preference : undefined,
      // Unknown assertions are DROPPED rather than honoured. A typo must not silently skip a field
      // the deployment meant to collect - the failure direction here is "ask anyway", which is
      // annoying, against "never ask", which loses the data with nothing to show it happened.
      assertedBy: Array.isArray(f.assertedBy)
        ? (f.assertedBy.filter((a: unknown): a is IntakeAssertion =>
            typeof a === 'string' && (INTAKE_ASSERTIONS as readonly string[]).includes(a)))
        : undefined,
    });
  }
  // AN OFFER IS A COMPLETE INTAKE ON ITS OWN, so the "no fields ⇒ disabled" rule below must not
  // discard one. All three strings are required: an offer that cannot ask, or cannot answer either
  // way, is not a usable offer and falls back to the field flow rather than half-running.
  const rawOffer = (obj as { offer?: Partial<IntakeOffer> }).offer;
  const words = (v: unknown): string[] => (Array.isArray(v)
    ? v.filter((w): w is string => typeof w === 'string' && !!w.trim()).map((w) => w.trim())
    : []);
  const affirmative = words(rawOffer?.affirmative);
  const negative = words(rawOffer?.negative);
  const offer: IntakeOffer | undefined = rawOffer
    && typeof rawOffer.ask === 'string' && rawOffer.ask.trim()
    && typeof rawOffer.onAccept === 'string' && rawOffer.onAccept.trim()
    && typeof rawOffer.onDecline === 'string' && rawOffer.onDecline.trim()
    // AN OFFER WITH NO ANSWER WORDS CANNOT BE ANSWERED. Every message would release, so the question
    // would be asked once and never mean anything. Refused as unusable rather than run half-working -
    // the platform has no vocabulary of its own to fall back on, deliberately.
    && affirmative.length > 0 && negative.length > 0
    ? {
      ask: rawOffer.ask.trim(),
      onAccept: rawOffer.onAccept.trim(),
      onDecline: rawOffer.onDecline.trim(),
      affirmative,
      negative,
      accessHas: typeof rawOffer.accessHas === 'string' && rawOffer.accessHas.trim() ? rawOffer.accessHas.trim() : undefined,
      accessNeeds: typeof rawOffer.accessNeeds === 'string' && rawOffer.accessNeeds.trim() ? rawOffer.accessNeeds.trim() : undefined,
    }
    : undefined;
  if (clean.length === 0 && !offer) return null; // nothing to ask ⇒ disabled
  return {
    ...(typeof obj.greeting === 'string' && obj.greeting.trim() ? { greeting: obj.greeting.trim() } : {}),
    fields: clean,
    completion: typeof obj.completion === 'string' && obj.completion.trim() ? obj.completion.trim() : undefined,
    ...(words((obj as { bail?: unknown }).bail).length ? { bail: words((obj as { bail?: unknown }).bail) } : {}),
    ...(offer ? { offer } : {}),
  };
}

/** True when a usable intake config is present: fields to collect, or an offer to make. */
export function isOnboardingEnabled(config: IntakeConfig | null): config is IntakeConfig {
  return !!config && (config.fields.length > 0 || !!config.offer);
}

/**
 * Is this ONE field already answered by what the turn holds?
 *
 * Pure, and deliberately dull: each assertion is a question with a cheap answer. `persona` and
 * `classification` do not need the VALUE - the point is that asking would be redundant, not that we
 * can recite what the deployment asserts - while `profile` needs a real stored value, because a
 * profile that exists but has no entry for this key has not answered anything.
 */
export function fieldIsAsserted(field: IntakeField, facts: KnownFacts): boolean {
  // A preference already chosen is never offered again, whatever `assertedBy` says: choosing it is
  // exactly what the offer exists to get, and "no preference" counts as a choice.
  if (field.preference && facts.profilePreferences?.[field.preference]) return true;
  for (const a of field.assertedBy || []) {
    if (a === 'persona' && facts.hasPersona) return true;
    if (a === 'classification' && facts.classification) return true;
    if (a === 'profile') {
      const v = facts.profileFacts?.[field.key];
      if (v !== undefined && v !== null && String(v).trim() !== '') return true;
    }
  }
  return false;
}

/**
 * The config with every already-answered field removed - the CHECKED step, applied.
 *
 * Returns `null` when nothing is left to ask, which `isOnboardingEnabled` then reads as disabled, so
 * a deployment whose fields are all asserted runs no intake at all rather than an empty one. That is
 * the reported case: persona names the company, classification is the role claim, nothing to ask.
 */
export function intakeAfterChecking(
  config: IntakeConfig | null,
  facts: KnownFacts,
): IntakeConfig | null {
  if (!config) return null;
  const remaining = config.fields.filter((f) => !fieldIsAsserted(f, facts));
  // AN OFFER IS NOT A FACT, SO NOTHING CAN ASSERT IT AWAY.
  //
  // The check drops fields the deployment already knows the answer to, and returns null when none are
  // left. An offer has no answer to know: it asks whether somebody WANTS something, which no persona,
  // classification or stored profile can settle on their behalf. Without this, an offer-only config
  // (`fields: []`) resolved to "every field is already asserted; asking nothing" and the offer was
  // silently never made - which is exactly how it behaved on the deployment until this line.
  if (remaining.length === 0) return config.offer ? { ...config, fields: [] } : null;
  if (remaining.length === config.fields.length) return config;
  return { ...config, fields: remaining };
}

/**
 * The intake a stored row is running: the fields its welcome asked, in the order it asked them.
 *
 * This is how the answer path and the welcome agree. The welcome resolves the intake ONCE, with
 * `intakeAfterChecking`, and pins the resulting keys on the row (`IntakeState.asked`); every answer turn
 * reads them back here rather than resolving again. Resolving again could not be trusted to agree - the
 * persona can be re-activated and the profile can change mid-intake - and a list that disagrees by one
 * field moves every later answer onto the wrong key.
 *
 * Returns null when a pinned key is no longer in the deployment's intake: the intake was edited under
 * this conversation, so its cursor no longer names a question anyone asked, and the caller treats the
 * turn as carrying no intake rather than guessing which answer it is.
 *
 * A row stored before the keys were pinned carries none. Its welcome dropped exactly the fields the
 * deployed router could match - `classification`, since `persona` and `profile` never matched there -
 * so the same check with only the classification rebuilds the list that welcome asked.
 */
export function intakeAsStarted(
  config: IntakeConfig | null,
  stored: Pick<IntakeState, 'asked'>,
  classification: string | null,
): IntakeConfig | null {
  if (!config) return null;
  if (!stored.asked) return intakeAfterChecking(config, { classification });
  const byKey = new Map(config.fields.map((f) => [f.key, f]));
  const fields: IntakeField[] = [];
  for (const key of stored.asked) {
    const field = byKey.get(key);
    if (!field) return null;
    fields.push(field);
  }
  // AN OFFER PINS NO KEYS, SO AN EMPTY LIST IS NOT AN EMPTY INTAKE.
  //
  // `asked: []` means "this conversation was made an offer", not "this conversation asked nothing".
  // Returning null here left the answer turn with no intake to run, so the person's "yes" was never
  // intercepted: it went to the assistant, which answered it as an ordinary question after a model
  // call. The offer was asked and could never be answered - visible only on a deployment, because the
  // engine and the resolution step were each correct on their own.
  if (fields.length === 0) return config.offer ? { ...config, fields: [] } : null;
  return { ...config, fields };
}

// ---------------------------------------------------------------------------
// The engine (pure). No AWS, no I/O — drives the FSM from (config, state, msg).
// ---------------------------------------------------------------------------

/** The reply text + the next state to persist. `done` ⇒ hand off to the assistant. */
export interface IntakeStep {
  reply: string;
  state: IntakeState;
  done: boolean;
  /**
   * THIS TURN WAS NOT AN ANSWER: hand it back to ordinary routing instead of replying here.
   *
   * The owner rule (2026-09-03) is that an intake must never sit in front of a question somebody is
   * waiting on. It did: a person opened a conversation, was asked a preference question, typed "What
   * is AgentEchelon?" and had that STORED as their answer - then every following message was met with
   * "Please reply yes or no" forever, because only yes/no advances the confirmation. There was no
   * escape and no way to reach the assistant at all.
   *
   * `release` is the way out. The intake is finished (`done`), nothing further is intercepted, and the
   * caller does NOT send `reply` - it lets the message continue to classification and dispatch, so the
   * person's actual question is answered by the assistant on the same turn they asked it.
   *
   * WHATEVER WAS COLLECTED IS KEPT, and the user is marked onboarded exactly as a completed intake
   * would. That is deliberate: re-asking on the next conversation would walk them back into the same
   * trap, and somebody who answered a preference question with a question has told us they did not
   * want to be asked. An intake is a nicety; reaching the assistant is not.
   */
  release?: boolean;
  /**
   * A REPLY-PREFERENCE OFFER IS STILL OPEN. Set with `release` when the message did not choose a value:
   * the message goes to ordinary routing, and the intake stays where it was (`done` false, state
   * unchanged), so the offer is still pending for the person's next message and onboarding is NOT
   * recorded as complete. A preference has to be set, or "no preference" chosen, to finish onboarding.
   */
  pending?: boolean;
  /**
   * The preferences this step chose, keyed by preference. Present on the step that set them, so the
   * caller can tell the assistant to confirm the choice in its own voice.
   */
  preferencesSet?: Record<string, string>;
}

/**
 * Does this read as a QUESTION rather than an answer to the field we asked?
 *
 * STRUCTURAL, NOT LEXICAL, AND THAT IS THE WHOLE DESIGN. An earlier version of this matched a list of
 * English interrogatives (`what|who|when|...`) and a list of English bail phrases, which compiled one
 * language into a platform whose questions are written by the deployment in whatever language it
 * speaks. A deployment asking in Japanese would have been understood only in English.
 *
 * A terminal question mark is punctuation rather than vocabulary, so it carries across every language
 * that uses it, and a deployment that wants more can add `bail` phrases in its own words below.
 *
 * NOT A MODEL CALL, deliberately: this path is documented as deterministic and instant, and paying for
 * a classification here would put a model round-trip in front of the very question the rule protects.
 * The offer flow needs none of this - it knows its own two answers and releases everything else.
 */
function looksLikeAQuestion(message: string): boolean {
  return message.trim().endsWith('?');
}

/**
 * Begin an intake: the greeting followed by the first field's prompt. The
 * returned state must be stored (with its subject) so the next turn resumes at
 * the first field.
 */
export function startIntake(config: IntakeConfig, greeting?: string): IntakeStep {
  // THE OPENING LINE IS THE CALLER'S WHEN IT HAS ONE.
  //
  // The router composes the orientation welcome - who the assistant is, what access this room carries,
  // example prompts, the platform note - and passes it here. An intake then ADDS its question to that
  // welcome instead of replacing it, which is what it used to do: the intake replied and the welcome
  // was never rendered, so configuring an intake silently cost a deployment all of its orientation.
  //
  // Falls back to the config's own `greeting` when no welcome is supplied, so the pure engine and its
  // tests stay callable without one.
  const opening = greeting?.trim() || config.greeting || say(config, 'greeting');

  // AN OFFER SHORT-CIRCUITS THE FIELD FLOW. `phase: 'confirming'` with no fields asked is exactly
  // what an offer is - a yes/no awaiting an answer - so it reuses the phase rather than inventing a
  // fourth one, and `asked: []` records that no field was ever put to this person.
  if (config.offer) {
    return {
      reply: `${opening}\n\n${config.offer.ask}`,
      state: { cursor: 0, collected: {}, phase: 'confirming', asked: [] },
      done: false,
    };
  }
  const first = config.fields[0];
  return {
    reply: `${opening}\n\n${first.prompt}`,
    state: { cursor: 0, collected: {}, phase: 'collecting', asked: config.fields.map((f) => f.key) },
    done: false,
  };
}

/**
 * The copy an offer answers with, plus the access line when we can say something true about access.
 *
 * `reaches` is the platform's answer to "does this person's clearance extend beyond the conversation
 * they are in", and `undefined` means it could not be established - see `IntakeOffer.accessHas`.
 */
function offerReply(offer: IntakeOffer, accepted: boolean, reaches: boolean | undefined): string {
  if (!accepted) return offer.onDecline;
  const access = reaches === undefined
    ? undefined
    : (reaches ? offer.accessHas : offer.accessNeeds);
  return access ? `${offer.onAccept}\n\n${access}` : offer.onAccept;
}

/** One of the intake's own lines, from the `onboarding-intake` template in the assistant's words. */
function say(config: IntakeConfig, form: string, values: Record<string, unknown> = {}): string {
  return templateLine('onboarding-intake', config.words, { form, values });
}

function summarize(config: IntakeConfig, collected: Record<string, string>): string {
  const lines = config.fields.map((f) => {
    const v = collected[f.key];
    const shown = f.preference && v ? (REPLY_PREFERENCES[f.preference]?.values[v]?.label ?? v) : v;
    return `- ${f.prompt.replace(/\?$/, '')}: ${shown && shown.length ? shown : templateLine('onboarding-intake', config.words, { section: 'label.skipped' })}`;
  });
  return `${say(config, 'summary')}\n${lines.join('\n')}\n\n${say(config, 'confirm')}`;
}

function completionMessage(config: IntakeConfig, userName?: string): string {
  const name = userName && userName !== 'there' ? userName : '';
  if (config.completion) return config.completion.replace(/\{name\}/g, name).replace(/\s{2,}/g, ' ').trim();
  return say(config, 'complete', { name });
}

/**
 * Advance the intake by one user turn. Pure: given the current state and the
 * user's message, returns the reply and the next state.
 *
 * - collecting: records the answer to the current field (re-asks a required
 *   field left blank or failing its pattern; accepts skip on optional fields),
 *   then either asks the next field or moves to the confirmation summary.
 * - confirming: yes ⇒ done (hand off); no ⇒ restart from the first field;
 *   unclear ⇒ re-ask the summary.
 */
export function advanceIntake(
  config: IntakeConfig,
  state: IntakeState,
  userMessage: string,
  userName?: string,
  /** Does this person's clearance reach beyond the conversation's own classification? `undefined`
   *  when it could not be resolved, which suppresses the access line rather than guessing at it. */
  reachesBeyond?: boolean,
): IntakeStep {
  const message = (userMessage || '').trim();
  // ── A REPLY-PREFERENCE OFFER, CHECKED BEFORE THE ESCAPE ───────────────────────────────────────
  //
  // An offer never blocks anything: a message that is not, on its own, one of the offered answers goes
  // straight to the assistant (`release`) and the offer stays open (`pending`), so a question, a
  // request or a stray "ok" is answered as ever. Only a message that IS an answer, by the strict match,
  // sets the preference. When every field is a preference there is no summary to confirm: the step that
  // sets the last one finishes the intake and hands the turn to the assistant to confirm it in its own
  // voice.
  const current = state.phase === 'collecting' ? config.fields[state.cursor] : undefined;
  if (current?.preference) {
    const value = resolvePreferenceAnswer(current.preference, message);
    if (!value) return { reply: '', state, done: false, release: true, pending: true };
    const collected = { ...state.collected, [current.key]: value };
    const next = state.cursor + 1;
    const preferencesSet = { [current.preference]: value };
    if (next < config.fields.length) {
      return { reply: config.fields[next].prompt, state: { ...state, cursor: next, collected }, done: false, preferencesSet };
    }
    if (config.fields.every((f) => f.preference)) {
      return { reply: '', state: { ...state, cursor: next, collected, phase: 'done' }, done: true, release: true, preferencesSet };
    }
    return { reply: summarize(config, collected), state: { ...state, cursor: next, collected, phase: 'confirming' }, done: false, preferencesSet };
  }

  // ── AN ESCAPE, AND IT COMES BEFORE EVERY PHASE ────────────────────────────────────────────────
  //
  // Checked first so it works wherever somebody is stuck, which is the whole point: the reported trap
  // was in `confirming`, where only yes/no advanced anything, but a person who wants out of a question
  // says so at whatever point they lost patience.
  //
  // A QUESTION IS AN ESCAPE TOO, and that is the half that fixes the report. Somebody typing "What is
  // AgentEchelon?" is not answering "what should I cover in reports" - they are asking the assistant
  // something, and the assistant is what they should get.
  const bail = (config.bail || []).some((w) => w.trim().toLowerCase() === message.toLowerCase());
  const released = bail || looksLikeAQuestion(message);
  if (released) {
    return {
      // Not sent: `release` tells the caller to route this turn normally instead of replying here.
      reply: '',
      state: { ...state, phase: 'done' },
      done: true,
      release: true,
    };
  }

  // ── AN OFFER IS ANSWERED ONCE, EITHER WAY ─────────────────────────────────────────────────────
  //
  // Both answers COMPLETE onboarding, which is the whole point of offering rather than asking: "no"
  // is a real answer and re-offering next time would make it a question they have to keep declining.
  // Nothing is collected, so there is no summary and nothing to confirm.
  //
  // An ambiguous reply re-asks once (below). The escape above already released anything that reads as
  // a question, so somebody who answers the offer with a question reaches the assistant instead.
  if (config.offer && state.phase === 'confirming') {
    const said = (list: string[]) => list.some((w) => w.trim().toLowerCase() === message.toLowerCase());
    const accepted = said(config.offer.affirmative);
    if (accepted || said(config.offer.negative)) {
      return {
        reply: offerReply(config.offer, accepted, reachesBeyond),
        state: { ...state, phase: 'done' },
        done: true,
      };
    }
    // ── ANYTHING THAT IS NOT AN ANSWER IS RELEASED, AND THAT NEEDS NO VOCABULARY ────────────────
    //
    // An offer has exactly two answers, both supplied by the deployment. A message that is neither is
    // something else the person wanted to say, so it goes to the assistant rather than being met with
    // the question again.
    //
    // THIS IS WHY THE OFFER PATH CARRIES NO LANGUAGE-SPECIFIC MATCHING AT ALL. It does not need to
    // recognise a question, or a refusal, or an "I do not understand" - it only needs to know its own
    // two answers, and everything else is by definition not for it. A person who types a question, or
    // asks to be left alone, or answers in a language the config did not anticipate, reaches the
    // assistant either way, and the offer is closed rather than re-asked.
    return {
      reply: '',
      state: { ...state, phase: 'done' },
      done: true,
      release: true,
    };
  }

  if (state.phase === 'confirming') {
    const verdict = classifyConfirmDeclineReply(message);
    if (verdict === 'affirmative') {
      return {
        reply: completionMessage(config, userName),
        state: { ...state, phase: 'done' },
        done: true,
      };
    }
    if (verdict === 'negative') {
      const first = config.fields[0];
      return {
        reply: `${say(config, 'redo')}\n\n${first.prompt}`,
        // The same questions again, so the pinned list survives the restart.
        state: { ...state, cursor: 0, collected: {}, phase: 'collecting' },
        done: false,
      };
    }
    // ambiguous — re-ask the summary without losing anything
    return {
      reply: `${say(config, 'confirmAgain')}\n\n${summarize(config, state.collected)}`,
      state,
      done: false,
    };
  }

  // phase === 'collecting'
  const field = config.fields[state.cursor];
  // Defensive: cursor out of range ⇒ fall to confirmation rather than crash.
  if (!field) {
    return { reply: summarize(config, state.collected), state: { ...state, phase: 'confirming' }, done: false };
  }

  const isSkip = message.length === 0 || SKIP_RE.test(message);
  if (isSkip) {
    if (field.required) {
      return { reply: `${say(config, 'required')} ${field.prompt}`, state, done: false };
    }
    // optional + skipped: record nothing, advance
    return advanceToNext(config, { ...state, collected: { ...state.collected } });
  }

  if (field.required && field.pattern) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(field.pattern, 'i');
    } catch {
      re = null; // a bad pattern in config must not block intake
    }
    if (re && !re.test(message)) {
      return { reply: `${say(config, 'invalid', { example: field.example })} ${field.prompt}`, state, done: false };
    }
  }

  const collected = { ...state.collected, [field.key]: message };
  return advanceToNext(config, { ...state, collected });
}

/**
 * The collected answers split by where they are stored: preference fields under `preferences`, keyed by
 * the PREFERENCE (not the field key), everything else under `facts`.
 */
export function splitCollected(
  config: IntakeConfig,
  collected: Record<string, string>,
): { facts: Record<string, string>; preferences: Record<string, string> } {
  const facts: Record<string, string> = {};
  const preferences: Record<string, string> = {};
  for (const [key, value] of Object.entries(collected)) {
    const field = config.fields.find((f) => f.key === key);
    if (field?.preference) preferences[field.preference] = value;
    else facts[key] = value;
  }
  return { facts, preferences };
}

/** Move to the next field, or to the confirmation summary when fields run out. */
function advanceToNext(config: IntakeConfig, state: IntakeState): IntakeStep {
  const next = state.cursor + 1;
  if (next < config.fields.length) {
    return {
      reply: config.fields[next].prompt,
      state: { ...state, cursor: next },
      done: false,
    };
  }
  return {
    reply: summarize(config, state.collected),
    state: { ...state, cursor: next, phase: 'confirming' },
    done: false,
  };
}

/**
 * The stored intake, re-validated rather than trusted. Returns null when absent or malformed, which the
 * caller reads as "no intake in progress" - never as an answer to the first question.
 */
export function parseStoredIntake(value: unknown): StoredIntake | null {
  const parsed = value as Partial<StoredIntake> | null | undefined;
  if (
    parsed
    && typeof parsed === 'object'
    && typeof parsed.subject === 'string'
    && parsed.subject.length > 0
    && typeof parsed.cursor === 'number'
    && parsed.collected
    && typeof parsed.collected === 'object'
    && (parsed.phase === 'collecting' || parsed.phase === 'confirming' || parsed.phase === 'done')
  ) {
    const asked = Array.isArray(parsed.asked) && parsed.asked.every((k) => typeof k === 'string')
      ? parsed.asked
      : undefined;
    return {
      subject: parsed.subject,
      cursor: parsed.cursor,
      collected: parsed.collected as Record<string, string>,
      phase: parsed.phase,
      ...(asked ? { asked } : {}),
    };
  }
  return null;
}
