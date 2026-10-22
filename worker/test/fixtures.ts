// Synthetic payloads only. Nothing here comes from real transcripts or exports.
import type { HourlyBucket, UsageIngest } from '@ccu/shared';

/** 1800000123 s, with more digits than a double holds exactly. */
export const T_NANOS = '1800000123456789012';
export const HOUR0 = 1_800_000_000 - (1_800_000_000 % 3600);

type Val = string | number | boolean;

export function attrs(o: Record<string, Val>) {
  return Object.entries(o).map(([key, v]) => ({
    key,
    value:
      typeof v === 'string' ? { stringValue: v }
      : typeof v === 'boolean' ? { boolValue: v }
      : Number.isInteger(v) ? { intValue: String(v) }
      : { doubleValue: v },
  }));
}

export function otlpPayload(records: unknown[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: attrs({ 'service.name': 'claude-code' }) },
        scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: records }],
      },
    ],
  };
}

export function apiRequest(over: Record<string, Val> = {}, timeUnixNano = T_NANOS) {
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    body: { stringValue: 'claude_code.api_request' },
    attributes: attrs({
      'event.name': 'api_request',
      'session.id': 'sess-synthetic-1',
      request_id: 'req_synthetic_1',
      model: 'claude-test-model',
      input_tokens: 12,
      output_tokens: 345,
      cache_read_tokens: 6789,
      cache_creation_tokens: 300,
      cache_creation_5m_tokens: 100,
      cache_creation_1h_tokens: 200,
      cost_usd: 0.0123,
      duration_ms: 4567,
      ttft_ms: 890,
      speed: 'normal',
      effort: 'high',
      query_source: 'repl_main_thread',
      ...over,
    }),
  };
}

export function apiError(status: Val, timeUnixNano: string) {
  return {
    timeUnixNano,
    body: { stringValue: 'claude_code.api_error' },
    attributes: attrs({ 'event.name': 'api_error', status_code: status, error: 'synthetic' }),
  };
}

export function bucket(i: number, over: Partial<HourlyBucket> = {}): HourlyBucket {
  return {
    hour: HOUR0 - (i % 48) * 3600,
    project: 'c:/synthetic/project-a',
    model: 'claude-test-model',
    agentKind: 'main',
    sessionId: `sess-${i}`,
    requests: 2,
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite5m: 40,
    cacheWrite1h: 50,
    webSearch: 0,
    costUsd: 0.5,
    ...over,
  };
}

export function usageIngest(over: Partial<UsageIngest> = {}): UsageIngest {
  return { device: 'test-device', version: '2.0.0-test', buckets: [bucket(0), bucket(1)], ...over };
}
