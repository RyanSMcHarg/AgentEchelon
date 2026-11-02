/**
 * WHAT A WORKFLOW BINDS TO: the one reader of a binding, shared by a platform-filled template's fields
 * (SPEC-DOCUMENT-TEMPLATES FR9) and a declared step action's arguments (SPEC-TASK-STATE-TRANSITIONS
 * FR29), so the two cannot come to mean different things by the same words.
 *
 * A binding is `<kind>:<key>`:
 *  - `requirement:<need>` reads a SOURCED requirement, `details.collectedRequirements[need].value`: a value
 *    the person gave, or a retrieved passage supplied, with its evidence. Never one the model filled in.
 *  - `detail:<key>` reads a top-level string or number on the task's details.
 *  - `tool:<state>.<path>` reads the result a declared action recorded on entering `<state>`
 *    (`details.actions[state].result`), walking `<path>` by object key or array index. Only a
 *    successful run binds: a failed action has no result to read.
 *  - `literal:<text>` is the text itself (an action argument only; a template's body is already literal).
 *  - ADR-060's variable sources, `<kind>:<key>` with a kind among `VARIABLE_BINDING_KINDS` (`person:displayName`,
 *    `conversation:type`, `ctx:<source>.<field>`, ...). The grammar is this one, so a template field, a version's
 *    variable and a step's binding name a value the same way. Such a binding is not read from the task's details:
 *    the variable resolver (`variables.ts`) reads it under the classification's own grants and hands its value in.
 *
 * Everything here is pure and reads only what the task recorded. Nothing reads what a person or a model
 * wrote to decide anything (tenet D11): a binding is a lookup by a key the workflow's author declared.
 */

/** The kinds a task records: what a step reads from the task's own details. */
export const TASK_BINDING_KINDS = ['requirement', 'detail', 'tool', 'literal'] as const;
/** ADR-060's variable sources (decision 1): read by the variable resolver, never from a task's details. */
export const VARIABLE_BINDING_KINDS = [
  'person', 'conversation', 'host', 'ctx', 'fact', 'pref', 'signal', 'event',
  'participant', 'participantRole', 'invitation', 'meeting', 'task',
] as const;
export const BINDING_KINDS = [...TASK_BINDING_KINDS, ...VARIABLE_BINDING_KINDS] as const;
export type TaskBindingKind = (typeof TASK_BINDING_KINDS)[number];
export type VariableBindingKind = (typeof VARIABLE_BINDING_KINDS)[number];
export type BindingKind = (typeof BINDING_KINDS)[number];

/**
 * A version's variable name (ADR-060 decision 1, slice 1b): no colon, so it never reads as a source, and the
 * `{{field}}` grammar accepts it. A template field may bind one, and the resolver reads it through the version.
 */
export const VARIABLE_NAME = /^[a-z][A-Za-z0-9_]{0,47}$/;

/**
 * True for a template field binding the variable resolver supplies: a source in the variable grammar, or a
 * version's variable by name. Every other binding (`value:<type>`, `assistant:displayName`) is the call site's.
 */
export function isResolverBinding(binding: unknown): binding is string {
  return typeof binding === 'string' && (VARIABLE_NAME.test(binding) || isVariableBinding(parseBinding(binding, VARIABLE_BINDING_KINDS)));
}

/** True for a binding the variable resolver reads rather than the task's details. */
export function isVariableBinding(binding: ParsedBinding | null | undefined): boolean {
  return !!binding && (VARIABLE_BINDING_KINDS as readonly string[]).includes(binding.kind);
}

/** A binding as its parts, or null when the string is not one. */
export interface ParsedBinding {
  kind: BindingKind;
  key: string;
  /** For `tool:` only: the state whose action recorded the result, and the path inside it. */
  state?: string;
  path?: string[];
}

/** `<state>.<path>`: a state name, then one or more dot-separated keys or indices. */
const TOOL_KEY = /^([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)+)$/;

/**
 * Parse a binding string. Null when it is not `<kind>:<key>` with a known kind and a non-empty key, or a
 * `tool:` key that does not name a state and a path. The caller says which kinds it accepts.
 */
export function parseBinding(value: unknown, kinds: readonly BindingKind[] = BINDING_KINDS): ParsedBinding | null {
  if (typeof value !== 'string') return null;
  const at = value.indexOf(':');
  if (at <= 0) return null;
  const kind = value.slice(0, at) as BindingKind;
  if (!(kinds as readonly string[]).includes(kind)) return null;
  const key = kind === 'literal' ? value.slice(at + 1) : value.slice(at + 1).trim();
  if (!key) return null;
  if (kind === 'tool') {
    const m = TOOL_KEY.exec(key);
    if (!m) return null;
    return { kind, key, state: m[1], path: m[2].slice(1).split('.') };
  }
  return { kind, key };
}

/** The action record a state's entry wrote (`details.actions[state]`), as far as a binding reads it. */
interface RecordedAction {
  ok?: unknown;
  result?: unknown;
}

/** Walk an object by keys and array indices. Undefined as soon as a step does not exist. */
function walk(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const step of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(step)) return undefined;
      cur = cur[Number(step)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[step];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * What a binding resolves to on this task's details, as text: a non-empty string, a finite number or a
 * boolean. Anything else (absent, empty, an object, a failed action's result) is `undefined`, which every
 * caller treats as UNBOUND and refuses rather than filling with a gap.
 *
 * A variable binding reads `variables`, the values the resolver already inserted by source name
 * (`resolveTemplateFields` in `variables.ts`), and never the task's details: a person's display name is not
 * something a task records. Absent there, it is unbound.
 */
export function resolveBinding(
  binding: ParsedBinding,
  details: Record<string, unknown> | undefined,
  variables?: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let value: unknown;
  if (isVariableBinding(binding)) {
    const source = `${binding.kind}:${binding.key}`;
    value = variables && Object.prototype.hasOwnProperty.call(variables, source) ? variables[source] : undefined;
  } else if (binding.kind === 'literal') {
    value = binding.key;
  } else if (binding.kind === 'requirement') {
    const collected = (details?.collectedRequirements ?? {}) as Record<string, { value?: unknown } | undefined>;
    value = collected[binding.key]?.value;
  } else if (binding.kind === 'detail') {
    value = details?.[binding.key];
  } else if (binding.kind === 'tool') {
    const record = ((details?.actions ?? {}) as Record<string, RecordedAction | undefined>)[binding.state ?? ''];
    value = record && record.ok === true ? walk(record.result, binding.path ?? []) : undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value.trim() ? (binding.kind === 'literal' ? value : value.trim()) : undefined;
  return undefined;
}
