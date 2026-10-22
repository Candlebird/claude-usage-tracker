# Claude Usage Tracker — v2 spec

The build contract for the overhaul. Every package codes against this file. If something here is wrong, fix it here first, then fix the code.

Research reports with evidence: a local scratch folder outside the repo (`transcripts.md`, `otel.md`, `limits.md`, `cloudflare.md`, `pricing-ux.md`, `oauth-usage-sample.json`, `otel-samples/`). These files are local only. Never copy raw samples into the repo: they hold the user's email, org id and account uuid.

## Goals

One power user (Claude Max 5x subscription, OAuth login, Windows 11, about 10 projects, many subagents and workflows) wants usage numbers that are **accurate**, that **fit the workflow**, and that run on **free hosting**:

1. Exact token accounting from transcripts: deduped, with 5-minute and 1-hour cache writes priced separately and a full history backfill.
2. Plan limits: the 5-hour session limit, the weekly limit and any per-model weekly limit, with pace, projected run-out and reset countdowns.
3. Drilldown by project, session, model, agent (main vs subagent vs workflow) and day, with cache efficiency and API-equivalent cost.
4. A Claude Code statusline in every project, showing live limit percentages and today's numbers.
5. Phone alerts through ntfy.sh: approaching limits, weekly pace, daily budget, stale sync.

## Hard constraints

- **The repo is public** (GitHub Pages). It must never contain tokens, emails, org or account ids, or transcript content. Secrets go in `wrangler secret`, in `~/.claude-usage/config.json`, or in GitHub Actions secrets.
- **Cloudflare free plan only.** Workers: 100k requests/day and ~10 ms CPU per request. D1: 100k rows written/day, 5M rows read/day, 100 bound parameters per statement, 50 queries per invocation, 5 GB. Crons: max 5 per account, and one is already used by another project, so use at most 2 here. So:
  - The local sync tool does the heavy work (parsing, dedupe, aggregation) and uploads **pre-aggregated, idempotent absolute values**.
  - The Worker only validates and upserts, with no heavy loops.
  - Dashboard reads hit small rollup tables with indexed range scans.
  - Every write path counts rows: unchanged buckets are never re-sent.
- **Do not use paid-only features**: Workers Paid, Cloudflare email sending, Durable Objects (they are fine on free with SQLite, but not needed), Queues, or Analytics Engine as a requirement.
- Node 22 is installed locally. The project has no other runtime dependencies on the user's machine.

## Architecture

```
 ~/.claude/projects/**/*.jsonl ─┐
 ~/.claude/.credentials.json ───┤  (oauth/usage, read-only)
                                ▼
                       ┌──────────────────┐  POST /api/ingest/*  ┌───────────────────────┐
  Windows Scheduled    │  sync (Node CLI) │ ───────────────────▶ │ Cloudflare Worker     │
  Task, every 5 min ──▶│  ccu sync        │   Bearer WRITE_TOKEN │ claude-usage-api + D1 │
                       └──────┬───────────┘                      │ cron */5: alerts      │
                              │ writes ~/.claude-usage/cache.json │ ─▶ ntfy.sh            │
                              ▼                                   └──────────▲────┬───────┘
                   statusline (Node script) ◀── Claude Code stdin (rate_limits)   │ GET /api/*
                                                                                  │ Bearer READ_TOKEN
 Claude Code OTel (http/json, logs+metrics) ── POST /v1/logs, /v1/metrics ────────┘ (CORS: github.io)
                                                                       ▼
                                          GitHub Pages: dashboard (Vite + React + TS)
```

## Repo layout (npm workspaces, TypeScript everywhere, ESM)

