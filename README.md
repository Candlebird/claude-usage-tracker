# Claude Usage Tracker

Accurate Claude Code usage and plan-limit tracking for a subscription (Pro/Max) user. It runs entirely on free hosting.

- **Exact token accounting** from local transcripts. Requests are deduped, 5-minute and 1-hour cache writes are priced separately, and the full history is backfilled.
- **Plan limits**: the 5-hour, weekly and per-model weekly windows, with pace, projected run-out and reset countdowns.
- **Drilldown** by project, session, model, agent (main, subagent or workflow) and day, with cache hit rate and **API-equivalent cost**.
- **Statusline** in every Claude Code session: live limit %, today's cost and context %.
- **Phone alerts** via [ntfy](https://ntfy.sh): limits approaching, weekly pace, daily budget, stale sync.

## How it works

The local `ccu` CLI parses transcripts and uploads pre-aggregated hourly buckets to a Cloudflare Worker with D1. A dashboard on GitHub Pages reads them back. Claude Code's OpenTelemetry export optionally adds a live per-request feed. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Package | What |
|---|---|
| `shared/` | Pricing, types, validators, time helpers |
| `sync/` | `ccu` CLI, statusline and Windows installer |
| `worker/` | Cloudflare Worker + D1 API, alerts cron |
| `web/` | Dashboard (Vite + React + Recharts) |

## Get started

Follow **[docs/SETUP.md](docs/SETUP.md)**. In short: create the D1 database, set the Worker secrets, deploy, turn on Pages, then run `npm ci; npm run build; node sync/dist/cli.js install`.

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run dev -w claude-usage-web   # open http://localhost:5173/?demo
```

## Privacy

Only token counts and metadata (session title, project folder name, git branch) leave your machine. Transcript text never does. Tokens live in Wrangler secrets and `~/.claude-usage/config.json`, never in this repo.

All costs are API-equivalent estimates at list prices. Subscription users pay a flat fee.
