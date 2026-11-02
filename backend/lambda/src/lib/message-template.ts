/**
 * RENDERING A MESSAGE OR PROMPT TEMPLATE (ADR-062 decision 5): the one function the router, the processor,
 * the notification bridge and the console's preview all call, so what the editor shows for a sample is what
 * the runtime posts.
 *
 * PURE: strings in, strings out, no client and no store. The parse is `document-template.ts`; which template
 * applies is `message-template-selection.ts`; the shipped templates are `shipped-message-templates.ts`.
 *
 * What it guarantees:
 *  - A SERVICE PASSES VALUES, NEVER TEXT. A value is used only for a field the template declares, and is
 *    checked, capped and stripped by the type its binding declares (`cleanMessageValue`), the strip a notice
 *    variable has always had: every marker a reader acts on, and half of one, is removed.
 *  - AN EMPTY FIELD LEAVES ITS LINE OUT. A line naming a field with no value is dropped, and an optional span
 *    `[[...]]` naming one is dropped from its line, so a value the caller did not have is never printed as a
 *    placeholder or as a half sentence. A document keeps refusing an unbound field (`fillTemplate`).
 *  - AN EMAIL SUBJECT IS ONE LINE, and a person's clearance renders empty in every email part.
 *  - A PROMPT'S FIELDS ARE DATA. They follow its instructions inside delimiters, never spliced into them.
 */
import { stripMessageMarkers } from './message-markers.js';
import { messageFieldType, type MessageValueType, type ParsedTemplate } from './document-template.js';
import { isResolverBinding } from './step-bindings.js';
import type { SourceLookup, When } from './variables.js';

/** The cap per value type, in characters. */
export const MESSAGE_VALUE_CAPS: Readonly<Record<MessageValueType, number>> = {
  text: 300, longText: 2000, arn: 400, id: 200, link: 2048, count: 20,
};

/**
 * Types whose value is a reference rather than prose. Cutting one short does not shorten it, it breaks it
 * (a truncated ARN or link names something else), so an over-cap value of these is REFUSED. Text is capped,
 * because a shortened sentence still reads.
 */
const REFUSED_OVER_CAP: ReadonlySet<MessageValueType> = new Set(['arn', 'id', 'link', 'count']);

const CHIME_ARN = /^arn:aws:chime:[a-z0-9-]+:\d{12}:app-instance\/[\w-]+\/(channel|user|bot)\/[\w.:-]+$/;

/**
 * One value, checked for its type: stripped of every marker a reader acts on (`stripMessageMarkers`, the
 * bare navigation prefix and an unpaired comment delimiter, so a value cannot supply half a marker for the
 * text around it to complete), capped, and refused when it is a reference that is over its cap or not of
 * its shape. The reason names the field, never the value.
 */