```
package.json            workspaces: shared, worker, sync, web; scripts: build, test, typecheck, lint
tsconfig.base.json
shared/                 @ccu/shared — pure TS, no Node/DOM APIs. Used by all others.
  src/pricing.ts        price table + normalizeModel() + costOf(usage, model)
  src/types.ts          API payload types (ingest + read API), Zod-free plain types
  src/validate.ts       tiny hand-written validators for ingest payloads (Worker uses them)
  src/time.ts           hour/day bucketing with an IANA tz, 5-hour block helpers
  src/index.ts
worker/                 claude-usage-api — Worker + D1 migrations + vitest
  wrangler.jsonc, migrations/0001_init.sql, src/index.ts, src/routes/*.ts, src/alerts.ts, test/
sync/                   @ccu/sync — Node CLI `ccu` (bin), statusline, installer
  src/cli.ts, src/transcripts.ts, src/aggregate.ts, src/state.ts, src/usageApi.ts, src/upload.ts,
  src/statusline.ts, src/install.ts, src/statsCacheImport.ts, test/ (fixtures: synthetic JSONL only)
web/                    dashboard — Vite + React 18 + TS + Recharts, deployed to GitHub Pages
.github/workflows/      ci.yml (typecheck+test all), pages.yml (build web → Pages on push to main)
docs/                   SETUP.md (user-facing install), ARCHITECTURE.md
```

Remove the old stack (`docker-compose.yml`, `start.ps1`, `grafana/`, `prometheus/`, `otel-collector/`). Rewrite `CLAUDE.md` and `SETUP.md` for v2.

Tooling: TypeScript 5.x with `strict`. Use vitest everywhere. The worker uses `@cloudflare/vitest-pool-workers` or `@cloudflare/vitest-plugin`, whichever works with the installed versions, for D1-backed tests. The sync package builds with `tsc` to `sync/dist` and runs with `node sync/dist/cli.js`. The web package builds with Vite, `base: './'`.

## Shared: pricing & cost (`shared/src/pricing.ts`)

- The price table comes from `pricing-ux.md` (JSON table keyed by model-id prefix) and is stored as a typed constant with `asOf` and a source URL. Prices are USD per million tokens: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, plus optional `fast` input/output, and `webSearchPerRequest` = 0.01.
- `normalizeModel(id)`: lowercase it, strip a `[1m]`-style suffix, strip a trailing date `-20xxxxxx`, strip Bedrock/Vertex prefixes and suffixes (`us.anthropic.`, `anthropic.`, `@...`, `-v1:0`), then take the longest matching prefix. Return `{ family, priced: boolean }`. `<synthetic>` is never priced and is excluded upstream.
- `costOf(u: UsageTokens, model, opts: {speed?: 'fast'|'standard'})` returns USD as a float. `UsageTokens = { input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearch }`. If only an un-split `cache_creation_input_tokens` exists, treat all of it as 5-minute. An unpriced model costs 0 and the result is flagged so the UI can show "unpriced".
- **Per-iteration pricing:** when a request carries two or more `usage.iterations`, each iteration is priced on its own and the costs are summed. This matters for long-context tiers, where the summed tokens would cross a tier boundary that no single iteration crossed. A request with no stored iterations is priced from its top-level tokens.
- **Limit window keys (`shared/src/time.ts`):** `limitWindowKey(kind)` maps every spelling of a window to one key: `five_hour`, `seven_day`, and `seven_day:<model>` (so the legacy `seven_day_opus` becomes `seven_day:opus`). Sync, the Worker (ingest, `/api/limits`, alerts) and the dashboard all go through it, so limit hits and snapshots for the same window always line up.
- Label every cost in the UI as **"API-equivalent cost"**. The user pays a flat subscription.

## Sync tool (`sync/`) — `ccu` CLI

Config: `~/.claude-usage/config.json` = `{ apiUrl, writeToken, readToken?, tz, deviceName, ntfyTopic?, maxRowsPerRun?, maxRowsPerDay? }`. It is created by `ccu install`. Files in `~/.claude-usage/`:

