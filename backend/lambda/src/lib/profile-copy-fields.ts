/**
 * THE SHAPE CHECKS FOR `copy`, `welcome` AND `messages` ON THE WRITE PATH.
 *
 * `copy` is retired (ADR-062): what an assistant says is its message templates, edited in the console's Message
 * templates section or with `npm run template`, and which template a message is said from is the version's
 * `messages`. A draft refuses a `copy` line, naming `npm run migrate-legacy-copy`, which makes each line a stored
 * version holds its assistant's own template; `copy: null` clears what a cloned version carried.
 *
 * The shape checks run on a DRAFT PATCH only (`editDraft`). They are not part of `validateDefinitionBody`,
 * which also runs on the read path, where refusing a stored version would fall a serving assistant back to
 * its seed over a wording problem. A stored version's `copy` is refused when the draft is validated and
 * activated (`retiredCopyErrors`), and read by the migration alone.
 *
 * `welcome` is retired too (W1): the welcome is the version's `assistant-joined` workflow, which `WelcomeIntent` starts.
 * A draft, validate, activate, an experiment's variant, an import and a rollback refuse a version that carries one,
 * naming `npm run migrate-legacy-welcome` (`retiredWelcomeErrors`).
 */
import type { ProfileDefinitionBody } from './active-profile.js';
import { versionEventWorkflowsErrors } from './event-workflow.js';
import { versionVariablesShapeErrors } from './variables.js';
import { TEMPLATE_NAME } from './document-template.js';
import { isMessageFamilyChoice } from './message-template.js';
import { shippedMessageTemplates } from './shipped-message-templates.js';

/** The command that makes a version's retired `copy` lines its assistant's own templates. */
export const MIGRATE_LEGACY_COPY = 'npm run migrate-legacy-copy';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Why a version's `copy` is refused, or nothing: any line in it. An empty object holds no line, so it is not refused. */
export function retiredCopyErrors(copy: unknown): string[] {
  if (copy === undefined || copy === null) return [];
  if (isObject(copy) && Object.keys(copy).length === 0) return [];
  const keys = isObject(copy) ? Object.keys(copy) : [];
  return [
    `copy is retired${keys.length ? ` (it holds ${keys.join(', ')})` : ''}: what this assistant says is its message templates. `
    + `Run \`${MIGRATE_LEGACY_COPY}\` to make each line this assistant's own template, then clear copy from the draft (copy: null).`,
  ];
}

/** The command that carries a version's retired `welcome` into its welcome workflows (W1). */
export const MIGRATE_LEGACY_WELCOME = 'npm run migrate-legacy-welcome';

/**
 * Why a version's `welcome` is refused, or nothing (W1): the welcome is the version's `assistant-joined` workflow, which
 * `WelcomeIntent` starts, so a separate `welcome` is read by nothing. `welcome: null` clears what a cloned version carried.
 */
export function retiredWelcomeErrors(welcome: unknown): string[] {
  if (welcome === undefined || welcome === null) return [];
  return [
    'welcome is retired: the welcome is this assistant\'s assistant-joined workflow in eventWorkflows, whose opening is a '
    + `template step (opening), a prompt step, or steps that greet and then continue. Run \`${MIGRATE_LEGACY_WELCOME}\` to `
    + 'carry this welcome into its workflows, or clear it from the draft (welcome: null).',
  ];
}

/**
 * Why a patched `messages` map is refused, or nothing: each key is a template the platform ships and each value
 * a template name, or a family (`@classification`, `@shipped`). Whether the named template is active in the assistant's family and fits is checked at
 * validate and activate (`messageTemplateErrors`), where the store is read.
 */
export function messagesShapeErrors(messages: unknown): string[] {
  if (!isObject(messages)) return ['messages must map a message template\'s name to one of this assistant\'s templates'];
  const errs: string[] = [];
  const shipped = shippedMessageTemplates();
  for (const [k, v] of Object.entries(messages)) {
    if (!shipped.has(k)) errs.push(`messages.${k} is not a message template the platform says`);
    errs.push(...messageEntryShapeErrors(`messages.${k}`, v));
  }
  return errs;
}

/**
 * Why one `messages` entry is refused as written: a template name, or a non-empty list of `{ template, when }` whose
 * last alternative alone carries no `when`, so a failed read still names a template. The conditions' own rules are
 * checked where the classification's sources are read (`messageTemplateErrors`).
 */
function messageEntryShapeErrors(at: string, v: unknown): string[] {
  if (typeof v === 'string') return TEMPLATE_NAME.test(v) || isMessageFamilyChoice(v) ? [] : [`${at} must name a template (lowercase letters, digits and hyphens), @classification or @shipped`];
  if (!Array.isArray(v) || !v.length) return [`${at} names a template, or lists { template, when } alternatives`];
  const errs: string[] = [];
  v.forEach((c, i) => {
    const cat = `${at}[${i}]`;
    if (!isObject(c)) { errs.push(`${cat} is { template, when }`); return; }
    for (const key of Object.keys(c)) if (key !== 'template' && key !== 'when') errs.push(`${cat}.${key} is not a field of an alternative; it is { template, when }`);
    if (typeof c.template !== 'string' || !(TEMPLATE_NAME.test(c.template) || isMessageFamilyChoice(c.template))) errs.push(`${cat}.template must name a template (lowercase letters, digits and hyphens), @classification or @shipped`);
    const last = i === v.length - 1;
    if (last && c.when !== undefined) errs.push(`${cat} is the last alternative, which carries no when, so a failed read still names a template`);
    if (!last && c.when === undefined) errs.push(`${cat} carries no when, so the alternatives after it are never said`);
  });
  return errs;
}

/** The draft patch's own refusals for the fields the console edits directly. Null clears a field. */
export function patchShapeErrors(
  patch: Partial<ProfileDefinitionBody> | Record<string, unknown>,
  /** The task machines the runtime runs (ADR-063), which a task step's machine is checked against. Absent, the platform's. */
  opts: { machines?: Readonly<Record<string, import('./task-state-machines.js').TaskStateMachine>> } = {},
): string[] {
  const p = patch as Record<string, unknown>;
  return [
    ...retiredCopyErrors(p.copy),
    ...retiredWelcomeErrors(p.welcome),
    ...(p.messages !== undefined && p.messages !== null ? messagesShapeErrors(p.messages) : []),
    ...(p.eventWorkflows !== undefined && p.eventWorkflows !== null ? versionEventWorkflowsErrors(p.eventWorkflows, opts.machines ? { machines: opts.machines } : {}) : []),
    // What each variable's source publishes is checked at validate, activate and import, where the catalog is read.
    ...(p.variables !== undefined && p.variables !== null ? versionVariablesShapeErrors(p.variables) : []),
  ];
}
