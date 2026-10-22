# CLAUDE.md — Claude Usage Tracker

## Project Context

This repo is a **self-hosted dashboard for Claude/Anthropic usage across all of `RiderProjects`**, not an app tied to any one project. Claude Code has built-in OpenTelemetry metrics export (`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*` env vars, set machine-wide in Windows so every project reports in automatically — not per-project config). This repo hosts the receiving side: a container stack that ingests those metrics and renders them. Nothing here calls the Anthropic Admin API — that requires metered API billing, which doesn't apply to OAuth/subscription usage, so it's out of scope.

- **`docker-compose.yml`** — the whole stack (otel-collector + Prometheus + Grafana, 3 containers). `docker compose up -d` is the entire deploy step; `restart: unless-stopped` + "start on login" is the auto-start mechanism — no scheduled task, no polling script. **Runtime is Podman, not Docker Desktop** — the `docker-compose.yml` filename is just convention (Podman's `docker compose` shim reads it fine). Use Podman Desktop, not Docker Desktop, when checking on the running stack (containers, pods, logs) in a GUI.
- **`grafana/`** — provisioned datasource + starter dashboard JSON, loaded automatically on container start. Edit dashboards here, not through clicking around in the Grafana UI, so changes survive a container recreate.
- **`otel-collector/`** — `config.yaml` for the `otel/opentelemetry-collector-contrib` container. Claude Code pushes OTLP metrics here over HTTP (`:4318`); the collector re-exposes them in Prometheus exposition format, which Prometheus then scrapes. This container is required — Prometheus does not receive OTLP natively in this stack.
- **`prometheus/`** — `prometheus.yml` scrapes the otel-collector's Prometheus exporter endpoint (`otel-collector:8889`) rather than receiving pushes directly.

## Execution & Token Efficiency Rules

- This repo is almost entirely YAML/JSON config, not code — there's rarely a reason to grep broadly. Read the specific config file the task concerns (`docker-compose.yml`, `prometheus/prometheus.yml`, or the one dashboard JSON) rather than scanning the whole repo.
- Don't hand-edit Grafana dashboard JSON by guessing panel schema — prefer small, targeted diffs to an existing panel over regenerating the whole file.
- Keep the stack to what's provisioned (otel-collector + Prometheus + Grafana). Don't add a second collector, a database, or a polling service without checking first — the whole point of this stack is that Claude Code pushes metrics straight to the collector with no extra plumbing, so anything beyond these three containers is a regression in "lightweight."

## Version Control

- Fresh repo, no commits yet. Create the initial commit on `main`, branch off for anything after that — standard workflow, no special cases here.