- `state.json`: parse offsets, deduped request records, bucket hashes, sessions, projects, limit hits, and `rowsToday = {day: 'YYYY-MM-DD' (UTC), rows}`. Loading an older state fills in missing fields (a missing `rowsToday` becomes `{day:'', rows:0}`) and re-keys stored limit hits through `limitWindowKey`, merging twins.
- `cache.json`: what the statusline reads.
- `limits.json`: `{lastUploadTs, signature}` of the last uploaded limit snapshot, used to decide whether the next one is worth sending.
- `install.json`: the installer's manifest, `{settingsBefore?: {statusLine?, cleanupPeriodDays?, statusLineSaved?, cleanupSaved?, statusLineCommand?}, envBefore?: {NAME: previous value or null}}`, so `ccu uninstall` can restore exactly what was there.
- `sync.lock`: the run lock.

### Transcript parsing (`transcripts.ts`) — rules from transcripts.md

- Walk `~/.claude/projects/<projDir>/`:
  - main sessions: `<sessionId>.jsonl`
  - subagents: `<sessionId>/subagents/agent-<id>.jsonl` and `<sessionId>/subagents/workflows/wf_*/agent-*.jsonl` (also check `<sessionId>/workflows/...`; match whatever exists). Each has a sibling `.meta.json` with `agentType`.
- **Incremental:** per file, keep `{size, mtimeMs, offset}` in state and read only from `offset`. Consume only complete lines (ending in `\n`). If the file shrank or was replaced, re-read it from 0.
- Cheap pre-filter: skip a line unless it contains `"type":"assistant"` or `"type":"cost-state"`. Never `JSON.parse` `api-request-blob` or `api-request-shape` lines.
- **Assistant usage:**
  - Take `message.usage`. Dedupe key is `message.id`, falling back to `requestId`.
  - When a key repeats (lines of the same response, or the same response in several files), keep the best candidate: the one with `message.stop_reason != null` wins; otherwise the one with the highest `output_tokens`. The request's `ts` (and so its hour bucket), its iterations and its other fields all come from the winning occurrence.
  - If `usage.iterations` is non-empty and the top-level counts are all zero, sum the iterations. When there are two or more iterations, keep each one's tokens (`extractIterations`) so the request can be priced per iteration.
  - Exclude `message.model === '<synthetic>'`, but record synthetic 429s that carry `quotaLimits` / `apiErrorParams.rate_limit_info` as **limit-hit events** (`{ts, rateLimitType, resetsAt}`). The hit's kind is normalized with `limitWindowKey`.
- **Session titles:** `{"type":"ai-title"}` lines (`aiTitle`, or `title`) set the session's title; the latest one wins. They pass the same pre-filter as assistant and cost-state lines.
- **Per request, extract:**
  - `ts`, `sessionId`, `cwd`, `gitBranch`, `model`, `requestedModel`, `effort`, `entrypoint`, `version`, `isSidechain`
  - agent kind: `main` | `subagent` | `workflow`, plus `agentType` from meta
  - tokens: input, output, cacheRead, cacheWrite5m/1h from `usage.cache_creation.ephemeral_*`, webSearch from `server_tool_use.web_search_requests`
  - `speed`
- **Project key:** derived from `cwd`. Normalize slashes and casing, then label it with the last path segment. If two projects share a label, add the parent segment. A project's `cwd` can be a subdirectory of a known git root: map it to the deepest ancestor that has a `.git` directory, when that directory exists on disk.
- **`cost-state` records:** the last one per session file gives authoritative per-session totals (`modelUsage`, `costUSD`, lines added/removed). Send it as session metadata. The UI shows "untracked overhead" = cost-state total minus the transcript-derived total (title generation, classifiers, compaction).
- Older subagent files (v2.1.278–2.1.303) often lack final lines, so output is undercounted. Count a request as `outputIncomplete` when it has no final line, and expose the count in Health.

### Local aggregation (`aggregate.ts`, `state.ts`)

