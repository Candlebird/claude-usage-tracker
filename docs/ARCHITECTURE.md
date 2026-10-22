# Architecture

`SPEC.md` is the binding contract. This page summarizes how the pieces fit together and why.

```
 ~/.claude/projects/**/*.jsonl ─┐
 ~/.claude/.credentials.json ───┤  (oauth/usage, read-only)
                                ▼
                       ┌──────────────────┐  POST /api/ingest/*  ┌───────────────────────┐
  Windows Scheduled    │  sync (Node CLI) │ ───────────────────▶ │ Cloudflare Worker     │
  Task, every 5 min ──▶│  ccu sync        │   Bearer WRITE_TOKEN │ claude-usage-api + D1 │
                       └──────┬───────────┘                      │ cron */5: alerts      │
                              │ writes ~/.claude-usage/cache.json │ ─▶ ntfy.sh ─▶ phone   │
                              ▼                                   └──────────▲────┬───────┘
                   statusline (Node script) ◀── Claude Code stdin (rate_limits)   │ GET /api/*
                                                                                  │ Bearer READ_TOKEN
 Claude Code OTel (http/json, logs+metrics) ── POST /v1/logs, /v1/metrics ────────┘ (CORS: github.io)
                                                                       ▼
                                          GitHub Pages: dashboard (Vite + React + TS)
```

## Packages

| Package | Runs on | Role |
|---|---|---|
| `shared/` (`@ccu/shared`) | everywhere | Pricing table and `costOf`, payload types, ingest validators, time bucketing. Pure TS with no Node or DOM APIs. |
| `sync/` (`@ccu/sync`, `ccu`) | your PC (Node 22) | Parses transcripts, dedupes, aggregates to hourly buckets, polls plan limits, uploads, writes the statusline cache, installs the Scheduled Task. |
| `worker/` (`claude-usage-api`) | Cloudflare Workers + D1 | Validates and upserts ingest data, serves the read API and OTLP intake, runs the alerts cron and pruning. |
| `web/` | GitHub Pages | The dashboard: hash router, read-only except for `PUT /api/settings`. |

## Data flow

1. **Transcripts → buckets (sync).** `ccu sync` reads only the new, complete lines of each `.jsonl` (main sessions, subagents and workflow agents). It keeps per-request records in `~/.claude-usage/state.json` and recomputes hourly buckets keyed by `(hour, project, model, agentKind, sessionId)`.
2. **Dirty buckets → Worker.** Only buckets whose hash changed since the last ack are POSTed, as **absolute values**, in chunks of 500 or fewer. The Worker upserts by primary key, so a retry or re-send is idempotent. State is persisted after each acked chunk.
3. **Plan limits.** Every run, sync reads the OAuth token (read-only) and calls `/api/oauth/usage`. The result is normalized into `LimitSnapshot` windows (5-hour, weekly, per-model weekly) and uploaded when a value changes or every 15 minutes. Each upload also triggers an immediate alert evaluation.
4. **OTel (optional).** Claude Code posts OTLP http/json logs. The Worker keeps only `api_request` events (plus 429 `api_error` events as limit hits) in `live_requests`, pruned to 72 h. It feeds the live strip and burn rate only, never the totals.
5. **Statusline.** It reads Claude Code's stdin (`rate_limits`, the freshest source) and `cache.json` (today's cost, per-model weekly limits, sync age). It makes no network calls.
6. **Dashboard.** It reads small rollup queries from the Worker with the read token and refreshes every 60 s while visible.
7. **Alerts.** The cron (`*/5`) plus the limits ingest evaluate thresholds, pace, the daily budget, stale sync and limit hits, then POST to ntfy. They are deduped per (rule, window reset) in `alert_state`.

## Accuracy rules

- **Dedupe** by `message.id`, falling back to `requestId`, across all files. One response is written as several lines and can appear in more than one file. The best candidate wins: the one with a non-null `stop_reason`, otherwise the highest `output_tokens`.
- **`usage.iterations`**: when the top-level counts are all zero, sum the iterations.
- **Cache writes** are priced separately: `ephemeral_5m` and `ephemeral_1h`. An un-split `cache_creation_input_tokens` is treated as 5-minute.
- **`<synthetic>`** messages are excluded from usage. Synthetic 429s become limit-hit events.
- **Model ids** are normalized (case, `[1m]`, date suffix, Bedrock/Vertex wrappers), then priced by longest prefix. Unknown models cost 0 and are flagged "unpriced".
- **Cost** is always labelled "API-equivalent", because the subscription is flat-rate.
- **`cost-state`** records give authoritative per-session totals. The difference from the transcript total is shown as "untracked overhead" (titles, classifiers, compaction).
- **Incomplete subagent files** (no final line) are counted as `outputIncomplete` and surfaced in Health instead of hidden.
- **Times** are stored as UTC unix seconds and bucketed into days only at query time, with the user's time zone.
- **Privacy**: only counts and metadata (title, project label, branch) leave the PC, never transcript text.

## Free-tier design

The whole system has to fit the Cloudflare free plan: 100k requests/day, about 10 ms CPU, 100k D1 rows written and 5M read per day, 100 bound parameters per statement, 50 queries per invocation, and 2 of the account's 5 crons at most.

- **Heavy work stays local.** Parsing, dedupe, pricing and aggregation all happen in `ccu`. The Worker validates and upserts in a few batched, multi-row statements.
- **Hourly rollups, not raw rows.** `usage_hourly` is about 50k rows a year. Every dashboard query is an indexed range scan on it. No raw per-request table is ever grouped.
- **Write budget.** Unchanged buckets are never re-sent. Indexes are kept minimal, because each one costs extra written rows. Each run is capped (`maxRowsPerRun`), and backfill goes newest first, so a large history spreads across days.
- **One cron.** `*/5` evaluates alerts. Pruning runs inside it only in the first 5 minutes of each hour.
- **Statusline costs nothing**, because it reads a local file.
- **Auth without paid features.** Bearer read and write tokens are compared in constant time, with no Cloudflare Access. CORS is limited to the Pages origin.
