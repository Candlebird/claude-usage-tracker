# Setup

End-to-end install on Windows 11. You need Node 22, a free Cloudflare account, a GitHub account and a Claude Pro/Max subscription logged in to Claude Code (OAuth). Everything runs on free tiers.

Commands are for PowerShell, run from the repo root unless a step says otherwise. Where a step `cd`s into `worker`, run `cd ..` afterwards.

What you end up with:

- **Worker + D1** (`claude-usage-api` on `*.workers.dev`): the API, alerts cron and database.
- **Dashboard** on GitHub Pages: `https://<github-user>.github.io/<repo>/`.
- **`ccu` sync CLI** on your PC: a Scheduled Task runs it every 5 minutes.
- **Statusline** in every Claude Code session, and **phone alerts** via ntfy.

## 0. Coming from v1 (Podman / Grafana)

Skip this if you never ran v1.

```powershell
podman compose down -v                 # run in an old checkout, or remove the containers in Podman Desktop
[Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", $null, "User")
[Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_PROTOCOL", $null, "User")
```

The v1 variables pointed Claude Code at `http://localhost:4318` with `http/protobuf`. v2 uses `http/json` against the Worker, and step 7 sets that up. If you had set them as **System** variables instead, clear them from an elevated shell with `"Machine"` in place of `"User"`.

## 1. Install and build

```powershell
npm ci
npm run build
```

`npm ci` also builds `@ccu/shared`, since the other packages import it. `npm run build` builds everything, including `sync/dist/cli.js`.

## 2. Create the D1 database

```powershell
cd worker
npx wrangler login
npx wrangler d1 create claude_usage
```

Copy the `database_id` from the output into the `d1_databases` entry in `worker/wrangler.jsonc`. The id is not a secret, because using it needs your Cloudflare login. Then create the tables:

```powershell
npx wrangler d1 migrations apply claude_usage --remote
```

## 3. Generate tokens

You need two random tokens. The **write token** is used by the sync CLI and OTel. The **read token** is entered in the dashboard. Generate each one with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Keep both in your password manager. Never commit them. They live only in Wrangler secrets, in `~/.claude-usage/config.json` and in your browser's localStorage.

For phone alerts, also make an unguessable ntfy topic. Anyone who knows the topic name can read it, so the name is the secret:

```powershell
node -e "console.log('ccu-' + require('crypto').randomBytes(16).toString('hex'))"
```

## 4. Set Worker secrets and deploy

Still in `worker/`:

```powershell
npx wrangler secret put READ_TOKEN
npx wrangler secret put WRITE_TOKEN
npx wrangler secret put NTFY_TOPIC      # optional; skip if you don't want phone alerts
cd ..
npm run deploy -w worker
```

Each `secret put` prompts for the value. Paste it there, never on the command line.

The deploy prints the Worker URL, for example `https://claude-usage-api.<your-subdomain>.workers.dev`. That URL is your **API URL**. Check it:

```powershell
curl.exe https://claude-usage-api.<your-subdomain>.workers.dev/api/health
```

Vars in `worker/wrangler.jsonc` you may want to change before deploying:

| Var | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://candlebird.github.io,http://localhost:5173` | CORS origins for the dashboard. Set this to your own `https://<github-user>.github.io`. |
| `TZ_NAME` | `America/Denver` | The time zone for day boundaries, the daily budget and quiet hours. |
| `DAILY_BUDGET_USD` | `0` | `0` turns it off. You can also change it later from the dashboard's Settings page. |
| `NTFY_SERVER` | `https://ntfy.sh` | Change it only if you self-host ntfy. |
| `DASHBOARD_URL` | empty | Your dashboard URL (e.g. `https://<github-user>.github.io/<repo>/`). Alerts link to it when tapped. Empty means no link. |

## 5. Publish the dashboard (GitHub Pages)

1. Push the repo to GitHub.
2. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Go to **Settings → Secrets and variables → Actions → Variables** and add the repo variable `API_URL` with your Worker URL. With the GitHub CLI: `gh variable set API_URL --body https://claude-usage-api.<your-subdomain>.workers.dev`.
4. Push to `main`, or run the **Deploy dashboard to GitHub Pages** workflow by hand. `.github/workflows/pages.yml` builds `web/` with `VITE_DEFAULT_API_URL=$API_URL` and publishes `web/dist`.

`API_URL` is a plain variable, not a secret: the URL is public anyway, and the read token guards the data. Open the Pages URL and paste the **read token** on the connect screen. The dashboard stores it in that browser only. To try the UI without a backend, add `?demo` to the URL.

## 6. Install the sync CLI

```powershell
node sync/dist/cli.js install
```

The installer is interactive and idempotent. It shows each step and asks before doing it:

1. It writes `~/.claude-usage/config.json` with the API URL, write token, time zone and device name. It can also store the read token and ntfy topic.
2. It registers the Scheduled Task `ClaudeUsageSync`, which runs `node <repo>/sync/dist/cli.js sync` every 5 minutes in a hidden window.
3. Optional: it sets the OTel user environment variables (step 7).
4. Optional: it adds the statusline to `~/.claude/settings.json` (step 9). It merges into the file and keeps a backup first.
5. Optional: it sets `cleanupPeriodDays` (for example `3650`) so Claude Code stops deleting transcripts after 30 days. **Say yes.** The transcripts are the source of truth, and once Claude Code deletes them that history is gone.

`node sync/dist/cli.js uninstall` reverses all of it.

