import type { JSX, ReactNode } from 'react';

export interface ColumnDef<Row> {
  key: keyof Row;
  header: string;
  render?: (value: Row[keyof Row], row: Row) => ReactNode;
}

interface TableProps<Row> {
  rows: Row[];
  columns: ReadonlyArray<ColumnDef<Row>>;
  state?: 'data' | 'empty' | 'loading' | 'error';
  emptyMessage?: ReactNode;
  errorMessage?: ReactNode;
}

export function Table<Row extends Record<string, unknown>>({
  rows,
  columns,
  state = 'data',
  emptyMessage = 'No data',
  errorMessage = 'Failed to load',
}: Readonly<TableProps<Row>>): JSX.Element {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={String(col.key)} scope="col">
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {state === 'loading' && (
          <tr>
            <td colSpan={columns.length}>
              <span role="status">Loading…</span>
            </td>
          </tr>
        )}
        {state === 'empty' && (
          <tr>
            <td colSpan={columns.length}>{emptyMessage}</td>
          </tr>
        )}
        {state === 'error' && (
          <tr>
            <td colSpan={columns.length}>{errorMessage}</td>
          </tr>
        )}
        {state === 'data' &&
          rows.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td key={String(col.key)}>
                  {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
      </tbody>
    </table>
  );
}
