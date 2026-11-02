/**
 * WHICH MESSAGE OR PROMPT TEMPLATE IS USED (ADR-062 decision 3): the assistant's own, then the classification's,
 * then the shipped one, the order every other selection follows.
 *
 *  1. The assistant's own family, `templates/<classification>/_assistants/<assistant>/`: the template the
 *     version's `messages` names for the message, else the one of the message's own name. A version may instead
 *     name a family (`@classification`, `@shipped`), which skips this step, or both of these steps.
 *  2. The classification's family, `templates/<classification>/<name>/`, as document templates are stored.
 *  3. A deployment-wide line, where a call site has one (the `budgetCannedResponse` context), then the shipped
 *     template (`shipped-message-templates.ts`), which the platform carries in every function that says a
 *     message, so a message is never lost for want of a store read.
 *
 * The order itself is one pure rule (`chooseMessageTemplate`), which the console's editor calls too. This
 * module reads the store for it. A stored template is used only when it fits the call site (its kind, and no
 * field the call site does not supply); one that does not, or cannot be read, is logged and the next family
 * answers (tenet D5): a message is always said.
 *
 * A TEMPLATE LEARNS ITS AUDIENCE HERE (ADR-060 decision 3, first layer): the call site says who reads the message
 * (`TemplateUse`), and a stored template whose insertions that audience may not read (a fact about a person in a
 * message the room reads, a mention of anything but a display name, clearance in an email) is passed over, so the
 * next family answers. The shipped templates are checked against the same rules by their own test.
 */
import type { ParsedTemplate } from './document-template.js';
import {
  chooseMessageName, chooseMessageTemplate, messageEntryNames, messageFamilies, storedTemplateMisfit, templateWhenHolds,
  type MessageOrigin, type VersionMessages,
} from './message-template.js';
import {
  buildSourceTable, insertionErrors, versionLookup, whenErrors, withUnreadCatalog,
  type SourceLookup, type VersionVariable, type When,
} from './variables.js';
import type { MessageTemplateSet } from './message-lines.js';
import { shippedMessageTemplate, shippedMessageTemplates } from './shipped-message-templates.js';
import {
  listTemplates,
  loadTemplate,
  TemplateNotActiveError,
  TEMPLATE_POINTER_TTL_MS,
  type TemplateOwner,
  type TemplateStoreDeps,
} from './template-store.js';

export { storedTemplateMisfit, type MessageOrigin };

/** Who reads the message at this call site, and the lookup its resolver-bound fields are checked through. */
export interface TemplateUse {
  /** The classification's sources and the version's variables (`versionLookup`, `withUnreadCatalog`). */
  lookup: SourceLookup;
  audience: 'room' | 'addressed';
  /** The fields the call site renders as an inert mention. */
  mentions?: readonly string[];
  /**
   * Whether a condition holds at this call site (`whenHolds` over the values it holds, ADR-060 decision 6): a stored
   * template carrying a `when` is said only where it holds, and a version's `messages` entry chooses among its
   * alternatives by it. Absent, no condition holds, so the unconditioned template answers.
   */
  holds?: (when: When) => boolean;
}

/** Why a template's insertions are refused for this use, or nothing. A prompt is read by a model, not a person. */
export function templateUseMisfit(template: ParsedTemplate, use: TemplateUse | undefined): string | undefined {
  if (!use || template.kind !== 'message') return undefined;
  const errors = insertionErrors({ fields: template.fields ?? {}, sections: template.messageSections ?? {}, audience: use.audience, mentions: use.mentions }, use.lookup);
  // A TEMPLATE'S CONDITION IS HELD TO THE SAME RULES AS A STEP'S: it selects a message these readers read.
  if (template.when !== undefined) errors.push(...whenErrors(template.when, use.lookup, { selects: use.audience }).map((e) => `its when: ${e}`));
  return errors.length ? errors.join('; ') : undefined;
}

export interface SelectedMessageTemplate {
  name: string;
  template: ParsedTemplate;
  origin: MessageOrigin;
}

export interface MessageSelectionInput {
  classification: string;
  /** The assistant whose voice says it: its profile name. Absent reads no assistant family. */
  assistant?: string;
  /** The shipped template's name. */
  name: string;
  /** The version's `messages`: which of the assistant's own templates, or which family, this message is said from. */
  messages?: VersionMessages | null;
  /** A deployment-wide line per section, between the classification's template and the shipped one. */
  deploymentLines?: Record<string, string>;
  /** Who reads it, which a stored template's insertions are checked against. */
  use?: TemplateUse;
}

