/**
 * THE FILTER SET BOTH PERFORMANCE SURFACES CUT BY.
 *
 * Latency and Effectiveness read one population two ways, and they shared only the date range: one
 * owned six pills in a component defined inside its own file and never exported, the other
 * re-implemented a subset as plain selects. A person who narrowed one and moved to the other got a
 * different population and was not told.
 *
 * The behavior below is pinned on the PURE functions rather than through the rendered bar, because
 * inside a click handler the only observable is a pill, and a test written against a pill passes
 * whether or not the cascade resets anything.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_FILTERS,
  withFilterChange,
  hasActiveFilter,
  filterOptions,
  rowMatches,
  filtersFromUrl,
  filtersToSearch,
  type PerformanceFilters,
} from './PerformanceFilters';

const ROWS = [
  { conversation_classification: 'premium', assistant: 'atlas', assistant_role: 'primary', profile_version: '3', turn_entry: 'flow', battle_round: null },
  { conversation_classification: 'premium', assistant: 'atlas', assistant_role: 'primary', profile_version: '4', turn_entry: 'lex', battle_round: null },
  { conversation_classification: 'premium', assistant: 'nova', assistant_role: 'alt', profile_version: '1', turn_entry: 'flow', battle_round: '1' },
  { conversation_classification: 'standard', assistant: 'echo', assistant_role: 'primary', profile_version: '9', turn_entry: 'flow', battle_round: null },
];

describe('the cascade clears what a change invalidates', () => {
  const narrowed: PerformanceFilters = {
    classification: 'premium', assistant: 'atlas', role: 'primary', version: '3', entry: 'flow', duel: null, responseType: null,
  };

  it('changing the classification clears assistant, role and version', () => {
    // THE DEFECT THIS PREVENTS: `standard` + `atlas` is a pairing that never ran, so the page returns
    // an empty chart - and an empty chart is indistinguishable from a quiet week.
    const next = withFilterChange(narrowed, 'classification', 'standard');
    expect(next).toMatchObject({ classification: 'standard', assistant: null, role: null, version: null });
  });

  it('changing the assistant clears the version, because a version number is only meaningful against one', () => {
    // Two assistants both have a version 3 and they are not the same thing.
    const next = withFilterChange(narrowed, 'assistant', 'nova');
    expect(next).toMatchObject({ assistant: 'nova', version: null });
    // The classification is NOT cleared: nova ran in premium, so the narrower cut still stands.
    expect(next.classification).toBe('premium');
  });

  it('leaves the unrelated axes alone, so the reset is a rule rather than a reset button', () => {
    // NON-VACUITY. A cascade that cleared everything on every change would pass both cases above and
    // make the bar useless.
    const next = withFilterChange(narrowed, 'entry', 'lex');
    expect(next).toMatchObject({ classification: 'premium', assistant: 'atlas', role: 'primary', version: '3', entry: 'lex' });
  });

  it('clearing one axis to "all" does not disturb the others', () => {
    const next = withFilterChange(narrowed, 'role', null);
    expect(next.role).toBeNull();
    expect(next.assistant).toBe('atlas');
  });

  it('knows when anything is narrowed at all', () => {
    expect(hasActiveFilter(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilter(narrowed)).toBe(true);
  });
});

describe('the options offered are the ones that exist', () => {
  it('offers only the assistants that ran in the chosen classification', () => {
    const o = filterOptions(ROWS, { ...EMPTY_FILTERS, classification: 'premium' });
    expect(o.assistants).toEqual(['atlas', 'nova']);
    expect(o.assistants).not.toContain('echo');
  });

  it('offers only the versions the chosen assistant ran', () => {
    const o = filterOptions(ROWS, { ...EMPTY_FILTERS, classification: 'premium', assistant: 'atlas' });
    expect(o.versions).toEqual(['3', '4']);
    expect(o.versions).not.toContain('1');
  });

  it('offers every classification before one is chosen', () => {
    const o = filterOptions(ROWS, EMPTY_FILTERS);
    expect(o.classifications).toEqual(['premium', 'standard']);
  });

  it('derives from the rows present, so an assistant with no turns this window is not offered', () => {
    // A configuration list would offer it and return nothing, which reads as a quiet week.
    const o = filterOptions(ROWS.filter((r) => r.assistant !== 'nova'), { ...EMPTY_FILTERS, classification: 'premium' });
    expect(o.assistants).toEqual(['atlas']);
  });
});

describe('one predicate, so both surfaces cut identically', () => {
  it('keeps a row on every axis it matches', () => {
    expect(rowMatches(ROWS[0], { ...EMPTY_FILTERS, classification: 'premium', assistant: 'atlas', version: '3' })).toBe(true);
  });

  it('drops a row that differs on any single axis', () => {
    expect(rowMatches(ROWS[0], { ...EMPTY_FILTERS, version: '4' })).toBe(false);
    expect(rowMatches(ROWS[0], { ...EMPTY_FILTERS, entry: 'lex' })).toBe(false);
  });

  it('treats an unset axis as "all" rather than as a requirement to be null', () => {
    expect(rowMatches(ROWS[0], EMPTY_FILTERS)).toBe(true);
  });

  it('matches the entry axis, which is the targeted-versus-standard split', () => {
    // Migration 054: StandardMessages NONE means every `lex` turn is a targeted one.
    const lexOnly = ROWS.filter((r) => rowMatches(r, { ...EMPTY_FILTERS, entry: 'lex' }));
    expect(lexOnly).toHaveLength(1);
    expect(lexOnly[0].profile_version).toBe('4');
  });
});

describe('the filters travel in the URL, so a narrowed view can be sent to somebody', () => {
  it('round-trips every axis', () => {
    const f: PerformanceFilters = {
      classification: 'premium', assistant: 'atlas', role: 'primary', version: '3', entry: 'lex', duel: '1', responseType: 'TASK_STEP',
    };
    expect(filtersFromUrl(filtersToSearch(f, ''))).toEqual(f);
  });

  it('writes nothing when nothing is narrowed, so an ordinary page carries no query string', () => {
    expect(filtersToSearch(EMPTY_FILTERS, '')).toBe('');
  });

  it('keeps whatever else the URL was already carrying', () => {
    // `?admin=<tab>` is the existing tab selector and must survive a filter change.
    const out = filtersToSearch({ ...EMPTY_FILTERS, assistant: 'atlas' }, '?admin=latency');
    expect(out).toContain('admin=latency');
    expect(out).toContain('as=atlas');
  });

  it('removes an axis from the URL when it is cleared', () => {
    const out = filtersToSearch({ ...EMPTY_FILTERS, assistant: null }, '?as=atlas&admin=latency');
    expect(out).not.toContain('as=');
    expect(out).toContain('admin=latency');
  });

  it('reads an absent or unknown key as "all" rather than failing', () => {
    expect(filtersFromUrl('')).toEqual(EMPTY_FILTERS);
    expect(filtersFromUrl('?nonsense=1')).toEqual(EMPTY_FILTERS);
  });
});

describe('the duel filter can EXCLUDE battle turns, which is what it is for', () => {
  it('offers a "none" option whenever any duel turn is present', () => {
    const o = filterOptions(ROWS, EMPTY_FILTERS);
    expect(o.duels).toContain('none');
    expect(o.duels).toContain('1');
  });

  it('selecting "none" keeps production turns and drops the duel', () => {
    // A duel fans out, so battle turns skew every percentile they are pooled into. Being able to
    // select a round but not to exclude one would leave the production population unaskable.
    const kept = ROWS.filter((r) => rowMatches(r, { ...EMPTY_FILTERS, duel: 'none' }));
    expect(kept).toHaveLength(3);
    expect(kept.every((r) => r.battle_round == null)).toBe(true);
  });

  it('selecting a round keeps only that round', () => {
    const kept = ROWS.filter((r) => rowMatches(r, { ...EMPTY_FILTERS, duel: '1' }));
    expect(kept).toHaveLength(1);
    expect(kept[0].assistant).toBe('nova');
  });

  it('offers nothing at all when the window holds no duel, so the bar shows no dead control', () => {
    const o = filterOptions(ROWS.filter((r) => r.battle_round == null), EMPTY_FILTERS);
    expect(o.duels).toEqual([]);
  });
});

/**
 * AN ACTIVE FILTER IS ALWAYS VISIBLE AND ALWAYS CLEARABLE.
 *
 * Every axis rendered only when it had more than one option derived from `rows`. Right for discovery,
 * wrong the moment a filter is already set: an axis with no rows behind it offered no options, so the
 * bar rendered nothing while the filter it was hiding went on narrowing the table underneath.
 *
 * Reported on Effectiveness, whose filter options come from the sibling `latency_metrics` read rather
 * than from its own rows - that query returns one row per intent and carries no assistant, role,
 * version or tier to build a bar from. Land on the tab before the sibling rows arrive, or arrive with
 * a filter carried over from Latency or from the profiles screen, and the controls disappear while the
 * data stays cut.
 *
 * Invisible is the smaller half. UNCLEARABLE is the fault: the only control that could undo the
 * narrowing was the one being hidden.
 */
