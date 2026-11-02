/**
 * A DOCUMENT TEMPLATE: the fixed shape a delivering step's document takes (SPEC-DOCUMENT-TEMPLATES).
 *
 * A template is a Markdown document whose headings are its sections and whose tables declare their
 * columns, with a front-matter block (a JSON object between two `---` lines) that names it, describes it
 * for a person choosing between formats, marks optional sections and carries each section's guidance.
 * Guidance is instruction to the model and is never expected in the output, which is why it lives in the
 * front matter and not in the body.
 *
 * Everything here is PURE: the parser, the guidance renderer, the structural check and the platform fill
 * take strings and return values, so each rule is unit-testable on real documents. Storage is
 * `template-store.ts`; the declaration a workflow state carries is in `task-state-machines.ts`.
 *
 * STRUCTURE DECIDES, NEVER HEADING TEXT (tenet D11). A section is identified by its position and heading
 * level, and a table by its column count. The template's own heading text is used for two things only:
 * as the key its front matter names a section by (the template's author naming their own section, inside
 * one file), and as a hint rendered to the model. Whether a delivered document's headings say the same
 * words is measured (`headingTextAgreement`) and decides nothing, so a document written in the
 * conversation's language passes.
 *
 * THREE KINDS SHARE THE FORMAT (ADR-062 decision 1). A `document` (the default) is the structure above. A
 * `message` is what a person reads from an assistant: its level-1 headings name the places it appears
 * (`# chat`, `# email.subject`, `# email.body`, and named parts such as `# email.greeting`), and each
 * section's text is the line, filled by the platform from declared fields (`message-template.ts`). A
 * `prompt` is what a model is asked on the platform's behalf: one `# prompt` section of instructions, whose
 * declared fields reach the model as delimited data after them, never spliced in. A message and a prompt
 * name their sections by heading text, because that is the author keying their own file; nothing compares
 * a heading with what a model wrote.
 */

/** A template name: the key segment its body and pointer are stored under. Lowercase, digits and hyphens. */
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

import { isResolverBinding, parseBinding, resolveBinding } from './step-bindings.js';

/**
 * What a platform-filled field may bind to (`step-bindings.ts`): a sourced requirement, a task detail, or
 * the result a declared step action recorded (`tool:<state>.<path>`, SPEC-TASK-STATE-TRANSITIONS FR29).
 */
export const FILL_BINDING_KINDS = ['requirement', 'detail', 'tool'] as const;

export class TemplateParseError extends Error {
  constructor(message: string) {
    super(`[DocumentTemplate] ${message}`);
    this.name = 'TemplateParseError';
  }
}

/** One section of a template, in document order. */
export interface TemplateSection {
  /** Heading level, 1-6. Part of the structure. */
  level: number;
  /** The template's heading text. A hint for the model and the front matter's key; never compared. */
  heading: string;
  optional: boolean;
  /** Instruction to the model for this section. Never expected in the output. */
  guidance?: string;
  /** The column count of each table directly under this heading, in order. */
  tables: number[];
  /** Each table's header cells, rendered to the model as a hint. */
  tableHeaders: string[][];
}

/** What a template is: a document's structure, a line a person reads, or what a model is asked. */
export const TEMPLATE_KINDS = ['document', 'message', 'prompt'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * A message's section names: the chat line and its forms (`chat.one` and `chat.other` by the CLDR plural
 * category of a count, `chat.none` for none, or a form a call site names, such as `chat.thanks`), the email
 * pair and an email's other named parts, a page's named parts (the email preference page), and labels a call
 * site fills one of the message's own fields from (`label.<name>`, which may be dotted). A prompt has one
 * `prompt` section.
 */
export const MESSAGE_SECTION = /^(chat(\.[a-z][A-Za-z0-9]{0,63})?|email\.[a-z][A-Za-z0-9]{0,63}|page\.[a-z][A-Za-z0-9]{0,63}|label\.[a-z][A-Za-z0-9_.-]{0,63})$/;

