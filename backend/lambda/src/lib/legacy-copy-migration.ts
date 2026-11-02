/**
 * A VERSION'S RETIRED `copy` LINES BECOME ITS ASSISTANT'S OWN MESSAGE TEMPLATES (ADR-062, `npm run migrate-legacy-copy`).
 *
 * Before message templates, a version reworded a platform line under `copy` (`memberWelcome`, `joinRecapRequest`, the
 * `email` keys, the keyed lines of decision 6). Each such key names the section of the shipped template it moved into
 * (`ShippedSection.legacy`, `shipped-message-templates.ts`). For one assistant, this reads its version's `copy`,
 * groups the lines by the template they word, and writes each template to the assistant's own family through the
 * template store, active at once, as the console's editor saves one:
 *
 *  - each line is written `{field}`-style and becomes the section it words with each declared `{field}` an optional
 *    span of that field (`braceLineAsSection`), the conversion a deployment-wide line takes too;
 *  - every section with no line keeps the shipped text, so a version that reworded one line keeps the rest;
 *  - each line is checked against the shipped template on its own: a line the template parser refuses, or one that
 *    makes the template ask for a value its call site does not supply (`storedTemplateMisfit`), is refused and
 *    reported, and the template is written from the lines that fit;
 *  - `email.language` is the language the email templates are written in, so it becomes the `notification-email`
 *    template's `language`;
 *  - IDEMPOTENT: a template the assistant already holds as its own (the message's name, or one the version's
 *    `messages` names for it) is kept, never overwritten. Run twice, the second run writes nothing.
 *
 * The version is not changed: it is immutable history. A new draft cloned from it carries the lines, and validate
 * refuses them until the draft clears `copy` (`retiredCopyErrors`).
 */
import { parseTemplate, type ParsedTemplate } from './document-template.js';
import { messageEntryNames, storedTemplateMisfit, withSectionLines, type VersionMessages } from './message-template.js';
import { legacyLinesOf, shippedMessageTemplates, shippedSourceWith } from './shipped-message-templates.js';
import { activateTemplate, loadTemplate, putTemplate, TemplateNotActiveError, type TemplateStoreDeps } from './template-store.js';

/** One template the migration settled for an assistant. */
export interface MigratedTemplate {
  /** The shipped template's name, which the assistant's own is stored under. */
  name: string;
  /** The `copy` keys that worded it. */
  keys: string[];
  /** `wrote`: stored and active; `kept`: the assistant already held its own; `would-write`: a dry run. */
  outcome: 'wrote' | 'kept' | 'would-write';
  contentHash?: string;
}

/** A line the migration did not write, and why. */
export interface RefusedLine {
  key: string;
  template?: string;
  reason: string;
}

