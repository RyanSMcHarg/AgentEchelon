import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * THE ONE FILTER SET THE PERFORMANCE SURFACE SLICES BY.
 *
 * ── WHY IT IS SHARED ────────────────────────────────────────────────────────────────────────────
 *
 * Latency and Effectiveness are two views of ONE population: the same turns, read for how fast they
 * were and for how good they were. They shared only the date range. Latency owned Tier, Assistant,
 * Role, Version, Entry and Duel in a pill component defined inside its own file and never exported;
 * Effectiveness re-implemented a subset as plain selects, with near-duplicate tooltip copy. So a
 * person who narrowed one surface and moved to the other silently got a different population, and the
 * page did not say so.
 *
 * ── WHY IT CASCADES ────────────────────────────────────────────────────────────────────────────
 *
 * The axes are the ones [ADR-051] argues for: an assistant has an id, a classification and a role.
 * They are not independent, and offering them flat invites a cut that cannot exist - an assistant
 * paired with a classification it never ran in returns nothing, and an empty chart is
 * indistinguishable from a quiet week.
 *
 *   classification  ->  the assistants and roles that ran IN it  ->  the versions that assistant ran
 *
 * RESET IS EXPLICIT, because the alternative is a stale selection quietly narrowing a new population.
 * Changing classification clears assistant, role and version; changing assistant clears version. A
 * selection that survives a change it is not valid under is the defect this ordering exists to
 * prevent.
 *
 * ── WHY IT IS IN THE ADMIN PACKAGE AND NOT `@ae/shared` ─────────────────────────────────────────
 *
 * The chat bundle asserts its import graph is admin-free (`assert-no-admin-in-chat.mjs`). This is
 * operator UI; putting it in the shared package would put admin surface within reach of that graph
 * for no gain, since the only two consumers are both here.
 */

/** Everything the Performance surface slices by. `null` is "all", never "unset". */
export interface PerformanceFilters {
  classification: string | null;
  assistant: string | null;
  role: string | null;
  version: string | null;
  /** How the turn arrived: `lex` (targeted) or `flow`. Migration 054 states the equivalence. */
  entry: string | null;
  /** Duel round, for keeping battle turns out of a production population. */
  duel: string | null;
  /**
   * How the reply was delivered (`delivery_option`): an answer, a task step, a refusal. An explicit
   * choice, so null means every type here; Latency's own default of leaving task turns out of its
   * timing cards is a separate toggle on that view, because Effectiveness must keep them.
   */
  responseType: string | null;
}

/** The bucket for a row whose entry was never recorded. Not a kind of turn - a defect, made findable. */
export const UNRECORDED = 'unrecorded';

export const EMPTY_FILTERS: PerformanceFilters = {
  classification: null, assistant: null, role: null, version: null, entry: null, duel: null, responseType: null,
};

/**
 * Apply a change, clearing whatever the change invalidates.
 *
 * Pure and exported so the cascade is assertable directly: inside a handler, the only thing a test
 * could observe was a rendered pill, and a test written against that passes whether or not the reset
 * happens.
 */
export function withFilterChange(
  current: PerformanceFilters,
  key: keyof PerformanceFilters,
  value: string | null,
): PerformanceFilters {
  const next = { ...current, [key]: value };
  // A classification decides which assistants and roles exist at all.
  if (key === 'classification') {
    next.assistant = null;
    next.role = null;
    next.version = null;
  }
  // A version number means nothing except against the assistant that ran it.
  if (key === 'assistant') next.version = null;
  return next;
}

/** True when any axis is narrowed, so a caller can offer to clear without reaching into the shape. */
export function hasActiveFilter(f: PerformanceFilters): boolean {
  return Object.values(f).some((v) => v !== null);
}

/** The entry axis, including a bucket for rows that recorded none. */
function entryOptions(rows: Row[]): string[] {
  const seen = rows.map((r) => String(r.turn_entry ?? r.entry ?? ''));
  const known = Array.from(new Set(seen.filter(Boolean))).sort();
  if (!known.length) return [];
  return seen.some((v) => !v) ? [...known, UNRECORDED] : known;
}