/** A BCP 47 language tag's shape. The closed set a deployment speaks is `lib/config/languages.ts` (ADR-062 decision 4). */
export const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * A SECTION WRITTEN IN ANOTHER LANGUAGE (ADR-062 decision 4): `# <section>@<tag>`, so one file holds a message in
 * every language its author wrote (decision 4's OPEN question, decided: one file, a section per language). The
 * unsuffixed sections are the template's own `language`.
 */
export const VARIANT_SECTION = /^(.+)@([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/;

/** The forms a section takes by a count (CLDR plural categories) or by `none`, which a language variant chooses for itself. */
const COUNT_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other', 'none']);

/**
 * The family a section belongs to: `chat.one`, `chat.few` and `chat` are all the `chat` line, because a language
 * chooses its own plural forms. A named form a call site asks for (`chat.thanks`) is its own family.
 */
export function sectionFamily(section: string): string {
  const dot = section.lastIndexOf('.');
  if (dot > 0 && COUNT_FORMS.has(section.slice(dot + 1))) return section.slice(0, dot);
  return section;
}

/** What bounds a `voice` render (ADR-062 decision 4). Each has a default and a largest value; a template may set it lower. */
export interface VoiceBounds {
  /** The longest a rendered section may be, in characters. */
  maxChars: number;
  /** How long the render may take before the platform fill is posted instead. */
  deadlineMs: number;
}

/** The bounds a `voice` template takes when it declares none, and the largest value each may be set to. */
export const VOICE_BOUNDS_DEFAULT: Readonly<VoiceBounds> = Object.freeze({ maxChars: 600, deadlineMs: 8000 });
export const VOICE_BOUNDS_MAX: Readonly<VoiceBounds> = Object.freeze({ maxChars: 1500, deadlineMs: 15000 });

/**
 * WHAT A MESSAGE OR PROMPT FIELD MAY BIND TO, and the type its value is checked, capped and stripped as.
 * Every value is supplied by the call site, by the field's name: a service names a template and passes
 * declared values, never text (ADR-062 decision 5). `value:<type>` declares a value of that type; the named
 * sources are ADR-060's, typed here so a template written today keeps its meaning when a resolver reads
 * them itself.
 *
 * Any other source in ADR-060's grammar (`conversation:type`, `ctx:<source>.<field>`, ...) and a version's
 * variable by its name are bound too: the variable resolver reads them (`resolveTemplateFields`), checks and caps
 * each by its own declared type, and refuses one where its trust or its audience does not allow it
 * (`insertionErrors`), so here they are carried as long text.
 */
export const MESSAGE_VALUE_TYPES = ['text', 'longText', 'id', 'arn', 'link', 'count'] as const;
export type MessageValueType = (typeof MESSAGE_VALUE_TYPES)[number];
export const MESSAGE_FIELD_SOURCES: Readonly<Record<string, MessageValueType>> = {
  'person:displayName': 'text',
  'person:clearance': 'text',
  'conversation:title': 'text',
  'assistant:displayName': 'text',
};

/** The type a message field's binding declares, or undefined when the binding is not one a message takes. */
export function messageFieldType(binding: string): MessageValueType | undefined {
  if (binding.startsWith('value:')) {
    const t = binding.slice('value:'.length);
    return (MESSAGE_VALUE_TYPES as readonly string[]).includes(t) ? (t as MessageValueType) : undefined;
  }
  if (Object.prototype.hasOwnProperty.call(MESSAGE_FIELD_SOURCES, binding)) return MESSAGE_FIELD_SOURCES[binding];
  return isResolverBinding(binding) ? 'longText' : undefined;
}

export interface ParsedTemplate {
  name: string;
  /** Absent for a document. */
  kind?: Exclude<TemplateKind, 'document'>;
  /** The BCP 47 tag a message or prompt is written in. */
  language?: string;
  /** A message's or prompt's sections by name, each the text under its heading. */
  messageSections?: Record<string, string>;
  /** Read to the person when the workflow offers a choice of formats. */
  description: string;
  sections: TemplateSection[];
  /**
   * `platform`: rendered from declared values with no model call (FR9 for a document, FR8 for a message). `voice`, a
   * message only: its sections say what to say, and a bounded model call renders them in the assistant's persona and the
   * target language where no written variant exists (ADR-062 decision 4), with the platform fill as its fallback.
   */
  fill?: 'platform' | 'voice';
  /** A `voice` message's bounds, defaults applied. */
  voice?: VoiceBounds;
  /**
   * A message's written language variants (ADR-062 decision 4): a language tag to that language's sections, each
   * variant covering every section family the template's own language has. `messageSections` is the own language's.
   */
  variants?: Record<string, Record<string, string>>;
  /** placeholder -> binding (`requirement:<need>`, `detail:<key>` or `tool:<state>.<path>`), for a platform fill. */
  fields?: Record<string, string>;
  /**
   * A message's condition (ADR-060 decision 6): a stored template that carries one is said only where it holds, and the
   * next family answers elsewhere. Its rules (a published source, never member text, the audience it selects) are
   * checked where the call site's audience is known (`templateUseMisfit`).
   */
  when?: unknown;
  /** The Markdown after the front matter: what a platform fill renders. */
  body: string;
}

/** A template loaded from the store, with the content hash of the body it was parsed from. */
export interface LoadedTemplate {
  name: string;
  contentHash: string;
  template: ParsedTemplate;
}

/** A declared reference that could not be loaded, with the named reason. */
export interface TemplateLoadFailure {
  name: string;
  error: string;
}

/** The templates a turn loaded, keyed by the declared reference (`name` or `name@<hash>`). */
export type TurnTemplates = Record<string, LoadedTemplate | TemplateLoadFailure>;

export function isLoadedTemplate(t: LoadedTemplate | TemplateLoadFailure | undefined): t is LoadedTemplate {
  return Boolean(t && (t as LoadedTemplate).template);
}

// ── Markdown structure, read from markup ───────────────────────────────────────────────────────

interface OutlineHeading {
  level: number;
  text: string;
  /** Column counts of the tables between this heading and the next heading of any level. */
  ownTables: number[];
  ownTableHeaders: string[][];
  /** Line index, so a span can be computed. */
  line: number;
}

interface Outline {
  headings: OutlineHeading[];
  /** Tables before the first heading. */
  preambleTables: number[];
  /** Every table with the line it starts on, so a section's span can collect its tables. */
  tables: Array<{ line: number; columns: number }>;
}

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TABLE_SEPARATOR = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;

/** The cells of a pipe table row. Leading and trailing pipes are optional in Markdown. */
function rowCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * The outline of a Markdown document: its ATX headings in order with their levels, and its pipe tables
 * with their column counts. Fenced blocks are skipped, so a heading-shaped line inside code is not a
 * section. A table is a row followed by a separator row; its column count is the header's cell count.
 */
function outlineOf(markdown: string): Outline {
  const lines = markdown.split(/\r?\n/);
  const headings: OutlineHeading[] = [];
  const preambleTables: number[] = [];
  const tables: Array<{ line: number; columns: number }> = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const fenceMatch = /^(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (line.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = ATX_HEADING.exec(line);
    if (h) {
      headings.push({ level: h[1].length, text: h[2].trim(), ownTables: [], ownTableHeaders: [], line: i });
      continue;
    }
    if (line.includes('|') && TABLE_SEPARATOR.test((lines[i + 1] ?? '').trim()) && (lines[i + 1] ?? '').includes('-')) {
      const header = rowCells(line);
      const columns = header.length;
      tables.push({ line: i, columns });
      const owner = headings[headings.length - 1];
      if (owner) {
        owner.ownTables.push(columns);
        owner.ownTableHeaders.push(header);
      } else {
        preambleTables.push(columns);
      }
      // Skip the separator and the body rows of this table.
      i += 1;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) i += 1;
    }
  }
  return { headings, preambleTables, tables };
}

// ── Parsing a template ─────────────────────────────────────────────────────────────────────────

interface FrontMatter {
  kind?: unknown;
  language?: unknown;
  name?: unknown;
  description?: unknown;
  sections?: unknown;
  fill?: unknown;
  fields?: unknown;
  when?: unknown;
  voice?: unknown;
}

function splitFrontMatter(source: string): { front: FrontMatter; body: string } {
  const text = source.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') {
    throw new TemplateParseError('a template opens with a front-matter block: a JSON object between two `---` lines');
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) throw new TemplateParseError('the front-matter block has no closing `---` line');
  let front: unknown;
  try {
    front = JSON.parse(lines.slice(1, end).join('\n'));
  } catch (err) {
    throw new TemplateParseError(`the front matter is not a JSON object (${(err as Error).message})`);
  }
  if (!front || typeof front !== 'object' || Array.isArray(front)) {
    throw new TemplateParseError('the front matter is not a JSON object');
  }
  return { front: front as FrontMatter, body: lines.slice(end + 1).join('\n').replace(/^\s*\n/, '') };
}

/** A `{{field}}` placeholder in a platform-filled body. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Parse a template into its structural outline. Throws `TemplateParseError` naming what is wrong, so a
 * template that cannot be checked against is refused when it is put, never discovered at a delivery.
 */
export function parseTemplate(source: string): ParsedTemplate {
  const { front, body } = splitFrontMatter(source);
  const name = typeof front.name === 'string' ? front.name.trim() : '';
  if (!TEMPLATE_NAME.test(name)) {
    throw new TemplateParseError(`the front matter's \`name\` "${name}" is not a template name (lowercase letters, digits and hyphens)`);
  }
  const description = typeof front.description === 'string' ? front.description.trim() : '';
  if (!description) {
    throw new TemplateParseError(`template "${name}" has no \`description\`; it is what a person is shown when choosing a format`);
  }
  if (front.kind !== undefined && !(TEMPLATE_KINDS as readonly unknown[]).includes(front.kind)) {
    throw new TemplateParseError(`template "${name}": \`kind\` is ${TEMPLATE_KINDS.map((k) => `"${k}"`).join(', ')} or absent`);
  }
  if (front.kind === 'message' || front.kind === 'prompt') return parseMessageTemplate(front, front.kind, name, description, body);
  if (front.when !== undefined) throw new TemplateParseError(`template "${name}" is a document, which its workflow step chooses; it carries no \`when\``);
  if (front.language !== undefined) {
    throw new TemplateParseError(`template "${name}": \`language\` is declared by a message or a prompt`);
  }

  const outline = outlineOf(body);
  if (outline.preambleTables.length) {
    throw new TemplateParseError(`template "${name}" has a table before its first heading; a table belongs to a section`);
  }
  if (!outline.headings.length) throw new TemplateParseError(`template "${name}" declares no sections (no headings)`);

  // THE FRONT MATTER NAMES SECTIONS BY THE TEMPLATE'S OWN HEADING TEXT. That is the author keying their
  // own file, and it is resolved here, once; nothing compares it with what a model wrote.
  const declared = front.sections ?? {};
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new TemplateParseError(`template "${name}": \`sections\` is an object keyed by a section's heading`);
  }
  const byText = new Map<string, number[]>();
  outline.headings.forEach((h, i) => byText.set(h.text, [...(byText.get(h.text) ?? []), i]));
  const settings = new Map<number, { optional: boolean; guidance?: string }>();
  for (const [key, raw] of Object.entries(declared as Record<string, unknown>)) {
    const at = byText.get(key.trim());
    if (!at) throw new TemplateParseError(`template "${name}": \`sections\` names "${key}", which is not a heading in the template`);
    if (at.length > 1) throw new TemplateParseError(`template "${name}": "${key}" is the heading of more than one section, so \`sections\` cannot name it`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TemplateParseError(`template "${name}": the settings for "${key}" are not an object`);
    }
    const r = raw as { optional?: unknown; guidance?: unknown };
    if (r.optional !== undefined && typeof r.optional !== 'boolean') {
      throw new TemplateParseError(`template "${name}": "${key}".optional is not true or false`);
    }
    if (r.guidance !== undefined && typeof r.guidance !== 'string') {
      throw new TemplateParseError(`template "${name}": "${key}".guidance is not text`);
    }
    settings.set(at[0], {
      optional: r.optional === true,
      ...(typeof r.guidance === 'string' && r.guidance.trim() ? { guidance: r.guidance.trim() } : {}),
    });
  }

  const sections: TemplateSection[] = outline.headings.map((h, i) => ({
    level: h.level,
    heading: h.text,
    optional: settings.get(i)?.optional ?? false,
    ...(settings.get(i)?.guidance ? { guidance: settings.get(i)!.guidance } : {}),
    tables: h.ownTables,
    tableHeaders: h.ownTableHeaders,
  }));
  if (!sections.some((s) => !s.optional)) {
    throw new TemplateParseError(`template "${name}" has no required section, so nothing could be checked`);
  }

  let fill: 'platform' | undefined;
  let fields: Record<string, string> | undefined;
  if (front.fill !== undefined) {
    if (front.fill !== 'platform') throw new TemplateParseError(`template "${name}": \`fill\` is "platform" or absent`);
    fill = 'platform';
    if (!front.fields || typeof front.fields !== 'object' || Array.isArray(front.fields)) {
      throw new TemplateParseError(`template "${name}" is filled by the platform, so it declares \`fields\`: placeholder -> binding`);
    }
    fields = {};
    for (const [field, binding] of Object.entries(front.fields as Record<string, unknown>)) {
      if (typeof binding !== 'string' || !binding.includes(':')) {
        throw new TemplateParseError(`template "${name}": field "${field}" binds to "${String(binding)}", not \`<kind>:<key>\``);
      }
      const parsed = parseBinding(binding, FILL_BINDING_KINDS);
      if (!parsed) {
        throw new TemplateParseError(
          `template "${name}": field "${field}" binds to "${binding}"; a binding is `
          + '`requirement:<need>`, `detail:<key>` or `tool:<state>.<path>`',
        );
      }
      fields[field] = `${parsed.kind}:${parsed.key}`;
    }
    const used = new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]));
    const undeclared = [...used].filter((f) => !(f in fields!));
    if (undeclared.length) {
      throw new TemplateParseError(`template "${name}" uses ${undeclared.map((f) => `{{${f}}}`).join(', ')} with no binding in \`fields\``);
    }
  }

  return { name, description, sections, ...(fill ? { fill, fields } : {}), body };
}

