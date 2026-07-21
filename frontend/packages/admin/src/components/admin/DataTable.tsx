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
   * Rows per page. Every table paginates by default (keeps long lists navigable and the DOM light);
   * the page controls only appear when there are more rows than this. Pass `0` to disable paging and
   * render every row (small fixed tables that should never split). Default 25.
   */
  pageSize?: number;
}

function DataTableInner<T extends AnyRow>({ columns, data, emptyMessage = 'No data available', onRowClick, pageSize = 25 }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  // A new result set (row count changed) starts at the first page rather than stranding the viewer on
  // a now-out-of-range page. Sorting also returns to the first page (see handleSort).
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

  // Client-side pagination over the (sorted) rows. `pageSize={0}` renders everything.
  const paginate = pageSize > 0 && sortedData.length > pageSize;
  const pageCount = paginate ? Math.ceil(sortedData.length / pageSize) : 1;
  const currentPage = Math.min(page, pageCount - 1);
  const start = paginate ? currentPage * pageSize : 0;
  const end = paginate ? Math.min(start + pageSize, sortedData.length) : sortedData.length;
  const pageRows = paginate ? sortedData.slice(start, end) : sortedData;

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
              key={start + i}
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
      {paginate && (
        <div className="data-table-pagination">
          <span className="data-table-pagination-info">
            {start + 1}&ndash;{end} of {sortedData.length}
          </span>
          <div className="data-table-pagination-controls">
            <button
              type="button"
              className="data-table-page-btn"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 0}
              aria-label="Previous page"
            >
              &larr; Prev
            </button>
            <span className="data-table-pagination-page">
              Page {currentPage + 1} of {pageCount}
            </span>
            <button
              type="button"
              className="data-table-page-btn"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= pageCount - 1}
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
