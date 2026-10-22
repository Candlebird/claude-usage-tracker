// `ccu install` / `ccu uninstall`: step-by-step, confirmed, idempotent setup.
// Every system effect goes through an injected Executor so tests never touch the real machine.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { validateConfig, type Config } from '@ccu/shared';

export const TASK_NAME = 'ClaudeUsageSync';
export const DEFAULT_CLEANUP_DAYS = 3650;
const MANIFEST = 'install.json';

// --- injectable effects -------------------------------------------------------

export interface PsResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Executor {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** Runs a PowerShell script fed via stdin (keeps secrets out of argv). */
  powershell(script: string): Promise<PsResult>;
}

export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  close(): void;
}

export interface InstallPaths {
  /** ~/.claude-usage */
  ccuHome: string;
  /** ~/.claude */
  claudeDir: string;
  /** Absolute node.exe. */
  nodePath: string;
  /** Directory holding cli.js and statusline.js. */
  distDir: string;
}

export interface InstallDeps {
  exec: Executor;
  prompt: Prompter;
  log: (line: string) => void;
  paths: InstallPaths;
  now: () => Date;
  defaultTz: string;
  defaultDevice: string;
  /** Environment to read CCU_WRITE_TOKEN / CCU_READ_TOKEN from (keeps secrets out of argv). */
  env?: Record<string, string | undefined>;
}

export const WRITE_TOKEN_ENV = 'CCU_WRITE_TOKEN';
export const READ_TOKEN_ENV = 'CCU_READ_TOKEN';
/** Files under ccuHome that `uninstall --purge` removes. */
export const PURGE_FILES = ['config.json', MANIFEST, 'state.json', 'cache.json', 'limits.json', 'sync.lock'] as const;

export const realExecutor: Executor = {
  async readFile(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  },
  async writeFile(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  },
  copyFile: (from, to) => copyFile(from, to),
  removeFile: (path) => rm(path, { force: true }),
  powershell(script) {
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(`${script}\nexit $LASTEXITCODE\n`);
    });
  },
};

export function readlinePrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(q, def) {
      const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
      return a || def || '';
    },
    async confirm(q) {
      const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
      return a === 'y' || a === 'yes';
    },
    close: () => rl.close(),
  };
}

function defaultDeps(): InstallDeps {
  return {
    exec: realExecutor,
    prompt: readlinePrompter(),
    log: (l) => console.log(l),
    paths: {
      ccuHome: process.env['CCU_HOME'] || join(homedir(), '.claude-usage'),
      claudeDir: join(homedir(), '.claude'),
      nodePath: process.execPath,
      distDir: dirname(fileURLToPath(import.meta.url)),
    },
    now: () => new Date(),
    defaultTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultDevice: hostname(),
    env: process.env,
  };
}

// --- args ---------------------------------------------------------------------

export interface InstallFlags {
  yes: boolean;
  dryRun: boolean;
  apiUrl?: string;
  writeToken?: string;
  readToken?: string;
  tz?: string;
  device?: string;
  ntfyTopic?: string;
  cleanupDays: number;
  skip: Set<Step>;
  /** uninstall: also delete config.json. */
  purge: boolean;
}

export type Step = 'config' | 'task' | 'otel' | 'statusline' | 'cleanup';
const STEPS: readonly Step[] = ['config', 'task', 'otel', 'statusline', 'cleanup'];

export function parseInstallArgs(args: string[]): InstallFlags {
  const f: InstallFlags = { yes: false, dryRun: false, cleanupDays: DEFAULT_CLEANUP_DAYS, skip: new Set(), purge: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => inline ?? args[++i] ?? '';
    switch (name) {
      case '-y':
      case '--yes':
        f.yes = true;
        break;
      case '--dry-run':
        f.dryRun = true;
        break;
      case '--purge':
        f.purge = true;
        break;
      case '--api-url':
        f.apiUrl = value();
        break;
      case '--write-token':
        f.writeToken = value();
        break;
      case '--read-token':
        f.readToken = value();
        break;
      case '--tz':
        f.tz = value();
        break;
      case '--device':
        f.device = value();
        break;
      case '--ntfy-topic':
        f.ntfyTopic = value();
        break;
      case '--cleanup-days': {
        const n = Number(value());
        if (Number.isInteger(n) && n > 0) f.cleanupDays = n;
        else throw new Error('--cleanup-days needs a positive integer');
        break;
      }
      default: {
        const step = name.startsWith('--skip-') ? (name.slice(7) as Step) : null;
        if (step && STEPS.includes(step)) f.skip.add(step);
        else throw new Error(`Unknown option: ${a}`);
      }
    }
  }
  return f;
}

