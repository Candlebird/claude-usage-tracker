// Multi-row INSERT builder that respects D1's 100-bound-parameter limit.
//
// Numbers and nulls are written as SQL literals (they are validated finite
// numbers, so this is safe) and only strings are bound. That packs far more
// rows into each statement, which keeps an ingest under 50 queries.

export type SqlValue = string | number | null;

export const MAX_BOUND_PARAMS = 100;
/** Upper bound on rows per statement, regardless of parameters. */
export const MAX_ROWS_PER_STATEMENT = 100;
/** D1 caps SQL text at 100 KB; stay well below. */
export const MAX_SQL_CHARS = 90_000;

export interface InsertSpec {
  table: string;
  columns: readonly string[];
  /** `INSERT` (default) or `INSERT OR IGNORE` / `INSERT OR REPLACE`. */
  verb?: 'INSERT' | 'INSERT OR IGNORE' | 'INSERT OR REPLACE';
  /** Appended after VALUES, e.g. from `upsertClause()`. */
  suffix?: string;
}

export interface BuiltStatement {
  sql: string;
  params: string[];
  /** Rows in this statement. */
  rows: number;
}

/** `ON CONFLICT(keys) DO UPDATE SET c=excluded.c, ...`; pass custom SQL per column via `overrides`. */
export function upsertClause(conflict: readonly string[], update: readonly string[], overrides: Record<string, string> = {}): string {
  const sets = update.map((c) => `${c}=${overrides[c] ?? `excluded.${c}`}`);
  return `ON CONFLICT(${conflict.join(',')}) DO UPDATE SET ${sets.join(',')}`;
}

export function sqlLiteral(v: number | null): string {
  if (v === null) return 'NULL';
  if (!Number.isFinite(v)) throw new Error('non-finite number in SQL row');
  return String(v);
}

/** Accumulates one statement's VALUES; identical strings share one bound parameter. */
class StatementBuilder {
  params: string[] = [];
  private index = new Map<string, number>();
  values: string[] = [];
  chars: number;

  constructor(private readonly base: number) {
    this.chars = base;
  }

  /** Bound parameters this row would add. */
  newParams(row: readonly SqlValue[]): number {
    const seen = new Set<string>();
    for (const v of row) if (typeof v === 'string' && !this.index.has(v)) seen.add(v);
    return seen.size;
  }

  rowSql(row: readonly SqlValue[]): string {
    const parts = row.map((v) => {
      if (typeof v !== 'string') return sqlLiteral(v);
      let i = this.index.get(v);
      if (i === undefined) {
        this.params.push(v);
        i = this.params.length;
        this.index.set(v, i);
      }
      return `?${i}`;
    });
    return `(${parts.join(',')})`;
  }

  /** Text length of a row if added now (placeholders are at most 4 chars). */
  estimate(row: readonly SqlValue[]): number {
    let n = 2 + row.length;
    for (const v of row) n += typeof v === 'string' ? 4 : sqlLiteral(v).length;
    return n;
  }
}

/** Splits rows into as few INSERT statements as the parameter, row and text limits allow. */
export function buildInserts(spec: InsertSpec, rows: readonly (readonly SqlValue[])[], maxParams = MAX_BOUND_PARAMS): BuiltStatement[] {
  const head = `${spec.verb ?? 'INSERT'} INTO ${spec.table} (${spec.columns.join(',')}) VALUES `;
  const tail = spec.suffix ? ` ${spec.suffix}` : '';
  const out: BuiltStatement[] = [];
  let cur = new StatementBuilder(head.length + tail.length);

  const flush = () => {
    if (cur.values.length === 0) return;
    out.push({ sql: head + cur.values.join(',') + tail, params: cur.params, rows: cur.values.length });
    cur = new StatementBuilder(head.length + tail.length);
  };

  for (const row of rows) {
    if (row.length !== spec.columns.length) throw new Error(`row has ${row.length} values, expected ${spec.columns.length}`);
    if (cur.values.length > 0) {
      const full =
        cur.params.length + cur.newParams(row) > maxParams ||
        cur.values.length >= MAX_ROWS_PER_STATEMENT ||
        cur.chars + cur.estimate(row) > MAX_SQL_CHARS;
      if (full) flush();
    }
    if (cur.newParams(row) > maxParams) throw new Error('row exceeds the bound parameter limit');
    const sql = cur.rowSql(row);
    cur.values.push(sql);
    cur.chars += sql.length + 1;
  }
  flush();
  return out;
}

export function prepare(db: D1Database, built: readonly BuiltStatement[]): D1PreparedStatement[] {
  return built.map((b) => db.prepare(b.sql).bind(...b.params));
}