- The state holds the deduped per-request records needed to recompute buckets. Keep it compact: key → `[ts, bucketKeyIndex, input, output, cr, cw5, cw1, ws, flags, iterations?]`. `iterations` is present only when the request had two or more: a flat array with five numbers per iteration (`input, output, cacheRead, cacheWrite5m, cacheWrite1h`). Records written before this field existed have nine elements and stay valid. This is bounded: about 120k requests over 30 days is a few MB. Prune records older than 400 days.
- **Bucket key** = `(hourStartUtcSec, projectKey, model, agentKind, sessionId)`. Each bucket stores the sums plus `requests` and `costUsd`, computed locally with `shared` pricing.
- After parsing, find the **dirty buckets**: the ones whose sums changed since the last successful upload (keep a hash per bucket in state). Upload only those, as absolute values. The server upserts by primary key, which makes uploads idempotent.
- **Sessions:** `{sessionId, projectKey, firstTs, lastTs, title (from 'ai-title' record), gitBranch, models[], agentCount, costStateUsd?, linesAdded?, linesRemoved?}`. Upload when changed.
- **Free-tier budget:** cap rows written per sync run with `maxRowsPerRun`, default 15000. When the history backfill exceeds the cap, upload the newest buckets first and continue on the next run. The `ccu backfill --days N` command lets the user control this. Report progress.
- **Daily row budget:** D1 allows 100k rows written per day, so sync also caps itself per UTC day with `maxRowsPerDay` (config or `--max-rows-per-day`), default `DEFAULT_MAX_ROWS_PER_DAY` = 80000, which leaves headroom for OTel, limits and the cron. Each run may write `max(0, min(perRun, perDay − rowsToday))` rows. `state.rowsToday` counts acked rows and resets when the UTC day changes. Once the day's budget is used up, a run still sends a heartbeat (a `sync_runs` row with `pending`) but no buckets. `ccu status` prints "rows written today (UTC): N of M".

### Plan limits (`usageApi.ts`)

- Every run, re-read `~/.claude/.credentials.json`. Use `claudeAiOauth.accessToken` and never refresh or write that file. `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer`. Use a short timeout. On a 401 or expired token, skip and record the error in the cache file.
- Parse loosely:
  - `five_hour` and `seven_day`, plus any `seven_day_*` object that is non-null and has a numeric `utilization`
  - `limits[]` (kind, percent, severity, resets_at, scope.model.display_name, is_active)
  - `extra_usage.is_enabled`
- Normalize to `LimitSnapshot = { ts, windows: [{ key: 'five_hour'|'seven_day'|'seven_day:<model>'|..., label, utilization (0-100), resetsAt (ISO, rounded to minute), severity? }], raw?: never sent }`.
- Upload snapshots to `/api/ingest/limits`, but only when a value changed or 15 minutes have passed. Write `cache.json` every run.

### Uploads (`upload.ts`)

- POST JSON with `Authorization: Bearer <writeToken>`. Use chunks of at most 500 rows. Retry with backoff on 5xx/network errors. Stop on a 401 or 400 and log the server message. After each chunk succeeds, persist the state so a crash never re-sends acked rows.

### Commands

- `ccu sync [--dry-run] [--verbose]`: parse, aggregate, refresh limits, upload, write the cache. It must be safe to run concurrently: take a lock file in `~/.claude-usage/` and exit quietly if it is held.
- `ccu backfill [--days N]`
- Shared flags: `--dry-run`, `--verbose`/`-v`, `--home <dir>` (instead of `~/.claude-usage`), `--claude-dir <dir>` (instead of `~/.claude`), `--days N`, `--max-rows N` (per run), `--max-rows-per-day N`. Each value flag also takes the `--flag=value` form.
- `ccu import-stats-cache`: a one-time import of `~/.claude/stats-cache.json` daily totals for days before the earliest transcript, into `/api/ingest/daily-legacy`.
- `ccu status`: what's synced, rows pending, last errors, current limits.
- `ccu install`: an interactive, idempotent installer. It is printed and confirmed step by step and must not silently modify the user's global setup.
  1. Write the config file. The API URL and tokens are prompted, or taken from flags. The write token, read token and ntfy topic are read with hidden input (nothing is echoed). An existing value is shown only masked (`mask()`), and pressing Enter keeps it. Non-interactive runs keep existing values.
  2. Register a Windows Scheduled Task, `ClaudeUsageSync`, every 5 minutes, hidden window (`schtasks` or a PowerShell `Register-ScheduledTask`), that runs `node <abs>/sync/dist/cli.js sync`.
  3. Optionally set user env vars for OTel (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=<apiUrl>`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <writeToken>`, `OTEL_METRIC_EXPORT_INTERVAL=60000`, `OTEL_LOGS_EXPORT_INTERVAL=10000`).
  4. Optionally add `statusLine` to `~/.claude/settings.json` by merging JSON, never clobbering it, after making a backup.
  5. Optionally set `cleanupPeriodDays` (e.g. 3650) in `~/.claude/settings.json` so transcripts stop being deleted after 30 days.
  6. `ccu uninstall` reverses all of this.

