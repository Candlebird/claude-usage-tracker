import { useMemo, useState, type ReactNode } from 'react';

export type SortDir = 'asc' | 'desc';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell content; defaults to String(sortValue). */
  render?: (row: T) => ReactNode;
  /** Value used for sorting. Omit to make the column unsortable. */
  sortValue?: (row: T) => number | string | null | undefined;
  /** Numeric columns right-align and use tabular figures. */
  numeric?: boolean;
  /** Hide below 640px. */
  hideOnMobile?: boolean;
  /** First sort direction when the header is clicked (numbers default to desc). */
  firstDir?: SortDir;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  initialSort?: { key: string; dir: SortDir };
  onRowClick?: (row: T) => void;
  /** Rendered instead of the table when rows is empty. */
  empty?: ReactNode;
  caption?: string;
  refreshing?: boolean;
}

export function sortRows<T>(rows: readonly T[], get: (r: T) => number | string | null | undefined, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // nulls last in either direction
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
    return String(va).localeCompare(String(vb)) * sign;
  });
}

export function DataTable<T>({ columns, rows, rowKey, initialSort, onRowClick, empty, caption, refreshing }: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    return col?.sortValue ? sortRows(rows, col.sortValue, sort!.dir) : [...rows];
  }, [rows, columns, sort]);

  if (rows.length === 0 && empty) return <>{empty}</>;

  const toggle = (c: Column<T>) => {
    if (!c.sortValue) return;
    setSort((s) =>
      s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.firstDir ?? (c.numeric ? 'desc' : 'asc') },
    );
  };

  return (
    <div className={`table-wrap${refreshing ? ' is-refreshing' : ''}`}>
      <table className="data-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const cls = [c.numeric ? 'num' : '', c.hideOnMobile ? 'hide-sm' : ''].filter(Boolean).join(' ');
              return (
                <th key={c.key} className={cls || undefined} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined} scope="col">
                  {c.sortValue ? (
                    <button type="button" className={`th-sort${active ? ' is-active' : ''}`} onClick={() => toggle(c)}>
                      {c.header}
                      <span className="th-arrow" aria-hidden="true">
                        {active ? (sort!.dir === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={rowKey(r)}
              className={onRowClick ? 'is-clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter') onRowClick(r);
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.key} className={[c.numeric ? 'num' : '', c.hideOnMobile ? 'hide-sm' : ''].filter(Boolean).join(' ') || undefined}>
                  {c.render ? c.render(r) : String(c.sortValue?.(r) ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
