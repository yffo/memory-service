
/**
 * 宿主 MCP 配置的**计划 / 应用**两段式。
 *
 * 为什么默认 dry-run：写的是别人家的全局配置文件（Claude Code、Cursor、Codex），
 * 一句 tabellio setup 就静默改掉是最不该有的「贴心」。
 * 计划阶段把所有冲突、坏 JSON、备份路径都算清楚；应用阶段只做已经展示过的事。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SETUP_HOSTS = Object.freeze(['claude', 'cursor', 'codex']);

const HOSTS = Object.freeze({
  claude: { label: 'Claude Code', path: (home) => join(home, '.claude.json'), dir: (home) => join(home, '.claude'), kind: 'json' },
  cursor: { label: 'Cursor', path: (home) => join(home, '.cursor', 'mcp.json'), dir: (home) => join(home, '.cursor'), kind: 'json' },
  codex: { label: 'Codex CLI', path: (home) => join(home, '.codex', 'config.toml'), dir: (home) => join(home, '.codex'), kind: 'toml' },
});

function stampOf(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameServer(current, desired) {
  if (!isPlainObject(current)) return false;
  if (current.command !== desired.command) return false;
  if (!Array.isArray(current.args) || current.args.length !== desired.args.length) return false;
  return current.args.every((arg, i) => arg === desired.args[i]);
}

function readJson(path) {
  if (!existsSync(path)) return { ok: true, data: {} };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, code: 'E_CONFIG_UNREADABLE', message: String(e.message ?? e) };
  }
  if (text.trim() === '') return { ok: true, data: {} };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'E_CONFIG_INVALID', message: 'JSON 解析失败：' + String(e.message ?? e) };
  }
  if (!isPlainObject(data)) return { ok: false, code: 'E_CONFIG_INVALID', message: '顶层必须是对象' };
  if (data.mcpServers !== undefined && !isPlainObject(data.mcpServers)) {
    return { ok: false, code: 'E_CONFIG_INVALID', message: 'mcpServers 必须是对象' };
  }
  return { ok: true, data };
}

function desiredServer({ command, mcpBin, store, readOnly }) {
  return {
    command,
    args: [mcpBin, '--store', store, ...(readOnly ? [] : ['--allow-write'])],
  };
}

function planJson(host, { path, server, readOnly, force, now }) {
  const read = readJson(path);
  if (!read.ok) return { host, path, action: 'invalid', ok: false, error: read };
  const currentServers = read.data.mcpServers ?? {};
  const current = currentServers.tabellio;
  const exists = existsSync(path);
  let action;
  if (current === undefined) action = exists ? 'append' : 'create';
  else if (sameServer(current, server)) action = 'unchanged';
  else action = force ? 'update' : 'conflict';

  const next = {
    ...read.data,
    mcpServers: { ...currentServers, tabellio: server },
  };
  const wouldWrite = action === 'create' || action === 'append' || action === 'update';
  return {
    host,
    label: HOSTS[host].label,
    path,
    kind: 'json',
    action,
    ok: action !== 'invalid' && action !== 'conflict',
    exists,
    current: current ?? null,
    desired: server,
    read_only: readOnly,
    would_write: wouldWrite,
    backup: wouldWrite && exists ? path + '.tabellio-backup-' + stampOf(now) : null,
    preview: wouldWrite ? JSON.stringify(next, null, 2) + '\n' : null,
  };
}

function findTomlSection(lines) {
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[mcp_servers\.tabellio(?:\]|\.)/.test(lines[i])) {
      if (start === -1) start = i;
    } else if (start !== -1 && /^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function tomlBlock(server) {
  const args = server.args.map((arg) => JSON.stringify(arg)).join(', ');
  return '[mcp_servers.tabellio]\ncommand = ' + JSON.stringify(server.command) + '\nargs = [' + args + ']\n';
}

function planToml(host, { path, server, force, now }) {
  let text = '';
  if (existsSync(path)) {
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      return { host, path, action: 'invalid', ok: false, error: { code: 'E_CONFIG_UNREADABLE', message: String(e.message ?? e) } };
    }
  }
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const section = findTomlSection(lines);
  const exists = section.start !== -1;
  const block = tomlBlock(server);
  let action;
  let nextText;
  if (!exists) {
    action = text.trim() === '' ? 'create' : 'append';
    const head = text.trimEnd();
    nextText = (head ? head + '\n\n' : '') + block;
  } else {
    const currentBlock = lines.slice(section.start, section.end).join('').trim();
    if (currentBlock === block.trim()) {
      action = 'unchanged';
      nextText = text;
    } else {
      action = force ? 'update' : 'conflict';
      nextText = lines.slice(0, section.start).join('') + block + lines.slice(section.end).join('');
    }
  }
  const wouldWrite = action === 'create' || action === 'append' || action === 'update';
  return {
    host,
    label: HOSTS[host].label,
    path,
    kind: 'toml',
    action,
    ok: action !== 'invalid' && action !== 'conflict',
    exists: existsSync(path),
    desired: server,
    read_only: false,
    would_write: wouldWrite,
    backup: wouldWrite && existsSync(path) ? path + '.tabellio-backup-' + stampOf(now) : null,
    preview: wouldWrite ? nextText : null,
  };
}

/**
 * @returns {{ok:boolean, reason?:string, hosts:Array, server:object, store:string, mcp_bin:string}}
 */
