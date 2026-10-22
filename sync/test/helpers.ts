import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectResolver } from '../src/projects.js';

export const FIXTURE_PROJECTS = fileURLToPath(new URL('./fixtures/projects', import.meta.url));

/** A writable copy of the synthetic projects tree. */
export function copyFixtures(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ccu-sync-')), 'projects');
  cpSync(FIXTURE_PROJECTS, dir, { recursive: true });
  return dir;
}

export function emptyProjectsDir(): string {
  return mkdtempSync(join(tmpdir(), 'ccu-sync-empty-'));
}

/** Resolver that only knows the synthetic git root `c:/work/alpha`. */
export const fakeResolver = () => createProjectResolver((p) => p === 'c:/work/alpha/.git');

export const iso = (s: string) => Math.floor(Date.parse(s) / 1000);

/** One synthetic assistant line (with trailing newline). */
export function assistantLine(o: {
  id: string;
  ts: string;
  output: number;
  input?: number;
  final?: boolean;
  sessionId?: string;
  cwd?: string;
  model?: string;
  pad?: string;
}): string {
  return (
    JSON.stringify({
      type: 'assistant',
      sessionId: o.sessionId ?? 'sess-t',
      requestId: `req_${o.id}`,
      timestamp: o.ts,
      cwd: o.cwd ?? 'C:\\work\\alpha',
      pad: o.pad,
      message: {
        id: o.id,
        model: o.model ?? 'claude-sonnet-4-5',
        stop_reason: o.final === false ? null : 'end_turn',
        usage: { input_tokens: o.input ?? 1, output_tokens: o.output },
      },
    }) + '\n'
  );
}