### Statusline (`statusline.ts` → `ccu statusline`, also a standalone `sync/dist/statusline.js`)

- Entry points: `statuslineMain()` in `statusline.ts`. `sync/dist/statusline.js` runs it when executed directly, and `statusline-entry.ts` is a dedicated entry that only calls it. Neither loads the full CLI. The installer points Claude Code at `dist/statusline.js`.

- Read the Claude Code statusline JSON from stdin: `model.display_name`, `workspace.current_dir`, `cost.total_cost_usd`, `context_window` if present, `rate_limits.five_hour/seven_day.{used_percentage,resets_at}`, `session_id`.
- **No network calls. Target under 50 ms.** Read `~/.claude-usage/cache.json` for today's API-equivalent cost and tokens, per-model weekly limits, last sync age and errors.
- Prefer the stdin `rate_limits`, which are fresher, and fall back to the cache.
- One line, ANSI colored with thresholds (green, then yellow at 70% or more, then red at 90% or more), compact. For example:
  `Opus 5.5 · 5h ▰▰▱▱▱ 42% ↻1h12m · wk 18% (pace ok) · today $38.20 · ctx 61%`
- Degrade gracefully when there is no cache or no rate_limits. Never throw: on any error, print a minimal line.
- Windows: Claude Code may run the command through Git Bash, so the installer writes the command with forward slashes and quotes.
- The cache file includes `today: {costUsd, tokens, requests}` and `burnRatePerHour`, both computed by sync.

## Worker (`worker/`) — `claude-usage-api`

- `wrangler.jsonc`:
  - name `claude-usage-api`, `workers_dev: true`, `compatibility_date: "2026-10-01"`
  - D1 binding `DB` (database `claude_usage`)
  - cron `*/5 * * * *` (alerts plus pruning of the live table)
  - vars `ALLOWED_ORIGINS` (default `https://candlebird.github.io,http://localhost:5173`), `TZ_NAME` (`America/Denver`), `DAILY_BUDGET_USD` (`0` = off), `DASHBOARD_URL` (optional; ntfy `Click` link, empty = none)
  - secrets `READ_TOKEN`, `WRITE_TOKEN`, `NTFY_TOPIC` (optional), `NTFY_SERVER` (optional var, default `https://ntfy.sh`)
- **Auth:**
  - Ingest routes and `/v1/*` need `Bearer WRITE_TOKEN`. Read routes need `Bearer READ_TOKEN`, and WRITE_TOKEN is also accepted for reads.
  - Compare in constant time.
  - CORS: echo the allowed origin, `Vary: Origin`, preflight with `Authorization, Content-Type`. Reads are only from allowed origins (the token is still required). No cookies.
- **Validation:** body size caps (1 MB for ingest, 256 KB for /v1), strict shape checks via `shared/validate.ts`, clamp strings. Reject unknown fields softly by dropping them.
- **CPU:** all inserts go through `DB.batch()` with multi-row VALUES sized to 100 parameters or fewer, using as few statements as possible. Stay within 50 queries per invocation.

### D1 schema (`migrations/0001_init.sql`, STRICT tables)

