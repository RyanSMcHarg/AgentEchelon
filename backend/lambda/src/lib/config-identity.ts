/**
 * Config identity.
 *
 * The diagnosis pivot: from "which MODEL performs best" to "which CONFIG performs best", where a
 * config = persona + intent pack (+ its per-intent response settings) + the assembled base system
 * prompt. To slice quality by config, every quality record (analytics turn, eval result, battle
 * outcome) is stamped with a stable `configId` computed HERE — a single deterministic algorithm so a
 * record produced by the processor, the eval runner, or a battle is comparable.
 *
 * STABILITY CONTRACT — `configId` is a *deployment/classification* fingerprint, not a per-turn value. It is
 * derived ONLY from config inputs that change on a (re)deploy:
 *   - persona     : the configured persona/system-prompt value (the SSM param), default-aware.
 *   - intentPack  : the raw pack JSON. NB this ALREADY contains each intent's `maxTokens`/`verbosity`
 *                   (P3), so the pack hash subsumes the plan's separate "responseSettings" component —
 *                   no per-turn response settings enter the id (that would make it per-intent).
 *   - systemPrompt: the assembled BASE system prompt actually sent (persona-or-default), NOT the
 *                   per-turn prompt with context/task sections appended.
 * Hashing component-then-join keeps it order-stable and lets two producers each contribute the pieces
 * they hold (the handler has the pack; the processor has the resolved persona) without drift.
 *
 * Privacy (open question 4): the stamped fields are SHORT HASHES, never the persona/pack text — a
 * quality record never carries config content, only its fingerprint.
 */
import { createHash } from 'node:crypto';

/** Stamped onto every quality record so it is attributable to the config that produced it. */
export interface ConfigIdentity {
  /** The slice key — hash over persona + intentPack + assembled-system-prompt component versions. */
  configId: string;
  /** Short hash of the configured persona value; the literal `'default'` when none is set. */
  personaVersion: string;
  /** Short hash of the raw intent-pack JSON (incl. per-intent response settings); `'default'` when none. */
  intentPackVersion: string;
  /** Short hash of the assembled base system prompt actually sent. */
  systemPromptHash: string;
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Short, stable version for one config component. An empty/whitespace value ⇒ the `fallbackLabel`
 * (default `'default'`) so a record reads "running the platform default", not a hash of empty string.
 */
export function componentVersion(value: string | undefined | null, fallbackLabel = 'default'): string {
  const v = value?.trim();
  return v ? sha256hex(v).slice(0, 12) : fallbackLabel;
}

/**
 * Combine already-derived component versions into a `ConfigIdentity`. Pure + deterministic: the same
 * inputs always yield the same `configId`. Producers that hold only some components pass `'default'`
 * for the rest (e.g. the analytics path has no pack version on a deploy without a pack).
 */
export function buildConfigIdentity(input: {
  personaVersion: string;
  intentPackVersion: string;
  systemPromptHash: string;
}): ConfigIdentity {
  const configId = sha256hex(
    [input.personaVersion, input.intentPackVersion, input.systemPromptHash].join('|'),
  ).slice(0, 16);
  return {
    configId,
    personaVersion: input.personaVersion,
    intentPackVersion: input.intentPackVersion,
    systemPromptHash: input.systemPromptHash,
  };
}

/**
 * Derive a full `ConfigIdentity` from raw config inputs in one call (the convenience the processor
 * uses). `persona`/`intentPackRaw` are the configured values (undefined ⇒ default); `systemPrompt`
 * is the assembled BASE prompt actually sent. `defaultPersona`, when supplied and equal to the
 * resolved base prompt, forces `personaVersion='default'` so a fall-through to the platform default
 * is recorded as default rather than as a hash of the default text.
 */
export function deriveConfigIdentity(input: {
  persona?: string;
  intentPackRaw?: string;
  systemPrompt: string;
  defaultPersona?: string;
}): ConfigIdentity {
  const isDefaultPersona =
    !input.persona?.trim() ||
    (input.defaultPersona !== undefined && input.persona.trim() === input.defaultPersona.trim());
  return buildConfigIdentity({
    personaVersion: isDefaultPersona ? 'default' : componentVersion(input.persona),
    intentPackVersion: componentVersion(input.intentPackRaw),
    systemPromptHash: componentVersion(input.systemPrompt, 'empty'),
  });
}
