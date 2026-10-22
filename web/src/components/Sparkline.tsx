/** Builds an SVG path for values scaled into a w x h box (min pinned to 0 so flat-zero stays on the floor). */
export function sparkPath(values: readonly number[], w: number, h: number, pad = 2): { line: string; area: string } {
  if (values.length === 0) return { line: '', area: '' };
  const max = Math.max(...values, 0);
  const n = values.length;
  const x = (i: number) => (n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => (max <= 0 ? h - pad : h - pad - (v / max) * (h - 2 * pad));
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${x(n - 1).toFixed(1)},${h - pad}L${x(0).toFixed(1)},${h - pad}Z`;
  return { line, area };
}

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  /** Defaults to the first series color. */
  color?: string;
  /** Accessible summary, e.g. "Cost, last 14 days". Omit to hide from screen readers. */
  label?: string;
  /** Show a light area fill under the line. */
  area?: boolean;
}

/** A tiny trend line: no axes, no tooltip; the number beside it carries the value. */
export function Sparkline({ values, width = 96, height = 28, color = 'var(--series-1)', label, area = true }: SparklineProps) {
  const { line, area: areaPath } = sparkPath(values, width, height);
  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {area && areaPath && <path d={areaPath} fill={color} fillOpacity={0.1} stroke="none" />}
      {line && <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
