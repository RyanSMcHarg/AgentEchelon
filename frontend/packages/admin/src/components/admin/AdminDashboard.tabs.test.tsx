import { describe, it, expect } from 'vitest';
import { isTabAvailableIn, SECTIONS } from './AdminDashboard';

// B6 regression guard: after 8f143e3 the Effectiveness section's tabs were ALL Aurora-only, so the
// section (and every evaluation surface) vanished in Athena mode even though evaluation_scores is still
// served there. `evaluations` is now Athena-only and lives in the Effectiveness section, so Athena has
// a reachable evaluation view again while Aurora keeps the richer drill.
describe('AdminDashboard tab availability (B6: Athena keeps an evaluation surface)', () => {
  const quality = SECTIONS.find((s) => s.id === 'quality')!;

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
    // Athena: only `evaluations` survives — but that is enough that the section (and eval UI) renders.
    expect(athena).toEqual(['evaluations']);
    // Aurora: the drill + human-action tabs, no basic evaluations clutter.
    expect(aurora).toEqual(['effectiveness', 'flagged', 'ground_truth']);
  });
});
