import '@testing-library/jest-dom/vitest';

/**
 * REAL TRANSLATIONS IN TESTS, so a converted component is verifiable rather than merely green.
 *
 * `main.tsx` imports this for the running app, but the test setup did not - so `useTranslation()` fell
 * back to an uninitialized i18next, `t('admin.metrics.ttff_ms.description')` returned the KEY, and every
 * rendering test saw dotted key strings where a person sees a sentence. Nothing failed, because nothing
 * asserted on that copy: the console's localization could have shipped rendering raw keys and the suite
 * would have stayed green.
 *
 * With the real resources loaded, a key that is missing or misspelled renders as itself and any test
 * asserting on the copy fails - which is the only way the conversion can be checked as it proceeds.
 */
import '@ae/shared/i18n';
