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
 * - **State in Lex `sessionAttributes`.** The cursor + collected values ride in
 *   `event.sessionState.sessionAttributes` (Lex carries it across turns for
 *   free; no per-turn DynamoDB hit). The engine here is a PURE function over
 *   that state, so it unit-tests without any AWS mock.
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

import { classifyConfirmDeclineReply } from './routing-state.js';

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
}

/** Per-deployment intake definition. Absent ⇒ onboarding is disabled. */
export interface IntakeConfig {
  /** Opening line, shown before the first field's prompt. */
  greeting: string;
  /** Ordered fields to collect. Empty ⇒ disabled. */
  fields: IntakeField[];
  /**
   * Closing line once the summary is confirmed. `{name}` interpolates the
   * user's display name when known. Defaults to a generic hand-off.
   */
  completion?: string;
}

/** Intake progress, serialised into a single sessionAttributes slot. */
export interface IntakeState {
  /** Index of the field whose answer we are currently awaiting. */
  cursor: number;
  /** Answers collected so far, keyed by `IntakeField.key`. */
  collected: Record<string, string>;
  /** collecting = asking fields; confirming = awaiting yes/no on the summary. */
  phase: 'collecting' | 'confirming' | 'done';
}

/** The sessionAttributes key the intake state rides in. */
export const INTAKE_STATE_ATTR = 'AE_ONBOARDING';

// Answers that mean "skip this optional field" (case-insensitive, whole-string).
const SKIP_RE = /^(skip|none|n\/?a|na|-)$/i;

const loadCache: { config: IntakeConfig | null; loaded: boolean } = { config: null, loaded: false };

/**
 * Resolve the deployment's intake config. Reads inline `ONBOARDING_INTAKE`
 * (JSON) first, then falls back to an SSM parameter named by
 * `ONBOARDING_INTAKE_PARAM`. Returns null (disabled) when neither is set or the
 * JSON is malformed / has no fields. Cached for the Lambda's warm life.
 *
 * `ssmGet` is injected so the router can pass its own SSM client; omitted in
 * unit tests (which exercise the pure engine, not the loader).
 */
export async function loadIntakeConfig(
  ssmGet?: (name: string) => Promise<string | undefined>,
): Promise<IntakeConfig | null> {
  if (loadCache.loaded) return loadCache.config;
  loadCache.loaded = true;
  loadCache.config = await resolveIntakeConfig(ssmGet);
  return loadCache.config;
}

/** Test hook: clear the warm intake-config cache. */
export function __clearIntakeConfigCache(): void {
  loadCache.loaded = false;
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
    });
  }
  if (clean.length === 0) return null; // no fields ⇒ nothing to intake ⇒ disabled
  return {
    greeting: typeof obj.greeting === 'string' && obj.greeting.trim() ? obj.greeting.trim() : 'Welcome! I just need a few details before we begin.',
    fields: clean,
    completion: typeof obj.completion === 'string' && obj.completion.trim() ? obj.completion.trim() : undefined,
  };
}

/** True when a usable intake config is present. */
export function isOnboardingEnabled(config: IntakeConfig | null): config is IntakeConfig {
  return !!config && config.fields.length > 0;
}

// ---------------------------------------------------------------------------
// The engine (pure). No AWS, no I/O — drives the FSM from (config, state, msg).
// ---------------------------------------------------------------------------

/** The reply text + the next state to persist. `done` ⇒ hand off to the assistant. */
export interface IntakeStep {
  reply: string;
  state: IntakeState;
  done: boolean;
}

/**
 * Begin an intake: the greeting followed by the first field's prompt. The
 * returned state must be persisted into sessionAttributes so the next turn
 * resumes at the first field.
 */
export function startIntake(config: IntakeConfig): IntakeStep {
  const first = config.fields[0];
  return {
    reply: `${config.greeting}\n\n${first.prompt}`,
    state: { cursor: 0, collected: {}, phase: 'collecting' },
    done: false,
  };
}

function summarize(config: IntakeConfig, collected: Record<string, string>): string {
  const lines = config.fields.map((f) => {
    const v = collected[f.key];
    return `- ${f.prompt.replace(/\?$/, '')}: ${v && v.length ? v : '(skipped)'}`;
  });
  return `Here is what I have:\n${lines.join('\n')}\n\nIs this correct? (yes / no)`;
}

function completionMessage(config: IntakeConfig, userName?: string): string {
  const name = userName && userName !== 'there' ? userName : '';
  if (config.completion) return config.completion.replace(/\{name\}/g, name).replace(/\s{2,}/g, ' ').trim();
  return name
    ? `Thanks, ${name} — you're all set. How can I help?`
    : `Thanks — you're all set. How can I help?`;
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
): IntakeStep {
  const message = (userMessage || '').trim();

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
        reply: `No problem — let's redo it.\n\n${first.prompt}`,
        state: { cursor: 0, collected: {}, phase: 'collecting' },
        done: false,
      };
    }
    // ambiguous — re-ask the summary without losing anything
    return {
      reply: `Please reply "yes" to confirm or "no" to start over.\n\n${summarize(config, state.collected)}`,
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
      return { reply: `That one is required. ${field.prompt}`, state, done: false };
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
      const hint = field.example ? ` (for example: ${field.example})` : '';
      return { reply: `That doesn't look right${hint}. ${field.prompt}`, state, done: false };
    }
  }

  const collected = { ...state.collected, [field.key]: message };
  return advanceToNext(config, { ...state, collected });
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

/** Read the intake state out of sessionAttributes. Returns null when absent/corrupt. */
export function readIntakeState(sessionAttributes?: Record<string, string>): IntakeState | null {
  const raw = sessionAttributes?.[INTAKE_STATE_ATTR];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IntakeState;
    if (
      parsed &&
      typeof parsed.cursor === 'number' &&
      parsed.collected &&
      typeof parsed.collected === 'object' &&
      (parsed.phase === 'collecting' || parsed.phase === 'confirming' || parsed.phase === 'done')
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Serialise the intake state for the sessionAttributes slot. */
export function writeIntakeState(state: IntakeState): Record<string, string> {
  return { [INTAKE_STATE_ATTR]: JSON.stringify(state) };
}