// ── Messages and prompts (ADR-062 decision 1) ──────────────────────────────────────────────────

/** A level-1 heading line. In a message or prompt every one names a section. */
const SECTION_HEADING = /^#[ \t]+(\S.*?)[ \t]*$/;

/** The sections of a message or prompt body, in order, each the text between its heading and the next. */
function messageSectionsOf(name: string, body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | undefined;
  let lines: string[] = [];
  const close = () => {
    if (current !== undefined) out[current] = lines.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  };
  for (const line of body.split(/\r?\n/)) {
    const h = SECTION_HEADING.exec(line);
    if (h) {
      const section = h[1];
      const base = VARIANT_SECTION.exec(section)?.[1] ?? section;
      if (!MESSAGE_SECTION.test(base) && base !== 'prompt') {
        throw new TemplateParseError(`template "${name}": "# ${section}" is not a section a message or prompt has`);
      }
      if (section in out || section === current) throw new TemplateParseError(`template "${name}" has the section "${section}" twice`);
      close();
      current = section;
      lines = [];
      continue;
    }
    if (current === undefined) {
      if (line.trim()) throw new TemplateParseError(`template "${name}" has text before its first section`);
      continue;
    }
    lines.push(line);
  }
  close();
  return out;
}

/**
 * A message or prompt: its sections by name, its language and its declared fields. Refused when stored,
 * never at a send: an undeclared field, an email with a subject and nothing to send under it, a link in a
 * line the room reads, a person's clearance in an email, or a prompt with any section but `prompt` or with
 * a field spliced into its instructions.
 */