```sql
CREATE TABLE usage_hourly (            -- authoritative, from sync (absolute values; upsert replaces)
  hour INTEGER NOT NULL,               -- unix seconds, UTC hour start
  project TEXT NOT NULL, model TEXT NOT NULL, agent_kind TEXT NOT NULL, session_id TEXT NOT NULL,
  requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
  web_search INTEGER NOT NULL, cost_usd REAL NOT NULL, device TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (hour, project, model, agent_kind, session_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX usage_hourly_session ON usage_hourly(session_id);
-- (hour is the PK prefix, so time-range scans are already indexed; keep indexes minimal: each index costs extra rows written)

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT, git_branch TEXT,
  first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, models TEXT NOT NULL,      -- JSON array
  agent_count INTEGER NOT NULL DEFAULT 0, cost_state_usd REAL, lines_added INTEGER, lines_removed INTEGER,
  device TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX sessions_last ON sessions(last_ts);

CREATE TABLE projects (project TEXT PRIMARY KEY, label TEXT NOT NULL, path TEXT) STRICT;

CREATE TABLE limit_snapshots (ts INTEGER NOT NULL, window_key TEXT NOT NULL, utilization REAL NOT NULL,
  resets_at INTEGER NOT NULL, severity TEXT, PRIMARY KEY (window_key, ts)) STRICT, WITHOUT ROWID;

CREATE TABLE limit_hits (ts INTEGER NOT NULL, kind TEXT NOT NULL, resets_at INTEGER, PRIMARY KEY (ts, kind)) STRICT;

CREATE TABLE live_requests (           -- from OTel api_request events; pruned to 72h by cron
  request_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT, model TEXT,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
  cost_usd REAL, duration_ms INTEGER, ttft_ms INTEGER, speed TEXT, effort TEXT, query_source TEXT
) STRICT;
CREATE INDEX live_requests_ts ON live_requests(ts);

CREATE TABLE daily_legacy (day TEXT NOT NULL, model TEXT NOT NULL, tokens INTEGER, requests INTEGER,
  PRIMARY KEY (day, model)) STRICT;

CREATE TABLE sync_runs (ts INTEGER PRIMARY KEY, device TEXT, rows INTEGER, pending INTEGER, version TEXT, errors TEXT) STRICT;
CREATE TABLE alert_state (alert_key TEXT PRIMARY KEY, fired_at INTEGER NOT NULL, window_reset INTEGER) STRICT;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;   -- daily budget, alert thresholds, tz
```

`migrations/0002_limit_hit_window_keys.sql` re-keys existing `limit_hits.kind` values to the `limitWindowKey` form (`seven_day_opus` becomes `seven_day:opus`). It does the same for `hit:` keys in `alert_state`. Where a row already exists under the new key, the old one is dropped. Ingest normalizes kinds the same way from then on.

### Routes

All responses are JSON. Errors look like `{error: string}` with the appropriate status. `from`/`to` are unix seconds, and the default range is the last 7 days.

Ingest (WRITE):

- `POST /api/ingest/usage` → body `{device, version, buckets: HourlyBucket[], sessions?: SessionMeta[], projects?: ProjectMeta[], limitHits?: LimitHit[], pending?: number}`. Upsert with `ON CONFLICT(...) DO UPDATE SET col=excluded.col`. Insert a `sync_runs` row. Response: `{ok:true, accepted:{buckets,sessions,...}}`.
- `POST /api/ingest/limits` → `{snapshots: LimitSnapshot[]}`. Store each window, then **run the alert evaluation immediately** (as well as on cron).
- `POST /api/ingest/daily-legacy` → `{days:[{day, model, tokens, requests}]}`.
- `POST /v1/logs`: OTLP http/json.
  - Walk `resourceLogs[].scopeLogs[].logRecords[]`. Keep only the `event.name` / body `claude_code.api_request` (and `api_error` with status 429, stored as a limit hit).
  - Attribute values are `{stringValue|intValue|doubleValue}`, and intValue can be a string.
  - Map to `live_requests` (request_id; ts from `timeUnixNano` (a string); tokens incl. `cache_creation_5m_tokens`/`_1h`; cost_usd; duration_ms; ttft_ms; speed; effort; query_source; session.id).
  - `INSERT OR IGNORE`. Respond **within 2s** with `{"partialSuccess":{}}`.
  - Never 401 a valid-shape request with a good token. With a bad token, return 401.
