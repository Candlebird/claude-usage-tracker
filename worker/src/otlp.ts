// Pure parser for OTLP http/json log exports from Claude Code. Keeps only
// `api_request` events (-> live_requests) and `api_error` with status 429
// (-> limit_hits). Everything else (startup noise, tool events) is dropped.
import { COUNT_MAX, roundToMinute, TS_MAX, TS_MIN, type LimitHit, type LiveRequest } from '@ccu/shared';

export interface OtlpParseResult {
  requests: LiveRequest[];
  limitHits: LimitHit[];
  /** Total log records seen. */
  records: number;
  /** api_request records dropped as malformed (no request id). */
  invalid: number;
}

type AnyValue = {
  stringValue?: unknown;
  intValue?: unknown;
  doubleValue?: unknown;
  boolValue?: unknown;
};

type KeyValue = { key?: unknown; value?: AnyValue };

const LIMITS = { requestId: 100, sessionId: 100, model: 100, speed: 32, effort: 32, querySource: 64 } as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function scalar(v: AnyValue | undefined): string | number | boolean | null {
  if (!isObj(v)) return null;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (v.intValue !== undefined && v.intValue !== null) {
    const n = typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  }
  if (typeof v.doubleValue === 'number' && Number.isFinite(v.doubleValue)) return v.doubleValue;
  if (typeof v.doubleValue === 'string' && Number.isFinite(Number(v.doubleValue))) return Number(v.doubleValue);
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  return null;
}

function attrMap(attrs: unknown): Map<string, string | number | boolean | null> {
  const m = new Map<string, string | number | boolean | null>();
  for (const kv of list(attrs) as KeyValue[]) {
    if (isObj(kv) && typeof kv.key === 'string') m.set(kv.key, scalar(kv.value));
  }
  return m;
}

type Attrs = ReturnType<typeof attrMap>;

function str(a: Attrs, key: string, max: number): string | null {
  const v = a.get(key);
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function numAttr(a: Attrs, key: string): number | null {
  const v = a.get(key);
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function countAttr(a: Attrs, key: string): number | null {
  const n = numAttr(a, key);
  if (n === null) return null;
  return Math.min(COUNT_MAX, Math.max(0, Math.round(n)));
}

/** Unix seconds from a nanosecond timestamp given as a decimal string or number. */
export function nanosToSeconds(v: unknown): number | null {
  let secs: number | null = null;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    secs = v.length > 9 ? Number(v.slice(0, -9)) : 0;
  } else if (typeof v === 'number' && Number.isFinite(v)) {
    secs = Math.floor(v / 1e9);
  }
  return secs !== null && secs >= TS_MIN && secs <= TS_MAX ? secs : null;
}

function isoSeconds(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const s = Math.floor(ms / 1000);
  return s >= TS_MIN && s <= TS_MAX ? s : null;
}

/** `api_request`, `api_error`, ... from either the event.name attribute or the body. */
function eventName(rec: Record<string, unknown>, a: Attrs): string | null {
  const fromAttr = a.get('event.name');
  const body = isObj(rec.body) ? scalar(rec.body as AnyValue) : null;
  const raw = typeof fromAttr === 'string' ? fromAttr : typeof body === 'string' ? body : null;
  return raw ? raw.replace(/^claude_code\./, '') : null;
}

function recordTs(rec: Record<string, unknown>, a: Attrs, now: number): number {
  return nanosToSeconds(rec.timeUnixNano) ?? nanosToSeconds(rec.observedTimeUnixNano) ?? isoSeconds(a.get('event.timestamp')) ?? now;
}

function liveRequest(a: Attrs, ts: number): LiveRequest | null {
  const requestId = str(a, 'request_id', LIMITS.requestId) ?? str(a, 'client_request_id', LIMITS.requestId);
  if (!requestId) return null;
  const creation = countAttr(a, 'cache_creation_tokens');
  let w5 = countAttr(a, 'cache_creation_5m_tokens');
  let w1 = countAttr(a, 'cache_creation_1h_tokens');
  if (w5 === null && w1 === null && creation !== null) {
    // No split reported: treat all cache writes as 5-minute (the default TTL).
    w5 = creation;
    w1 = 0;
  }
  let cost = numAttr(a, 'cost_usd');
  if (cost === null) {
    const micros = numAttr(a, 'cost_usd_micros');
    cost = micros === null ? null : micros / 1e6;
  }
  if (cost !== null && (cost < 0 || cost > 1e6)) cost = null;
  return {
    requestId,
    ts,
    sessionId: str(a, 'session.id', LIMITS.sessionId),
    model: str(a, 'model', LIMITS.model),
    input: countAttr(a, 'input_tokens'),
    output: countAttr(a, 'output_tokens'),
    cacheRead: countAttr(a, 'cache_read_tokens'),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    costUsd: cost,
    durationMs: countAttr(a, 'duration_ms'),
    ttftMs: countAttr(a, 'ttft_ms'),
    speed: str(a, 'speed', LIMITS.speed),
    effort: str(a, 'effort', LIMITS.effort),
    querySource: str(a, 'query_source', LIMITS.querySource),
  };
}

export function parseOtlpLogs(body: unknown, now: number): OtlpParseResult {
  const out: OtlpParseResult = { requests: [], limitHits: [], records: 0, invalid: 0 };
  if (!isObj(body)) return out;
  const seenRequests = new Set<string>();
  const seenHits = new Set<number>();
  for (const rl of list(body.resourceLogs)) {
    if (!isObj(rl)) continue;
    for (const sl of list(rl.scopeLogs)) {
      if (!isObj(sl)) continue;
      for (const rec of list(sl.logRecords)) {
        if (!isObj(rec)) continue;
        out.records++;
        const a = attrMap(rec.attributes);
        const name = eventName(rec, a);
        if (name === 'api_request') {
          const r = liveRequest(a, recordTs(rec, a, now));
          if (!r) out.invalid++;
          else if (!seenRequests.has(r.requestId)) {
            seenRequests.add(r.requestId);
            out.requests.push(r);
          }
        } else if (name === 'api_error' && numAttr(a, 'status_code') === 429) {
          const ts = roundToMinute(recordTs(rec, a, now));
          if (!seenHits.has(ts)) {
            seenHits.add(ts);
            out.limitHits.push({ ts, kind: 'unknown', resetsAt: null });
          }
        }
      }
    }
  }
  return out;
}
