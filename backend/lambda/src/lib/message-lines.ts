/**
 * ONE LINE OF A MESSAGE TEMPLATE, WHERE THE CALL SITE IS SYNCHRONOUS (ADR-062 decisions 3, 5 and 6).
 *
 * A line an assistant says on the fast path (a queue notice, a stop, a placeholder, a quick reply) is composed
 * inside code that cannot wait on the store. The store is read once, where the call site resolves the assistant's
 * version (`loadMessageTemplateSet`, `message-template-selection.ts`), and the set it returns is handed here with
 * version (`loadMessageTemplateSet`, `message-template-selection.ts`), and the set it returns is handed here, directly
 * or carried by the turn's words object (`withMessageTemplates`); the order is the one every message follows
 * (`chooseMessageTemplate`): the template the version's `messages` names, the assistant's own, the classification's, a
 * deployment-wide line, then the shipped. With no set, the shipped template answers.
 *
 * THE FORM IS CHOSEN BY DATA, NEVER BY ENGLISH. A count selects `chat.one` or `chat.other` by the template
 * language's CLDR plural category (`Intl.PluralRules`), and `chat.none` when it is zero and the template has one;
 * a call site that knows which case it is in (a farewell, a starter) names the form. Nothing here builds grammar.
 *
 * PURE: the console's editor previews with it.
 */
import type { ParsedTemplate } from './document-template.js';
import { chooseMessageName, chooseMessageTemplate, messageFamilies, renderMessageTemplate, type MessageOrigin, type VersionMessages } from './message-template.js';
import { shippedMessageTemplate } from './shipped-message-templates.js';
import { resolveTemplateFields, whenHolds, type GateResolution, type When } from './variables.js';
import type { CallSiteCapabilities } from './context-source-shapes.js';
import { chooseLanguage } from './message-language.js';

/** The templates an assistant's family and its classification hold, by name, read once for a turn. */
export interface MessageTemplateSet {
  own: ReadonlyMap<string, ParsedTemplate>;
  classwide: ReadonlyMap<string, ParsedTemplate>;
  /** The version's `messages`: which of the assistant's own templates, or which family, a message is said from. */
  messages?: VersionMessages;
  /**
   * WHAT THE TURN'S RESOLVER HOLDS (ADR-060, slice 1d): a field a template binds to a source or to one of the version's
   * variables is read through it (`resolveTemplateFields`), and a value the call site passes stands over it. A line
   * here states no audience, so it is resolved as one the room reads: a fact about a person renders empty.
   */
  resolver?: LineResolver;
}

/** The resolver a turn hands its lines: its lookup, the version's variables, the values it holds and its call site. */
export type LineResolver = Omit<GateResolution, 'site'> & { callSite: CallSiteCapabilities };

/**
 * What a line is worded from: the stored templates the call site read, handed directly (`templates`) or carried by the
 * turn's words object (`copy`, `withMessageTemplates`). Nothing a version stores under `copy` is read as wording.
 */
export interface VersionWords {
  copy?: object | null;
  templates?: MessageTemplateSet;
}

/**
 * THE TURN'S WORDS CARRY ITS STORED TEMPLATES. A turn reads its set once and hands one words object (named `copy` along
 * the signatures it travels) to every line it says; the set rides that object under a key no JSON or version field
 * can hold, so each line reaches the stored templates without a second parameter on every function between. An object
 * that crosses a payload loses the set, and its lines answer from the shipped templates.
 */
const STORED_TEMPLATES = Symbol.for('agent-echelon.message-templates');

/** A words object carrying the turn's stored templates, and nothing else. */
export function withMessageTemplates<T extends object>(templates: MessageTemplateSet): T {
  const carried = {} as T;
  Object.defineProperty(carried, STORED_TEMPLATES, { value: templates, enumerable: false });
  return carried;
}

/** The stored templates a turn's words object carries, when the turn read them. */
export function templatesOf(copy: object | null | undefined): MessageTemplateSet | undefined {
  return copy ? (copy as { [STORED_TEMPLATES]?: MessageTemplateSet })[STORED_TEMPLATES] : undefined;
}

/** The template a message is said from, by the selection order. */
export function messageTemplateFor(name: string, words: VersionWords = {}, deploymentLine?: string): ParsedTemplate {
  return messageTemplateChoice(name, words, deploymentLine).template;
}

/** The template a message is said from and the family it came from (`MessageOrigin`). */
export function messageTemplateChoice(name: string, words: VersionWords = {}, deploymentLine?: string): { template: ParsedTemplate; origin: MessageOrigin } {
  const shipped = shippedMessageTemplate(name);
  const t = words.templates ?? templatesOf(words.copy);
  const holds = lineHolds(t);
  const families = messageFamilies(chooseMessageName(t?.messages?.[name], holds), name);
  return chooseMessageTemplate({
    shipped,
    own: families.own ? t?.own.get(families.own) : undefined,
    holds,
    // A field bound to a source or a version variable fits where the turn's resolver reads it.
    ...(t?.resolver ? { lookup: t.resolver.lookup } : {}),
    classification: families.classification ? t?.classwide.get(name) : undefined,
    ...(deploymentLine && deploymentLine.trim() ? { deploymentLines: Object.fromEntries(Object.keys(shipped.messageSections ?? {}).filter((s) => s.startsWith('chat')).map((s) => [s, deploymentLine])) } : {}),
  });
}

