/**
 * THE LANGUAGES A DEPLOYMENT SPEAKS, AS A CLOSED MAP (ADR-062 decision 4, SPEC-BILINGUAL-CONVERSATIONS FR3).
 *
 * Three languages are in play on every turn and the platform holds none of them constant (tenet D11): the
 * deployment's, the person's and the model's working language. This module holds the first two's VALUE SET:
 *
 *  - `LANGUAGE_CATALOG` is every language the platform can name in a prompt, each with its English name and its own
 *    name. It is platform text: a language's name reaches a prompt from here and never from a stored tag, so a
 *    crafted tag cannot inject prompt text.
 *  - The deployment DECLARES the languages it speaks (`languages` in `deploy.config.json`), a list of catalog tags
 *    whose first entry is the deployment's own language. Synth refuses a tag the catalog does not hold, a duplicate
 *    and an empty list. Declared as nothing, the deployment speaks `DEFAULT_DEPLOYMENT_LANGUAGES`.
 *  - The declared list is the closed value set of `signal:userLanguage` and `person:preferredLanguage` (ADR-060),
 *    the choices a person's language setting offers, and the targets a message template's language order resolves
 *    to. A tag outside it is unresolved: it selects no variant, decides no condition and names no language.
 *
 * A tag a creating application sends is resolved from data, never from text: exactly, then by its primary subtag
 * (`zh-CN` reads as `zh` where `zh` is declared and `zh-CN` is not). Nothing here looks at what a person wrote.
 *
 * PURE apart from `deploymentLanguages()`, which reads the one environment variable the CDK app sets on a function
 * when the deployment declares a list (`DEPLOYMENT_LANGUAGES_ENV`). The admin console imports the catalog for its
 * language tabs.
 */

/** One language the platform can name: its English name and its own. */
export interface LanguageEntry {
  tag: string;
  /** The English name, which a prompt's reply-language instruction carries. */
  name: string;
  /** The language's own name, which a person choosing it reads. */
  native: string;
}

/**
 * EVERY LANGUAGE THE PLATFORM CAN NAME. Adding one is a reviewed change, as a reply preference is: its names are
 * platform text that reaches a prompt.
 */
export const LANGUAGE_CATALOG: Readonly<Record<string, LanguageEntry>> = Object.freeze({
  en: { tag: 'en', name: 'English', native: 'English' },
  zh: { tag: 'zh', name: 'Simplified Chinese (简体中文)', native: '简体中文' },
  'zh-Hant': { tag: 'zh-Hant', name: 'Traditional Chinese (繁體中文)', native: '繁體中文' },
  es: { tag: 'es', name: 'Spanish', native: 'Español' },
  fr: { tag: 'fr', name: 'French', native: 'Français' },
  de: { tag: 'de', name: 'German', native: 'Deutsch' },
  it: { tag: 'it', name: 'Italian', native: 'Italiano' },
  pt: { tag: 'pt', name: 'Portuguese', native: 'Português' },
  nl: { tag: 'nl', name: 'Dutch', native: 'Nederlands' },
  sv: { tag: 'sv', name: 'Swedish', native: 'Svenska' },
  pl: { tag: 'pl', name: 'Polish', native: 'Polski' },
  uk: { tag: 'uk', name: 'Ukrainian', native: 'Українська' },
  ru: { tag: 'ru', name: 'Russian', native: 'Русский' },
  tr: { tag: 'tr', name: 'Turkish', native: 'Türkçe' },
  ar: { tag: 'ar', name: 'Arabic', native: 'العربية' },
  he: { tag: 'he', name: 'Hebrew', native: 'עברית' },
  hi: { tag: 'hi', name: 'Hindi', native: 'हिन्दी' },
  id: { tag: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  vi: { tag: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  th: { tag: 'th', name: 'Thai', native: 'ไทย' },
  ja: { tag: 'ja', name: 'Japanese', native: '日本語' },
  ko: { tag: 'ko', name: 'Korean', native: '한국어' },
} satisfies Record<string, LanguageEntry>);

/** What a deployment that declares no `languages` speaks: English first, and the Chinese the catalog's CN models serve. */
export const DEFAULT_DEPLOYMENT_LANGUAGES: readonly string[] = Object.freeze(['en', 'zh']);

/** The environment variable a function reads its deployment's declared languages from (a JSON list). */
export const DEPLOYMENT_LANGUAGES_ENV = 'AE_DEPLOYMENT_LANGUAGES';

/** The context key a deployment declares its languages under. */
export const LANGUAGES_CONTEXT_KEY = 'languages';

/** Why a declared list is refused, every reason at once; empty when it is a list the platform can speak. */
export function languageListErrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['`languages` is a list of language tags, the deployment\'s own language first'];
  if (!raw.length) return ['`languages` declares no language; leave it empty ("") to take the default'];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const tag of raw) {
    if (typeof tag !== 'string' || !Object.prototype.hasOwnProperty.call(LANGUAGE_CATALOG, tag)) {
      errors.push(`"${String(tag)}" is not a language the platform can name; the catalog holds ${Object.keys(LANGUAGE_CATALOG).join(', ')}`);
      continue;
    }
    if (seen.has(tag)) errors.push(`"${tag}" is declared twice`);
    seen.add(tag);
  }
  return errors;
}

