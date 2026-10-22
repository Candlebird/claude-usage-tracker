import { homedir } from 'node:os';
import { join } from 'node:path';

/** Local file locations. `claudeDir` can be overridden by config (tests, unusual installs). */
export interface Paths {
  claudeDir: string;
  projectsDir: string;
  credentialsFile: string;
  statsCacheFile: string;
  usageDir: string;
  configFile: string;
  stateFile: string;
  cacheFile: string;
  lockFile: string;
}

export function claudeDir(override?: string | null): string {
  return override || join(homedir(), '.claude');
}

export function usageDir(override?: string | null): string {
  return override || join(homedir(), '.claude-usage');
}

export function resolvePaths(opts: { claudeDir?: string | null; usageDir?: string | null } = {}): Paths {
  const claude = claudeDir(opts.claudeDir);
  const usage = usageDir(opts.usageDir);
  return {
    claudeDir: claude,
    projectsDir: join(claude, 'projects'),
    credentialsFile: join(claude, '.credentials.json'),
    statsCacheFile: join(claude, 'stats-cache.json'),
    usageDir: usage,
    configFile: join(usage, 'config.json'),
    stateFile: join(usage, 'state.json'),
    cacheFile: join(usage, 'cache.json'),
    lockFile: join(usage, 'sync.lock'),
  };
}