// --- helpers --------------------------------------------------------------------

/** Forward slashes, so the path survives Git Bash and cmd alike. */
export function slashPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** PowerShell single-quoted string literal. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function mask(secret: string): string {
  return secret.length <= 8 ? '****' : `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function statuslineCommand(paths: InstallPaths): string {
  return `"${slashPath(paths.nodePath)}" "${slashPath(join(paths.distDir, 'statusline.js'))}"`;
}

/** Arguments for conhost --headless, which runs node without flashing a console window. */
export function taskArguments(paths: InstallPaths): string {
  return `--headless "${paths.nodePath}" "${join(paths.distDir, 'cli.js')}" sync`;
}

export const TASK_EXECUTE = '%SystemRoot%\\System32\\conhost.exe';

export function registerTaskScript(paths: InstallPaths): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$action = New-ScheduledTaskAction -Execute ${psQuote(TASK_EXECUTE)} -Argument ${psQuote(taskArguments(paths))}`,
    `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)`,
    `$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)`,
    `$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Description 'Claude Usage Tracker sync (ccu sync) every 5 minutes' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
    `exit 0`,
  ].join('\n');
}

/** Prints "<Execute>|<Arguments>" of the task's first action, or nothing when absent. */
export function queryTaskScript(): string {
  return [
    `$t = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue`,
    `if ($t) { Write-Output ($t.Actions[0].Execute + '|' + $t.Actions[0].Arguments) }`,
    `exit 0`,
  ].join('\n');
}

export function unregisterTaskScript(): string {
  return [
    `$t = Get-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue`,
    `if ($t) { Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false -ErrorAction Stop }`,
    `exit 0`,
  ].join('\n');
}

export function otelEnv(apiUrl: string, writeToken: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: apiUrl.replace(/\/+$/, ''),
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${writeToken}`,
    OTEL_METRIC_EXPORT_INTERVAL: '60000',
    OTEL_LOGS_EXPORT_INTERVAL: '10000',
  };
}
export const OTEL_ENV_NAMES = Object.keys(otelEnv('', ''));

/** Prints a JSON object of the current User-scope values (missing names are omitted). */
export function readEnvScript(names: string[]): string {
  return [
    `$o = @{}`,
    ...names.map((n) => `$v = [Environment]::GetEnvironmentVariable(${psQuote(n)}, 'User'); if ($null -ne $v) { $o[${psQuote(n)}] = $v }`),
    `$o | ConvertTo-Json -Compress`,
    `exit 0`,
  ].join('\n');
}

/** `null` values delete the variable. */
export function setEnvScript(vars: Record<string, string | null>): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    ...Object.entries(vars).map(
      ([n, v]) => `[Environment]::SetEnvironmentVariable(${psQuote(n)}, ${v === null ? '$null' : psQuote(v)}, 'User')`,
    ),
    `exit 0`,
  ].join('\n');
}

function displayEnvValue(name: string, value: string): string {
  return name === 'OTEL_EXPORTER_OTLP_HEADERS' ? `Authorization=Bearer ${mask(value.replace(/^.*Bearer /, ''))}` : value;
}

// --- settings.json ------------------------------------------------------------

type Json = Record<string, unknown>;

