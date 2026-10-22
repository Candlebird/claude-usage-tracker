# Dashboard component kit

Everything a page needs is exported from `src/components/index.ts`. Helpers live in `src/format.ts`, `src/palette.ts`, `src/router.ts`, `src/hooks/useApi.ts` and `src/state/*`. Styles live in `src/styles/components.css` (kit) and `src/styles/base.css` (shell, tokens, utilities). Colors are CSS variables: `--series-1..8`, `--series-other`, `--status-ok|warning|serious|critical`, `--ink`, `--ink-2`, `--muted`, `--surface`, `--page`.

## Page pattern

```tsx
const { range, bucket, tz } = useControls();
const state = useApi((api, signal) => api.timeseries({ ...range, bucket, group: 'model', metric: 'cost', tz }, { signal }), [range.from, range.to, bucket, tz]);

<Card title="Cost by model" subtitle="API-equivalent USD per day" refreshing={state.refreshing} footer={<CostNote />}>
  <AsyncView state={state} isEmpty={(d) => isAllZero(d.series)}>
    {(d) => <StackedBarChart series={d.series} tz={tz} bucket="day" format={fmtUsd} costNote ariaLabel="Daily cost by model" />}
  </AsyncView>
</Card>
```

- `useApi(fetcher, deps, { auto?, enabled? })` refetches when `deps` change and on every 60s tick (unless `auto: false`). It returns `ApiState<T>`: `{ data, error, loading, refreshing, reload }`. On a refetch, the previous `data` stays and `refreshing` is true. Pass `refreshing` to Card, DataTable or KpiTile so they dim the old render (`.is-refreshing`) instead of blanking it. A 401 disconnects and sends the user back to the Connect screen.
- `useControls()` returns the global date range (`preset`, `custom`, `range`, `bucket`, `setPreset`, `setCustom`), `tz` (browser tz), `tick` and `now` (advanced every 60s while the page is visible) and `refresh()`.
- `useNow(ms)` gives the current unix second, for countdowns.

## Layout and containers

| Component | Props | Notes |
|---|---|---|
| `Card` | `title, subtitle, actions, refreshing, footer, className, id, children` | A section with an h2. `actions` is right-aligned (Segmented, link). |
| `AsyncView<T>` | `state, isEmpty?, empty?, skeletonHeight?, children(data, refreshing)` | Skeleton on first load, ErrorState with retry on failure, EmptyState when `isEmpty`. |
| `Drawer` | `open, onClose, title, width?, children` | A right panel on desktop and a bottom sheet on phones. Esc closes it and focus is restored. |
| `Tabs<V>` / `TabPanel` | `tabs: TabDef<V>[], value, onChange, label, idBase` / `idBase, value` | ARIA tabs with arrow-key navigation. Pass the generic explicitly: `<Tabs<Split> ...>`. |
| `Segmented<V>` | `options: SegmentOption<V>[], value, onChange, label, size?` | A radiogroup for small option sets (metric, group-by). |
| `DateRangeControl` | none | 24h/7d/30d/90d/custom, wired to `useControls`. It is already in the top bar, so pages should not add another. |
| `EmptyState` | `title?, icon?, action?, children` | |
| `ErrorState` | `error, onRetry?, title?` | |
| `Skeleton` | `height?, width?, lines?` | Static when the user prefers reduced motion. |
| `CostNote` | `compact?` | "API-equivalent cost..." footnote. Use it wherever a dollar figure appears (`COST_NOTE` holds the text). |
| `Icon` | `name: IconName, size?` | Inline SVG, `aria-hidden`. |

## Numbers and status

| Component | Props | Notes |
|---|---|---|
| `KpiTile` | `label, value, sub?, delta?: KpiDelta, spark?, sparkColor?, hero?, refreshing?` | `delta = { pct, label?, goodWhen?: 'up' \| 'down' \| 'neither' }`. For cost, use `goodWhen: 'down'`. `deltaTone()` is exported. |
| `Sparkline` | `values, width?, height?, color?, label?, area?` | Decorative unless you pass `label`. `sparkPath()` is exported for tests. |
| `Meter` | `value (0-100), label, pace?, thresholds?, size?` | `role="meter"`. The fill uses the status color, and the tick marks even pace. |
| `StatusBadge` | `status: Status` | Icon plus label, never color alone. |
| `LimitGauge` | `window: LimitWindowStatus, now, tz, thresholds?` | A plan-limit window: % used, meter with a pace tick, reset countdown and projection. |

