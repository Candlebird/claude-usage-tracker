import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STRING_LIMITS, validateUsageIngest } from '@ccu/shared';
import { buildBuckets, buildProjects, buildSessions } from '../src/aggregate.js';
import { safeId, UNKNOWN_ID } from '../src/normalize.js';
import { emptyState } from '../src/state.js';
import { scanTranscripts } from '../src/transcripts.js';
import { assistantLine, emptyProjectsDir, fakeResolver } from './helpers.js';

describe('safeId', () => {
  it('trims, falls back when empty, and keeps distinct long ids distinct within the limit', () => {
    expect(safeId('  abc ', 10)).toBe('abc');
    expect(safeId('   ', 10)).toBe(UNKNOWN_ID);
    expect(safeId(null, 10)).toBe(UNKNOWN_ID);
    const a = safeId('x'.repeat(300) + 'a', 100);
    const b = safeId('x'.repeat(300) + 'b', 100);
    expect(a.length).toBeLessThanOrEqual(100);
    expect(a).not.toBe(b);
    expect(safeId(a, 100)).toBe(a); // idempotent
  });
});

describe('ingest normalization', () => {
  it('turns overlong or missing identifiers into rows the shared validator accepts', () => {
    const root = emptyProjectsDir();
    const dir = join(root, 'C--work-weird');
    mkdirSync(dir, { recursive: true });
    const longSid = 's'.repeat(150);
    const lines =
      assistantLine({ id: 'm1', ts: '2026-01-15T10:00:00Z', output: 5, sessionId: longSid, cwd: 'C:/deep/' +'d'.repeat(400), model: 'm'.repeat(150) }) +
      // no cwd at all: the session has no project
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-nocwd',
        requestId: 'req_m2',
        timestamp: '2026-01-15T10:05:00Z',
        message: { id: 'm2', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } },
      }) +
      '\n';
    writeFileSync(join(dir, 'sess-nocwd.jsonl'), lines);
    const state = emptyState();
    scanTranscripts(root, state, { resolveProject: fakeResolver(), now: 1 });

    const buckets = [...buildBuckets(state).values()];
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b.project.length).toBeLessThanOrEqual(STRING_LIMITS.project);
      expect(b.model.length).toBeLessThanOrEqual(STRING_LIMITS.model);
      expect(b.sessionId.length).toBeLessThanOrEqual(STRING_LIMITS.sessionId);
    }
    expect(buckets.find((b) => b.sessionId === 'sess-nocwd')!.project).toBe(UNKNOWN_ID);
    const v = validateUsageIngest({ device: 'dev', version: '1', buckets, sessions: buildSessions(state), projects: buildProjects(state) });
    expect(v.ok ? null : v.error).toBeNull();
  });
});