function parseMessageTemplate(
  front: FrontMatter,
  kind: 'message' | 'prompt',
  name: string,
  description: string,
  body: string,
): ParsedTemplate {
  if (front.language !== undefined && (typeof front.language !== 'string' || !LANGUAGE_TAG.test(front.language))) {
    throw new TemplateParseError(`template "${name}": \`language\` "${String(front.language)}" is not a language tag`);
  }
  const language = typeof front.language === 'string' ? front.language : undefined;
  if (front.sections !== undefined) {
    throw new TemplateParseError(`template "${name}": a ${kind} names its sections by their headings and declares no \`sections\``);
  }
  const all = messageSectionsOf(name, body);
  // THE TEMPLATE'S OWN LANGUAGE, AND EACH LANGUAGE WRITTEN BESIDE IT (ADR-062 decision 4).
  const sections: Record<string, string> = {};
  const variants: Record<string, Record<string, string>> = {};
  for (const [section, text] of Object.entries(all)) {
    const v = VARIANT_SECTION.exec(section);
    if (!v) { sections[section] = text; continue; }
    (variants[v[2]] ??= {})[v[1]] = text;
  }
  const names = Object.keys(sections);
  if (!names.length) throw new TemplateParseError(`template "${name}" declares no sections (no \`# <section>\` headings)`);
  for (const [section, text] of Object.entries(sections)) {
    if (!text.trim()) throw new TemplateParseError(`template "${name}": the section "${section}" is empty`);
  }

  if (Object.keys(variants).length) {
    if (kind === 'prompt') {
      throw new TemplateParseError(`template "${name}" is a prompt, which a model reads; it has no language variants, because the persona's reply-language instruction decides the language the model writes in`);
    }
    const ownFamilies = new Set(names.map(sectionFamily));
    for (const [tag, vs] of Object.entries(variants)) {
      if (tag === (language ?? 'en')) {
        throw new TemplateParseError(`template "${name}" is written in "${tag}", so its sections are not marked @${tag}`);
      }
      const families = new Set(Object.keys(vs).map(sectionFamily));
      const extra = [...families].filter((f) => !ownFamilies.has(f));
      if (extra.length) {
        throw new TemplateParseError(`template "${name}": the "${tag}" variant has ${extra.map((f) => `"${f}"`).join(', ')}, which the template's own language does not`);
      }
      const missing = [...ownFamilies].filter((f) => !families.has(f));
      if (missing.length) {
        // A VARIANT IS WHOLE, so a message never reads half in one language and half in another.
        throw new TemplateParseError(`template "${name}": the "${tag}" variant has no ${missing.map((f) => `"${f}"`).join(', ')}; a language variant carries every section the template has`);
      }
      for (const [section, text] of Object.entries(vs)) {
        if (!text.trim()) throw new TemplateParseError(`template "${name}": the section "${section}@${tag}" is empty`);
      }
    }
  }

  if (kind === 'prompt') {
    if (names.length !== 1 || names[0] !== 'prompt') {
      throw new TemplateParseError(`template "${name}" is a prompt, so it has one \`# prompt\` section and no other`);
    }
    if (front.fill !== undefined) throw new TemplateParseError(`template "${name}" is a prompt, which no person reads; it declares no \`fill\``);
  } else {
    if ('prompt' in sections) throw new TemplateParseError(`template "${name}" is a message, so it has no \`# prompt\` section`);
    if (front.fill !== undefined && front.fill !== 'platform' && front.fill !== 'voice') {
      throw new TemplateParseError(`template "${name}": a message's \`fill\` is "platform", "voice" or absent`);
    }
    // AN EMAIL IS A SUBJECT AND A BODY. The body is its own section, or the chat line the email carries (a
    // notice emailed by the bridge is the line posted in the conversation). Named email parts with neither
    // are the wrapper every notice email is sent in, which sends nothing of its own.
    if ('email.body' in sections && !('email.subject' in sections)) {
      throw new TemplateParseError(`template "${name}" has an \`# email.body\` and no \`# email.subject\``);
    }
    if ('email.subject' in sections && !('email.body' in sections) && !('chat' in sections)) {
      throw new TemplateParseError(
        `template "${name}" has an \`# email.subject\` and nothing to send under it: an \`# email.body\`, or the \`# chat\` line the email carries`,
      );
    }
  }

  const fields: Record<string, string> = {};
  if (front.fields !== undefined) {
    if (!front.fields || typeof front.fields !== 'object' || Array.isArray(front.fields)) {
      throw new TemplateParseError(`template "${name}": \`fields\` maps a placeholder to a binding`);
    }
    for (const [field, binding] of Object.entries(front.fields as Record<string, unknown>)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field)) throw new TemplateParseError(`template "${name}": "${field}" is not a field name`);
      if (typeof binding !== 'string' || !messageFieldType(binding)) {
        throw new TemplateParseError(
          `template "${name}": field "${field}" binds to "${String(binding)}"; a ${kind} field is \`value:<type>\` `
          + `(${MESSAGE_VALUE_TYPES.join(', ')}), one of ${Object.keys(MESSAGE_FIELD_SOURCES).join(', ')}, a variable source \`<kind>:<key>\` or a version's variable by name`,
        );
      }
      fields[field] = binding;
    }
  }
  const everySection: Array<[string, string]> = [
    ...Object.entries(sections),
    ...Object.entries(variants).flatMap(([tag, vs]) => Object.entries(vs).map(([s, t]) => [`${s}@${tag}`, t] as [string, string])),
  ];
  for (const [named, text] of everySection) {
    const section = VARIANT_SECTION.exec(named)?.[1] ?? named;
    const used = [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];
    if (kind === 'prompt' && used.length) {
      throw new TemplateParseError(
        `template "${name}" is a prompt, and a prompt's fields reach the model as data after its instructions, never inside them; `
        + `remove ${used.map((f) => `{{${f}}}`).join(', ')} from its text`,
      );
    }
    const undeclared = used.filter((f) => !(f in fields));
    if (undeclared.length) {
      throw new TemplateParseError(`template "${name}" uses ${undeclared.map((f) => `{{${f}}}`).join(', ')} in "${section}" with no binding in \`fields\``);
    }
    for (const f of used) {
      if (section.startsWith('email.') && fields[f] === 'person:clearance') {
        throw new TemplateParseError(`template "${name}": a person's clearance never reaches an email, so "{{${f}}}" cannot be in "${section}"`);
      }
      if (messageFieldType(fields[f]) === 'link' && !section.startsWith('email.') && !section.startsWith('page.')) {
        throw new TemplateParseError(`template "${name}": "{{${f}}}" is a link, which only an email or a page carries, never "${section}"`);
      }
    }
  }

  if (kind === 'prompt' && front.voice !== undefined) throw new TemplateParseError(`template "${name}" is a prompt; it declares no \`voice\``);
  const voice = kind === 'message' ? voiceBounds(name, front.fill, front.voice) : undefined;
  return {
    name,
    kind,
    description,
    ...(language ? { language } : {}),
    sections: [],
    ...(kind === 'message' ? { fill: front.fill === 'voice' ? 'voice' as const : 'platform' as const } : {}),
    ...(voice ? { voice } : {}),
    fields,
    messageSections: sections,
    ...(Object.keys(variants).length ? { variants } : {}),
    ...(front.when !== undefined ? { when: messageWhen(name, kind, front.when) } : {}),
    body,
  };
}

