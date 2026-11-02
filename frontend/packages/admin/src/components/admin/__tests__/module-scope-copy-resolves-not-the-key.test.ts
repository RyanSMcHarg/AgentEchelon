/**
 * COPY OUTSIDE A COMPONENT RESOLVES TO WORDS, NOT TO ITS OWN KEY.
 *
 * Most of this console translates through `useTranslation()`, where a missing key is obvious the moment
 * anyone opens the tab. The modules that have no hook - `alerts.ts`, the services, the chart placeholders -
 * call `i18n.t(...)` directly instead, and that call has a silent failure mode: if the shared i18n has not
 * initialized, or the key is absent from `en.json`, `t` RETURNS THE KEY. The page still renders, the types
 * still check, the tests that only assert a value exists still pass, and what a person sees is
 * `admin.alerts.platformErrorRateAboveTarget`.
 *
 * That is the failure this file exists for, and it is not hypothetical here: these call sites were created
 * mechanically, in bulk, by a converter. A missing import in one of them would look exactly like success.
 *
 * It asserts the SHAPE rather than the wording - no dot-separated key, and some real letters - so editing
 * the English does not break the test, while shipping a key does.
 */
import { describe, it, expect } from 'vitest';
import { computeAlerts } from '../alerts';
import i18n from '@ae/shared/i18n';

/** A locale key that leaked instead of its copy: dotted, no spaces, starts with a known namespace. */
const looksLikeAKey = (s: string): boolean => /^[a-z][\w]*(\.[\w]+){2,}$/i.test(s.trim());

describe('copy resolved outside a component', () => {
  it('turns a key into words, so the shared i18n is actually initialized here', () => {
    // If this returns the key, every `i18n.t` site in the console is shipping keys.
    const resolved = i18n.t('admin.alerts.platformErrorRateAboveTarget');
    expect(looksLikeAKey(resolved)).toBe(false);
    expect(resolved).toMatch(/[a-z]\s+[a-z]/i);
  });

  it('gives an alert built outside any component a readable title', () => {
    const alerts = computeAlerts({
      latency: [{ delivery_option: 'DIRECT', assistant_turn_count: 100, avg_ttff_ms: 3200, p95_total_ms: 9000 }],
      errorRate: [{ error_count: 80, total_count: 1000 }],
    });
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect(looksLikeAKey(a.title)).toBe(false);
      // `detail` carries the measured value against its target, and is assembled in the same
      // hook-less module, so it leaks a key the same way the title would.
      expect(looksLikeAKey(a.detail)).toBe(false);
    }
  });

  it('REFUSES a key that does not exist, which is what proves the check can fail', () => {
    // Without this, a `looksLikeAKey` that never matches would make both tests above vacuous.
    expect(looksLikeAKey(i18n.t('admin.alerts.thisKeyWasNeverAdded'))).toBe(true);
  });
});
