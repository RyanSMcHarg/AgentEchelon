import { describe, it, expect } from 'vitest';
import { isTabAvailableIn, isTabAvailableToTeam, profilesLanding, SECTIONS, TAB_CAPABILITY, TEAM_TABS, TABS_THAT_FETCH_NOTHING_HERE } from './AdminDashboard';

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

describe('the Processes tab (SPEC-PROCESSES P9)', () => {
  it('sits under Performance beside Overview, read with the same capability as Effectiveness', () => {
    const performance = SECTIONS.find((s) => s.id === 'performance')!;
    expect(performance.tabs.slice(0, 2)).toEqual(['effectiveness', 'processes']);
    expect(TAB_CAPABILITY.processes).toBe(TAB_CAPABILITY.effectiveness);
    expect(TAB_CAPABILITY.processes).toBe('view-analytics');
  });

  it('is Aurora mode only, as the process analytics are', () => {
    expect(isTabAvailableIn('processes', 'aurora')).toBe(true);
    expect(isTabAvailableIn('processes', 'athena')).toBe(false);
  });

  it('is a team tab, so a team reads the processes its own assistants ran, on its team route', () => {
    expect(TEAM_TABS.has('processes')).toBe(true);
    expect(isTabAvailableToTeam('processes', 'aurora', false)).toBe(true);
    expect(isTabAvailableToTeam('processes', 'athena', false)).toBe(false);
    expect(isTabAvailableToTeam('processes', 'aurora', true)).toBe(false);
  });

  it('issues its own query, so the dashboard fan-out asks for nothing on it', () => {
    expect(TABS_THAT_FETCH_NOTHING_HERE.processes).toBeTruthy();
  });
});

describe('browser history landing on the Assistants tab', () => {
  it('opens the workflow an entry names, on its own assistant, over the assistant analytics were opened from', () => {
    expect(profilesLanding('advisor', { assistant: 'concierge', workflow: 'welcome' })).toEqual({ link: { assistant: 'concierge', workflow: 'welcome' } });
  });

  it('returns to the assistant analytics were opened from when the entry names no workflow, else the list', () => {
    expect(profilesLanding('advisor', null)).toEqual({ reopen: 'advisor' });
    expect(profilesLanding(null, null)).toEqual({ link: null });
  });
});
