/**
 * The widget's own translation instance.
 *
 * Every string a person reads is a key in `locales/<lang>.json`, never fixed English in a component
 * (tenets P5 and D11), the same way the chat app localizes through `@ae/shared/i18n`. The widget keeps
 * its own i18next instance rather than the shared global one, so its frame carries only its own strings.
 *
 * The language is the one the host asks for (`?lang=` on the frame URL, from the loader's `lang`), then
 * the browser's, then English. Add a language by adding `locales/<lang>.json` and listing it below.
 */
import i18next, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

export const RESOURCES = { en: { translation: en } } as const;
export type WidgetLanguage = keyof typeof RESOURCES;

/** The first of the requested languages the widget has, by full tag then by primary subtag. */
export function pickLanguage(requested: readonly (string | null | undefined)[]): WidgetLanguage {
  for (const tag of requested) {
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (lower in RESOURCES) return lower as WidgetLanguage;
    const primary = lower.split('-')[0];
    if (primary in RESOURCES) return primary as WidgetLanguage;
  }
  return 'en';
}

/** A fresh instance, so a test can create one per locale. `extra` adds resources (a test's second locale). */
export function createWidgetI18n(lng: string, extra: Record<string, { translation: unknown }> = {}): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources: { ...RESOURCES, ...extra } as never,
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return instance;
}
