import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DataTable from './DataTable';

const cols = [{ key: 'name', label: 'Name' }];
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `row-${i}` }));

describe('DataTable pagination', () => {
  it('shows every row and NO controls when rows fit within the page size', () => {
    render(<DataTable columns={cols} data={rows(5)} pageSize={25} />);
    expect(screen.getByText('row-0')).toBeTruthy();
    expect(screen.getByText('row-4')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Next page/ })).toBeNull();
  });

  it('paginates when rows exceed the page size: first page only, then Next advances', () => {
    render(<DataTable columns={cols} data={rows(30)} pageSize={25} />);
    // Page 1 shows the first 25; row-25 is on page 2 and must NOT be present yet.
    expect(screen.getByText('row-0')).toBeTruthy();
    expect(screen.getByText('row-24')).toBeTruthy();
    expect(screen.queryByText('row-25')).toBeNull();
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(screen.getByText('1–25 of 30')).toBeTruthy();

    // Prev is disabled on page 1.
    expect((screen.getByRole('button', { name: /Previous page/ }) as HTMLButtonElement).disabled).toBe(true);

    // Advance: page 2 reveals the remaining rows and hides page-1 rows.
    fireEvent.click(screen.getByRole('button', { name: /Next page/ }));
    expect(screen.getByText('row-25')).toBeTruthy();
    expect(screen.getByText('row-29')).toBeTruthy();
    expect(screen.queryByText('row-0')).toBeNull();
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    // Next is disabled on the last page.
    expect((screen.getByRole('button', { name: /Next page/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('pageSize={0} disables pagination and renders every row', () => {
    render(<DataTable columns={cols} data={rows(60)} pageSize={0} />);
    expect(screen.getByText('row-0')).toBeTruthy();
    expect(screen.getByText('row-59')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Next page/ })).toBeNull();
  });
});
