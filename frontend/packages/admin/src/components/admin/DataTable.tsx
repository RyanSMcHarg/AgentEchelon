import React, { useEffect, useState } from 'react';
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
   *  also honours Enter/Space when focused. Give such tables an inline link (e.g. the id/name cell) as
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
}

function DataTableInner<T extends AnyRow>({ columns, data, emptyMessage = 'No data available', onRowClick, pageSize = 25, serverPagination }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

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
  const sortedData = sortKey
    ? [...data].sort((a, b) => {
        const aVal = (a as AnyRow)[sortKey];
        const bVal = (b as AnyRow)[sortKey];
        const cmp = typeof aVal === 'number' && typeof bVal === 'number'
          ? aVal - bVal
          : String(aVal).localeCompare(String(bVal));
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : data;

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

  return (
    <div className="data-table-wrapper">
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
          {pageRows.map((row, i) => (
            <tr
              key={`${curPage}_${i}`}
              className={onRowClick ? 'data-table-row--clickable' : ''}
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
                <td key={col.key} data-label={labelFor(col)}>
                  {col.render ? col.render((row as AnyRow)[col.key], row) : String((row as AnyRow)[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
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
              className="data-table-page-btn"
              onClick={goPrev}
              disabled={controlsDisabled || curPage === 0}
              aria-label="Previous page"
            >
              &larr; Prev
            </button>
            <span className="data-table-pagination-page">
              {controlsDisabled ? 'Loading…' : `Page ${curPage + 1} of ${totalPages}`}
            </span>
            <button
              type="button"
              className="data-table-page-btn"
              onClick={goNext}
              disabled={controlsDisabled || curPage >= totalPages - 1}
              aria-label="Next page"
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
