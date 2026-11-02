import { describe, it, expect } from 'vitest';
import { DATE_PRESETS, getDateRange, type DatePreset } from './AdminDashboard';

/**
 * EVERY PRESET NAMES ITS OWN WINDOW.
 *
 * `getDateRange` was a switch with cases for 7d, 30d and 90d and a `default` that returned seven
 * days, so any preset the switch did not know about was served as a week without saying so - and
 * there was no shorter preset to reach for at all. A pull taken before the 2026-09-05 teardown asked
 * for 24h and got eight days of data back, which reads as the system being that slow rather than as
 * the window not being applied.
 *
 * The guard is that the table the selector renders is the same table the range is derived from, so a
 * button can never exist without a window behind it.
 */
const DAY_MS = 86_400_000;

describe('the date presets', () => {
  it('offers a window shorter than a week', () => {
    expect(Object.keys(DATE_PRESETS)).toContain('24h');
  });

  it('each day preset serves exactly the calendar days it is named for, and 24h the smallest window that holds a day', () => {
    // Both analytics modes serve a range as whole UTC days from start THROUGH end, so the days served
    // are (end - start) + 1. Sending start = today - N made "Last 7 days" serve eight.
    for (const [preset, days] of Object.entries(DATE_PRESETS)) {
      const { start, end } = getDateRange(preset as DatePreset);
      const servedDays = (Date.parse(end) - Date.parse(start)) / DAY_MS + 1;
      expect({ preset, servedDays }).toEqual({ preset, servedDays: preset === '24h' ? 2 : days });
    }
  });

  it('no two presets produce the same window - the failure this replaces', () => {
    const spans = (Object.keys(DATE_PRESETS) as DatePreset[]).map((preset) => {
      const { start, end } = getDateRange(preset);
      return Date.parse(end) - Date.parse(start);
    });
    expect(new Set(spans).size).toBe(spans.length);
  });

  it('the bounds are YYYY-MM-DD, which is what both analytics modes validate', () => {
    for (const preset of Object.keys(DATE_PRESETS) as DatePreset[]) {
      const { start, end } = getDateRange(preset);
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('every window ends today and reaches backwards, never forwards', () => {
    const today = new Date().toISOString().split('T')[0];
    for (const preset of Object.keys(DATE_PRESETS) as DatePreset[]) {
      const { start, end } = getDateRange(preset);
      expect(end).toBe(today);
      expect(Date.parse(start)).toBeLessThan(Date.parse(end));
    }
  });
});
