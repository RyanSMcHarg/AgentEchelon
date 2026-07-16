import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';

/**
 * Translation infrastructure.
 *
 * Single-source-of-truth: `src/locales/<lang>.json`.
 *
 * Add a new locale:
 *   1. Copy `en.json` to `<lang>.json` and translate values
 *   2. Import it below and add to `resources`
 *   3. (optional) Add a language picker that calls `i18n.changeLanguage(code)`
 *
 * Add a new string:
 *   1. Add the key to `en.json` under the appropriate namespace
 *   2. Use `const { t } = useTranslation();` and `t('namespace.key')` in your component
 *   3. For interpolation: `t('key', { name: 'Alice' })` with `"{{name}}"` in the JSON value
 */

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: {
      // React already escapes — avoid double-escape
      escapeValue: false,
    },
    returnNull: false,
  });

export default i18n;