- `POST /v1/metrics`: accept and return 200 `{}`. It's optional to store anything: metrics duplicate the logs. Answer quickly.

Read (READ):

- `GET /api/summary?tz=` → KPIs:
  - today, last 7 days and last 30 days: cost, tokens by type, requests, sessions
  - cache hit rate = cacheRead / (input + cacheRead + cacheWrite)
  - cache savings in USD versus no cache
  - live burn rate (last 60 minutes, from `live_requests` merged with hourly)
  - latest limit snapshot per window, with pace (utilization / fraction of the window elapsed) and projected time to 100%
  - last sync time and age, rows pending, unpriced-model flag
- `GET /api/timeseries?from&to&bucket=hour|day&group=model|project|agent_kind|type&tz=` → `{series:[{key, points:[[t, value...]]}], metric}` with `metric=cost|tokens|requests`. Day bucketing uses the tz offset.
- `GET /api/limits?from&to` → snapshots per window (for limit-history charts), limit hits, and 5-hour block reconstruction: block start = resets_at − 5h, with peak utilization and the cost and tokens used in that block.
- `GET /api/projects?from&to` → per project: cost, tokens, requests, sessions, cache hit rate, top model, last active, and a sparkline (daily cost).
- `GET /api/sessions?from&to&project=&limit=&offset=&sort=cost|recent` → list with title, project, branch, models, cost, tokens, duration, agent count, cost_state_usd, untracked overhead.
- `GET /api/sessions/:id` → session detail: hourly series by model and agent_kind, totals, meta.
- `GET /api/models?from&to` → per model: tokens by type, cost, cache hit rate, share.
- `GET /api/heatmap?weeks=12&tz=` → day-of-week × hour-of-day cost/tokens grid, plus a daily calendar series.
- `GET /api/live?minutes=60` → recent `live_requests`: the per-minute series and the last 50 requests.
- `GET /api/health` → no auth; returns `{ok, version}` only.
- `GET /api/status` (READ) → sync runs, row counts per table, unpriced models seen, OTel last-received time, `outputIncomplete` stats, D1 approximate rows written today.
- `GET/PUT /api/settings` (READ for GET, WRITE **or READ** for PUT; the user only has the read token in the browser) → `{dailyBudgetUsd, alertThresholds:{fiveHour:[75,90], weekly:[75,90]}, weeklyPaceAlert:true, staleSyncMinutes:60, ntfyEnabled}`. Both methods respond with a `SettingsResponse`: the settings plus a server fact, `ntfyConfigured` (true when a `NTFY_TOPIC` secret is set). The topic itself is never returned. `ntfyConfigured` is ignored in a PUT body. The Settings page shows whether ntfy is configured next to the ntfy toggle.
- `POST /api/alerts/test` (READ) → sends a test ntfy push.

### Alerts (`alerts.ts`, cron `*/5` + after `/api/ingest/limits`)