/** The active template of one family, when it can be read and fits the call site. */
async function fromStore(
  classification: string,
  name: string,
  owner: TemplateOwner,
  shipped: ParsedTemplate,
  deps: TemplateStoreDeps | undefined,
  use?: TemplateUse,
  /** What a resolver-bound field fits through where no use is stated (a set read for a turn). */
  fitLookup?: SourceLookup,
): Promise<ParsedTemplate | undefined> {
  try {
    const loaded = await loadTemplate(classification, { name }, deps, { owner, kind: shipped.kind ?? 'document' });
    const misfit = storedTemplateMisfit(loaded.template, shipped, { lookup: use?.lookup ?? fitLookup }) ?? templateUseMisfit(loaded.template, use);
    if (misfit) {
      console.warn('[message-template] a stored template does not fit its call site; the next one answers', { classification, name, family: owner.family, misfit });
      return undefined;
    }
    // A stored template's own condition is read where the call site states its use; a set read for a turn keeps it,
    // and the line that says it reads the condition then (`chooseMessageTemplate`).
    if (use && !templateWhenHolds(loaded.template, use.holds)) return undefined;
    return loaded.template;
  } catch (err) {
    if (!(err instanceof TemplateNotActiveError)) {
      console.warn('[message-template] a stored template could not be read; the next one answers', {
        classification, name, family: owner.family, err: (err as Error)?.name, message: (err as Error)?.message,
      });
    }
    return undefined;
  }
}

const setCache = new Map<string, { at: number; set: MessageTemplateSet }>();

/** Forget cached sets. For tests. */
export function _resetMessageTemplateSets(): void {
  setCache.clear();
}

/** The active templates of one family that fit a shipped message, by name. A family that cannot be read holds none. */
async function familyTemplates(
  classification: string,
  owner: TemplateOwner,
  kindOf: (name: string) => ParsedTemplate | undefined,
  deps: TemplateStoreDeps | undefined,
  fitLookup?: SourceLookup,
): Promise<Map<string, ParsedTemplate>> {
  const out = new Map<string, ParsedTemplate>();
  try {
    for (const listed of await listTemplates(classification, deps, owner)) {
      const shipped = listed.active ? kindOf(listed.name) : undefined;
      if (!shipped) continue;
      const loaded = await fromStore(classification, listed.name, owner, shipped, deps, undefined, fitLookup);
      if (loaded) out.set(listed.name, loaded);
    }
  } catch (err) {
    console.warn('[message-template] a template family could not be listed; its messages use the next family', {
      classification, family: owner.family, err: (err as Error)?.name, message: (err as Error)?.message,
    });
  }
  return out;
}

/**
 * THE STORED TEMPLATES ONE ASSISTANT SAYS ITS LINES FROM, read once for a turn and handed to the synchronous call
 * sites (`templateLine`, `message-lines.ts`). Each family is listed (one list per family) and only the templates it
 * holds are read, so a deployment that has saved none pays two lists. Cached per container for the pointer TTL,
 * the same freshness every template read has. A template the version's `messages` names is checked against the
 * message it is named for.
 */