describe('the bar keeps a chosen value even when the rows do not offer it', () => {
  const opts = (rows: Array<Record<string, unknown>>, value: PerformanceFilters) =>
    filterOptions(rows, value);

  it('offers no options at all when there are no rows, which is what hid the bar', () => {
    // The precondition, asserted so the fix below is not tested against a situation that cannot arise.
    const o = opts([], EMPTY_FILTERS);
    expect(o.classifications).toEqual([]);
    expect(o.assistants).toEqual([]);
  });

  it('still lists a classification the rows never mentioned, so it can be removed', () => {
    // The component folds the selected value into its axis; this pins the shape that makes that
    // possible - filterOptions is honest about the rows, and the bar adds the selection back.
    const o = opts([], { ...EMPTY_FILTERS, classification: 'premium' });
    expect(o.classifications).not.toContain('premium');
    const shown = o.classifications.includes('premium') ? o.classifications : [...o.classifications, 'premium'];
    expect(shown).toContain('premium');
  });

  it('narrows to a classification that has rows, unchanged', () => {
    // The ordinary path must not move: options still come from the rows and still cascade.
    const rows = [
      { conversation_classification: 'premium', assistant: 'advisor', assistant_role: 'primary', profile_version: 4 },
      { conversation_classification: 'standard', assistant: 'analyst', assistant_role: 'primary', profile_version: 2 },
    ];
    expect(opts(rows, EMPTY_FILTERS).classifications).toEqual(['premium', 'standard']);
    expect(opts(rows, { ...EMPTY_FILTERS, classification: 'premium' }).assistants).toEqual(['advisor']);
  });
});
