import { describe, expect, it } from 'vitest';
import { matchesSession, pageInfo, PAGE_SIZE, readSessionsQuery, sessionTitle } from './sessionsQuery';

describe('readSessionsQuery', () => {
  it('defaults to recent, page 1, no project', () => {
    expect(readSessionsQuery(new URLSearchParams())).toEqual({ project: null, sort: 'recent', page: 1 });
  });

  it('reads project, sort and page', () => {
    expect(readSessionsQuery(new URLSearchParams('project=c%3A%2Fdev%2Fx&sort=cost&page=3'))).toEqual({ project: 'c:/dev/x', sort: 'cost', page: 3 });
  });

  it('ignores bad values', () => {
    expect(readSessionsQuery(new URLSearchParams('sort=nope&page=-2'))).toMatchObject({ sort: 'recent', page: 1 });
    expect(readSessionsQuery(new URLSearchParams('page=abc')).page).toBe(1);
  });
});

describe('pageInfo', () => {
  it('describes a middle page', () => {
    expect(pageInfo(60, 2, 25)).toEqual({ page: 2, pages: 3, first: 26, last: 50, hasPrev: true, hasNext: true });
  });

  it('clamps past the last page and handles a partial last page', () => {
    expect(pageInfo(60, 9, 25)).toMatchObject({ page: 3, first: 51, last: 60, hasNext: false });
  });

  it('handles no rows', () => {
    expect(pageInfo(0, 1)).toEqual({ page: 1, pages: 1, first: 0, last: 0, hasPrev: false, hasNext: false });
  });

  it('uses the default page size', () => {
    expect(pageInfo(PAGE_SIZE + 1, 1).pages).toBe(2);
  });
});

describe('matchesSession', () => {
  const s = { title: 'Fix login flow', projectLabel: 'lumen-web', gitBranch: 'feat/auth', models: ['claude-sonnet-4-5'], sessionId: 'abc12345-0000' };

  it('matches title, branch, project, id and model names case-insensitively', () => {
    for (const n of ['LOGIN', 'feat/', 'lumen', 'abc123', 'sonnet']) expect(matchesSession(s, n)).toBe(true);
    expect(matchesSession(s, 'pretty', () => 'Pretty Name')).toBe(true);
    expect(matchesSession(s, 'orbit')).toBe(false);
  });

  it('treats a blank needle as a match', () => {
    expect(matchesSession(s, '  ')).toBe(true);
  });
});

describe('sessionTitle', () => {
  it('falls back to a short id', () => {
    expect(sessionTitle({ title: null, sessionId: '0123456789' })).toBe('Untitled · 01234567');
    expect(sessionTitle({ title: '  ', sessionId: 'abcdefghij' })).toBe('Untitled · abcdefgh');
    expect(sessionTitle({ title: 'Hello', sessionId: 'x' })).toBe('Hello');
  });
});