// ── Guidance: what the model is told ───────────────────────────────────────────────────────────

const hashLabel = (hash: string) => hash.slice(0, 12);

/**
 * The template rendered into a step's guidance (FR5): the structure, in order, with each section's
 * level, optionality, tables and guidance. Rendered on every turn in, or advancing into, a state that
 * declares the template; never left to retrieval.
 */
export function renderTemplateGuidance(loaded: LoadedTemplate): string {
  const t = loaded.template;
  if (t.fill === 'platform') {
    return `\n\n## DOCUMENT TEMPLATE: ${t.name} (${hashLabel(loaded.contentHash)})\n`
      + 'The platform fills this document from what the task recorded. Do not write it: advance the task as '
      + 'the step says and leave `document` empty. Anything you want to say to the person goes in your reply.';
  }
  const lines = t.sections.map((s, i) => {
    const marks = '#'.repeat(s.level);
    const parts = [`${i + 1}. \`${marks}\` level-${s.level} heading (the template calls it "${s.heading}")${s.optional ? ', optional' : ''}`];
    s.tables.forEach((cols, n) => {
      const header = s.tableHeaders[n]?.filter(Boolean).join(' | ');
      parts.push(`   - a table with exactly ${cols} columns${header ? ` (${header})` : ''}`);
    });
    if (s.guidance) parts.push(`   - guidance: ${s.guidance}`);
    return parts.join('\n');
  });
  return `\n\n## DOCUMENT TEMPLATE: ${t.name} (${hashLabel(loaded.contentHash)})\n`
    + 'The document you declare follows this template: these sections, in this order, at these heading '
    + 'levels, with each table\'s column count. Write the headings and content in the conversation\'s '
    + 'language. The guidance is instruction to you and never appears in the document. An optional '
    + 'section may be left out when there is nothing for it; add no section the template does not have.\n'
    + lines.join('\n');
}