## Charts (Recharts)

`StackedAreaChart` and `StackedBarChart` share `TimeChartProps`:

- `series: TimeseriesSeries[]` comes straight from `/api/timeseries`.
- `colorFor?(key, i)`: color by entity. Use `modelColorMap`, `agentKindColor`, `tokenTypeColor` or `assignColors(keys)`.
- `labelFor?(key)`: for example `modelLabel`, `agentKindLabel` or `tokenTypeLabel`.
- `format?` formats tooltip values. `axisFormat?` formats axis ticks and defaults to compact.
- `tz`, `bucket?: 'hour' | 'day'`, `height?`, `costNote?`, and `ariaLabel` (required).

Behavior:

- Series past 8 fold into "Other" (`foldOther`).
- A legend shows when there are 2 or more series.
- Hover shows a crosshair tooltip with the rows sorted by value and a total.
- Gaps are zero-filled (`toRows`).

Lower-level pieces: `Legend`, `TooltipRows`, `foldOther`, `toRows`, `rowTotal`, `isAllZero`.

Chart rules (from the dataviz skill):

- **One y-axis per chart.** Two measures with different scales go in two charts.
- **Color follows the entity.** Never color by rank or index after filtering. Model colors come from the family (`modelColorMap`), and the same project keeps the same slot across a page (`assignColors` over the full key list).
- **Palette slots are fixed and never cycled.** A ninth series becomes "Other".
- **Status colors are only for status.** Never use them for series.
- **Text uses ink tokens, not series colors.**
- **Every chart needs a table or a numeric alternative nearby.** The light palette has a contrast WARN, so labels and tables are required, not optional.

## Tables

`DataTable<T>`: `columns: Column<T>[], rows, rowKey, initialSort?, onRowClick?, empty?, caption?, refreshing?`.

`Column<T>`: `key, header, render?, sortValue?, numeric?, hideOnMobile?, firstDir?`.

- Leave out `sortValue` to make a column unsortable.
- Numeric columns are right-aligned, use tabular figures and sort descending first.
- `hideOnMobile` hides the column below 640px.
- `sortRows(rows, get, dir)` is pure, with nulls last.

## Palette (`src/palette.ts`)

`SERIES`, `seriesColor(slot)`, `OTHER_KEY`, `OTHER_COLOR`, `MAX_SERIES`, `modelColor`, `modelColorMap(models)`, `agentKindColor`, `tokenTypeColor`, `assignColors(keys)`, `Status`, `statusFor(utilization, thresholds = [70, 90])`, `STATUS_COLOR`, `STATUS_LABEL`.

## Format (`src/format.ts`)

`fmtCompact`, `fmtTokens`, `fmtInt`, `fmtUsd(n, { compact })`, `fmtPct(n, digits)` (input is 0-100), `fmtRatio` (input is 0-1), `fmtDuration`, `fmtMs`, `fmtCountdown`, `fmtRelative`, `fmtDateTime`, `fmtDate`, `fmtWeekdayDate`, `fmtTime`, `fmtAxisTime`, `fmtDayKey`, `modelLabel`, `modelFamilyWord`, `agentKindLabel`, `tokenTypeLabel`, `pctChange`. Every function that takes a timestamp takes unix seconds and a tz. Null or undefined renders as an em dash.

## Router (`src/router.ts`)

The router is hash-based: `#/path?query`.

- `useRoute()` returns `{ path, query }`.
- `href(path, query)` builds a link. `navigate(path, query, replace?)` goes there.
- `setQuery(patch)` merges into the current query. Null removes a key.
- `matchPath('/sessions/:id', path)` matches a route pattern.

Routes are mapped in `App.tsx` (`resolveRoute`). Nav items are in `src/shell/nav.ts`.

## Demo mode

`?demo` or `VITE_DEMO=1` serves deterministic synthetic data from `src/demo/handler.ts` (`handleDemoRequest`) through the same `ApiClient`. It has no network access and no real data. Pages need no demo-specific code.
