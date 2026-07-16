import React, { useState } from 'react';
import './DataTable.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

export interface Column<T extends AnyRow = AnyRow> {
  key: string;
  /** Header content — a string, or nodes (e.g. a label with an info tooltip). */
  label: React.ReactNode;
  render?: (value: unknown, row: T) => React.ReactNode;
  sortable?: boolean;
}

interface DataTableProps<T extends AnyRow = AnyRow> {
  columns: Column<T>[];
  data: T[];
  emptyMessage?: string;
}

function DataTableInner<T extends AnyRow>({ columns, data, emptyMessage = 'No data available' }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
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

  return (
    <div className="data-table-wrapper">
      <table className="data-table">
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
          {sortedData.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td key={col.key}>
                  {col.render ? col.render((row as AnyRow)[col.key], row) : String((row as AnyRow)[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DataTable = DataTableInner as <T extends AnyRow = AnyRow>(props: DataTableProps<T>) => React.ReactElement;

export default DataTable;
