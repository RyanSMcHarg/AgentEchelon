/**
 * A CONVERTED CARD RENDERS THE SENTENCE, NOT THE KEY.
 *
 * Moving copy into `en.json` introduces a failure mode the old hardcoded strings did not have: i18next
 * returns the key itself when a key is missing, and this deployment sets no `missingKeyHandler`. So a
 * typo does not throw, does not warn in production, and does not fail a build - it renders
 * `admin.metrics.ttff_ms.description` in a tooltip and looks like a styling bug.
 *
 * It was briefly worse than that. The vitest setup did not import `@ae/shared/i18n`, so under test every
 * `t()` returned its key, and the whole console could have shipped rendering dotted keys with 411 tests
 * green. This file is the assertion that would have caught it, and it is deliberately written against
 * the rendered output rather than against the registry.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MetricCard from '../MetricCard';
import { METRIC_TARGETS } from '../metricTargets';

describe('a metric card shows its explanation', () => {
  it('renders the description text, never the locale key', async () => {
    render(
      <MetricCard
        title="Time to first feedback"
        value="820ms"
        rawValue={820}
        target={METRIC_TARGETS.ttff_ms}
      />,
    );
    const trigger = screen.getByRole('button', { name: /About Time to first feedback/i });
    trigger.focus();

    const tip = await screen.findByRole('tooltip');
    // The real sentence, from en.json.
    expect(tip).toHaveTextContent(/placeholder appearing/i);
    // AND NOT the key, which is what an unresolved lookup renders and what a human eye skims past.
    expect(tip.textContent).not.toMatch(/admin\.metrics\./);
  });

  it('shows the guide and the code behind the number', async () => {
    // The provenance links are appended by the card rather than by each call site, so this is the one
    // place that can prove they actually reach the page.
    render(
      <MetricCard
        title="Time to first feedback"
        value="820ms"
        rawValue={820}
        target={METRIC_TARGETS.ttff_ms}
      />,
    );
    screen.getByRole('button', { name: /About Time to first feedback/i }).focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip.querySelector('a[href*="LATENCY-TARGETS"]')).not.toBeNull();
    expect(tip.querySelector('a[href*="analytics-query.ts"]')).not.toBeNull();
  });
});