interface Manifest {
  /** Values of settings.json keys before we changed them (undefined = key was absent). */
  settingsBefore?: {
    statusLine?: unknown;
    cleanupPeriodDays?: unknown;
    statusLineSaved?: boolean;
    cleanupSaved?: boolean;
    /** The exact statusLine command we wrote, so uninstall recognises it after node/dist moved. */
    statusLineCommand?: string;
  };
  /** Env vars we set, with their previous values (null = was absent). */
  envBefore?: Record<string, string | null>;
}

async function readJson(exec: Executor, path: string): Promise<Json | null | 'invalid'> {
  const text = await exec.readFile(path);
  if (text === null || !text.trim()) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : 'invalid';
  } catch {
    return 'invalid';
  }
}

class Session {
  constructor(
    readonly deps: InstallDeps,
    readonly flags: InstallFlags,
  ) {}

  log(line: string) {
    this.deps.log(line);
  }

  get settingsPath() {
    return join(this.deps.paths.claudeDir, 'settings.json');
  }
  get configPath() {
    return join(this.deps.paths.ccuHome, 'config.json');
  }
  get manifestPath() {
    return join(this.deps.paths.ccuHome, MANIFEST);
  }

  /** Explicit y/N for every change; --yes accepts; --dry-run only describes. */
  async approve(question: string): Promise<boolean> {
    if (this.flags.dryRun) {
      this.log(`  [dry-run] would: ${question}`);
      return false;
    }
    if (this.flags.yes) return true;
    return this.deps.prompt.confirm(`  ${question}?`);
  }

  async ps(script: string): Promise<PsResult> {
    const r = await this.deps.exec.powershell(script);
    if (r.code !== 0) throw new Error(`PowerShell failed (${r.code}): ${r.stderr.trim().split('\n')[0] ?? ''}`);
    return r;
  }

  async manifest(): Promise<Manifest> {
    const m = await readJson(this.deps.exec, this.manifestPath);
    return m && m !== 'invalid' ? (m as Manifest) : {};
  }

