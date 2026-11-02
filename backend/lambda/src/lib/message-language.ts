/**
 * WHICH LANGUAGE A MESSAGE IS SAID IN (ADR-062 decision 4), decided from data and never from text (tenet D11).
 *
 * The target depends on who reads the message:
 *
 * | Message | Order |
 * |---|---|
 * | addressed to one person, and its email | the person's preferred language (`person:preferredLanguage`); the conversation's language (`signal:userLanguage`); the deployment's language; the template's own |
 * | read by the room, and its emails | the conversation's language; the deployment's language; the template's own |
 *
 * A person's own language is used only where one person reads the message (ADR-060 decision 7): a room speaks one
 * language, the conversation's. Every candidate is read against the deployment's declared languages
 * (`lib/config/languages.ts`), so a tag the deployment does not speak is skipped, never interpolated and never a
 * blocker. The template's own language always closes the order, so a language always resolves.
 *
 * A WRITTEN VARIANT ALWAYS WINS where one exists. `platform` fill takes the first language in the order the template
 * was written in. `voice` fill renders the order's first language with a model call when no variant is written for
 * it (`voice-fill.ts`), and falls back to the platform fill of the first written one.
 *
 * PURE: the router, the processor and the console's preview call it with what they hold.
 */
import type { ParsedTemplate } from './document-template.js';
import { deploymentLanguage, deploymentLanguages, resolveLanguageTag } from '../../../lib/config/languages.js';

/** What a call site holds that names a language, each a tag or nothing. */
export interface LanguageSignals {
  /** Who reads the message. */
  audience: 'room' | 'addressed';
  /** The addressed person's preferred language (`person:preferredLanguage`). Read only for an addressed message. */
  preferred?: unknown;
  /** The conversation's language (`signal:userLanguage`, the server-only channel-context row). */
  conversation?: unknown;
  /** The deployment's declared languages; `deploymentLanguages()` when absent. Its first is the deployment's own. */
  declared?: readonly string[];
}

/** Which step of the order a language came from, for the ledger and the console. */
export type LanguageStep = 'person' | 'conversation' | 'deployment' | 'template';

/**
 * THE ORDER, as declared tags, first preference first, without repeats. The template's own language is appended by
 * `chooseLanguage`, which knows the template; here the order ends at the deployment's language.
 */
export function languageOrder(signals: LanguageSignals): Array<{ tag: string; step: LanguageStep }> {
  const declared = signals.declared ?? deploymentLanguages();
  const out: Array<{ tag: string; step: LanguageStep }> = [];
  const push = (raw: unknown, step: LanguageStep) => {
    const tag = resolveLanguageTag(raw, declared);
    if (tag && !out.some((o) => o.tag === tag)) out.push({ tag, step });
  };
  // A PERSON'S OWN LANGUAGE ONLY WHERE ONE PERSON READS IT.
  if (signals.audience === 'addressed') push(signals.preferred, 'person');
  push(signals.conversation, 'conversation');
  push(deploymentLanguage(declared), 'deployment');
  return out;
}

/** The languages a template is written in: its own first, then each variant. */
export function writtenLanguages(template: ParsedTemplate): string[] {
  return [template.language ?? 'en', ...Object.keys(template.variants ?? {})];
}

/** The template as it reads in one language it was written in: that language's sections, under that language. */
export function inLanguage(template: ParsedTemplate, tag: string): ParsedTemplate {
  if (tag === (template.language ?? 'en') || !template.variants?.[tag]) return template;
  return { ...template, language: tag, messageSections: { ...template.variants[tag] } };
}

/** What the order chose for one template. */
export interface LanguageChoice {
  /** The language the message should reach the reader in: the order's first. */
  target: string;
  /** Which step the target came from. */
  targetStep: LanguageStep;
  /**
   * The template in the language it will be filled in: the first written language in the order, else its own. SETTLED:
   * it carries no variants, so a later render says it in this language and cannot choose again.
   */
  written: ParsedTemplate;
  /** The language `written` is in. */
  writtenLanguage: string;
  /** True when the target has a written variant (or is the template's own language): no model call is needed. */
  targetWritten: boolean;
}

/**
 * CHOOSE A TEMPLATE'S LANGUAGE for this reader. The target is the order's first language, else the template's own.
 * The written text is the first language in the order the template carries, else the template's own language, so a
 * `platform` fill is always written text and a `voice` fill knows whether the target needs a model call.
 */
export function chooseLanguage(template: ParsedTemplate, signals: LanguageSignals): LanguageChoice {
  const own = template.language ?? 'en';
  const order = languageOrder(signals);
  const written = new Set(writtenLanguages(template));
  const target = order[0] ?? { tag: own, step: 'template' as const };
  const firstWritten = order.find((o) => written.has(o.tag));
  const writtenLanguage = firstWritten?.tag ?? own;
  const { variants: _variants, ...settled } = inLanguage(template, writtenLanguage);
  return {
    target: target.tag,
    targetStep: target.step,
    written: settled,
    writtenLanguage,
    targetWritten: written.has(target.tag),
  };
}
