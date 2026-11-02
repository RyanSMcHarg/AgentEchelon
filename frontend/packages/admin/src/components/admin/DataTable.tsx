import i18n from '@ae/shared/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './DataTable.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

export interface Column<T extends AnyRow = AnyRow> {
  key: string;
  /** Header content — a string, or nodes (e.g. a label with an info tooltip). */
  label: React.ReactNode;
  /** Plain-text label for the stacked mobile layout (the `data-label` shown before each cell).
   *  Defaults to `label` when it is a string, else the column key. */
  mobileLabel?: string;
  render?: (value: unknown, row: T) => React.ReactNode;
  sortable?: boolean;
  /**
   * A PRIMARY grouping applied before the value, and NOT inverted by sort direction.
   *
   * Sorting reads the raw row value, which is right for a number a reader can see and wrong for one the
   * cell is deliberately withholding. A column that renders "too few to report" for an unsupportable
   * figure still sorts on the hidden number underneath, so ascending puts that row at position one with
   * no number in it - and a reader takes the POSITION as the finding, which is the whole failure the
   * withholding exists to prevent.
   *
   * Rows are ordered by this group first (lower first), then by the value within the group. Because it
   * is not inverted, a group pushed to the bottom stays at the bottom in both directions.
   */
  sortGroup?: (row: T) => number;
}

interface DataTableProps<T extends AnyRow = AnyRow> {
  columns: Column<T>[];
  data: T[];
  emptyMessage?: string;
  /** When set, the whole ROW is clickable (not just an inline link) and invokes this with the row —
   *  the fix for drilling on touch/mobile, where a tiny inline link is hard to hit. Clicks that land on
   *  an inner interactive element (button/link/input) are ignored so a cell's own action still works.
   *  The row is a POINTER/keyboard convenience over the cell's inline link, not a control itself: it
   *  deliberately does NOT take `role="button"` (that would nest an interactive role around the inline
   *  buttons it contains). Keyboard and screen-reader users drill via the labeled inline link; the row
   *  also honors Enter/Space when focused. Give such tables an inline link (e.g. the id/name cell) as
   *  the accessible drill control. */
  onRowClick?: (row: T) => void;
  /**
   * Rows per page for CLIENT-side pagination (slices the already-fetched `data`). Every table
   * paginates by default (keeps long lists navigable and the DOM light); the page controls only
   * appear when there are more rows than this. Pass `0` to disable paging and render every row
   * (small fixed tables that should never split). Default 25. Ignored when `serverPagination` is set.
   */
  pageSize?: number;
  /**
   * SERVER-side pagination. When set, `data` is treated as ONE already-fetched page (not sliced),
   * and the controls are driven by the parent: `total` rows exist across all pages, the parent owns
   * `page`, and clicking Prev/Next calls `onPageChange` to fetch the next page. Use this for lists
   * that can grow past a single fetch window (conversations, exchanges, tasks) so nothing is hidden
   * behind a client-only cap. `loading` disables the controls during the fetch.
   */
  serverPagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    loading?: boolean;
  };
  /** A stable key per row, written to the row as `data-row-key`. Required for `focusKey`. */
  rowKey?: (row: T) => string | null | undefined;
  /**
   * The row to bring into view: the table opens the client page that holds it, scrolls it into view once,
   * and highlights it briefly. A key no row carries does nothing, so a caller can set it before its data arrives.
   */
  focusKey?: string | null;
}

