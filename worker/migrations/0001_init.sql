-- Claude Usage Tracker v2 schema. See SPEC.md "D1 schema".

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
