import { existsSync } from 'node:fs';

/** A project identity derived from a transcript `cwd`. */
export interface ProjectRef {
  /** Stable key: forward slashes, no trailing slash, lowercased for Windows drive paths. */
  key: string;
  /** Display path: same as key but with the original casing. */
  path: string;
}

const DRIVE = /^[a-zA-Z]:/;

/** Forward slashes, collapsed separators, no trailing slash (except a root like `c:/` or `/`). */
export function cleanPath(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  const unc = s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/');
  if (unc) s = '/' + s;
  if (DRIVE.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  if (/^[a-z]:$/.test(s)) s += '/';
  return s;
}

/** Windows paths are case-insensitive, so their key is lowercased; POSIX paths keep case. */
export function projectRefFromPath(p: string): ProjectRef {
  const path = cleanPath(p);
  const windows = DRIVE.test(path) || path.startsWith('//');
  return { key: windows ? path.toLowerCase() : path, path };
}

/** Ancestors of a cleaned path, deepest first, including the path itself. */
export function ancestors(path: string): string[] {
  const out: string[] = [path];
  let cur = path;
  for (;;) {
    const i = cur.lastIndexOf('/');
    if (i < 0) break;
    let parent = cur.slice(0, i);
    if (parent === '') parent = '/';
    else if (/^[a-z]:$/i.test(parent)) parent += '/';
    if (parent === cur) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** Deepest ancestor (or the path itself) holding a `.git` entry, or null. */
export function findGitRoot(path: string, exists: (p: string) => boolean = existsSync): string | null {
  for (const dir of ancestors(path)) {
    if (exists(dir.endsWith('/') ? `${dir}.git` : `${dir}/.git`)) return dir;
  }
  return null;
}

export type ProjectResolver = (cwd: string) => ProjectRef;

/** Maps a cwd to its project (git root when one exists on disk), memoized per cwd. */
export function createProjectResolver(exists: (p: string) => boolean = existsSync): ProjectResolver {
  const cache = new Map<string, ProjectRef>();
  return (cwd: string) => {
    let ref = cache.get(cwd);
    if (!ref) {
      const cleaned = cleanPath(cwd);
      ref = projectRefFromPath(findGitRoot(cleaned, exists) ?? cleaned);
      cache.set(cwd, ref);
    }
    return ref;
  };
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * Display labels: the last path segment; when labels collide (case-insensitively),
 * prepend parent segments until they are unique.
 */
export function labelProjects(projects: readonly ProjectRef[]): Map<string, string> {
  const labels = new Map<string, string>();
  const depth = new Map<string, number>(projects.map((p) => [p.key, 1]));
  const label = (p: ProjectRef) => {
    const segs = segments(p.path);
    const d = Math.min(depth.get(p.key)!, Math.max(1, segs.length));
    return segs.length ? segs.slice(-d).join('/') : p.path;
  };
  for (let round = 0; round < 64; round++) {
    const groups = new Map<string, ProjectRef[]>();
    for (const p of projects) {
      const l = label(p).toLowerCase();
      groups.set(l, [...(groups.get(l) ?? []), p]);
    }
    let changed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const p of group) {
        if (depth.get(p.key)! < segments(p.path).length) {
          depth.set(p.key, depth.get(p.key)! + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (const p of projects) labels.set(p.key, label(p));
  return labels;
}