function DataTableInner<T extends AnyRow>({ columns, data, emptyMessage = i18n.t('admin.dataTable.noDataAvailable'), onRowClick, pageSize = 25, serverPagination, rowKey, focusKey = null }: DataTableProps<T>) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  // A new client-side result set (row count changed) starts at the first page rather than stranding the
  // viewer on a now-out-of-range page. Sorting also returns to the first page (see handleSort). In
  // server mode the parent owns the page, so this local reset is inert.
  useEffect(() => setPage(0), [data.length]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(0);
  };

  // NOTE: sorting is client-side over the rows currently in `data`. In server mode that is one page,
  // so a sort orders only the visible page (the server's ORDER BY is the authoritative overall order).
  const sortGroup = sortKey ? columns.find((c) => c.key === sortKey)?.sortGroup : undefined;
  const sortedData = sortKey
    ? [...data].sort((a, b) => {
        // The group is applied OUTSIDE the direction flip on purpose: a row whose value this column is
        // withholding belongs at the bottom whichever way the reader sorts, not at the top on one click.
        if (sortGroup) {
          const grouped = sortGroup(a) - sortGroup(b);
          if (grouped !== 0) return grouped;
        }
        const aVal = (a as AnyRow)[sortKey];
        const bVal = (b as AnyRow)[sortKey];
        const cmp = typeof aVal === 'number' && typeof bVal === 'number'
          ? aVal - bVal
          : String(aVal).localeCompare(String(bVal));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : data;

  // THE FOCUSED ROW'S PAGE. Declared after the reset above, so when both run on one commit the focused
  // row's page wins. Keyed on the row's position, so paging away by hand afterwards stays where it is put.
  const focusIndex = focusKey && rowKey ? sortedData.findIndex((r) => rowKey(r) === focusKey) : -1;
  useEffect(() => {
    if (focusIndex < 0 || serverPagination || pageSize <= 0) return;
    setPage(Math.floor(focusIndex / pageSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, focusIndex, pageSize, data.length]);

  // Scrolled into view once per key, after the render that shows it. Smooth unless the reader asked for less motion.
  useEffect(() => {
    if (!focusKey) { scrolledFor.current = null; return; }
    if (scrolledFor.current === focusKey) return;
    const row = Array.from(wrapperRef.current?.querySelectorAll<HTMLElement>('tr[data-row-key]') ?? [])
      .find((el) => el.getAttribute('data-row-key') === focusKey);
    if (!row) return;
    scrolledFor.current = focusKey;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  });

  if (data.length === 0) {
    return <div className="data-table-empty">{emptyMessage}</div>;
  }

  // Unified pager: SERVER mode (parent-driven, `data` is one page) OR CLIENT mode (slice `data`).
  let showPagination: boolean;
  let pageRows: T[];
  let infoStart: number; // 1-indexed first row shown
  let infoEnd: number;   // 1-indexed last row shown
  let infoTotal: number;
  let curPage: number;   // 0-indexed
  let totalPages: number;
  let goPrev: () => void;
  let goNext: () => void;
  let controlsDisabled: boolean;

  if (serverPagination) {
    const { page: sp, pageSize: sps, total, onPageChange, loading } = serverPagination;
    pageRows = sortedData; // the fetched page, in the server's order (client sort applies within it)
    totalPages = Math.max(1, Math.ceil(total / sps));
    curPage = Math.min(sp, totalPages - 1);
    infoTotal = total;
    infoStart = curPage * sps + 1;
    infoEnd = curPage * sps + data.length;
    showPagination = totalPages > 1;
    controlsDisabled = !!loading;
    goPrev = () => onPageChange(curPage - 1);
    goNext = () => onPageChange(curPage + 1);
  } else {
    const paginate = pageSize > 0 && sortedData.length > pageSize;
    totalPages = paginate ? Math.ceil(sortedData.length / pageSize) : 1;
    curPage = Math.min(page, totalPages - 1);
    const start = paginate ? curPage * pageSize : 0;
    const end = paginate ? Math.min(start + pageSize, sortedData.length) : sortedData.length;
    pageRows = paginate ? sortedData.slice(start, end) : sortedData;
    infoStart = start + 1;
    infoEnd = end;
    infoTotal = sortedData.length;
    showPagination = paginate;
    controlsDisabled = false;
    goPrev = () => setPage(curPage - 1);
    goNext = () => setPage(curPage + 1);
  }

  const labelFor = (col: Column<T>): string =>
    col.mobileLabel ?? (typeof col.label === 'string' ? col.label : col.key);

  // Sortable columns, for the mobile sort control below.
  const sortableCols = columns.filter((c) => c.sortable !== false);

  return (
    <div className="data-table-wrapper" ref={wrapperRef}>
      {/*
        MOBILE SORT. Below 640px the stacked card layout hides `thead` entirely - and the column
        headers are the ONLY sort affordance this table has. So on a phone a long list could not be
        ordered at all: finding the one `active` row among ~95 experiments meant scrolling every card.
        (Reported from a phone; the desktop advice "click the Status header" is unfollowable there.)

        Rendered in the DOM at every width and revealed by CSS at <=640px, so it cannot fall out of
        sync with the breakpoint that hides the headers.
      */}
      {sortableCols.length > 0 && (
        <div className="data-table-mobile-sort">
          <label className="data-table-mobile-sort-label" htmlFor="dt-sort">{t('admin.table.sort')}</label>
          <select
            id="dt-sort"
            className="select"
            value={sortKey ?? ''}
            onChange={(e) => setSortKey(e.target.value || null)}
          >
            <option value="">{t('admin.table.defaultOrder')}</option>
            {sortableCols.map((c) => (
              <option key={c.key} value={c.key}>
                {typeof c.label === 'string' ? c.label : c.key}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="data-table-mobile-sort-dir"
            disabled={!sortKey}
            aria-label={sortDir === 'asc' ? t('admin.dataTable.sortAscendingSwitchToDescending') : t('admin.dataTable.sortDescendingSwitchToAscending')}
            onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
          >
            {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
          </button>
        </div>
      )}
      <table className={`data-table${onRowClick ? ' data-table--rows-clickable' : ''}`}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                onClick={col.sortable !== false ? () => handleSort(col.key) : undefined}
                className={col.sortable !== false ? 'sortable' : ''}
              >
                {col.label}
                {sortKey === col.key && (
                  <span className="sort-indicator">{sortDir === 'asc' ? ' \u2191' : ' \u2193'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, i) => {
            const key = rowKey?.(row) || undefined;
            const focused = Boolean(focusKey && key === focusKey);
            return (
            <tr
              key={`${curPage}_${i}`}
              data-row-key={key}
              aria-current={focused ? 'true' : undefined}
              className={[onRowClick ? 'data-table-row--clickable' : '', focused ? 'data-table-row--focus' : ''].filter(Boolean).join(' ')}
              onClick={onRowClick
                ? (e) => {
                    // Let nested buttons/links handle their own click; only a bare-row click drills.
                    if ((e.target as HTMLElement).closest('button,a,input,select,label')) return;
                    onRowClick(row);
                  }
                : undefined}
              onKeyDown={onRowClick
                ? (e) => {
                    // Only when the row itself is focused (not an inner control) does Enter/Space drill.
                    if (e.currentTarget !== e.target) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); }
                  }
                : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((col) => (
                // `data-col` is the STABLE hook for per-column styling. `data-label` is display text
                // and changes whenever a heading is reworded, so CSS keyed on it breaks silently.
                <td key={col.key} data-col={col.key} data-label={labelFor(col)}>
                  {col.render ? col.render((row as AnyRow)[col.key], row) : String((row as AnyRow)[col.key] ?? '')}
                </td>
              ))}
            </tr>
            );
          })}
        </tbody>
      </table>
      {showPagination && (
        <div className="data-table-pagination">
          <span className="data-table-pagination-info">
            {infoStart}&ndash;{infoEnd} of {infoTotal}
          </span>
          <div className="data-table-pagination-controls">
            <button
              type="button"
              className="btn-secondary"
              onClick={goPrev}
              disabled={controlsDisabled || curPage === 0}
              aria-label={t('admin.table.previousPage')}
            >
              &larr; Prev
            </button>
            <span className="data-table-pagination-page">
              {controlsDisabled ? 'Loading…' : `Page ${curPage + 1} of ${totalPages}`}
            </span>
            <button
              type="button"
              className="btn-secondary"
              onClick={goNext}
              disabled={controlsDisabled || curPage >= totalPages - 1}
              aria-label={t('admin.table.nextPage')}
            >
              Next &rarr;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const DataTable = DataTableInner as <T extends AnyRow = AnyRow>(props: DataTableProps<T>) => React.ReactElement;

export default DataTable;
