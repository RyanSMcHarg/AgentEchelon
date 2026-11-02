import { describe, it, expect } from 'vitest';
import { isTabAvailableIn, SECTIONS } from './AdminDashboard';

// B6 regression guard: after 8f143e3 the Effectiveness section's tabs were ALL Aurora-only, so the
// section (and every evaluation surface) vanished in Athena mode even though evaluation_scores is still
// served there. `evaluations` is now Athena-only and lives in the Effectiveness section, so Athena has
// a reachable evaluation view again while Aurora keeps the richer drill.
describe('AdminDashboard tab availability (B6: Athena keeps an evaluation surface)', () => {
  // The evaluation surface moved from a section called 'quality' to the PERFORMANCE surface, which
  // holds the two views of one population: how fast a turn was and how good it was. B6 is unchanged
  // by that rename - what it guards is that the section carrying  stays reachable in
  // BOTH analytics modes, because Athena has no effectiveness drill and this is its only eval view.
  const quality = SECTIONS.find((s) => s.id === 'performance')!;

  it('the Effectiveness section exists and includes the evaluations tab', () => {
    expect(quality).toBeTruthy();
    expect(quality.tabs).toContain('evaluations');
  });

  it('`evaluations` is reachable in Athena and hidden in Aurora (drill supersedes it)', () => {
    expect(isTabAvailableIn('evaluations', 'athena')).toBe(true);
    expect(isTabAvailableIn('evaluations', 'aurora')).toBe(false);
  });

  it('`effectiveness` (the rich drill) is Aurora-only', () => {
    expect(isTabAvailableIn('effectiveness', 'aurora')).toBe(true);
    expect(isTabAvailableIn('effectiveness', 'athena')).toBe(false);
  });

  it('the Effectiveness section has at least one reachable tab in BOTH modes (never fully hidden)', () => {
    const athena = quality.tabs.filter((t) => isTabAvailableIn(t, 'athena'));
    const aurora = quality.tabs.filter((t) => isTabAvailableIn(t, 'aurora'));

    // THE INVARIANT, asserted as the invariant. This read as two exact arrays, which made it fail the
    // moment `latency` joined this section in the restructure - a true statement about tab
    // availability breaking on a change to tab GROUPING. B6 is about neither mode losing its eval
    // surface, so that is what is checked, plus the specific facts underneath it.
    expect(athena.length).toBeGreaterThan(0);
    expect(aurora.length).toBeGreaterThan(0);

    // Athena has no effectiveness drill, so `evaluations` is its eval view and must survive.
    expect(athena).toContain('evaluations');
    expect(athena).not.toContain('effectiveness');
    // Aurora has the drill, and the basic evaluations view is hidden as clutter behind it.
    expect(aurora).toContain('effectiveness');
    expect(aurora).not.toContain('evaluations');
    // The human-ACTION views are Aurora-only and stay reachable there.
    expect(aurora).toEqual(expect.arrayContaining(['flagged', 'ground_truth']));
  });
});