export interface LegacyCopyReport {
  assistant: string;
  classification: string;
  templates: MigratedTemplate[];
  refused: RefusedLine[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every key a `copy` holds, `email.<key>` and `queueStatus.<key>` for the two groups. */
function keysOf(copy: Record<string, unknown>): string[] {
  return Object.entries(copy).flatMap(([k, v]) => (isObject(v) ? Object.keys(v).map((sub) => `${k}.${sub}`) : [k]));
}

/** The source a template is stored as: the shipped one with the given sections' lines over it, in `language` when set. */
function sourceWith(name: string, shipped: ParsedTemplate, lines: Record<string, string>, language?: string): string {
  const sections = withSectionLines(shipped, lines).messageSections ?? {};
  const changed = Object.fromEntries(Object.keys(lines).map((s) => [s, sections[s]]));
  const source = shippedSourceWith(name, changed);
  if (!language) return source;
  // The front matter is one JSON line between the two `---` lines (`shippedMessageSource`).
  const [, front, ...rest] = source.split('\n');
  return ['---', JSON.stringify({ ...JSON.parse(front), language }), ...rest].join('\n');
}

/** Why a source cannot be stored as this template, or nothing. */
function misfitOf(source: string, shipped: ParsedTemplate): string | undefined {
  let parsed: ParsedTemplate;
  try {
    parsed = parseTemplate(source);
  } catch (err) {
    return (err as Error).message.replace(/^\[DocumentTemplate\] /, '');
  }
  return storedTemplateMisfit(parsed, shipped);
}

/**
 * THE TEMPLATES A `copy` WORDS, with no store read: per shipped template, the source its fitting lines make, the keys
 * that worded it, and each line refused. Pure, so the console and the tests read the same plan the script writes.
 */
export function legacyCopyPlan(copy: unknown): { templates: Array<{ name: string; keys: string[]; source: string }>; refused: RefusedLine[] } {
  if (!isObject(copy)) return { templates: [], refused: [] };
  const refused: RefusedLine[] = [];
  const mapped = new Set<string>();
  const templates: Array<{ name: string; keys: string[]; source: string }> = [];
  const email = isObject(copy.email) ? copy.email : undefined;
  const language = typeof email?.language === 'string' && email.language.trim() ? email.language.trim() : undefined;
  if (email && 'language' in email) mapped.add('email.language');
  for (const [name, t] of shippedMessageTemplates()) {
    const lines = legacyLinesOf(name, copy);
    const keyOf = (section: string) => t.entry.sections[section]?.legacy ?? section;
    const fitting: Record<string, string> = {};
    for (const [section, line] of Object.entries(lines)) {
      mapped.add(keyOf(section));
      const misfit = misfitOf(sourceWith(name, t.template, { [section]: line }), t.template);
      if (misfit) refused.push({ key: keyOf(section), template: name, reason: misfit });
      else fitting[section] = line;
    }
    const lang = name === 'notification-email' ? language : undefined;
    if (!Object.keys(fitting).length && !lang) continue;
    const source = sourceWith(name, t.template, fitting, lang);
    const misfit = misfitOf(source, t.template);
    if (misfit) {
      refused.push({ key: lang ? 'email.language' : Object.keys(fitting).map(keyOf).join(', '), template: name, reason: misfit });
      continue;
    }
    templates.push({ name, keys: [...new Set(Object.keys(fitting).map(keyOf)), ...(lang ? ['email.language'] : [])], source });
  }
  // A key no shipped template words, or a value that is not a line, is said rather than dropped silently.
  for (const key of keysOf(copy)) {
    if (mapped.has(key)) continue;
    const [group, sub] = key.split('.');
    const value = sub ? (copy[group] as Record<string, unknown>)[sub] : copy[key];
    refused.push({ key, reason: typeof value === 'string' && value.trim() ? 'no message template words this key' : 'not a line (blank or not text)' });
  }
  return { templates, refused };
}

/** Whether the assistant's own family holds an active template of this name. */
async function holdsOwn(classification: string, assistant: string, name: string, kind: 'message' | 'prompt', deps?: TemplateStoreDeps): Promise<boolean> {
  try {
    await loadTemplate(classification, { name }, deps, { owner: { family: 'assistant', assistant }, kind });
    return true;
  } catch (err) {
    if (err instanceof TemplateNotActiveError) return false;
    throw err;
  }
}

/** Migrate one assistant's version `copy` into its own templates. See the module header. */
export async function migrateLegacyCopy(
  at: { assistant: string; classification: string; copy: unknown; messages?: VersionMessages | null },
  deps?: TemplateStoreDeps,
  opts: { dryRun?: boolean } = {},
): Promise<LegacyCopyReport> {
  const plan = legacyCopyPlan(at.copy);
  const owner = { family: 'assistant' as const, assistant: at.assistant };
  const templates: MigratedTemplate[] = [];
  for (const t of plan.templates) {
    const kind = shippedMessageTemplates().get(t.name)?.template.kind === 'prompt' ? 'prompt' : 'message';
    const held = [t.name, ...messageEntryNames(at.messages?.[t.name])];
    let kept = false;
    for (const name of held) if (await holdsOwn(at.classification, at.assistant, name, kind, deps)) { kept = true; break; }
    if (kept) {
      templates.push({ name: t.name, keys: t.keys, outcome: 'kept' });
      continue;
    }
    const put = await putTemplate(at.classification, t.source, deps, { owner, dryRun: opts.dryRun });
    if (!opts.dryRun) await activateTemplate(at.classification, put.name, put.contentHash, deps, { owner });
    templates.push({ name: t.name, keys: t.keys, outcome: opts.dryRun ? 'would-write' : 'wrote', contentHash: put.contentHash });
  }
  return { assistant: at.assistant, classification: at.classification, templates, refused: plan.refused };
}
