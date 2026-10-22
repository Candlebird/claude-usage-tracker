import { describe, expect, it } from 'vitest';
import { nanosToSeconds, parseOtlpLogs } from '../src/otlp.js';
import { apiError, apiRequest, otlpPayload, T_NANOS } from './fixtures.js';

const NOW = 1_800_000_000;

describe('parseOtlpLogs', () => {
  it('maps an api_request event to a live request', () => {
    const r = parseOtlpLogs(otlpPayload([apiRequest()]), NOW);
    expect(r.records).toBe(1);
    expect(r.invalid).toBe(0);
    expect(r.requests).toEqual([
      {
        requestId: 'req_synthetic_1',
        ts: 1_800_000_123,
        sessionId: 'sess-synthetic-1',
        model: 'claude-test-model',
        input: 12,
        output: 345,
        cacheRead: 6789,
        cacheWrite5m: 100,
        cacheWrite1h: 200,
        costUsd: 0.0123,
        durationMs: 4567,
        ttftMs: 890,
        speed: 'normal',
        effort: 'high',
        querySource: 'repl_main_thread',
      },
    ]);
  });

  it('falls back for the missing split, cost, request id and timestamp', () => {
    const rec = {
      body: { stringValue: 'claude_code.api_request' },
      attributes: [
        { key: 'client_request_id', value: { stringValue: 'client-req-2' } },
        { key: 'cache_creation_tokens', value: { intValue: 50 } },
        { key: 'cost_usd_micros', value: { intValue: '2500' } },
        { key: 'event.timestamp', value: { stringValue: '2027-01-15T08:02:03Z' } },
      ],
    };
    const [r] = parseOtlpLogs(otlpPayload([rec]), NOW).requests;
    expect(r!.requestId).toBe('client-req-2');
    expect(r!.cacheWrite5m).toBe(50);
    expect(r!.cacheWrite1h).toBe(0);
    expect(r!.costUsd).toBeCloseTo(0.0025);
    expect(r!.ts).toBe(Math.floor(Date.parse('2027-01-15T08:02:03Z') / 1000));
    expect(r!.input).toBeNull();
  });

  it('uses now when no timestamp is usable', () => {
    const rec = { body: { stringValue: 'api_request' }, attributes: [{ key: 'request_id', value: { stringValue: 'r' } }] };
    expect(parseOtlpLogs(otlpPayload([rec]), NOW).requests[0]!.ts).toBe(NOW);
  });

  it('clamps and rounds counts', () => {
    const rec = apiRequest({ input_tokens: -5, output_tokens: 2.6 });
    const [r] = parseOtlpLogs(otlpPayload([rec]), NOW).requests;
    expect(r!.input).toBe(0);
    expect(r!.output).toBe(3);
  });

  it('ignores noise events and dedupes request ids', () => {
    const noise = { timeUnixNano: T_NANOS, body: { stringValue: 'claude_code.tool_result' }, attributes: [] };
    const r = parseOtlpLogs(otlpPayload([noise, apiRequest(), apiRequest(), { attributes: 'bad' }, 42]), NOW);
    expect(r.records).toBe(4);
    expect(r.requests).toHaveLength(1);
  });

  it('counts api_request records without an id as invalid', () => {
    const rec = { body: { stringValue: 'claude_code.api_request' }, attributes: [{ key: 'model', value: { stringValue: 'x' } }] };
    const r = parseOtlpLogs(otlpPayload([rec]), NOW);
    expect(r.requests).toHaveLength(0);
    expect(r.invalid).toBe(1);
  });

  it('turns api_error 429 into one limit hit per minute and ignores other errors', () => {
    const r = parseOtlpLogs(otlpPayload([apiError(429, T_NANOS), apiError('429', '1800000140000000000'), apiError(500, T_NANOS)]), NOW);
    expect(r.limitHits).toEqual([{ ts: 1_800_000_120, kind: 'unknown', resetsAt: null }]);
    expect(r.requests).toHaveLength(0);
  });

  it('tolerates junk input', () => {
    expect(parseOtlpLogs(null, NOW).records).toBe(0);
    expect(parseOtlpLogs({ resourceLogs: 'x' }, NOW).records).toBe(0);
    expect(parseOtlpLogs({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] }, NOW)).toMatchObject({ records: 1, requests: [] });
  });
});

describe('nanosToSeconds', () => {
  it('handles strings beyond 2^53 and rejects nonsense', () => {
    expect(nanosToSeconds(T_NANOS)).toBe(1_800_000_123);
    expect(nanosToSeconds(1.8e18)).toBe(1_800_000_000);
    expect(nanosToSeconds('0')).toBeNull();
    expect(nanosToSeconds('12abc')).toBeNull();
    expect(nanosToSeconds(undefined)).toBeNull();
  });
});
