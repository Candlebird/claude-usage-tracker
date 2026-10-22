/** "Less ... More" key for the sequential heatmap scale (level 0 = no activity). */
export function ScaleLegend({ levels = 5 }: { levels?: number }) {
  return (
    <div className="act-scale" aria-hidden="true">
      <span>Less</span>
      {Array.from({ length: levels + 1 }, (_, i) => (
        <span key={i} className="act-cell act-scale-cell" data-level={i} />
      ))}
      <span>More</span>
    </div>
  );
}
