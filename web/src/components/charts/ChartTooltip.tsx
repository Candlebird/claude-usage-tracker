import type { ChartSeries } from './series';

export interface TooltipRowsProps {
  title: string;
  series: readonly ChartSeries[];
  values: Record<string, number | undefined>;
  format: (v: number) => string;
  /** Shows a total row when there are 2+ series. */
  total?: boolean;
  /** Adds the API-equivalent note (cost metrics). */
  costNote?: boolean;
}

/**
 * Tooltip body: values first, then the series name, largest first; zero rows dropped.
 * Text stays in ink tokens; the swatch carries identity.
 */
export function TooltipRows({ title, series, values, format, total = true, costNote }: TooltipRowsProps) {
  const rows = series
    .map((s) => ({ s, v: values[s.key] ?? 0 }))
    .filter((r) => r.v !== 0)
    .sort((a, b) => b.v - a.v);
  const sum = rows.reduce((n, r) => n + r.v, 0);
  return (
    <div className="chart-tooltip" role="presentation">
      <div className="chart-tooltip-title">{title}</div>
      {rows.length === 0 ? (
        <div className="chart-tooltip-empty">No usage</div>
      ) : (
        <table>
          <tbody>
            {rows.map(({ s, v }) => (
              <tr key={s.key}>
                <td className="num">{format(v)}</td>
                <td>
                  <span className="swatch" style={{ background: s.color }} />
                  {s.label}
                </td>
              </tr>
            ))}
            {total && rows.length > 1 && (
              <tr className="chart-tooltip-total">
                <td className="num">{format(sum)}</td>
                <td>Total</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {costNote && <div className="chart-tooltip-note">API-equivalent cost, not a bill</div>}
    </div>
  );
}