/** A delivery option as a person reads it: TASK_STEP becomes Task Step. */
export const humanizeResponseType = (dt: string): string =>
  dt.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** A multi-step task's turn, which runs for minutes and is not a reply time. */
export const isTaskType = (dt: string): boolean => dt.toUpperCase().startsWith('TASK');

/** One row of the analytics result, as far as the filters care. */
type Row = Record<string, unknown>;

const distinct = (rows: Row[], key: string): string[] => Array.from(
  new Set(rows.map((r) => (r[key] == null ? '' : String(r[key]))).filter(Boolean)),
).sort();

/**
 * The options each axis offers, derived from the rows actually present and narrowed by the choices
 * already made.
 *
 * DERIVED FROM THE DATA, not from a configuration list, so an assistant that never ran in this window
 * is not offered - the cut would be real but empty, and an empty chart reads as a quiet week rather
 * than as a filter that excluded everything.
 */
export function filterOptions(rows: Row[], f: PerformanceFilters) {
  const inClassification = f.classification
    ? rows.filter((r) => String(r.conversation_classification ?? r.classification ?? '') === f.classification)
    : rows;
  const forAssistant = f.assistant
    ? inClassification.filter((r) => String(r.assistant ?? '') === f.assistant)
    : inClassification;
  return {
    classifications: distinct(rows, 'conversation_classification').length
      ? distinct(rows, 'conversation_classification')
      : distinct(rows, 'classification'),
    assistants: distinct(inClassification, 'assistant'),
    roles: distinct(inClassification, 'assistant_role'),
    versions: distinct(forAssistant, 'profile_version'),
    // THE UNRECORDED BUCKET IS OFFERED, AND THAT IS DELIBERATE (measured, LatencyTab).
    //
    // Offering only `lex` and `flow` would be a control whose options do not partition the
    // population: over 30 days, 493 turns carried no entry against 191 flow and 3 lex. An operator
    // filtering to "standard" would have seen a fraction of the traffic with nothing saying the rest
    // was left out - a filter that silently drops most of the data.
    //
    // It is not a third KIND of turn. The entry is known at dispatch and should always be on the row,
    // so this bucket is a defect made findable rather than a category.
    entries: entryOptions(rows),
    // 'none' IS AN OPTION, and it is the one the filter exists for. A duel fans out, so battle turns
    // skew every percentile they are pooled into; being able to select rounds but not to EXCLUDE them
    // would leave the production population unaskable. Offered only when duels are present.
    duels: distinct(rows, 'battle_round').length
      ? ['none', ...distinct(rows, 'battle_round')]
      : [],
    responseTypes: distinct(rows, 'delivery_option'),
  };
}

function matchesEntry(entry: unknown, want: string | null): boolean {
  if (want === null) return true;
  const v = String(entry ?? '');
  return want === UNRECORDED ? v === '' : v === want;
}

/** 'none' means this turn was not part of a duel; any other value names the round. */
function matchesDuel(round: unknown, want: string | null): boolean {
  if (want === null) return true;
  if (want === 'none') return round == null || String(round) === '';
  return String(round ?? '') === want;
}

/** Does this row survive the current filters? One predicate, so both surfaces cut identically. */
export function rowMatches(r: Row, f: PerformanceFilters): boolean {
  const eq = (v: unknown, want: string | null) => want === null || String(v ?? '') === want;
  return eq(r.conversation_classification ?? r.classification, f.classification)
    && eq(r.assistant, f.assistant)
    && eq(r.assistant_role, f.role)
    && eq(r.profile_version, f.version)
    && matchesEntry(r.turn_entry ?? r.entry, f.entry)
    && matchesDuel(r.battle_round, f.duel)
    && eq(r.delivery_option, f.responseType);
}