export async function loadMessageTemplateSet(
  at: {
    classification: string; assistant?: string; messages?: VersionMessages | null;
    /** The version's variables: a stored field bound to one, or to a source the platform publishes, fits the set. */
    variables?: Readonly<Record<string, VersionVariable>>;
  },
  deps?: TemplateStoreDeps,
): Promise<MessageTemplateSet> {
  const key = `${at.classification}|${at.assistant ?? ''}|${JSON.stringify(at.messages ?? {})}|${JSON.stringify(at.variables ?? {})}`;
  // A RESOLVER-BOUND FIELD FITS THE SET as the catalog's least-permitting reading would admit it; the line that says
  // the template reads it through the turn's own resolver (`resolverValues`, `message-lines.ts`).
  const fitLookup = withUnreadCatalog(versionLookup(buildSourceTable({ catalog: [] }), at.variables));
  const now = Date.now();
  const hit = setCache.get(key);
  if (hit && now - hit.at < TEMPLATE_POINTER_TTL_MS && !deps) return hit.set;
  const shipped = shippedMessageTemplates();
  const namedFor = new Map(Object.entries(at.messages ?? {}).flatMap(([message, entry]) => messageEntryNames(entry).map((name) => [name, message] as const)));
  const shippedFor = (name: string) => shipped.get(name)?.template ?? (namedFor.has(name) ? shipped.get(namedFor.get(name)!)?.template : undefined);
  const [own, classwide] = await Promise.all([
    at.assistant ? familyTemplates(at.classification, { family: 'assistant', assistant: at.assistant }, shippedFor, deps, fitLookup) : Promise.resolve(new Map()),
    familyTemplates(at.classification, { family: 'classification' }, (n) => shipped.get(n)?.template, deps, fitLookup),
  ]);
  const set: MessageTemplateSet = { own, classwide, ...(at.messages ? { messages: at.messages } : {}) };
  if (!deps) setCache.set(key, { at: now, set });
  return set;
}

/**
 * A PROMPT TEMPLATE A VERSION NAMES BY ITS OWN NAME (a \`prompt\` welcome's \`welcome.prompt\`), by the same order: the
 * assistant's family, the classification's, then the shipped one of that name. Undefined when none of them holds a
 * prompt of that name, which validation refuses before a version names it.
 */
export async function loadNamedPromptTemplate(
  at: { classification: string; assistant?: string; name: string },
  deps?: TemplateStoreDeps,
): Promise<ParsedTemplate | undefined> {
  return loadNamedTemplate(at, 'prompt', deps);
}

/**
 * A TEMPLATE OF EITHER KIND A WORKFLOW STEP NAMES (ADR-061): a `send` step's message, an `agent` step's prompt, in
 * the same order, the assistant's family, the classification's, then the shipped one of that name and kind.
 */
export async function loadNamedTemplate(
  at: { classification: string; assistant?: string; name: string },
  kind: 'message' | 'prompt',
  deps?: TemplateStoreDeps,
  /** Who reads the message: a stored one its audience may not read is passed over, and the next family answers. */
  use?: TemplateUse,
): Promise<ParsedTemplate | undefined> {
  const owners: TemplateOwner[] = [
    ...(at.assistant ? [{ family: 'assistant' as const, assistant: at.assistant }] : []),
    { family: 'classification' },
  ];
  for (const owner of owners) {
    try {
      const { template } = await loadTemplate(at.classification, { name: at.name }, deps, { owner, kind });
      const misfit = templateUseMisfit(template, use);
      if (!misfit && templateWhenHolds(template, use?.holds)) return template;
      if (!misfit) continue;
      console.warn('[message-template] a stored template inserts what its audience may not read; the next one answers', {
        classification: at.classification, name: at.name, family: owner.family, misfit,
      });
    } catch (err) {
      if (!(err instanceof TemplateNotActiveError)) {
        console.warn('[message-template] a named template could not be read; the next family answers', {
          classification: at.classification, name: at.name, family: owner.family, err: (err as Error)?.name,
        });
      }
    }
  }
  const shipped = shippedMessageTemplates().get(at.name)?.template;
  return (shipped?.kind ?? 'message') === kind ? shipped : undefined;
}

/** The template a message is said from, by the order above. Never throws for a name the platform ships. */
export async function selectMessageTemplate(input: MessageSelectionInput, deps?: TemplateStoreDeps): Promise<SelectedMessageTemplate> {
  const { classification, assistant, name } = input;
  const shipped = shippedMessageTemplate(name);
  // The template the version names for this message, else the assistant's template of the message's own name; a
  // family the version names skips the assistant's, or both.
  const families = messageFamilies(chooseMessageName(input.messages?.[name], input.use?.holds), name);
  const own = assistant && families.own ? await fromStore(classification, families.own, { family: 'assistant', assistant }, shipped, deps, input.use) : undefined;
  // The classification's family is read only when nothing of the assistant's answers.
  const classwide = own || !families.classification ? undefined : await fromStore(classification, name, { family: 'classification' }, shipped, deps, input.use);
  const chosen = chooseMessageTemplate({ shipped, own, classification: classwide, deploymentLines: input.deploymentLines, lookup: input.use?.lookup, holds: input.use?.holds });
  return { name, ...chosen };
}
