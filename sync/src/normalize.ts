// Clamps identifiers that become bucket/session keys so every row passes the shared ingest
// validator. Done at ingest time: bucket ids embed these strings, so normalizing later would make
// upload hashes disagree with rebuilt ids.
import { createHash } from 'node:crypto';
import { STRING_LIMITS } from '@ccu/shared';

export const UNKNOWN_ID = 'unknown';

/**
 * Trimmed, non-empty and at most `max` chars. Overlong values keep a readable prefix plus a hash
 * of the full value, so distinct long ids stay distinct.
 */
export function safeId(raw: string | null | undefined, max: number, fallback = UNKNOWN_ID): string {
  const s = (raw ?? '').trim();
  if (!s) return fallback;
  if (s.length <= max) return s;
  const h = createHash('sha1').update(s).digest('hex').slice(0, 16);
  return `${s.slice(0, max - h.length - 1).trimEnd()}~${h}`;
}

export const safeProject = (s: string | null | undefined) => safeId(s, STRING_LIMITS.project);
export const safeModel = (s: string | null | undefined) => safeId(s, STRING_LIMITS.model);
export const safeSessionId = (s: string | null | undefined) => safeId(s, STRING_LIMITS.sessionId);