export const FilterPills: React.FC<{
  label: string;
  allLabel: string;
  options: string[];
  value: string | null;
  onChange: (v: string | null) => void;
  format?: (v: string) => string;
  children?: React.ReactNode;
}> = ({ label, allLabel, options, value, onChange, format, children }) => (
  <div
    role="group"
    aria-label={`${label} filter`}
    className="admin-filter-group"
  >
    <span className="admin-filter-label">{label}:</span>
    {[null, ...options].map((t) => {
      const on = value === t;
      return (
        <button
          key={t ?? '__all'}
          type="button"
          aria-pressed={on}
          onClick={() => onChange(t)}
          className="admin-filter-btn"
        >
          {t === null ? allLabel : (format ? format(t) : t)}
        </button>
      );
    })}
    {children}
  </div>
);

/**
 * The filter bar both Performance surfaces render.
 *
 * PROGRESSIVE, so the bar states what is decidable rather than everything that exists. Assistants and
 * roles appear once a classification is chosen; versions once an assistant is. An axis with nothing to
 * choose between is not rendered at all - a single-option filter is a control that cannot do anything,
 * and it teaches people to skim the bar.
 */
const PerformanceFilterBar: React.FC<{
  rows: Row[];
  value: PerformanceFilters;
  onChange: (next: PerformanceFilters) => void;
  /** Hidden where the surface has no such column to cut on. */
  showEntry?: boolean;
  showDuel?: boolean;
}> = ({ rows, value, onChange, showEntry = true, showDuel = true }) => {
  const { t } = useTranslation();
  const base = filterOptions(rows, value);
  const set = (k: keyof PerformanceFilters) => (v: string | null) => onChange(withFilterChange(value, k, v));

  // ── AN ACTIVE FILTER IS ALWAYS VISIBLE AND ALWAYS CLEARABLE ──────────────
  //
  // Every axis rendered only when it had MORE THAN ONE option derived from `rows`, which is right for
  // discovery and wrong the moment a filter is already set: an axis with no rows behind it offered no
  // options, so the bar rendered NOTHING while the filter it was hiding went on narrowing the table
  // underneath. Reported on Effectiveness, whose options come from the sibling `latency_metrics` read -
  // land on that tab before those rows arrive, or with a filter carried over from Latency, and the
  // controls vanish while the data stays cut.
  //
  // Invisible is the smaller half. UNCLEARABLE is the real fault: the only control that could undo the
  // narrowing was the one being hidden, so a person could see a filtered table and have no way back.
  //
  // So a SELECTED value is folded into its own axis whatever the rows say. It stays listed, stays
  // marked, and stays removable - and an axis the person has chosen on renders even when it is the
  // only thing left to choose, because "one option" is still the difference between filtered and not.
  const withSelected = (options: string[], selected: string | null): string[] =>
    selected && !options.includes(selected) ? [...options, selected].sort() : options;
  const o = {
    ...base,
    classifications: withSelected(base.classifications, value.classification),
    assistants: withSelected(base.assistants, value.assistant),
    roles: withSelected(base.roles, value.role),
    versions: withSelected(base.versions, value.version),
    entries: withSelected(base.entries, value.entry ?? null),
    responseTypes: withSelected(base.responseTypes, value.responseType ?? null),
  };
  /** Render an axis when it can be chosen between, or when it is already carrying a choice. */
  const show = (options: string[], selected: string | null | undefined) => options.length > 1 || !!selected;

  return (
    <div className="admin-filter-bar">
      {show(o.classifications, value.classification) && (
        <FilterPills label={t('admin.filters.tier')} allLabel="All tiers" options={o.classifications} value={value.classification} onChange={set('classification')} />
      )}

      {/* ONLY ONCE A CLASSIFICATION IS CHOSEN. Assistants and roles exist WITHIN one; offering them
          across all of them invites a pairing that never ran and returns an empty chart. */}
      {(value.classification || value.assistant) && show(o.assistants, value.assistant) && (
        <FilterPills label={t('admin.filters.assistant')} allLabel={t('admin.filters.allAssistants')} options={o.assistants} value={value.assistant} onChange={set('assistant')} />
      )}
      {(value.classification || value.role) && show(o.roles, value.role) && (
        <FilterPills label={t('admin.filters.role')} allLabel="All roles" options={o.roles} value={value.role} onChange={set('role')} />
      )}

      {/* A VERSION NUMBER MEANS NOTHING WITHOUT THE ASSISTANT THAT RAN IT. Two assistants both have a
          version 3, and they are not the same thing. */}
      {(value.assistant || value.version) && show(o.versions, value.version) && (
        <FilterPills label={t('admin.filters.version')} allLabel={t('admin.filters.allVersions')} options={o.versions} value={value.version} onChange={set('version')} format={(v) => `v${v}`} />
      )}

      {showEntry && show(o.entries, value.entry) && (
        <FilterPills
          label={t('admin.filters.entry')}
          allLabel="All entries"
          options={o.entries}
          value={value.entry}
          onChange={set('entry')}
          format={(v) => (v === 'lex' || v === 'flow' || v === 'platform' ? t(`admin.latency.entry.${v}`) : t('admin.performanceFilters.notRecorded'))}
        />
      )}
      {showDuel && o.duels.length > 0 && (
        <FilterPills
          label={t('admin.filters.battle')}
          allLabel="All turns"
          options={o.duels}
          value={value.duel}
          onChange={set('duel')}
          format={(v) => (v === 'none' ? 'production' : `round ${v}`)}
        />
      )}

      {show(o.responseTypes, value.responseType) && (
        <FilterPills
          label={t('admin.filters.responseType')}
          allLabel={t('admin.filters.allResponseTypes')}
          options={o.responseTypes}
          value={value.responseType}
          onChange={set('responseType')}
          format={humanizeResponseType}
        />
      )}

      {hasActiveFilter(value) && (
        <button type="button" className="btn-link admin-filter-clear" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear filters
        </button>
      )}
    </div>
  );
};