export function cleanMessageValue(type: MessageValueType, raw: unknown, field = 'value'): { value: string } | { refused: string; cap?: number; length?: number } {
  let value = stripMessageMarkers(String(raw ?? ''))
    .replace(/NAVIGATE_CHANNEL:/g, '')
    .replace(/<!--|-->/g, '')
    .trim();
  const cap = MESSAGE_VALUE_CAPS[type];
  if (value.length > cap) {
    if (REFUSED_OVER_CAP.has(type)) return { refused: `${field} is ${value.length} characters, over its ${type} cap of ${cap}`, cap, length: value.length };
    value = value.slice(0, cap);
  }
  if (!value) return { value };
  if (type === 'arn' && !CHIME_ARN.test(value)) return { refused: `${field} is not an Amazon Chime SDK ARN` };
  if (type === 'id' && !/^[\w.:@-]+$/.test(value)) return { refused: `${field} is not an id` };
  if (type === 'count' && !/^\d+$/.test(value)) return { refused: `${field} is not a count` };
  if (type === 'link' && !/^https?:\/\/[^\s<>"]+$/.test(value)) return { refused: `${field} is not a link` };
  return { value };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const OPTIONAL_SPAN = /\[\[([\s\S]*?)\]\]/g;

/** The fields a piece of text names, in order, as its `{{field}}` placeholders. */
export const fieldsIn = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);

/** One section's text with its values: optional spans and lines naming an empty field left out. */
function renderSection(text: string, values: Record<string, string>): string {
  const filled = (s: string) => s.replace(PLACEHOLDER, (_m, f: string) => values[f] ?? '');
  const empty = (f: string) => !values[f];
  let dropped = false;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const spanned = line.replace(OPTIONAL_SPAN, (_m, inner: string) => (fieldsIn(inner).some(empty) ? '' : inner));
    if (fieldsIn(spanned).some(empty)) {
      dropped = true;
      continue;
    }
    lines.push(filled(spanned));
  }
  const out = lines.join('\n');
  return dropped ? out.replace(/\n{3,}/g, '\n\n').trim() : out;
}

export type MessageRender =
  | { ok: true; sections: Record<string, string> }
  | { ok: false; refused: string };

/**
 * Render a message template's sections with the call site's values. Every value is checked for its field's
 * declared type first; one that is refused refuses the whole message with the field named, so nothing is
 * posted with a broken reference in it. A value for a field the template does not declare is not used.
 * `sections` limits the render to the named sections; absent renders all of them. `refusedValue: 'empty'`
 * treats a refused value as one the caller did not have, leaving its line out, for a call site whose message
 * must still be said.
 */
export function renderMessageTemplate(
  template: ParsedTemplate,
  values: Record<string, unknown> = {},
  opts: { sections?: readonly string[]; refusedValue?: 'refuse' | 'empty' } = {},
): MessageRender {
  const own = template.messageSections ?? {};
  const fields = template.fields ?? {};
  const clean: Record<string, string> = {};
  for (const [field, binding] of Object.entries(fields)) {
    if (!(field in values) || values[field] === undefined || values[field] === null) continue;
    const type = messageFieldType(binding) ?? 'text';
    const checked = cleanMessageValue(type, values[field], field);
    if ('refused' in checked) {
      if (opts.refusedValue !== 'empty') return { ok: false, refused: `the template ${template.name}: ${checked.refused}` };
      // Named by template and field, never by value.
      console.warn('[message-template] a value was refused and left out', { template: template.name, field, type });
      continue;
    }
    clean[field] = checked.value;
  }
  const out: Record<string, string> = {};
  for (const section of opts.sections ?? Object.keys(own)) {
    const text = own[section];
    if (text === undefined) continue;
    let sectionValues = clean;
    if (section.startsWith('email.')) {
      // A PERSON'S CLEARANCE NEVER REACHES AN EMAIL. The parse refuses it there; a value is emptied too.
      sectionValues = Object.fromEntries(Object.entries(clean).filter(([f]) => fields[f] !== 'person:clearance'));
    }
    let rendered = renderSection(text, sectionValues);
    if (section === 'email.subject') rendered = rendered.replace(/\s+/g, ' ').trim();
    out[section] = rendered;
  }
  return { ok: true, sections: out };
}

/** The opening and closing delimiters a prompt's data is passed inside. */
export const PROMPT_DATA_OPEN = '<template-data>';
export const PROMPT_DATA_CLOSE = '</template-data>';

/**
 * A prompt template as the model is asked it: its instructions, then each declared field that has a value as
 * one `name: value` line inside the data delimiters. A value is stripped and capped like any other, folded to
 * one line, and loses any delimiter it carries, so it cannot close the data block and continue as an
 * instruction. A prompt with no field values is its instructions alone.
 */
export function renderPromptTemplate(template: ParsedTemplate, values: Record<string, unknown> = {}): { ok: true; prompt: string } | { ok: false; refused: string } {
  const instructions = template.messageSections?.prompt ?? '';
  const rows: string[] = [];
  for (const [field, binding] of Object.entries(template.fields ?? {})) {
    if (values[field] === undefined || values[field] === null) continue;
    const checked = cleanMessageValue(messageFieldType(binding) ?? 'text', values[field], field);
    if ('refused' in checked) return { ok: false, refused: `the template ${template.name}: ${checked.refused}` };
    const value = checked.value.replace(/<\/?template-data>/gi, '').replace(/\s+/g, ' ').trim();
    if (value) rows.push(`${field}: ${value}`);
  }
  return { ok: true, prompt: rows.length ? `${instructions}\n\n${PROMPT_DATA_OPEN}\n${rows.join('\n')}\n${PROMPT_DATA_CLOSE}` : instructions };
}

/**
 * A LINE WRITTEN `{name}`-STYLE AS A TEMPLATE SECTION. Each `{field}` the shipped template declares becomes an
 * optional span of that field, `[[{{field}}]]`, so a value the call site does not have is substituted with nothing
 * and the line is still said. A brace pair naming anything else stays as written, so a field the shipped template
 * does not declare can never be introduced through a line. A deployment-wide line (`budgetCannedResponse`) is read
 * this way, and `npm run migrate-legacy-copy` converts a version's retired `copy` lines with it.
 */
export function braceLineAsSection(line: string, shipped: ParsedTemplate): string {
  const declared = shipped.fields ?? {};
  return line.replace(/(?<!\{)\{([A-Za-z][A-Za-z0-9_]*)\}(?!\})/g, (m, f: string) => (f in declared ? `[[{{${f}}}]]` : m));
}

/** Where the template in use came from (ADR-062 decision 3). */
export type MessageOrigin = 'assistant' | 'classification' | 'deployment' | 'shipped';

/**
 * A FAMILY A VERSION'S `messages` ENTRY MAY CHOOSE INSTEAD OF ONE OF THE ASSISTANT'S OWN TEMPLATES: `@classification`
 * says the message from the classification's template of its name (else the shipped one), `@shipped` from the
 * platform's. Neither is a template name (`TEMPLATE_NAME` starts with a letter or digit), so the two cannot collide.
 */
export const MESSAGE_FAMILY_CHOICES = ['@classification', '@shipped'] as const;
export type MessageFamilyChoice = (typeof MESSAGE_FAMILY_CHOICES)[number];

/** Whether an entry's value names a family rather than one of the assistant's own templates. */
export function isMessageFamilyChoice(name: unknown): name is MessageFamilyChoice {
  return (MESSAGE_FAMILY_CHOICES as readonly unknown[]).includes(name);
}

/**
 * A field a stored template binds as `value:<type>` where the call site now names the variable source it always
 * carried (a notice's `name` is `person:displayName`, ADR-060 slice 1c): the same value of the same type, read as
 * it was stored, so a template saved before the declaration moved keeps fitting.
 */
function legacyValueBindingFits(stored: string, supplied: string | undefined): boolean {
  return supplied !== undefined && stored.startsWith('value:') && messageFieldType(stored) !== undefined
    && messageFieldType(stored) === messageFieldType(supplied);
}

/**
 * Why a stored template does not fit the call site of the shipped one, or nothing when it does.
 *
 * A field the call site supplies fits under its own binding, or under the `value:<type>` binding it was stored with
 * before the call site named its source. Given a `lookup` (the classification's sources and the version's variables,
 * `versionLookup`), a field the variable resolver supplies fits too: a source the classification publishes or a
 * variable the version names, which the call site resolves itself (`resolveTemplateFields`).
 */
export function storedTemplateMisfit(stored: ParsedTemplate, shipped: ParsedTemplate, opts: { lookup?: SourceLookup } = {}): string | undefined {
  if ((stored.kind ?? 'document') !== (shipped.kind ?? 'document')) return `it is a ${stored.kind ?? 'document'}, not a ${shipped.kind}`;
  const supplied = shipped.fields ?? {};
  for (const [field, binding] of Object.entries(stored.fields ?? {})) {
    if (supplied[field] === binding || legacyValueBindingFits(binding, supplied[field])) continue;
    if (opts.lookup && isResolverBinding(binding) && opts.lookup(binding)) continue;
    return `it declares the field "${field}" (${binding}), which the call site does not supply`;
  }
  return undefined;
}

/**
 * THE ORDER, AS ONE RULE: the assistant's own stored template, then the classification's stored template, then a
 * deployment-wide line, then the shipped template. A stored
 * template that does not fit the call site is passed over. The server reads the store and calls this
 * (`message-template-selection.ts`); the console calls it with what it listed, so both say which applies alike.
 */
export function chooseMessageTemplate(input: {
  shipped: ParsedTemplate;
  own?: ParsedTemplate;
  classification?: ParsedTemplate;
  deploymentLines?: Record<string, string>;
  /** The lookup a stored template's resolver-bound fields fit through (`storedTemplateMisfit`). */
  lookup?: SourceLookup;
  /**
   * Whether a condition holds at this call site (ADR-060 decision 6). A stored template carrying a `when` that does
   * not hold is passed over like one that does not fit, so the next family answers; absent, no condition holds.
   */
  holds?: (when: When) => boolean;
}): { template: ParsedTemplate; origin: MessageOrigin } {
  const { shipped } = input;
  const fits = (t: ParsedTemplate | undefined): t is ParsedTemplate =>
    !!t && !storedTemplateMisfit(t, shipped, { lookup: input.lookup }) && templateWhenHolds(t, input.holds);
  if (fits(input.own)) return { template: input.own, origin: 'assistant' };
  const nonBlank = (lines?: Record<string, string>) => Object.fromEntries(Object.entries(lines ?? {}).filter(([, l]) => typeof l === 'string' && l.trim()));
  if (fits(input.classification)) return { template: input.classification, origin: 'classification' };
  const deployment = nonBlank(input.deploymentLines);
  if (Object.keys(deployment).length) return { template: withSectionLines(shipped, deployment), origin: 'deployment' };
  return { template: shipped, origin: 'shipped' };
}

/**
 * The shipped template with `{name}`-style lines over the sections they word (`braceLineAsSection`). A section with
 * no line keeps the shipped text, so a line that rewords one section keeps the rest.
 */
export function withSectionLines(shipped: ParsedTemplate, lines: Record<string, string>): ParsedTemplate {
  const sections = { ...(shipped.messageSections ?? {}) };
  for (const [section, line] of Object.entries(lines)) {
    if (section in sections && typeof line === 'string' && line.trim()) sections[section] = braceLineAsSection(line, shipped);
  }
  return { ...shipped, messageSections: sections };
}

/**
 * One alternative of a version's `messages` entry: a template of the assistant's own, or a family
 * (`MESSAGE_FAMILY_CHOICES`), and the condition that selects it.
 */
export interface MessageChoice {
  template: string;
  /** Absent on the unconditioned alternative, which is said when no condition holds. */
  when?: When;
}

/**
 * WHICH TEMPLATE A MESSAGE IS SAID FROM (ADR-062 decision 3, ADR-060 decision 6): one of the assistant's own by name, or a
 * family (`@classification`, `@shipped`), or an ordered list of `{ template, when }` alternatives with one unconditioned.
 */
export type MessageEntry = string | readonly MessageChoice[];

/** A version's `messages`: a shipped message's name to the entry its assistant says it from. */
export type VersionMessages = Readonly<Record<string, MessageEntry>>;

/** Every name of the assistant's own templates an entry may select, in order. A family choice names none. */
export function messageEntryNames(entry: unknown): string[] {
  const all = typeof entry === 'string' ? [entry]
    : !Array.isArray(entry) ? []
      : entry.flatMap((c) => (c && typeof c === 'object' && typeof (c as MessageChoice).template === 'string' ? [(c as MessageChoice).template] : []));
  return all.filter((n) => !isMessageFamilyChoice(n));
}

/**
 * THE FAMILIES A MESSAGE IS READ FROM, given what its entry selected here (`chooseMessageName`): with no entry, the
 * assistant's template of the message's own name, then the classification's; with one of the assistant's own named,
 * that one, then the classification's; `@classification` skips the assistant's; `@shipped` skips both.
 */
export function messageFamilies(chosen: string | undefined, message: string): { own?: string; classification: boolean } {
  if (chosen === '@shipped') return { classification: false };
  if (chosen === '@classification') return { classification: true };
  return { own: chosen ?? message, classification: true };
}

/**
 * THE TEMPLATE AN ENTRY SELECTS AT THIS CALL SITE: a name as written; of a list, the first alternative whose `when`
 * holds, else the unconditioned one. An unresolved value holds no condition, so a failed read takes the unconditioned
 * template. Undefined when the version names nothing for the message.
 */
export function chooseMessageName(entry: MessageEntry | undefined | null, holds: (when: When) => boolean = () => false): string | undefined {
  if (entry === undefined || entry === null) return undefined;
  if (typeof entry === 'string') return entry;
  if (!Array.isArray(entry)) return undefined;
  for (const c of entry) if (c.when !== undefined && holds(c.when)) return c.template;
  return entry.find((c) => c.when === undefined)?.template;
}

/** A stored template's own `when` holds at this call site, or it carries none. */
export function templateWhenHolds(template: ParsedTemplate | undefined, holds: ((when: When) => boolean) | undefined): boolean {
  return !template || template.when === undefined || Boolean(holds?.(template.when as When));
}
