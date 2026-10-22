import type { SessionSort } from '@ccu/shared';

export const PAGE_SIZE = 25;

export interface SessionsQuery {
  project: string | null;
  sort: SessionSort;
  /** 1-based. */
  page: number;
}

/** Reads the Sessions list state from the hash query (`?project=&sort=cost&page=2`). */
export function readSessionsQuery(q: URLSearchParams): SessionsQuery {
  const page = Number.parseInt(q.get('page') ?? '', 10);
  return {
    project: q.get('project') || null,
    sort: q.get('sort') === 'cost' ? 'cost' : 'recent',
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

export interface PageInfo {
  page: number;
  pages: number;
  first: number;
  last: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Page math for `total` rows; `first`/`last` are 1-based row numbers (0 when empty). */
export function pageInfo(total: number, page: number, size = PAGE_SIZE): PageInfo {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pages);
  const first = total === 0 ? 0 : (p - 1) * size + 1;
  return { page: p, pages, first, last: Math.min(total, p * size), hasPrev: p > 1, hasNext: p < pages };
}

/** Case-insensitive match on title, project, branch, model ids and session id. */
export function matchesSession(
  s: { title: string | null; projectLabel: string; gitBranch: string | null; models: readonly string[]; sessionId: string },
  needle: string,
  modelName: (m: string) => string = (m) => m,
): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  const hay = [s.title ?? '', s.projectLabel, s.gitBranch ?? '', s.sessionId, ...s.models, ...s.models.map(modelName)].join('\n').toLowerCase();
  return hay.includes(n);
}

/** Display title; untitled sessions show a short id so rows stay distinguishable. */
export function sessionTitle(s: { title: string | null; sessionId: string }): string {
  return s.title?.trim() || `Untitled · ${s.sessionId.slice(0, 8)}`;
}
