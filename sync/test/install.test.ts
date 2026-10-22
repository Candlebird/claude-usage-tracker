import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mask,
  type Executor,
  type InstallDeps,
  type Prompter,
  TASK_EXECUTE,
  parseInstallArgs,
  psQuote,
  registerTaskScript,
  runInstall,
  runUninstall,
  setEnvScript,
  statuslineCommand,
  taskArguments,
} from '../src/install.js';

// Synthetic paths; nothing here touches the real machine.
const paths = {
  ccuHome: 'X:\\home\\.claude-usage',
  claudeDir: 'X:\\home\\.claude',
  nodePath: 'X:\\Program Files\\nodejs\\node.exe',
  distDir: 'X:\\repo\\sync\\dist',
};
const SETTINGS = join(paths.claudeDir, 'settings.json');
const CONFIG = join(paths.ccuHome, 'config.json');
const TOKEN = 'wt_synthetic_token_123456';

/** In-memory machine: files, user env vars and the one scheduled task. */
function fakeMachine(files: Record<string, string> = {}) {
  const fs = new Map(Object.entries(files));
  const env = new Map<string, string>();
  let task: string | null = null;
  const scripts: string[] = [];
  const exec: Executor = {
    readFile: async (p) => fs.get(p) ?? null,
    writeFile: async (p, c) => void fs.set(p, c),
    copyFile: async (a, b) => void fs.set(b, fs.get(a) ?? ''),
    removeFile: async (p) => void fs.delete(p),
    powershell: async (script) => {
      scripts.push(script);
      if (script.includes('Get-ScheduledTask') && script.includes('Write-Output')) {
        return { code: 0, stdout: task ? `${task}\r\n` : '', stderr: '' };
      }
      if (script.includes('Register-ScheduledTask')) {
        task = `${TASK_EXECUTE}|${taskArguments(paths)}`;
      } else if (script.includes('Unregister-ScheduledTask')) {
        task = null;
      } else if (script.includes('GetEnvironmentVariable')) {
        return { code: 0, stdout: JSON.stringify(Object.fromEntries(env)), stderr: '' };
      } else if (script.includes('SetEnvironmentVariable')) {
        for (const m of script.matchAll(/SetEnvironmentVariable\('([^']+)', (\$null|'((?:[^']|'')*)'), 'User'\)/g)) {
          if (m[2] === '$null') env.delete(m[1]!);
          else env.set(m[1]!, m[3]!.replace(/''/g, "'"));
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { fs, env, scripts, exec, task: () => task };
}

function deps(m: ReturnType<typeof fakeMachine>, answers: string[] = []): { d: Partial<InstallDeps>; out: string[]; asked: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  const prompt: Prompter = {
    ask: async (q, def) => {
      asked.push(q);
      return answers.shift() || def || '';
    },
    confirm: async (q) => {
      asked.push(q);
      return answers.shift() === 'y';
    },
    close: () => {},
  };
  return {
    d: {
      exec: m.exec,
      prompt,
      paths,
      log: (l) => out.push(l),
      now: () => new Date(2026, 9, 22, 13, 5, 9),
      defaultTz: 'America/Denver',
      defaultDevice: 'test-pc',
    },
    out,
    asked,
  };
}

const flags = ['--api-url', 'https://api.example.test/', '--write-token', TOKEN, '--yes'];

describe('parseInstallArgs', () => {
  it('parses flags', () => {
    const f = parseInstallArgs(['--yes', '--dry-run', '--api-url=https://x', '--skip-otel', '--cleanup-days', '90']);
    expect(f).toMatchObject({ yes: true, dryRun: true, apiUrl: 'https://x', cleanupDays: 90 });
    expect([...f.skip]).toEqual(['otel']);
    expect(() => parseInstallArgs(['--bogus'])).toThrow(/Unknown option/);
    expect(() => parseInstallArgs(['--cleanup-days', 'x'])).toThrow();
  });
});

describe('scripts', () => {
  it('quotes PowerShell strings', () => {
    expect(psQuote("it's")).toBe("'it''s'");
    expect(setEnvScript({ A: "x'y", B: null })).toContain("SetEnvironmentVariable('A', 'x''y', 'User')");
    expect(setEnvScript({ B: null })).toContain("SetEnvironmentVariable('B', $null, 'User')");
  });

  it('registers a 5-minute hidden task for the current user with absolute node', () => {
    const s = registerTaskScript(paths);
    expect(s).toContain('-RepetitionInterval (New-TimeSpan -Minutes 5)');
    expect(s).toContain('-Hidden');
    expect(s).toContain('-RunLevel Limited');
    expect(s).toContain('WindowsIdentity]::GetCurrent().Name');
    expect(s).toContain(`"${paths.nodePath}" "X:\\repo\\sync\\dist\\cli.js" sync`);
    expect(s).not.toMatch(/RunOnlyIfIdle/);
  });

  it('builds a Git Bash friendly statusline command', () => {
    expect(statuslineCommand(paths)).toBe('"X:/Program Files/nodejs/node.exe" "X:/repo/sync/dist/statusline.js"');
  });
});

describe('runInstall', () => {
  it('installs everything with --yes, preserving other settings keys', async () => {
    const m = fakeMachine({ [SETTINGS]: JSON.stringify({ model: 'opus', hooks: { Stop: [] }, cleanupPeriodDays: 30 }) });
    const { d, out } = deps(m);
    expect(await runInstall(flags, d)).toBe(0);

    const config = JSON.parse(m.fs.get(CONFIG)!);
    expect(config).toEqual({ apiUrl: 'https://api.example.test', writeToken: TOKEN, tz: 'America/Denver', deviceName: 'test-pc' });
    expect(m.task()).toBe(`${TASK_EXECUTE}|${taskArguments(paths)}`);
    expect(m.env.get('OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('https://api.example.test');
    expect(m.env.get('OTEL_EXPORTER_OTLP_HEADERS')).toBe(`Authorization=Bearer ${TOKEN}`);
    expect(m.env.get('CLAUDE_CODE_ENABLE_TELEMETRY')).toBe('1');

    const settings = JSON.parse(m.fs.get(SETTINGS)!);
    expect(settings).toEqual({
      model: 'opus',
      hooks: { Stop: [] },
      cleanupPeriodDays: 3650,
      statusLine: { type: 'command', command: statuslineCommand(paths), padding: 0 },
    });
    expect(m.fs.has(`${SETTINGS}.bak-20261022-130509`)).toBe(true);
    // The token never reaches the log.
    expect(out.join('\n')).not.toContain(TOKEN);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const m = fakeMachine({ [SETTINGS]: '{"model":"opus"}' });
    await runInstall(flags, deps(m).d);
    const snapshot = new Map(m.fs);
    const before = m.scripts.length;
    const { d, out } = deps(m);
    expect(await runInstall(flags, d)).toBe(0);
    expect(m.fs).toEqual(snapshot);
    const newScripts = m.scripts.slice(before);
    expect(newScripts.some((s) => s.includes('Register-ScheduledTask') && !s.includes('Get-'))).toBe(false);
    expect(newScripts.some((s) => s.includes('SetEnvironmentVariable'))).toBe(false);
    expect(out.filter((l) => /already/.test(l))).toHaveLength(5);
  });

  it('dry run changes nothing', async () => {
    const m = fakeMachine({ [SETTINGS]: '{"model":"opus"}' });
    const { d, out } = deps(m);
    expect(await runInstall(['--dry-run'], d)).toBe(0);
    expect([...m.fs.keys()]).toEqual([SETTINGS]);
    expect(m.fs.get(SETTINGS)).toBe('{"model":"opus"}');
    expect(m.scripts.some((s) => /Register-ScheduledTask|SetEnvironmentVariable/.test(s.replace(/Get-ScheduledTask/g, '')))).toBe(false);
    expect(out.filter((l) => l.includes('[dry-run] would'))).toHaveLength(5);
  });

  it('asks y/N for each change and respects no', async () => {
    const m = fakeMachine();
    // prompts: url, token, readToken, tz, device, ntfy; confirms: config y, task n, otel n, statusline y, cleanup n
    const { d, asked } = deps(m, ['https://api.example.test', TOKEN, '', '', '', '', 'y', 'n', 'n', 'y', 'n']);
    expect(await runInstall([], d)).toBe(0);
    expect(asked.filter((q) => q.endsWith('?'))).toHaveLength(5);
    expect(m.fs.has(CONFIG)).toBe(true);
    expect(m.task()).toBeNull();
    expect(m.env.size).toBe(0);
    expect(JSON.parse(m.fs.get(SETTINGS)!)).toEqual({ statusLine: { type: 'command', command: statuslineCommand(paths), padding: 0 } });
  });

  it('refuses to touch invalid settings.json', async () => {
    const m = fakeMachine({ [SETTINGS]: '{ not json' });
    const { d, out } = deps(m);
    expect(await runInstall([...flags, '--skip-task', '--skip-otel'], d)).toBe(0);
    expect(m.fs.get(SETTINGS)).toBe('{ not json');
    expect(out.some((l) => l.includes('not valid JSON'))).toBe(true);
  });

  it('fails without an API URL and token in non-interactive mode', async () => {
    const m = fakeMachine();
    expect(await runInstall(['--yes'], deps(m).d)).toBe(1);
    expect(m.fs.size).toBe(0);
  });
});

describe('runUninstall', () => {
  it('reverses each step, restoring previous values', async () => {
    const original = { model: 'opus', statusLine: { type: 'command', command: 'old' }, cleanupPeriodDays: 30 };
    const m = fakeMachine({ [SETTINGS]: JSON.stringify(original) });
    m.env.set('OTEL_METRICS_EXPORTER', 'console');
    m.env.set('UNRELATED', 'keep');
    await runInstall(flags, deps(m).d);
    expect(m.env.get('OTEL_METRICS_EXPORTER')).toBe('otlp');

    const { d } = deps(m);
    expect(await runUninstall(['--yes', '--purge'], d)).toBe(0);
    expect(m.task()).toBeNull();
    expect(Object.fromEntries(m.env)).toEqual({ OTEL_METRICS_EXPORTER: 'console', UNRELATED: 'keep' });
    expect(JSON.parse(m.fs.get(SETTINGS)!)).toEqual(original);
    expect(m.fs.has(CONFIG)).toBe(false);
  });

  it('leaves a statusLine it did not write', async () => {
    const m = fakeMachine({ [SETTINGS]: JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }) });
    expect(await runUninstall(['--yes'], deps(m).d)).toBe(0);
    expect(JSON.parse(m.fs.get(SETTINGS)!)).toEqual({ statusLine: { type: 'command', command: 'mine' } });
  });
});

describe('review fixes', () => {
  it('rejects a non-localhost http API URL but accepts http://localhost', async () => {
    const m = fakeMachine();
    const { d, out } = deps(m);
    expect(await runInstall(['--api-url', 'http://api.example.test', '--write-token', TOKEN, '--yes'], d)).toBe(1);
    expect(m.fs.has(CONFIG)).toBe(false);
    expect(out.some((l) => /invalid config: .*https/.test(l))).toBe(true);

    const m2 = fakeMachine();
    expect(await runInstall(['--api-url', 'http://localhost:8787', '--write-token', TOKEN, '--yes', '--skip-task', '--skip-otel'], deps(m2).d)).toBe(0);
    expect(JSON.parse(m2.fs.get(CONFIG)!).apiUrl).toBe('http://localhost:8787');
  });

  it('rejects an unknown timezone', async () => {
    const m = fakeMachine();
    expect(await runInstall([...flags, '--tz', 'Mars/Olympus'], deps(m).d)).toBe(1);
    expect(m.fs.has(CONFIG)).toBe(false);
  });

  it('asks for tokens through the hidden-input prompt and never shows an existing one in full', async () => {
    const m = fakeMachine();
    m.fs.set(CONFIG, JSON.stringify({ apiUrl: 'https://api.example.test', writeToken: TOKEN, tz: 'UTC', deviceName: 'test-pc' }));
    // asks: url, tz, device (blank keeps the old value); confirms: config y, the rest n
    const { d, asked } = deps(m, ['', '', '', 'y', 'n', 'n', 'n', 'n']);
    const secrets: { q: string; hint?: string }[] = [];
    d.prompt!.askSecret = async (q, hint) => {
      secrets.push({ q, ...(hint ? { hint } : {}) });
      return q.startsWith('Read token') ? 'rt_synthetic_typed_123456' : '';
    };
    expect(await runInstall([], d)).toBe(0);
    expect(secrets.map((x) => x.q.split(' ')[0])).toEqual(['Write', 'Read', 'ntfy']);
    expect(secrets[0]!.hint).toBe(mask(TOKEN));
    expect(JSON.stringify([...secrets, ...asked])).not.toContain(TOKEN);
    // A blank answer keeps the existing token; a typed one replaces it.
    expect(JSON.parse(m.fs.get(CONFIG)!)).toMatchObject({ writeToken: TOKEN, readToken: 'rt_synthetic_typed_123456' });
  });

  it('takes tokens from CCU_WRITE_TOKEN / CCU_READ_TOKEN and warns about argv tokens', async () => {
    const m = fakeMachine();
    const { d, out } = deps(m);
    d.env = { CCU_WRITE_TOKEN: TOKEN, CCU_READ_TOKEN: 'rt_synthetic_token_654321' };
    expect(await runInstall(['--api-url', 'https://api.example.test', '--yes', '--skip-task', '--skip-otel'], d)).toBe(0);
    const config = JSON.parse(m.fs.get(CONFIG)!);
    expect(config).toMatchObject({ writeToken: TOKEN, readToken: 'rt_synthetic_token_654321' });
    expect(out.some((l) => /warning/.test(l))).toBe(false);
    expect(out.join('\n')).not.toContain(TOKEN);

    const m2 = fakeMachine();
    const r2 = deps(m2);
    await runInstall(flags, r2.d);
    expect(r2.out.some((l) => /warning: --write-token/.test(l))).toBe(true);
  });

  it('restores the statusLine after node / dist moved', async () => {
    const original = { statusLine: { type: 'command', command: 'old' } };
    const m = fakeMachine({ [SETTINGS]: JSON.stringify(original) });
    await runInstall([...flags, '--skip-task', '--skip-otel'], deps(m).d);
    const moved = deps(m);
    moved.d.paths = { ...paths, nodePath: 'X:\nvm\v24\node.exe', distDir: 'X:\elsewhere\dist' };
    expect(await runUninstall(['--yes', '--skip-task', '--skip-otel'], moved.d)).toBe(0);
    expect(JSON.parse(m.fs.get(SETTINGS)!)).toMatchObject(original);
  });

  it('records the statusLine command for installs whose settings were already up to date', async () => {
    const MANIFEST_PATH = join(paths.ccuHome, 'install.json');
    const m = fakeMachine({ [SETTINGS]: JSON.stringify({ statusLine: { type: 'command', command: statuslineCommand(paths), padding: 0 } }) });
    await runInstall([...flags, '--skip-task', '--skip-otel', '--skip-cleanup'], deps(m).d);
    expect(JSON.parse(m.fs.get(MANIFEST_PATH)!).settingsBefore.statusLineCommand).toBe(statuslineCommand(paths));
  });

  it('--purge removes config, manifest, state, cache, limits and lock', async () => {
    const m = fakeMachine();
    await runInstall([...flags, '--skip-task', '--skip-otel'], deps(m).d);
    for (const f of ['state.json', 'cache.json', 'limits.json', 'sync.lock']) m.fs.set(join(paths.ccuHome, f), '{}');
    expect(await runUninstall(['--yes', '--purge'], deps(m).d)).toBe(0);
    expect([...m.fs.keys()].filter((k) => k.startsWith(paths.ccuHome))).toEqual([]);
  });
});