export function planSetup({
  hosts = 'all',
  home = homedir(),
  command = process.execPath,
  mcpBin,
  store,
  readOnly = false,
  force = false,
  now = Date.now(),
} = {}) {
  const wanted = Array.isArray(hosts) ? hosts : String(hosts).split(',');
  const names = [];
  for (const raw of wanted) {
    const name = String(raw).trim();
    if (!name) continue;
    if (name === 'all') {
      for (const host of SETUP_HOSTS) {
        const spec = HOSTS[host];
        if (existsSync(spec.path(home)) || existsSync(spec.dir(home))) names.push(host);
      }
    } else if (HOSTS[name]) {
      if (!names.includes(name)) names.push(name);
    } else {
      return { ok: false, reason: 'unknown_host', unknown: name, hosts: [], store, mcp_bin: mcpBin };
    }
  }
  const unique = [...new Set(names)];
  if (unique.length === 0) {
    return { ok: false, reason: 'no_host_detected', hosts: [], store, mcp_bin: mcpBin, dry_run: true };
  }
  if (!mcpBin || !store) return { ok: false, reason: 'missing_target', hosts: [], store, mcp_bin: mcpBin };

  const server = desiredServer({ command, mcpBin, store, readOnly });
  const planned = unique.map((host) => {
    const spec = HOSTS[host];
    const path = spec.path(home);
    return spec.kind === 'json'
      ? planJson(host, { path, server, readOnly, force, now })
      : planToml(host, { path, server, force, now });
  });
  const bad = planned.find((p) => p.ok === false);
  return {
    ok: !bad,
    reason: bad ? (bad.action === 'conflict' ? 'conflict' : 'invalid_config') : null,
    dry_run: true,
    hosts: planned,
    server,
    store,
    mcp_bin: mcpBin,
    command,
  };
}

/** 应用一份计划。计划里 ok:false 的宿主不写；配置已经在计划阶段全部看过，失败不会写半份。 */
export function applySetup(plan) {
  if (!plan?.ok) return { ok: false, reason: plan?.reason ?? 'invalid_plan', applied: [], failed: [] };
  const applied = [];
  const failed = [];
  for (const host of plan.hosts) {
    if (!host.would_write) {
      applied.push({ host: host.host, path: host.path, action: host.action, written: false });
      continue;
    }
    try {
      if (host.backup) copyFileSync(host.path, host.backup);
      mkdirSync(dirname(host.path), { recursive: true });
      const tmp = host.path + '.tabellio-tmp-' + process.pid;
      writeFileSync(tmp, host.preview, 'utf8');
      renameSync(tmp, host.path);
      applied.push({ host: host.host, path: host.path, action: host.action, written: true, backup: host.backup });
    } catch (e) {
      failed.push({ host: host.host, path: host.path, action: host.action, error: String(e.message ?? e) });
    }
  }
  return { ok: failed.length === 0, applied, failed };
}