Rules: each window crossing a threshold; weekly pace > 1.15 with more than 1 day left (projected to hit 100% before reset); daily budget exceeded (today's cost ≥ budget); stale sync (no `sync_runs` row in `staleSyncMinutes` while limit snapshots were recent… or simply > 60 min during 08:00–23:00 local); a new limit hit.

Delivery: POST `${NTFY_SERVER}/${NTFY_TOPIC}` with headers `Title`, `Priority` (high at 90% or more), `Tags`, `Click` (dashboard URL). Dedupe with `alert_state`: one alert per (rule, window reset). Light CPU work only.

Pruning (`prune.ts`): the cron deletes `live_requests` older than 72 hours and `limit_snapshots` older than 90 days, but keeps one per window per hour beyond 7 days. It also deletes `sync_runs` older than 90 days, and `alert_state` rows that fired more than 30 days ago or whose `window_reset` is more than 1 day past. `stale:` rows key on the last sync time instead of a reset, so they only age out by `fired_at`. Run the pruning only hourly (minute < 5) to save rows. `runAlerts` itself no longer deletes `alert_state` rows.

## Dashboard (`web/`) — GitHub Pages

- Vite + React 18 + TypeScript + Recharts. Use a hash router (GitHub Pages has no SPA fallback). Use no UI kit; write it in CSS with design tokens.
  - Dark by default with a light theme toggle (`prefers-color-scheme`).
  - Responsive down to a 375 px phone: it must look good on a phone because the alerts link there.
  - Follow the `dataviz` skill for chart colors and forms.
- **First run:** a connect screen asks for the API URL (prefilled from `VITE_DEFAULT_API_URL` at build time) and the read token. Store both in localStorage. Validate with `/api/summary`. A Settings page can change or forget them.
- **Pages:**
  1. **Overview:**
     - limit gauges (5-hour, weekly, per-model) with reset countdowns and pace
     - KPI tiles: today, 7 days, 30 days API-equivalent cost and tokens; cache hit rate and savings; burn rate
     - stacked cost-by-model area chart (last 7 days, hourly)
     - top projects; recent sessions
     - live strip (last 60 minutes from OTel)
  2. **Limits:**
     - utilization history per window with threshold lines and reset markers
     - 5-hour block history table: start, peak %, cost, tokens, and "cost per 1%" (an estimate of the plan's capacity)
     - weekly pace projection; limit hits
  3. **Projects:** a sortable table with sparklines, then a project detail drawer: timeseries by model and agent kind, plus its sessions.
  4. **Sessions:** a filterable and sortable list with pagination, then session detail: timeline, model mix, main vs subagent vs workflow split, untracked overhead.
  5. **Models & Cache:** token mix by type, cache hit rate over time, savings, 1h vs 5m cache writes, cost share.
  6. **Activity:** day×hour heatmap and calendar heatmap (12 weeks).
  7. **Settings & Health:** API connection; daily budget and alert thresholds (PUT /api/settings) with a test-alert button; sync status; unpriced models; OTel last seen; D1 row usage vs free quota.
- **Bundle:** each page except Connect is `React.lazy`-loaded behind a `Suspense` placeholder (`.page-loading`). `vite.config.ts` uses `build.rolldownOptions.output.codeSplitting.groups` to put `react` and `recharts` (with its d3 and redux dependencies) in their own chunks. `chunkSizeWarningLimit` is 500 kB, and no chunk may exceed it.
- Global controls: a date-range picker (24h / 7d / 30d / 90d / custom), timezone from the browser, and auto-refresh every 60 s while visible (pause when hidden).
- Numbers: compact formats (1.2M tokens, $38.20). Every cost carries the "API-equivalent" tooltip.
- Empty, loading and error states everywhere. A 401 sends the user back to the connect screen.
- `web/src/api.ts` is a typed client using the types from `@ccu/shared`. **Mock mode:** with `?demo` or the `VITE_DEMO` env, it serves generated fixture data so the UI can be developed and screenshot-tested without a backend.

## CI / deploy

- `.github/workflows/ci.yml`: on push/PR, `npm ci`, typecheck, test for all workspaces.
- `.github/workflows/pages.yml`: on push to main, build `web` with `VITE_DEFAULT_API_URL` from repo variable `API_URL` and upload `web/dist` to Pages. This mirrors the Crusade Dataslate `deploy.yml`.
- The Worker is deployed manually: `npm run deploy -w worker` (`wrangler deploy`), and migrations with `wrangler d1 migrations apply claude_usage --remote`. Both are documented in `docs/SETUP.md`.

## Conventions

- Match the Crusade Dataslate style: small focused modules, plain functions, comments only where intent isn't obvious, and tests next to the logic that matters (dedupe, pricing, aggregation, OTLP parsing, alert rules, route SQL).
- Times are stored as unix seconds UTC everywhere, and only bucketed by the user's timezone at query time (days) or in the UI.
- Never log tokens. Never send transcript text anywhere: only counts and metadata (title, cwd-derived project label, branch).