export default PerformanceFilterBar;

// ── THE FILTER STATE BELONGS IN THE URL ─────────────────────────────────────────────────────────
//
// It was React state, so a narrowed view could not be sent to anybody: an operator who found the
// regression had to describe the filters rather than share the page. On a console where a manager,
// Legal and a platform developer look at the same window, that is the difference between
// collaborating and dictating.
//
// Short keys, and absent rather than empty when unset, so an unfiltered page carries no query string
// at all and the common URL stays clean.
const URL_KEYS: Array<[keyof PerformanceFilters, string]> = [
  ['classification', 'tier'],
  ['assistant', 'as'],
  ['role', 'role'],
  ['version', 'ver'],
  ['entry', 'entry'],
  ['duel', 'duel'],
  ['responseType', 'type'],
];

/** Read the filters a URL carries. Unknown or absent keys are "all", never an error. */
export function filtersFromUrl(search: string = window.location.search): PerformanceFilters {
  const q = new URLSearchParams(search);
  const out = { ...EMPTY_FILTERS };
  for (const [key, param] of URL_KEYS) {
    const v = q.get(param);
    if (v) out[key] = v;
  }
  return out;
}

/** The query string for these filters, preserving whatever else the URL already carried. */
export function filtersToSearch(f: PerformanceFilters, search: string = window.location.search): string {
  const q = new URLSearchParams(search);
  for (const [key, param] of URL_KEYS) {
    const v = f[key];
    if (v) q.set(param, v); else q.delete(param);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Put the filters in the address bar without adding a history entry.
 *
 * REPLACE, NOT PUSH. Narrowing a filter is not navigation, and pushing would make Back walk one pill
 * at a time through a bar somebody clicked six times - the page would appear not to leave.
 */
export function syncFiltersToUrl(f: PerformanceFilters): void {
  try {
    const next = `${window.location.pathname}${filtersToSearch(f)}${window.location.hash}`;
    window.history.replaceState(null, '', next);
  } catch {
    // A browser that refuses the write still gets working filters; only the sharing is lost.
  }
}
