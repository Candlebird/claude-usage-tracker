# CLAUDE.md — Claude Usage Tracker

## Project Context

This repo is a **personal usage and plan-limit tracker for Claude Code across all of `RiderProjects`**, not an app tied to any one project. It answers three questions: what did I use (exact, deduped token accounting from transcripts), how close am I to my limits (the 5-hour, weekly and per-model weekly windows), and where did it go (by project, session, model and agent kind). The subscription is flat-rate (Max via OAuth), so every dollar figure is an **API-equivalent cost**, not a bill. The Anthropic Admin API is out of scope, because it needs metered API billing.

`SPEC.md` is the binding contract. If code and spec disagree, fix the spec first, then the code. `docs/ARCHITECTURE.md` has the diagram and the accuracy rules. `docs/SETUP.md` is the user install guide.

- **`shared/`**: `@ccu/shared`. Pricing table and `costOf`, payload types, ingest validators, time bucketing. Pure TS with no Node or DOM APIs. Every other package imports it.
- **`sync/`**: `@ccu/sync`, the `ccu` CLI that runs on the PC from a Scheduled Task every 5 minutes. It parses `~/.claude/projects/**/*.jsonl` incrementally, dedupes, aggregates to hourly buckets, polls `/api/oauth/usage` read-only, uploads only changed buckets, and writes `~/.claude-usage/cache.json` for the statusline. All the heavy work lives here.
- **`worker/`**: `claude-usage-api`, a Cloudflare Worker with D1, `migrations/` and the `*/5` alerts cron that posts to ntfy. It validates and upserts, serves the read API and OTLP intake, and does nothing else. It is deployed by hand (`npm run deploy -w worker`), never from CI.
- **`web/`**: the dashboard (Vite + React 18 + Recharts, hash router), deployed to GitHub Pages by `.github/workflows/pages.yml`. `?demo` serves fixture data with no backend.

## Hard Rules

- **This repo is public.** Never commit tokens, emails, org or account ids, ntfy topics, or anything from real transcripts. Secrets live in `wrangler secret`, in `~/.claude-usage/config.json`, or in GitHub Actions variables and secrets. Test fixtures are **synthetic**, hand-written JSONL. Never read or print the OAuth access token in `~/.claude/.credentials.json`; sync only passes it to the usage endpoint.
- **Cloudflare free tier only.** That means 100k Worker requests/day, about 10 ms CPU per request, 100k D1 rows written and 5M read per day, 100 bound parameters per statement, 50 queries per invocation, and at most 2 crons for this project. Before adding a write path, count its rows. Before adding a query, check that it is an indexed range scan on a rollup table. No Workers Paid, Queues, Durable Objects or Analytics Engine.
- **Accuracy over convenience.** The dedupe, cache-write split and `<synthetic>` exclusion rules in `SPEC.md` exist because the naive sum is wrong. Don't simplify them away without a test that proves the numbers still match.
- Don't change the user's global setup (`~/.claude/settings.json`, environment variables, Scheduled Tasks) except through `ccu install` and `ccu uninstall`, which confirm each step and back files up first.

## Execution & Token Efficiency Rules

- Read the package the task concerns, not the whole repo. Each package has small, focused modules named for what they do (`transcripts.ts`, `aggregate.ts`, `routes/*.ts`, `alerts.ts`). Go straight to the one you need.
- Shared types change in `shared/` first. Keep changes additive: add a new export instead of reshaping one that other packages already depend on.
- Don't open real transcripts or `~/.claude-usage/state.json` to "check something". They are large and private. Write a synthetic fixture that reproduces the case.
- Keep the stack to sync + Worker/D1 + Pages. Don't add a server, a database, a queue or a second polling service without checking first.
- Style: strict TS, ESM, plain functions, comments only where intent isn't obvious, and tests next to the logic that matters (dedupe, pricing, aggregation, OTLP parsing, alert rules, route SQL).

## Testing

```powershell
npm ci                    # also builds @ccu/shared (postinstall)
npm run typecheck         # all workspaces
npm test                  # all workspaces (vitest; worker tests run against local Miniflare D1)
npm test -w @ccu/sync     # one package
npm run build             # everything; sync -> sync/dist, web -> web/dist
npm run dev -w claude-usage-web   # dashboard at http://localhost:5173 (add ?demo)
npm run dev -w claude-usage-api   # local Worker (wrangler dev, local D1)
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck and test on every push and PR. Never run anything with `--remote`, `wrangler deploy` or `wrangler secret put` unless the user asks for it.

## Version Control

- Work on a branch and merge to `main` by PR. A push to `main` redeploys the dashboard.
- Before committing, check the diff for secrets and real data (ids, emails, topics, transcript snippets). If something slipped in, rotate it; don't just delete it in a later commit.