/**
 * The choice of formats, rendered into the requirements step while nobody has chosen (FR3a): each
 * template's name and description, and what happens when the person names none.
 */
export function renderTemplateChoice(
  options: Array<LoadedTemplate | TemplateLoadFailure>,
  defaultName: string | undefined,
  chosen: string | undefined,
): string {
  if (chosen) {
    return `\n\n## DOCUMENT FORMAT\nThe person chose the format \`${chosen}\`. Keep it unless they ask for a different one; `
      + 'a new choice is recorded in the `template` argument of the advance.';
  }
  const list = options.map((o) => (isLoadedTemplate(o)
    ? `- \`${o.name}\`: ${o.template.description}`
    : `- \`${o.name}\``)).join('\n');
  return '\n\n## DOCUMENT FORMAT\nThis workflow offers a choice of format for the document:\n'
    + `${list}\n`
    + 'If the person has not named one, list these with their descriptions and ask which they want. Record '
    + 'their choice in the `template` argument of the advance, with the source and evidence of their words.'
    + (defaultName
      ? ` If they do not choose, \`${defaultName}\` is used: say so as one of the requirements you are taking.`
      : ' Do not advance until they have chosen.');
}

// ── The structural check (FR6) ─────────────────────────────────────────────────────────────────

/** A piece of the template's structure the document does not carry. */
export interface MissingStructure {
  kind: 'section' | 'table';
  /** 1-based position of the section in the template. */
  position: number;
  level: number;
  /** The template's heading text, as a hint for the correction. Never what decided the miss. */
  heading: string;
  /** For a table: the column count it declares. */
  columns?: number;
}

