import { afterEach, describe, expect, it } from 'vitest';
import { isDemoMode } from '../src/connection';
import { href, matchPath, parseHash, setQuery } from '../src/router';

afterEach(() => window.history.replaceState(null, '', '/'));

describe('router', () => {
  it('parses hashes', () => {
    expect(parseHash('').path).toBe('/');
    expect(parseHash('#/').path).toBe('/');
    const r = parseHash('#/sessions/abc%20d/?sort=cost');
    expect(r.path).toBe('/sessions/abc%20d');
    expect(r.segments).toEqual(['sessions', 'abc d']);
    expect(r.query.get('sort')).toBe('cost');
  });

  it('builds hrefs and drops empty params', () => {
    expect(href('/projects')).toBe('#/projects');
    expect(href('sessions', { project: 'p1', sort: null, x: '' })).toBe('#/sessions?project=p1');
  });

  it('matches patterns', () => {
    expect(matchPath('/sessions/:id', '/sessions/a%2Fb')).toEqual({ id: 'a/b' });
    expect(matchPath('/sessions/:id', '/sessions')).toBeNull();
    expect(matchPath('/sessions/:id', '/projects/x')).toBeNull();
    expect(matchPath('/limits', '/limits')).toEqual({});
  });

  it('carries a hash demo flag through links and query updates', () => {
    window.history.replaceState(null, '', '/#/?demo');
    expect(href('/projects')).toBe('#/projects?demo=');
    expect(href('/sessions', { project: 'p1' })).toBe('#/sessions?project=p1&demo=');
    window.location.hash = href('/limits');
    setQuery({ project: 'p2' });
    expect(isDemoMode(window.location)).toBe(true);
    setQuery({ project: null });
    expect(isDemoMode(window.location)).toBe(true);
  });

  it('adds no demo flag outside hash demo mode', () => {
    window.history.replaceState(null, '', '/?demo#/');
    expect(href('/projects')).toBe('#/projects');
  });
});
