/**
 * 宿主 MCP 配置的**连接验证**：setup 写完配置之后，站在宿主自己的视角再问一次。
 *
 * 为什么不做成「读一遍 JSON 就算验证」：配置写对和宿主真能连上是两件事。
 * 这里只调用宿主自己的命令，并把结果分级，绝不把「CLI 接受了 TOML」说成「已连接」。
 *
 * 验证时使用配置文件的**临时副本**：Claude Code 的 mcp list 会在配置目录里写备份，
 * 不能让一次只读检查去动用户的真实配置。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const HOST_VERIFY_LEVELS = Object.freeze([
  'connected',
  'configured',
  'unverified',
  'unavailable',
  'failed',
  'missing',
]);

const HOSTS = Object.freeze({
  claude: {
    label: 'Claude Code',
    binary: 'claude',
    envKey: 'TABELLIO_CLAUDE_BIN',
    config: (home) => join(home, '.claude.json'),
    isolatedName: '.claude.json',
  },
  cursor: {
    label: 'Cursor',
    binary: 'cursor',
    envKey: 'TABELLIO_CURSOR_BIN',
    config: (home) => join(home, '.cursor', 'mcp.json'),
    isolatedName: 'mcp.json',
  },
  codex: {
    label: 'Codex CLI',
    binary: 'codex',
    envKey: 'TABELLIO_CODEX_BIN',
    config: (home) => join(home, '.codex', 'config.toml'),
    isolatedName: 'config.toml',
    known: (home) => [
      '/Applications/Codex.app/Contents/Resources/codex',
      join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    ],
  },
});

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executableNames(binary) {
  return process.platform === 'win32' ? [binary + '.cmd', binary + '.exe', binary] : [binary];
}

/** 在 PATH 和少量已知安装位置里找宿主 CLI；显式 binaries 优先（测试/特殊安装用）。 */
function findBinary(host, { home, env, binaries }) {
  const explicit = binaries?.[host];
  if (explicit) return explicit;
  const spec = HOSTS[host];
  const override = spec.envKey ? env[spec.envKey] : undefined;
  if (override) return isFile(override) ? override : null;
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of executableNames(spec.binary)) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  for (const candidate of spec.known?.(home) ?? []) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function clip(text, max = 320) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function invoke(run, bin, args, options) {
  let r;
  try {
    r = run(bin, args, options);
  } catch (error) {
    return { status: -1, stdout: '', stderr: '', error: String(error?.message ?? error) };
  }
  return {
    status: typeof r?.status === 'number' ? r.status : -1,
    stdout: String(r?.stdout ?? ''),
    stderr: String(r?.stderr ?? ''),
    error: r?.error ? String(r.error.message ?? r.error) : null,
  };
}