Other commands: `ccu sync [--dry-run] [--verbose]`, `ccu status`, `ccu backfill [--days N]`, `ccu import-stats-cache`. Run them as `node sync/dist/cli.js <command>`, or `npm link -w @ccu/sync` once to put `ccu` on your PATH.

## 7. OpenTelemetry (optional, for the live strip)

Transcripts give exact totals within 5 minutes. OTel adds a per-request live feed (latency, time to first token, the last 60 minutes). If you said yes in the installer, it set these **user** environment variables:

| Variable | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `OTEL_METRICS_EXPORTER` | `otlp` |
| `OTEL_LOGS_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | your API URL |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer <write token>` |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` |
| `OTEL_LOGS_EXPORT_INTERVAL` | `10000` |

Restart terminals and IDEs afterwards, because environment variables are read when a process starts. No prompt text is exported unless you also set `OTEL_LOG_USER_PROMPTS`. Don't set it.

## 8. Backfill history (free-tier aware)

The first sync finds every transcript still on disk, which can be up to about 30 days, or more if `cleanupPeriodDays` was already raised. The data goes up as hourly buckets. The D1 free plan allows **100,000 rows written per day**, resets at 00:00 UTC, and hard-fails writes beyond that. Each bucket costs about 2 written rows (the row plus its session index).

- Check the size first: `node sync/dist/cli.js sync --dry-run` and `node sync/dist/cli.js status` show the pending rows.
- One sync run uploads at most `maxRowsPerRun` (15,000 by default), newest buckets first, and continues on the next run.
- If the backlog is large, backfill in stages, one window per day: `node sync/dist/cli.js backfill --days 7`, then `--days 14` the next day, and so on. **Keep each day's backfill under about 40,000 buckets**, which leaves room for normal syncing, OTel and alerts.
- For days older than your oldest transcript, `node sync/dist/cli.js import-stats-cache` imports the daily totals from `~/.claude/stats-cache.json`. Those totals are coarse: per day and per model, with no cost split.
- Hitting the limit loses nothing. Failed chunks are not marked as sent, so they retry on the next run after the quota resets.

## 9. Statusline

The installer adds an entry like this to `~/.claude/settings.json`. Forward slashes are required, because Claude Code may run the command through Git Bash:

```json
"statusLine": {
  "type": "command",
  "command": "node \"C:/path/to/ClaudeUsageTracker/sync/dist/statusline.js\""
}
```

It shows the model, the 5-hour and weekly limit % with the reset countdown and pace, today's API-equivalent cost, and context %. It reads Claude Code's stdin and `~/.claude-usage/cache.json` only. It makes no network calls, so it costs nothing on the free tier. A project's own `statusLine` setting overrides this one.

## 10. Phone alerts (ntfy)

1. Install the **ntfy** app (Android or iOS).
2. Subscribe to your topic from step 3 on `ntfy.sh`.
3. In the dashboard, go to **Settings & Health → Send test alert**.

Alerts: a 5-hour or weekly window crossing a threshold (75/90% by default), weekly pace above 1.15× with more than a day left, the daily budget exceeded, stale sync (no sync for 60+ minutes during 08:00–23:00), and a new limit hit. Each alert fires once per window reset. Tapping one opens the dashboard.

## Free-tier budget

Rough worst case for one heavy user with about 10 projects:

| Resource | Free limit | Expected use |
|---|---|---|
| Worker requests | 100k/day | Sync: 288 runs × 1–3 requests ≈ 900. OTel: about 1 request per 10 s per *active* session, so 5–30k on a heavy day. Dashboard: about 60/h while open. |
| Worker CPU | ~10 ms/request | Validation plus batched upserts only. All parsing and aggregation happens on your PC. |
| D1 rows written | 100k/day | Steady state: a few thousand a day, since only changed buckets are re-sent. The backfill is the only spike (see step 8). |
| D1 rows read | 5M/day | The dashboard reads hourly rollups with indexed range scans, about 10–50k rows per full page load. |
| D1 storage | 5 GB | About 50k bucket rows a year, a few MB. `live_requests` is pruned to 72 h. |
| Cron triggers | 5/account | This project uses 1 (`*/5`). |
| GitHub Pages / Actions | free for public repos | One build per push to `main`. |

## Troubleshooting

- **Dashboard says "unauthorized"**: wrong read token, or your Pages origin is missing from `ALLOWED_ORIGINS`. Fix the var and redeploy (`npm run deploy -w worker`).
- **CORS error in the browser console**: same cause. The origin is scheme plus host only (`https://<user>.github.io`) with no path.
- **No data after install**: run `node sync/dist/cli.js sync --verbose` by hand. Check `ccu status` for the last error. Check that the task exists with `schtasks /Query /TN ClaudeUsageSync`.
- **401 from ingest**: the write token in `~/.claude-usage/config.json` doesn't match `WRITE_TOKEN`. Re-run `install` or edit the config.
- **"exceeded D1's free tier daily … limit"**: the backfill was too big for one day. Wait for 00:00 UTC. Nothing is lost (step 8).
- **Limits show an error or "stale"**: the OAuth token in `~/.claude/.credentials.json` expired. Start Claude Code once to refresh it. `ccu` only reads that file and never refreshes or writes it.
- **The live strip stays empty**: check the OTel variables (step 7) in a *new* terminal with `Get-ChildItem Env:OTEL*`. To see export errors, start `claude --debug-file otel.log` and search the log for `[3P telemetry]`.
- **The statusline shows only a minimal line**: there is no cache yet (run a sync), or the path in `statusLine.command` uses backslashes.
- **Costs show "unpriced"**: a new model id isn't in `shared/src/pricing.ts` yet. Add it and redeploy. The token counts are still correct.