/** The CLDR plural category of a count in a language, `other` where the language is not known. */
export function pluralCategory(language: string | undefined, count: number): string {
  try {
    return new Intl.PluralRules(language || 'en').select(count);
  } catch {
    return 'other';
  }
}

export interface LineOptions {
  values?: Record<string, unknown>;
  /** The section, `chat` when absent. */
  section?: string;
  /** A count that selects the section's plural form. */
  count?: number;
  /** A form the call site names, such as `thanks`. */
  form?: string;
  /** A deployment-wide line that stands between the classification's template and the shipped one. */
  deploymentLine?: string;
}

/** The section a line is rendered from: the named form, then the count's form, then the section itself. */
export function sectionFor(template: ParsedTemplate, opts: LineOptions = {}): string {
  const base = opts.section ?? 'chat';
  const has = (s: string) => Object.prototype.hasOwnProperty.call(template.messageSections ?? {}, s);
  const candidates: string[] = [];
  if (opts.form) candidates.push(`${base}.${opts.form}`);
  if (opts.count !== undefined) {
    if (opts.count === 0) candidates.push(`${base}.none`);
    candidates.push(`${base}.${pluralCategory(template.language, opts.count)}`, `${base}.other`);
  }
  candidates.push(base);
  return candidates.find(has) ?? base;
}

/**
 * One line of a message, rendered (`renderMessageTemplate`): each value checked by its field's type, a line naming
 * a field with no value left out, and a value its type refuses treated as one the call site did not have.
 */
export function templateLine(name: string, words: VersionWords = {}, opts: LineOptions = {}): string {
  const template = localizedTemplate(messageTemplateFor(name, words, opts.deploymentLine), words, 'room');
  const section = sectionFor(template, opts);
  const values = opts.count !== undefined && !('count' in (opts.values ?? {})) ? { ...opts.values, count: opts.count } : opts.values;
  const resolved = resolverValues(template, words, 'room', section);
  const rendered = renderMessageTemplate(template, { ...resolved, ...(values ?? {}) }, { sections: [section], refusedValue: 'empty' });
  return rendered.ok ? rendered.sections[section] ?? '' : '';
}

/**
 * THE TEMPLATE IN THE LANGUAGE ITS READERS GET (ADR-062 decision 4), from what the turn's resolver holds: for a line one
 * person reads, that person's preferred language first; then the conversation's; then the deployment's; then the
 * template's own. A line is said instantly, so it is the first WRITTEN language in that order (a `voice` template's
 * written text included): no line here waits on a model. With no resolver the conversation's language is not known,
 * and the deployment's, then the template's own, answer.
 */
export function localizedTemplate(template: ParsedTemplate, words: VersionWords, audience: 'room' | 'addressed'): ParsedTemplate {
  if (!template.variants) return template;
  const values = (words.templates ?? templatesOf(words.copy))?.resolver?.values ?? {};
  return chooseLanguage(template, {
    audience,
    preferred: values['person:preferredLanguage'],
    conversation: values['signal:userLanguage'],
  }).written;
}

/**
 * A shipped template's section as one line in the `{field}` form: what a
 * module that named its shipped line as a constant exports, read from the template so the two cannot differ.
 */
export function shippedLineText(name: string, section = 'chat'): string {
  return (shippedMessageTemplate(name).messageSections?.[section] ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, '{$1}');
}

/**
 * THE TEXT A TEMPLATE'S RESOLVER-BOUND FIELDS INSERT AT THIS TURN (ADR-060 decision 5), from the resolver its words
 * carry (`MessageTemplateSet.resolver`), for the readers the call site names. Empty with no resolver: the call site's
 * own values are then the only ones, as before.
 */
export function resolverValues(template: ParsedTemplate, words: VersionWords, audience: 'room' | 'addressed', section = 'chat'): Record<string, string> {
  const r = (words.templates ?? templatesOf(words.copy))?.resolver;
  if (!r) return {};
  return resolveTemplateFields(template.fields ?? {}, {
    lookup: r.lookup, ...(r.variables ? { variables: r.variables } : {}), values: r.values,
    site: { callSite: r.callSite, audience, section },
  });
}

/**
 * Whether a condition holds for a line this turn says (ADR-060 decision 6), read through the turn's resolver as the room
 * would read the line: a line states no audience, so a condition on a fact about a person does not hold here. With no
 * resolver no condition holds, and the unconditioned template answers.
 */
function lineHolds(t: MessageTemplateSet | undefined): (when: When) => boolean {
  const r = t?.resolver;
  if (!r) return () => false;
  return (when) => whenHolds(when, { lookup: r.lookup, ...(r.variables ? { variables: r.variables } : {}), values: r.values, site: { callSite: r.callSite, audience: 'room' } });
}
