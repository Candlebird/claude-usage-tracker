import { describe, expect, it } from 'vitest';
import { ancestors, cleanPath, createProjectResolver, findGitRoot, labelProjects, projectRefFromPath } from '../src/projects.js';

describe('cleanPath / projectRefFromPath', () => {
  it('normalizes slashes, drive case and trailing separators', () => {
    expect(cleanPath('C:\\Users\\dev\\Repo\\')).toBe('c:/Users/dev/Repo');
    expect(cleanPath('C:\\')).toBe('c:/');
    expect(cleanPath('/home/dev//repo/')).toBe('/home/dev/repo');
    expect(cleanPath('\\\\server\\share\\x')).toBe('//server/share/x');
  });

  it('lowercases Windows keys but keeps display casing; POSIX keys keep case', () => {
    expect(projectRefFromPath('C:\\Work\\MyApp')).toEqual({ key: 'c:/work/myapp', path: 'c:/Work/MyApp' });
    expect(projectRefFromPath('/home/dev/MyApp')).toEqual({ key: '/home/dev/MyApp', path: '/home/dev/MyApp' });
  });
});

describe('git root mapping', () => {
  it('lists ancestors deepest first', () => {
    expect(ancestors('c:/a/b')).toEqual(['c:/a/b', 'c:/a', 'c:/']);
    expect(ancestors('/a/b')).toEqual(['/a/b', '/a', '/']);
  });

  it('maps a subdirectory cwd to the deepest ancestor with .git', () => {
    const exists = (p: string) => p === 'c:/work/repo/.git' || p === 'c:/work/repo/nested/.git';
    expect(findGitRoot('c:/work/repo/src/deep', exists)).toBe('c:/work/repo');
    expect(findGitRoot('c:/work/repo/nested/x', exists)).toBe('c:/work/repo/nested');
    expect(findGitRoot('c:/elsewhere', exists)).toBeNull();
    const resolve = createProjectResolver(exists);
    expect(resolve('C:\\work\\repo\\src')).toEqual({ key: 'c:/work/repo', path: 'c:/work/repo' });
    expect(resolve('C:\\Elsewhere\\X')).toEqual({ key: 'c:/elsewhere/x', path: 'c:/Elsewhere/X' });
  });
});

describe('labelProjects', () => {
  it('uses the last segment and adds parents only for collisions (case-insensitive)', () => {
    const refs = ['c:/a/x/app', 'c:/b/x/App', 'c:/c/tool', 'c:/d/y/app'].map(projectRefFromPath);
    const labels = labelProjects(refs);
    expect(labels.get('c:/c/tool')).toBe('tool');
    expect(labels.get('c:/d/y/app')).toBe('y/app');
    // x/app vs x/App still collide, so a third segment is added.
    expect(labels.get('c:/a/x/app')).toBe('a/x/app');
    expect(labels.get('c:/b/x/app')).toBe('b/x/App');
  });
});