export interface TemplateCheck {
  passed: boolean;
  missing: MissingStructure[];
  /**
   * SHADOW METRIC ONLY (tenet D11): the share of matched sections whose heading text equals the
   * template's, compared case- and space-insensitively. A translated document scores low and passes.
   * Null when no section matched.
   */
  headingTextAgreement: number | null;
}

/** Whether every column count the section declares is carried by the document's tables in this span. */
function tablesSatisfied(required: number[], available: number[]): boolean {
  const pool = [...available];
  for (const cols of required) {
    const at = pool.indexOf(cols);
    if (at < 0) return false;
    pool.splice(at, 1);
  }
  return true;
}

/**
 * Compare a document's structure to a template's (FR6), by position and heading level, never by text.
 *
 * Every required section must be matched, in the template's order, by a heading of the same level, and
 * each table the section declares must appear in that heading's span (up to the next heading of the
 * same or a higher level) with the declared column count. Optional sections may be absent. Headings
 * the template does not have do not fail the check; dropping or reordering a required one does.
 *
 * The matching is an alignment over the two sequences, so an absent optional section never shifts a
 * required one onto the wrong heading.
 */
export function checkAgainstTemplate(doc: string, template: ParsedTemplate): TemplateCheck {
  const outline = outlineOf(doc);
  const D = outline.headings;
  const T = template.sections;
  const n = T.length;
  const m = D.length;

  // The tables in each document heading's span: up to the next heading of the same or a higher level.
  const spanTables: number[][] = D.map((h, k) => {
    const end = D.slice(k + 1).find((x) => x.level <= h.level)?.line ?? Number.MAX_SAFE_INTEGER;
    return outline.tables.filter((t) => t.line > h.line && t.line < end).map((t) => t.columns);
  });
  const levelFits = (i: number, k: number) => D[k].level === T[i].level;
  const fits = (i: number, k: number) => levelFits(i, k) && tablesSatisfied(T[i].tables, spanTables[k]);
  const required = T.filter((s) => !s.optional).length;

  // THE STRUCTURE PASSES when one order-preserving alignment carries every required section, each on a
  // heading of its level whose span holds its tables.
  const full = alignSections(T, m, fits);
  if (full.required === required) {
    return { passed: true, missing: [], headingTextAgreement: textAgreement(full.pairs, T, D) };
  }

  // WHAT IS MISSING, named so the correction can say it. Read from the alignment by level alone: a
  // required section with no heading of its level in place is absent; one that has its heading but not
  // the tables under it is missing those tables.
  const byLevel = alignSections(T, m, levelFits);
  const missing: MissingStructure[] = [];
  for (let i = 0; i < n; i++) {
    if (T[i].optional) continue;
    const k = byLevel.matchedAt[i];
    if (k === undefined) {
      missing.push({ kind: 'section', position: i + 1, level: T[i].level, heading: T[i].heading });
      continue;
    }
    const pool = [...spanTables[k]];
    for (const cols of T[i].tables) {
      const at = pool.indexOf(cols);
      if (at >= 0) pool.splice(at, 1);
      else missing.push({ kind: 'table', position: i + 1, level: T[i].level, heading: T[i].heading, columns: cols });
    }
  }
  return { passed: false, missing, headingTextAgreement: null };
}

/**
 * One best order-preserving alignment of the template's sections onto the document's headings under
 * `fits`. A required section outweighs every optional one together, so the alignment first carries as
 * many required sections as it can and then as many optional ones. Walked with stepping over a
 * section preferred on a tie, then matching, then stepping over a heading, so a section the document
 * lacks is reported where it falls.
 */
function alignSections(
  T: TemplateSection[],
  m: number,
  fits: (i: number, k: number) => boolean,
): { required: number; pairs: Array<[number, number]>; matchedAt: Array<number | undefined> } {
  const n = T.length;
  const weight = (i: number) => (T[i].optional ? 1 : n + 1);
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      let v = Math.max(best[i + 1][j], j < m ? best[i][j + 1] : 0);
      if (j < m && fits(i, j)) v = Math.max(v, weight(i) + best[i + 1][j + 1]);
      best[i][j] = v;
    }
  }
  const pairs: Array<[number, number]> = [];
  const matchedAt = new Array<number | undefined>(n).fill(undefined);
  let i = 0;
  let j = 0;
  while (i < n) {
    const cur = best[i][j];
    if (best[i + 1][j] === cur) {
      i += 1;
    } else if (j < m && fits(i, j) && weight(i) + best[i + 1][j + 1] === cur) {
      pairs.push([i, j]);
      matchedAt[i] = j;
      i += 1;
      j += 1;
    } else {
      j += 1;
    }
  }
  return { required: pairs.filter(([s]) => !T[s].optional).length, pairs, matchedAt };
}