/** 用真实配置的临时副本验证，避免宿主自己的备份/迁移逻辑写用户目录。 */
function withIsolatedConfig(host, home, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tabellio-host-verify-'));
  try {
    const source = HOSTS[host].config(home);
    const target = join(dir, HOSTS[host].isolatedName);
    if (existsSync(source)) copyFileSync(source, target);
    return fn({ dir, target });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseResult(host, home) {
  return {
    host,
    label: HOSTS[host].label,
    config_path: HOSTS[host].config(home),
    level: 'unverified',
    ok: true,
    detail: '',
    binary: null,
    connection_checked: false,
  };
}

function verifyClaude(binary, { home, env, run }) {
  return withIsolatedConfig('claude', home, ({ dir }) => {
    const childEnv = { ...env, HOME: home, CLAUDE_CONFIG_DIR: dir };
    const r = invoke(run, binary, ['mcp', 'list'], {
      encoding: 'utf8',
      timeout: 20000,
      env: childEnv,
      maxBuffer: 1024 * 1024,
    });
    if (r.error) {
      return { level: 'failed', ok: false, detail: '启动 claude 失败：' + clip(r.error), binary, connection_checked: true };
    }
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
    const line = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => /^tabellio\s*:/.test(s));
    if (!line) {
      return {
        level: r.status === 0 ? 'missing' : 'failed',
        ok: false,
        detail: r.status === 0 ? 'claude mcp list 里没有 tabellio；配置可能没被读取' : 'claude mcp list 退出码 ' + r.status + '：' + clip(out),
        binary,
        connection_checked: true,
      };
    }
    if (/✓\s*Connected/.test(line)) {
      return { level: 'connected', ok: true, detail: 'claude mcp list：✓ Connected', binary, connection_checked: true };
    }
    if (/Failed to connect|✗/i.test(line)) {
      return { level: 'failed', ok: false, detail: line, binary, connection_checked: true };
    }
    return {
      level: 'failed',
      ok: false,
      detail: 'claude mcp list 没有给出可识别的状态：' + clip(line),
      binary,
      connection_checked: true,
    };
  });
}

function verifyCodex(binary, { home, env, run }) {
  return withIsolatedConfig('codex', home, ({ dir }) => {
    const childEnv = { ...env, HOME: home, CODEX_HOME: dir };
    const r = invoke(run, binary, ['mcp', 'list'], {
      encoding: 'utf8',
      timeout: 20000,
      env: childEnv,
      maxBuffer: 1024 * 1024,
    });
    if (r.error) {
      return { level: 'failed', ok: false, detail: '启动 codex 失败：' + clip(r.error), binary, connection_checked: false };
    }
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
    const line = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => /^tabellio\s+/.test(s));
    if (!line) {
      return {
        level: r.status === 0 ? 'missing' : 'failed',
        ok: false,
        detail: r.status === 0 ? 'codex mcp list 里没有 tabellio；配置可能没被读取' : 'codex mcp list 退出码 ' + r.status + '：' + clip(out),
        binary,
        connection_checked: false,
      };
    }
    if (/\bdisabled\b/i.test(line)) {
      return { level: 'failed', ok: false, detail: 'Codex 里的 tabellio 是 disabled：' + clip(line), binary, connection_checked: false };
    }
    if (/\benabled\b/i.test(line)) {
      return {
        level: 'configured',
        ok: true,
        detail: 'Codex CLI 接受了配置（mcp list 显示 enabled）；Codex 不提供连接检查',
        binary,
        connection_checked: false,
      };
    }
    return { level: 'failed', ok: false, detail: 'codex mcp list 没有给出可识别的状态：' + clip(line), binary, connection_checked: false };
  });
}

/**
 * 验证宿主是否读到并接受 tabellio 配置。
 *
 * 等级：
 * - connected：宿主自己报告已连接（Claude Code）
 * - configured：宿主 CLI 接受了配置，但该命令不做连接检查（Codex）
 * - unverified：没有无头健康检查（Cursor）
 * - unavailable：没找到宿主 CLI，**不算配置失败**
 * - failed / missing：宿主报告连不上 / 没看到 tabellio，才让整体 ok=false
 *
 * @param {{hosts?: string|string[], home?: string, env?: object, run?: Function, binaries?: object}} options
 */
export function verifyHosts({ hosts = ['claude', 'cursor', 'codex'], home = homedir(), env = process.env, run = spawnSync, binaries = {} } = {}) {
  const requested = Array.isArray(hosts) ? hosts : String(hosts).split(',');
  const names = [];
  for (const raw of requested) {
    const name = String(raw).trim();
    if (HOSTS[name] && !names.includes(name)) names.push(name);
  }
  const results = names.map((host) => {
    const base = baseResult(host, home);
    if (host === 'cursor') {
      return {
        ...base,
        level: 'unverified',
        ok: true,
        detail: 'Cursor 没有无头 MCP 健康检查；请在 Cursor 的 MCP 设置里确认 tabellio',
      };
    }
    const binary = findBinary(host, { home, env, binaries });
    if (!binary) {
      return {
        ...base,
        level: 'unavailable',
        ok: true,
        detail: '没有找到 ' + HOSTS[host].binary + ' CLI；配置已写，但本次无法验证',
      };
    }
    try {
      const detail = host === 'claude' ? verifyClaude(binary, { home, env, run }) : verifyCodex(binary, { home, env, run });
      return { ...base, ...detail };
    } catch (error) {
      return {
        ...base,
        level: 'failed',
        ok: false,
        detail: '验证时出错：' + clip(error?.message ?? error),
        binary,
      };
    }
  });
  return {
    ok: results.every((r) => r.ok !== false),
    checked: results.filter((r) => r.level === 'connected' || r.level === 'configured').length,
    hosts: results,
  };
}