/**
 * The deployment's declared list from its context value: a JSON list, a comma list, or nothing (the default).
 * Throws naming every reason when the list is refused, so synth fails before a function is told a language the
 * platform cannot name.
 */
export function resolveDeploymentLanguages(context: unknown): readonly string[] {
  if (context === undefined || context === null || context === '') return DEFAULT_DEPLOYMENT_LANGUAGES;
  let list: unknown = context;
  if (typeof context === 'string') {
    const trimmed = context.trim();
    if (!trimmed) return DEFAULT_DEPLOYMENT_LANGUAGES;
    try { list = JSON.parse(trimmed); } catch { list = trimmed.split(',').map((s) => s.trim()).filter(Boolean); }
  }
  const errors = languageListErrors(list);
  if (errors.length) throw new Error(`languages: ${errors.join('; ')}`);
  return Object.freeze([...(list as string[])]);
}

/** True when the list is the default, so a function told nothing reads the same set. */
export function isDefaultLanguages(list: readonly string[]): boolean {
  return list.length === DEFAULT_DEPLOYMENT_LANGUAGES.length && list.every((t, i) => t === DEFAULT_DEPLOYMENT_LANGUAGES[i]);
}

/**
 * THE LANGUAGES THIS DEPLOYMENT DECLARES, as a function reads them: its environment variable when the CDK app set
 * one, else the default. A value the variable carries that the catalog would refuse is dropped tag by tag, and an
 * empty result reads as the default, so a function never names a language the platform cannot.
 */
export function deploymentLanguages(): readonly string[] {
  const raw = typeof process !== 'undefined' ? process.env?.[DEPLOYMENT_LANGUAGES_ENV] : undefined;
  if (!raw || !raw.trim()) return DEFAULT_DEPLOYMENT_LANGUAGES;
  let list: unknown;
  try { list = JSON.parse(raw); } catch { list = raw.split(','); }
  if (!Array.isArray(list)) return DEFAULT_DEPLOYMENT_LANGUAGES;
  const seen = new Set<string>();
  const kept = list.map((t) => String(t).trim()).filter((t) => {
    if (!Object.prototype.hasOwnProperty.call(LANGUAGE_CATALOG, t) || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  return kept.length ? Object.freeze(kept) : DEFAULT_DEPLOYMENT_LANGUAGES;
}

/** The deployment's own language: the first it declares. */
export function deploymentLanguage(declared: readonly string[] = deploymentLanguages()): string {
  return declared[0] ?? DEFAULT_DEPLOYMENT_LANGUAGES[0];
}

/**
 * A TAG AS THE DECLARED SET READS IT, or undefined when the set holds none of it. Exactly first, then by its primary
 * subtag, case-folded on the subtag only (`ZH-cn` and `zh-CN` both read as `zh` where only `zh` is declared). A value
 * that is not a string, or longer than a tag can be, is unresolved. Never a judgement on text: the tag is data a
 * record holds.
 */
export function resolveLanguageTag(raw: unknown, declared: readonly string[] = deploymentLanguages()): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const tag = raw.trim();
  if (!tag || tag.length > 35) return undefined;
  if (declared.includes(tag)) return tag;
  const folded = declared.find((d) => d.toLowerCase() === tag.toLowerCase());
  if (folded) return folded;
  const primary = tag.split('-')[0].toLowerCase();
  return declared.find((d) => d.toLowerCase() === primary);
}

/** The English name a prompt carries for a declared tag, or undefined: never the tag itself. */
export function languageName(raw: unknown, declared: readonly string[] = deploymentLanguages()): string | undefined {
  const tag = resolveLanguageTag(raw, declared);
  return tag ? LANGUAGE_CATALOG[tag]?.name : undefined;
}

/** The declared languages as a person choosing one, or the console, lists them. */
export function declaredLanguageEntries(declared: readonly string[] = deploymentLanguages()): LanguageEntry[] {
  return declared.map((t) => LANGUAGE_CATALOG[t]).filter((e): e is LanguageEntry => !!e);
}
