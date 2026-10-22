# Setup

## 1. Start the stack

```powershell
.\start.ps1
```

Grafana: http://localhost:3000 (default login `admin` / `admin`, it'll prompt a change). The "Claude Usage" dashboard is provisioned automatically.

This runs on **Podman**, not Docker — `podman compose` (bundled with Podman Desktop) shells out to a real `docker-compose` binary against the Podman socket, so the compose file is unchanged, but `docker` in commands below is `podman`.

**The Podman machine must be rootless** (Podman Desktop → Settings → Resources → edit `podman-machine-default` → "Machine with root privileges" **off**). A rootful WSL machine doesn't forward published container ports to the Windows host at all — `localhost:3000`/`:9090`/`:4318` will refuse connections even though the containers are healthy — while rootless machines forward correctly via gvproxy/user-mode networking. If you ever recreate this machine or reset it to rootful, port forwarding will silently break again; re-checking that toggle is the first thing to try.

For it to survive machine restarts without manual intervention, two things need to auto-start: Podman Desktop itself (its own app setting, e.g. "Start Podman Desktop on login") and the `podman-machine-default` VM (look for an autostart toggle on the machine in Podman Desktop's Resources/machine settings — the CLI has no `podman machine start --enable` equivalent, so this has to be set in the UI). If your version doesn't expose that toggle, `start.ps1` calls `podman machine start` before `podman compose up -d`, so re-running it after login is the fallback. Every container here has `restart: unless-stopped`, so once the machine is running, the stack itself comes back on its own.

## 2. Point Claude Code at it — machine-wide, once

This is what makes it cover *every* project, not just this one. Set these as **Windows System Environment Variables** (System Properties → Advanced → Environment Variables → System variables — not per-project `.claude/settings.local.json`, and not User variables, so it applies no matter which shell or IDE launches Claude Code):

| Variable | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `OTEL_METRICS_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |

Or from an elevated PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_ENABLE_TELEMETRY", "1", "Machine")
[Environment]::SetEnvironmentVariable("OTEL_METRICS_EXPORTER", "otlp", "Machine")
[Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf", "Machine")
[Environment]::SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318", "Machine")
```

Restart any open terminal/IDE (env vars are read at process start) and start a new Claude Code session. Metrics export every 60s by default, so give it a minute before checking the dashboard.

This ships **metrics only** — no logs, no traces, no prompt content. That's `OTEL_LOGS_EXPORTER` / `OTEL_TRACES_EXPORTER`, both intentionally left unset. Add either later (same env-var mechanism) if you want per-prompt/per-session detail; it'll cost more resources and, for logs, needs an explicit opt-in (`OTEL_LOG_USER_PROMPTS`, etc.) before it captures any actual prompt text.

## 3. (Optional) break usage down by project

The stack works without this — Grafana will already show tokens/cost/sessions aggregated across everything. To split by project, add a resource attribute in that project's own `.claude/settings.local.json` (`env` block) rather than machine-wide:

```json
"OTEL_RESOURCE_ATTRIBUTES": "project=routingtest"
```

Then group any dashboard query by `project` the same way the starter dashboard groups by `model`/`type`.

## Notes

- Metric names in the starter dashboard (`claude_code_token_usage_tokens_total`, etc.) are Prometheus's rendering of Claude Code's OTLP metric names after passing through the collector. If a panel shows "No data" once real traffic is flowing, open Prometheus (http://localhost:9090/graph) and check the autocomplete for the actual metric names — collector/exporter versions occasionally change the exact suffixing — and adjust the dashboard JSON to match.
- After editing `grafana/provisioning/dashboards/json/claude-usage.json`, restart the Grafana container (`podman compose restart grafana`) rather than waiting on `dashboard.yml`'s `updateIntervalSeconds: 30`. On this stack's Grafana version (13.2.1) the legacy file-provisioner's periodic re-scan doesn't reliably pick up on-disk changes — provisioning logs only show it running once, at container start — so a stale/broken dashboard can keep serving old queries and refresh settings even after a hard browser refresh, since that just re-fetches whatever Grafana already has stored, not the file.
- Every panel target in this dashboard needs an explicit `"datasource": {"type": "prometheus", "uid": "<datasource uid>"}` — don't rely on the Prometheus datasource's `isDefault: true` to cover it. On Grafana 13.2.1 a target with no `datasource` field silently never issues a query at all (confirmed via the browser network log: zero `/api/ds/query` requests fired), which renders as permanently blank panels indistinguishable from "no data yet." Find the datasource uid via `GET /api/datasources` if it's ever regenerated.
- The four single-number "stat" panels (Tokens/Cost/Sessions/Active Time) need `"instant": true` on their targets. Without it, Prometheus evaluates the query as a range query over the whole dashboard time window (`now-7d` by default) at a coarse auto-calculated step (often ~15m), and the stat tile displays whichever value lands at one of those step points — not the current value. This looks exactly like a frozen/stale number even though the underlying data is updating live every scrape.
- The Anthropic Admin API is intentionally not used here — it requires metered API billing tied to an Admin API key, which doesn't apply to OAuth/subscription usage (see project CLAUDE.md).
