import type { ChartSeries } from './series';

/** Legend row above the plot. Rendered only for 2+ series (a single series is named by the title). */
export function Legend({ series }: { series: readonly ChartSeries[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="legend" aria-label="Legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