function textAgreement(pairs: Array<[number, number]>, T: TemplateSection[], D: OutlineHeading[]): number | null {
  if (!pairs.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const same = pairs.filter(([i, k]) => norm(T[i].heading) === norm(D[k].text)).length;
  return Math.round((same / pairs.length) * 1000) / 1000;
}

/** The correction's instruction for what the document lacks, by position and level. */
export function describeMissingStructure(missing: MissingStructure[], templateName: string): string {
  const parts = missing.map((m) => (m.kind === 'section'
    ? `section ${m.position} (a level-${m.level} heading; the template calls it "${m.heading}")`
    : `the ${m.columns}-column table in section ${m.position} (the template's "${m.heading}")`));
  return `It does not follow the "${templateName}" template: it is missing ${parts.join('; ')}. `
    + 'Add each one at its place in the template\'s order, at that heading level, written in the '
    + 'conversation\'s language, and keep every other section as it is.';
}

// ── Deterministic fill (FR9) ───────────────────────────────────────────────────────────────────

export type FillResult =
  | { ok: true; document: string }
  | { ok: false; error: 'template_unbound_field'; field: string; binding: string; message: string };

/**
 * Render a platform-filled template from what the task recorded, with no model call.
 *
 * `requirement:<need>` binds to a SOURCED requirement (`collectedRequirements[need].value`): a value the
 * person gave or a retrieved passage supplied, never one the model filled in. `detail:<key>` binds to a
 * top-level string or number on the task's details. `tool:<state>.<path>` binds to the result the action
 * declared on `<state>` recorded when the task entered it (`details.actions[state]`), read only when that
 * run succeeded. One reader, `step-bindings.ts`, serves these fields and a step action's arguments. A
 * field whose binding resolves to nothing refuses the whole document with a named error, because a
 * document with a gap in it is not the one declared.
 */
export function fillTemplate(template: ParsedTemplate, details: Record<string, unknown> | undefined): FillResult {
  if (template.fill !== 'platform' || !template.fields) {
    return { ok: true, document: template.body.trim() };
  }
  const values: Record<string, string> = {};
  for (const [field, binding] of Object.entries(template.fields)) {
    const parsed = parseBinding(binding, FILL_BINDING_KINDS);
    const text = parsed ? resolveBinding(parsed, details) : undefined;
    if (!text) {
      return {
        ok: false,
        error: 'template_unbound_field',
        field,
        binding,
        message: `The "${template.name}" template is filled by the platform, and its field "${field}" (${binding}) `
          + (parsed?.kind === 'tool'
            ? `has no result recorded: the action on "${parsed.state}" did not run, failed, or returned nothing at that path.`
            : 'has nothing recorded. Collect it from the person, with its source, before delivering.'),
      };
    }
    values[field] = text;
  }
  return {
    ok: true,
    document: template.body.replace(PLACEHOLDER, (_m, f: string) => values[f] ?? '').trim(),
  };
}

/**
 * A `voice` message's bounds: its declared `voice` (`maxChars`, `deadlineMs`) over the defaults, each a whole number no
 * higher than its largest value. Refused on a message that is not `fill: voice`, where nothing would read it.
 */
function voiceBounds(name: string, fill: unknown, raw: unknown): VoiceBounds | undefined {
  if (fill !== 'voice') {
    if (raw !== undefined) throw new TemplateParseError(`template "${name}" declares \`voice\` bounds but is not \`fill: voice\``);
    return undefined;
  }
  if (raw === undefined) return { ...VOICE_BOUNDS_DEFAULT };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TemplateParseError(`template "${name}": \`voice\` is { maxChars?, deadlineMs? }`);
  const out: VoiceBounds = { ...VOICE_BOUNDS_DEFAULT };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== 'maxChars' && key !== 'deadlineMs') throw new TemplateParseError(`template "${name}": \`voice\` takes maxChars and deadlineMs, not "${key}"`);
    const most = VOICE_BOUNDS_MAX[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > most) {
      throw new TemplateParseError(`template "${name}": \`voice.${key}\` is a whole number from 1 to ${most}`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * A message's `when`, as far as its shape goes: one clause or a non-empty list of clauses. A prompt is read by a model,
 * and a document is chosen by its workflow step, so neither carries one.
 */
function messageWhen(name: string, kind: 'message' | 'prompt', when: unknown): unknown {
  if (kind !== 'message') throw new TemplateParseError(`template "${name}" is a ${kind}, which carries no \`when\`; a message is chosen by one`);
  const clause = (c: unknown) => !!c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length > 0;
  if (!(clause(when) || (Array.isArray(when) && when.length > 0 && when.every(clause)))) {
    throw new TemplateParseError(`template "${name}": \`when\` is { <variable>: <value> } or a list of them`);
  }
  return when;
}