  async saveManifest(m: Manifest) {
    await this.deps.exec.writeFile(this.manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  }

  /** Applies `edit` to settings.json with a timestamped backup; returns false when nothing changed. */
  async editSettings(describe: string, edit: (s: Json) => boolean, unchanged = 'already up to date.'): Promise<boolean> {
    const current = await readJson(this.deps.exec, this.settingsPath);
    if (current === 'invalid') {
      this.log(`  ${this.settingsPath} is not valid JSON; leaving it alone. Fix it and re-run.`);
      return false;
    }
    const next: Json = structuredClone(current ?? {});
    if (!edit(next)) {
      this.log(`  ${unchanged}`);
      return false;
    }
    if (!(await this.approve(describe))) return false;
    if (current !== null) {
      const backup = `${this.settingsPath}.bak-${timestamp(this.deps.now())}`;
      await this.deps.exec.copyFile(this.settingsPath, backup);
      this.log(`  backup: ${backup}`);
    }
    await this.deps.exec.writeFile(this.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    this.log(`  updated ${this.settingsPath}`);
    return true;
  }
}

// --- install steps --------------------------------------------------------------

async function stepConfig(s: Session): Promise<Config | null> {
  const { exec, prompt } = s.deps;
  const f = s.flags;
  s.log(`\n[1/5] Config file ${s.configPath}`);
  const existing = await readJson(exec, s.configPath);
  const prev: Partial<Config> = existing && existing !== 'invalid' ? (existing as Partial<Config>) : {};
  const interactive = !f.yes && !f.dryRun;
  const pick = async (flag: string | undefined, old: string | undefined, q: string, def?: string) =>
    flag ?? (interactive ? await prompt.ask(q, old ?? def) : (old ?? def ?? ''));

  let apiUrl = (await pick(f.apiUrl, prev.apiUrl, 'Worker API URL (https://claude-usage-api.<you>.workers.dev)')).replace(/\/+$/, '');
  if (f.writeToken !== undefined || f.readToken !== undefined) {
    s.log(
      `  warning: --write-token / --read-token leave the secret in shell history and the process list. Prefer the prompt or the ${WRITE_TOKEN_ENV} / ${READ_TOKEN_ENV} environment variables.`,
    );
  }
  const env = s.deps.env ?? {};
  const fromEnv = (name: string) => env[name]?.trim() || undefined;
  let writeToken = await pick(f.writeToken ?? fromEnv(WRITE_TOKEN_ENV), prev.writeToken, 'Write token (WRITE_TOKEN secret)');
  const readToken = await pick(f.readToken ?? fromEnv(READ_TOKEN_ENV), prev.readToken, 'Read token (optional, for `ccu status`)', '');
  const tz = await pick(f.tz, prev.tz, 'Timezone', s.deps.defaultTz);
  const deviceName = await pick(f.device, prev.deviceName, 'Device name', s.deps.defaultDevice);
  const ntfyTopic = await pick(f.ntfyTopic, prev.ntfyTopic, 'ntfy topic (optional)', '');

  if (f.dryRun && (!apiUrl || !writeToken)) {
    s.log('  [dry-run] no API URL / write token given; using placeholders.');
    apiUrl ||= 'https://api.example.invalid';
    writeToken ||= '<write-token>';
  }
  if (!apiUrl || !writeToken) {
    s.log(`  An API URL and a write token are required (prompted, or --api-url and the ${WRITE_TOKEN_ENV} environment variable).`);
    return null;
  }
  const config: Config = { ...prev, apiUrl, writeToken, tz, deviceName };
  if (readToken) config.readToken = readToken;
  else delete config.readToken;
  if (ntfyTopic) config.ntfyTopic = ntfyTopic;
  else delete config.ntfyTopic;
  // Same rules `ccu sync` loads the config with: https only (http just for localhost), a real tz.
  const valid = validateConfig(config);
  if (!valid.ok) {
    s.log(`  invalid config: ${valid.error}`);
    return null;
  }

  s.log(`  apiUrl=${apiUrl} writeToken=${mask(writeToken)}${readToken ? ` readToken=${mask(readToken)}` : ''} tz=${tz} device=${deviceName}`);
  if (JSON.stringify(config) === JSON.stringify(prev)) {
    s.log('  already up to date.');
    return config;
  }
  if (await s.approve(`write ${s.configPath}`)) {
    await exec.writeFile(s.configPath, `${JSON.stringify(config, null, 2)}\n`);
    s.log('  written.');
  }
  return config;
}

async function stepTask(s: Session) {
  const p = s.deps.paths;
  s.log(`\n[2/5] Scheduled task "${TASK_NAME}" (every 5 min, hidden, current user, no admin)`);
  s.log(`  runs: conhost.exe ${taskArguments(p)}`);
  const current = (await s.ps(queryTaskScript())).stdout.trim();
  if (current === `${TASK_EXECUTE}|${taskArguments(p)}`) {
    s.log('  already registered.');
    return;
  }
  if (current) s.log(`  existing task differs (${current}); it will be replaced.`);
  if (!(await s.approve(`register scheduled task ${TASK_NAME}`))) return;
  await s.ps(registerTaskScript(p));
  s.log('  registered.');
}

async function stepOtel(s: Session, config: Config) {
  s.log('\n[3/5] (optional) User environment variables for Claude Code OpenTelemetry');
  const want = otelEnv(config.apiUrl, config.writeToken);
  const before = JSON.parse((await s.ps(readEnvScript(OTEL_ENV_NAMES))).stdout.trim() || '{}') as Record<string, string>;
  const changes = Object.entries(want).filter(([n, v]) => before[n] !== v);
  if (!changes.length) {
    s.log('  already set.');
    return;
  }
  for (const [n, v] of changes) s.log(`  ${n}=${displayEnvValue(n, v)}`);
  if (!(await s.approve(`set ${changes.length} user environment variable(s)`))) return;
  const m = await s.manifest();
  m.envBefore ??= {};
  for (const [n] of changes) if (!(n in m.envBefore)) m.envBefore[n] = before[n] ?? null;
  await s.saveManifest(m);
  await s.ps(setEnvScript(Object.fromEntries(changes)));
  s.log('  set. Restart terminals / Claude Code to pick them up.');
}

async function stepStatusline(s: Session) {
  s.log(`\n[4/5] (optional) statusLine in ${s.settingsPath}`);
  const command = statuslineCommand(s.deps.paths);
  s.log(`  command: ${command}`);
  const m = await s.manifest();
  const changed = await s.editSettings('merge statusLine into settings.json (backup first)', (j) => {
    const want = { type: 'command', command, padding: 0 };
    if (JSON.stringify(j['statusLine']) === JSON.stringify(want)) return false;
    if (!m.settingsBefore?.statusLineSaved) {
      m.settingsBefore = { ...m.settingsBefore, statusLine: j['statusLine'], statusLineSaved: true };
    }
    j['statusLine'] = want;
    return true;
  });
  const settings = await readJson(s.deps.exec, s.settingsPath);
  const ownsIt = settings && settings !== 'invalid' && (settings['statusLine'] as { command?: unknown } | undefined)?.command === command;
  if (ownsIt && !s.flags.dryRun && m.settingsBefore?.statusLineCommand !== command) {
    m.settingsBefore = { ...m.settingsBefore, statusLineCommand: command };
    await s.saveManifest(m);
  } else if (changed) await s.saveManifest(m);
}

async function stepCleanup(s: Session) {
  const days = s.flags.cleanupDays;
  s.log(`\n[5/5] (optional) cleanupPeriodDays=${days} in ${s.settingsPath} (keep transcripts longer than 30 days)`);
  const m = await s.manifest();
  const changed = await s.editSettings(`set cleanupPeriodDays=${days} (backup first)`, (j) => {
    if (j['cleanupPeriodDays'] === days) return false;
    if (!m.settingsBefore?.cleanupSaved) {
      m.settingsBefore = { ...m.settingsBefore, cleanupPeriodDays: j['cleanupPeriodDays'], cleanupSaved: true };
    }
    j['cleanupPeriodDays'] = days;
    return true;
  });
  if (changed) await s.saveManifest(m);
}

async function withDeps(
  args: string[],
  overrides: Partial<InstallDeps> | undefined,
  body: (s: Session) => Promise<number>,
): Promise<number> {
  const base = overrides?.exec && overrides.prompt && overrides.paths ? null : defaultDeps();
  const deps: InstallDeps = { ...(base as InstallDeps), ...overrides } as InstallDeps;
  try {
    const flags = parseInstallArgs(args);
    return await body(new Session(deps, flags));
  } catch (e) {
    deps.log(`ccu: ${(e as Error).message}`);
    return 1;
  } finally {
    deps.prompt.close();
  }
}

export function runInstall(args: string[], overrides?: Partial<InstallDeps>): Promise<number> {
  return withDeps(args, overrides, async (s) => {
    s.log(`Claude Usage Tracker installer${s.flags.dryRun ? ' (dry run: nothing will change)' : ''}.`);
    s.log('Each change is shown first and needs a y to proceed.');
    const config = await stepConfig(s);
    if (!config) return 1;
    if (!s.flags.skip.has('task')) await stepTask(s);
    if (!s.flags.skip.has('otel')) await stepOtel(s, config);
    if (!s.flags.skip.has('statusline')) await stepStatusline(s);
    if (!s.flags.skip.has('cleanup')) await stepCleanup(s);
    s.log('\nDone. Run `ccu sync --verbose` once to check, or `ccu uninstall` to reverse.');
    return 0;
  });
}

// --- uninstall ------------------------------------------------------------------

/**
 * Our statusLine: the command for the current paths, the one recorded at install time, or (for
 * manifests from before that was recorded) any `... statusline.js` command once we saved a backup.
 */
function isOurStatusline(command: unknown, ours: string, sb: NonNullable<Manifest['settingsBefore']>): boolean {
  if (typeof command !== 'string') return false;
  if (command === ours || (sb.statusLineCommand !== undefined && command === sb.statusLineCommand)) return true;
  return sb.statusLineSaved === true && sb.statusLineCommand === undefined && /[\\/]statusline\.js"?\s*$/.test(command);
}

export function runUninstall(args: string[], overrides?: Partial<InstallDeps>): Promise<number> {
  return withDeps(args, overrides, async (s) => {
    s.log(`Claude Usage Tracker uninstaller${s.flags.dryRun ? ' (dry run: nothing will change)' : ''}.`);
    const m = await s.manifest();

    if (!s.flags.skip.has('task')) {
      s.log(`\n[1/4] Scheduled task "${TASK_NAME}"`);
      if (!(await s.ps(queryTaskScript())).stdout.trim()) s.log('  not registered.');
      else if (await s.approve(`unregister scheduled task ${TASK_NAME}`)) {
        await s.ps(unregisterTaskScript());
        s.log('  removed.');
      }
    }

    if (!s.flags.skip.has('otel')) {
      s.log('\n[2/4] OpenTelemetry user environment variables');
      const current = JSON.parse((await s.ps(readEnvScript(OTEL_ENV_NAMES))).stdout.trim() || '{}') as Record<string, string>;
      // Restore what was there before install; never touch variables we did not set.
      const restore = Object.fromEntries(
        Object.entries(m.envBefore ?? {}).filter(([n, prev]) => current[n] !== undefined && current[n] !== prev),
      );
      if (!Object.keys(restore).length) s.log('  nothing to restore.');
      else {
        for (const [n, v] of Object.entries(restore)) s.log(`  ${n} -> ${v === null ? '(removed)' : displayEnvValue(n, v)}`);
        if (await s.approve(`restore ${Object.keys(restore).length} user environment variable(s)`)) {
          await s.ps(setEnvScript(restore));
          delete m.envBefore;
          await s.saveManifest(m);
          s.log('  restored.');
        }
      }
    }

    const ours = statuslineCommand(s.deps.paths);
    const sb = m.settingsBefore ?? {};
    if (!s.flags.skip.has('statusline')) {
      s.log(`\n[3/4] statusLine in ${s.settingsPath}`);
      const changed = await s.editSettings(
        'restore the previous statusLine (backup first)',
        (j) => {
          const cur = j['statusLine'] as { command?: unknown } | undefined;
          if (!cur || !isOurStatusline(cur.command, ours, sb)) return false;
          if (sb.statusLineSaved && sb.statusLine !== undefined) j['statusLine'] = sb.statusLine;
          else delete j['statusLine'];
          return true;
        },
        'not set by ccu; leaving it.',
      );
      if (changed) {
        delete sb.statusLine;
        delete sb.statusLineSaved;
        delete sb.statusLineCommand;
        await s.saveManifest({ ...m, settingsBefore: sb });
      }
    }

    if (!s.flags.skip.has('cleanup')) {
      s.log(`\n[4/4] cleanupPeriodDays in ${s.settingsPath}`);
      if (!sb.cleanupSaved) s.log('  not set by the installer; leaving it.');
      else {
        const changed = await s.editSettings('restore the previous cleanupPeriodDays (backup first)', (j) => {
          if (j['cleanupPeriodDays'] === sb.cleanupPeriodDays) return false;
          if (sb.cleanupPeriodDays === undefined) delete j['cleanupPeriodDays'];
          else j['cleanupPeriodDays'] = sb.cleanupPeriodDays;
          return true;
        });
        if (changed) {
          delete sb.cleanupPeriodDays;
          delete sb.cleanupSaved;
          await s.saveManifest({ ...m, settingsBefore: sb });
        }
      }
    }

    const home = s.deps.paths.ccuHome;
    if (s.flags.purge && !s.flags.skip.has('config')) {
      s.log(`\nLocal data in ${home}: ${PURGE_FILES.join(', ')}`);
      if (await s.approve(`delete ${PURGE_FILES.length} file(s) in ${home}`)) {
        for (const name of PURGE_FILES) await s.deps.exec.removeFile(join(home, name));
        s.log('  deleted.');
      }
    } else {
      s.log(`\nKept ${home} (config, state, cache, limits). Use --purge to delete them.`);
    }
    s.log('\nDone.');
    return 0;
  });
}
