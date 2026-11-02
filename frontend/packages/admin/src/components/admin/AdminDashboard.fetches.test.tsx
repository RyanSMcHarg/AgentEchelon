/**
 * EVERY TAB EITHER ASKS FOR ITS DATA OR SAYS WHY IT DOES NOT.
 *
 * THE FAILURE THIS EXISTS FOR. `Page and Connection` renders `page_load_metrics` and
 * `connection_health_daily` and had no entry in `QUERIES_BY_TAB`, so it fetched nothing. The only
 * tab that requested those two was Latency, which meant the page was populated if and only if an
 * operator had already opened Latency in the same session - and when they had not, the empty state
 * told them there was no data in the window. That reads as "the browser telemetry is not being
 * collected", which is the opposite of true, and it is exactly what SPEC-ADMIN-CONSOLE FR26 promises
 * will not happen: no table renders as silently empty or misleading.
 *
 * Nothing failed when that entry went missing, and nothing would have failed if a second one went
 * missing tomorrow, because a tab with no entry is indistinguishable from a tab that legitimately
 * has none - Model Strategy renders shipped constants and issues no query at all. So the two cases
 * are now written down separately and this test holds the line between them.
 *
 * WHAT IT DOES NOT CLAIM. That the queries are the RIGHT ones for a tab, or that a tab renders what
 * it fetched. It claims only that no tab is silently in neither list.
 */
import { describe, it, expect } from 'vitest';
import { SECTIONS, QUERIES_BY_TAB, TABS_THAT_FETCH_NOTHING_HERE } from './AdminDashboard';

const allTabs = SECTIONS.flatMap((s) => s.tabs);

describe('the per-tab query map', () => {
  it('covers every tab in the nav, or names why a tab is absent', () => {
    const unaccounted = allTabs.filter(
      (id) => !(id in QUERIES_BY_TAB) && !(id in TABS_THAT_FETCH_NOTHING_HERE),
    );
    expect(
      unaccounted,
      'A tab in neither list fetches nothing and says nothing about why. That is how Page and '
        + 'Connection shipped empty: add it to QUERIES_BY_TAB, or to TABS_THAT_FETCH_NOTHING_HERE '
        + 'with the reason it needs no entry.',
    ).toEqual([]);
  });

  it('puts no tab in both lists, since the second is for tabs the first does not serve', () => {
    const both = allTabs.filter((id) => id in QUERIES_BY_TAB && id in TABS_THAT_FETCH_NOTHING_HERE);
    expect(both).toEqual([]);
  });

  it('names only tabs that are actually in the nav', () => {
    const known = new Set<string>(allTabs);
    const strays = [...Object.keys(QUERIES_BY_TAB), ...Object.keys(TABS_THAT_FETCH_NOTHING_HERE)]
      .filter((id) => !known.has(id));
    expect(
      strays,
      'An entry for a tab the nav does not render is dead weight that reads as coverage.',
    ).toEqual([]);
  });

  it('asks for the client-events reads on the tab that renders them', () => {
    // The specific regression: Page and Connection depending on Latency having been visited.
    expect(QUERIES_BY_TAB.client ?? []).toEqual(
      expect.arrayContaining(['page_load_metrics', 'connection_health_daily']),
    );
  });

  it('gives a non-empty reason for every tab that fetches nothing here', () => {
    const blank = Object.entries(TABS_THAT_FETCH_NOTHING_HERE)
      .filter(([, why]) => !why || !why.trim())
      .map(([id]) => id);
    expect(blank, 'An empty reason is an absent entry with extra steps.').toEqual([]);
  });
});
