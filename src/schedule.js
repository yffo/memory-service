/**
 * 定时自动发现：用 macOS 的 launchd LaunchAgent 定期跑
 * `tabellio consolidate --auto --write`，只写待批准提案。
 *
 * 为什么不是常驻进程：这也是一条「自动整理」的旁路，但它的产物只有提案，
 * 不写正式笔记、不批准确认、不改索引。launchd 负责按时叫醒它，跑完就退出。
 *
 * 口径：
 * 1. 只支持 macOS。Linux/Windows 的调度器契约不同，先不假装支持。
 * 2. 默认 dry-run；--write 才写 ~/Library/LaunchAgents 并 bootstrap。
 * 3. 只碰自己的 label：不删别的 LaunchAgent，也不改用户自己的定时任务。
 * 4. 安装失败不回滚已写的 plist（文件本身是安全的），但命令退 1 并说明「已写未加载」。
 * 5. 写的是可执行文件的绝对路径；Node 被 nvm 等挪走后任务会失败，status 会暴露未加载。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const SCHEDULE_LABEL = 'io.github.yffo.tabellio.sweep';
export const SCHEDULE_PLATFORMS = Object.freeze(['darwin']);
export const SCHEDULE_DEFAULT_INTERVAL_MINUTES = 360;
export const SCHEDULE_MIN_INTERVAL_MINUTES = 15;
export const SCHEDULE_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

function stampOf(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clip(text, max = 320) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 解析 6h / 30m / 1d / 360 这类间隔。裸数字按分钟算。 */
export function parseIntervalMinutes(value, fallback = SCHEDULE_DEFAULT_INTERVAL_MINUTES) {
  if (value === undefined || value === null || value === '') return fallback;
  const match = /^(\d+)([mhd])?$/.exec(String(value).trim().toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'm';
  const factor = unit === 'h' ? 60 : unit === 'd' ? 24 * 60 : 1;
  const minutes = amount * factor;
  if (!Number.isInteger(minutes)) return null;
  if (minutes < SCHEDULE_MIN_INTERVAL_MINUTES || minutes > SCHEDULE_MAX_INTERVAL_MINUTES) return null;
  return minutes;
}

/** 当前用户与平台对应的文件位置；不支持的平台返回 null。 */
export function schedulePaths({ home = homedir(), platform = process.platform, label = SCHEDULE_LABEL } = {}) {
  if (!SCHEDULE_PLATFORMS.includes(platform)) return null;
  const logDir = join(home, 'Library', 'Logs', 'tabellio');
  return {
    platform,
    label,
    dir: join(home, 'Library', 'LaunchAgents'),
    path: join(home, 'Library', 'LaunchAgents', label + '.plist'),
    log_dir: logDir,
    out_log: join(logDir, 'sweep.log'),
    err_log: join(logDir, 'sweep.err.log'),
  };
}

export function scheduleProgramArguments({ command, bin, store }) {
  return [command, bin, 'consolidate', '--auto', '--write', '--store', store, '--json'];
}

/** 纯函数：把一份 LaunchAgent 渲染成 plist。 */
export function renderSchedulePlist({
  label = SCHEDULE_LABEL,
  command,
  bin,
  store,
  intervalMinutes = SCHEDULE_DEFAULT_INTERVAL_MINUTES,
  home = homedir(),
  outLog,
  errLog,
} = {}) {
  const paths = schedulePaths({ home });
  const out = outLog ?? paths?.out_log;
  const err = errLog ?? paths?.err_log;
  if (!out || !err) throw new Error('renderSchedulePlist 只支持 darwin');
  const args = scheduleProgramArguments({ command, bin, store });
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + escapeXml(label) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((arg) => '    <string>' + escapeXml(arg) + '</string>'),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    '  <string>' + escapeXml(home) + '</string>',
    '  <key>StartInterval</key>',
    '  <integer>' + intervalMinutes * 60 + '</integer>',
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    '  <string>' + escapeXml(out) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + escapeXml(err) + '</string>',
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

function readPlist(path) {
  if (!existsSync(path)) return { ok: true, exists: false, text: '' };
  try {
    return { ok: true, exists: true, text: readFileSync(path, 'utf8') };
  } catch (e) {
    return { ok: false, code: 'E_SCHEDULE_UNREADABLE', message: String(e?.message ?? e) };
  }
}

function invalid(platform, reason, extra = {}) {
  return { ok: false, platform, reason, would_write: false, ...extra };
}

/**
 * 计划一次定时安装/卸载。默认 dry-run：只算，不写文件，不碰 launchctl。
 */
export function planScheduleInstall({
  platform = process.platform,
  home = homedir(),
  label = SCHEDULE_LABEL,
  bin,
  store,
  command = process.execPath,
  intervalMinutes = SCHEDULE_DEFAULT_INTERVAL_MINUTES,
  uninstall = false,
  force = false,
  now = Date.now(),
} = {}) {
  const paths = schedulePaths({ home, platform, label });
  if (!paths) {
    return invalid(platform, 'unsupported_platform', {
      supported: [...SCHEDULE_PLATFORMS],
      hint: '定时自动发现目前只支持 macOS；Linux 可先用 cron 手动跑 tabellio consolidate --auto --write。',
    });
  }
  if (!uninstall) {
    if (typeof bin !== 'string' || !bin || typeof store !== 'string' || !store) {
      return invalid(platform, 'missing_target', { path: paths.path, hint: '缺少 bin / store。' });
    }
    if (!isAbsolute(bin) || !isAbsolute(store)) {
      return invalid(platform, 'invalid_path', {
        path: paths.path,
        hint: '定时任务不会继承当前目录，bin 和 store 必须是绝对路径。',
      });
    }
    if (!isAbsolute(command)) {
      return invalid(platform, 'invalid_command', {
        path: paths.path,
        hint: 'Node 可执行文件必须是绝对路径（launchd 不读 shell 的 PATH）。',
      });
    }
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < SCHEDULE_MIN_INTERVAL_MINUTES || intervalMinutes > SCHEDULE_MAX_INTERVAL_MINUTES) {
      return invalid(platform, 'invalid_interval', {
        path: paths.path,
        min_minutes: SCHEDULE_MIN_INTERVAL_MINUTES,
        max_minutes: SCHEDULE_MAX_INTERVAL_MINUTES,
      });
    }
  }

  const read = readPlist(paths.path);
  if (!read.ok) return invalid(platform, read.code, { path: paths.path, error: read.message });

  if (uninstall) {
    if (!read.exists) {
      return {
        ok: true,
        platform,
        label,
        path: paths.path,
        log_dir: paths.log_dir,
        action: 'unchanged',
        reason: 'not_installed',
        exists: false,
        would_write: false,
      };
    }
    return {
      ok: true,
      platform,
      label,
      path: paths.path,
      log_dir: paths.log_dir,
      action: 'uninstall',
      exists: true,
      would_write: true,
      removed: true,
    };
  }

  const preview = renderSchedulePlist({
    label,
    command,
    bin,
    store,
    intervalMinutes,
    home,
    outLog: paths.out_log,
    errLog: paths.err_log,
  });
  const base = {
    platform,
    label,
    path: paths.path,
    log_dir: paths.log_dir,
    out_log: paths.out_log,
    err_log: paths.err_log,
    command,
    bin,
    store,
    interval_minutes: intervalMinutes,
    program_arguments: scheduleProgramArguments({ command, bin, store }),
    preview,
  };

  if (!read.exists) {
    return { ok: true, ...base, action: 'create', exists: false, would_write: true };
  }
  if (read.text === preview) {
    return { ok: true, ...base, action: 'unchanged', exists: true, would_write: false };
  }
  if (!force) {
    return {
      ok: false,
      ...base,
      action: 'conflict',
      reason: 'conflict',
      exists: true,
      would_write: false,
      hint: '已有另一个 tabellio 定时任务（可能指向别的 store）。确认替换请加 --force；只想看内容请用 schedule status。',
    };
  }
  return {
    ok: true,
    ...base,
    action: 'update',
    exists: true,
    would_write: true,
    backup: paths.path + '.tabellio-backup-' + stampOf(now),
  };
}

function invoke(run, bin, args, env) {
  let result;
  try {
    result = run(bin, args, { encoding: 'utf8', env });
  } catch (e) {
    return { status: -1, stdout: '', stderr: '', error: String(e?.message ?? e) };
  }
  return {
    status: typeof result?.status === 'number' ? result.status : -1,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
    error: result?.error ? String(result.error.message ?? result.error) : null,
  };
}

function serviceTarget(uid, label) {
  if (uid === null || uid === undefined) return null;
  return 'gui/' + uid + '/' + label;
}

function bootstrap(run, launchctl, env, uid, path) {
  if (uid === null || uid === undefined) {
    return { ok: false, reason: 'no_uid', error: '拿不到当前用户 uid，无法在当前 GUI 会话里加载 launchd 任务。' };
  }
  const loaded = invoke(run, launchctl, ['bootstrap', 'gui/' + uid, path], env);
  if (loaded.status === 0) return { ok: true, detail: clip(loaded.stderr) || null };
  const reason = loaded.status === -1 && /ENOENT/i.test(String(loaded.error ?? loaded.stderr)) ? 'launchctl_unavailable' : 'load_failed';
  return {
    ok: false,
    reason,
    error: clip(loaded.error ?? loaded.stderr ?? loaded.stdout) || 'launchctl bootstrap 失败',
    hint: 'plist 已经写好，但没有加载。可在桌面会话里运行 launchctl bootstrap gui/$(id -u) <plist> 重试。',
  };
}

function bootout(run, launchctl, env, uid, label) {
  if (uid === null || uid === undefined) return { ok: false, reason: 'no_uid', detail: null };
  const target = serviceTarget(uid, label);
  const result = invoke(run, launchctl, ['bootout', target], env);
  if (result.status === 0) return { ok: true, detail: null };
  const text = clip(result.error ?? result.stderr ?? result.stdout);
  return { ok: false, detail: text || null };
}

function probeLoaded(run, launchctl, env, uid, label) {
  const target = serviceTarget(uid, label);
  if (!target) return { checked: false, loaded: false, error: 'no_uid' };
  const result = invoke(run, launchctl, ['print', target], env);
  if (result.status === 0) return { checked: true, loaded: true, detail: null };
  const text = clip(result.error ?? result.stderr ?? result.stdout);
  if (result.status === -1 && /ENOENT/i.test(String(result.error ?? result.stderr))) {
    return { checked: false, loaded: false, error: 'launchctl_unavailable', detail: text || null };
  }
  return { checked: true, loaded: false, detail: text || null };
}

/**
 * 应用计划。只有 action=create/update 才写文件；unchanged 也会确认/尝试加载一次。
 */
export function applyScheduleInstall(plan, options = {}) {
  const env = options.env ?? process.env;
  const run = options.run ?? spawnSync;
  const launchctl = options.launchctl ?? env.TABELLIO_LAUNCHCTL_BIN ?? 'launchctl';
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (!plan?.ok) {
    return { ok: false, reason: plan?.reason ?? 'invalid_plan', written: false, loaded: false, path: plan?.path ?? null };
  }

  if (plan.action === 'unchanged') {
    const probe = probeLoaded(run, launchctl, env, uid, plan.label);
    if (probe.loaded) return { ok: true, written: false, loaded: true, path: plan.path, action: 'unchanged' };
    const load = bootstrap(run, launchctl, env, uid, plan.path);
    return {
      ok: load.ok,
      written: false,
      loaded: load.ok,
      path: plan.path,
      action: 'unchanged',
      ...(load.ok ? {} : { reason: load.reason, error: load.error, hint: load.hint }),
    };
  }

  if (plan.action === 'uninstall') {
    const out = bootout(run, launchctl, env, uid, plan.label);
    try {
      rmSync(plan.path, { force: true });
      return {
        ok: true,
        written: true,
        removed: true,
        loaded: false,
        unloaded: out.ok,
        path: plan.path,
        action: 'uninstall',
        ...(out.detail ? { detail: out.detail } : {}),
      };
    } catch (e) {
      return {
        ok: false,
        reason: 'remove_failed',
        written: false,
        loaded: false,
        path: plan.path,
        error: String(e?.message ?? e),
      };
    }
  }

  if (!plan.would_write) {
    return { ok: true, written: false, loaded: null, path: plan.path, action: plan.action };
  }
  if (!isPlainObject(plan) || typeof plan.preview !== 'string' || plan.preview === '') {
    return { ok: false, reason: 'missing_preview', written: false, loaded: false, path: plan.path ?? null };
  }
  try {
    mkdirSync(plan.log_dir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(plan.path), { recursive: true });
    if (plan.backup) copyFileSync(plan.path, plan.backup);
    const tmp = plan.path + '.tabellio-tmp-' + process.pid;
    writeFileSync(tmp, plan.preview, { encoding: 'utf8', mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, plan.path);
  } catch (e) {
    return { ok: false, reason: 'write_failed', written: false, loaded: false, path: plan.path, error: String(e?.message ?? e) };
  }

  bootout(run, launchctl, env, uid, plan.label);
  const load = bootstrap(run, launchctl, env, uid, plan.path);
  return {
    ok: load.ok,
    written: true,
    loaded: load.ok,
    path: plan.path,
    action: plan.action,
    ...(plan.backup ? { backup: plan.backup } : {}),
    ...(load.ok ? {} : { reason: load.reason, error: load.error, hint: load.hint }),
  };
}

function parsePlist(text) {
  const interval = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text);
  const store = /<string>--store<\/string>\s*<string>([\s\S]*?)<\/string>/.exec(text);
  return {
    interval_minutes: interval ? Number(interval[1]) / 60 : null,
    store: store ? decodeXml(store[1]) : null,
  };
}

/** 只读体检：文件在不在、launchd 里有没有加载。 */
export function scheduleStatus({
  platform = process.platform,
  home = homedir(),
  label = SCHEDULE_LABEL,
  run = spawnSync,
  env = process.env,
  launchctl = env.TABELLIO_LAUNCHCTL_BIN ?? 'launchctl',
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const paths = schedulePaths({ home, platform, label });
  if (!paths) {
    return {
      ok: true,
      supported: false,
      platform,
      label,
      installed: false,
      loaded: false,
      checked: false,
      reason: 'unsupported_platform',
      supported_platforms: [...SCHEDULE_PLATFORMS],
    };
  }
  const read = readPlist(paths.path);
  if (!read.ok) {
    return { ok: false, supported: true, platform, label, path: paths.path, installed: false, loaded: false, checked: false, reason: read.code, error: read.message };
  }
  if (!read.exists) {
    return {
      ok: true,
      supported: true,
      platform,
      label,
      path: paths.path,
      log_dir: paths.log_dir,
      installed: false,
      loaded: false,
      checked: false,
    };
  }
  const parsed = parsePlist(read.text);
  const probe = probeLoaded(run, launchctl, env, uid, label);
  return {
    ok: true,
    supported: true,
    platform,
    label,
    path: paths.path,
    log_dir: paths.log_dir,
    out_log: paths.out_log,
    err_log: paths.err_log,
    installed: true,
    loaded: probe.loaded,
    checked: probe.checked,
    interval_minutes: parsed.interval_minutes,
    store: parsed.store,
    ...(probe.error ? { error: probe.error } : {}),
    ...(probe.detail ? { detail: probe.detail } : {}),
  };
}
