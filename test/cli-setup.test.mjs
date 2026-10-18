/**
 * tabellio setup 的 CLI 端到端用例。
 *
 * 写的是别人家的全局配置，所以这里最重要的断言是「默认什么都不写」：
 * dry-run 不创建文件、坏 JSON 整单拒绝、冲突不 --force 不覆盖、写前有备份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'memory');

function cli(args, { store, input, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...(store ? { MEMORY_STORE: store } : {}), ...(env ?? {}) },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function homeDir(prefix) {
  return tempDir(prefix);
}

function configPath(home, host) {
  return host === 'claude' ? join(home, '.claude.json') : host === 'cursor' ? join(home, '.cursor', 'mcp.json') : join(home, '.codex', 'config.toml');
}

function backupFiles(home, host) {
  const path = configPath(home, host);
  return readdirSync(dirname(path)).filter((name) => name.startsWith(path.split('/').pop() + '.tabellio-backup-'));
}

test('setup 默认 dry-run：只预览，不创建/不修改任何宿主配置', () => {
  const home = homeDir('memory-setup-dry-');
  try {
    const store = join(home, 'store');
    const r = cli(['setup', '--home', home, '--host', 'claude', '--json'], { store });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true, r.json.reason);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.hosts[0].action, 'create');
    assert.equal(r.json.hosts[0].would_write, true);
    assert.equal(r.json.hosts[0].desired.args.at(-1), '--allow-write');
    assert.equal(r.json.hosts[0].desired.args.includes('--store'), true);
    assert.equal(existsSync(configPath(home, 'claude')), false, 'dry-run 不能写文件');
  } finally {
    rm(home);
  }
});

test('setup --write：写前备份、保留其他 server、二次幂等', () => {
  const home = homeDir('memory-setup-write-');
  try {
    const store = join(home, 'store');
    const path = configPath(home, 'claude');
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2) + '\n', 'utf8');

    const first = cli(['setup', '--home', home, '--host', 'claude', '--write', '--json'], { store });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.dry_run, false);
    assert.equal(first.json.applied[0].written, true);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(config.mcpServers.other.command, 'x');
    assert.equal(config.mcpServers.tabellio.command, process.execPath);
    assert.deepEqual(config.mcpServers.tabellio.args.slice(-1), ['--allow-write']);
    assert.equal(backupFiles(home, 'claude').length, 1, '写前必须留一份备份');

    const second = cli(['setup', '--home', home, '--host', 'claude', '--write', '--json'], { store });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.applied[0].written, false);
    assert.equal(second.json.hosts[0].action, 'unchanged');
    assert.equal(backupFiles(home, 'claude').length, 1, '未变时不该再产生备份');
  } finally {
    rm(home);
  }
});


test('setup --verify：宿主报 Connected 才退 0；报失败退 1 但配置已写', () => {
  const okHome = homeDir('memory-setup-verify-ok-');
  const badHome = homeDir('memory-setup-verify-bad-');
  try {
    const fake = join(okHome, 'fake-claude');
    writeFileSync(fake, '#!/bin/sh\nprintf \'tabellio: /fake - ✓ Connected\\n\'\n', { mode: 0o755 });
    chmodSync(fake, 0o755);
    const ok = cli(['setup', '--home', okHome, '--host', 'claude', '--write', '--verify', '--json'], {
      store: join(okHome, 'store'),
      env: { TABELLIO_CLAUDE_BIN: fake },
    });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.json.verification.ok, true);
    assert.equal(ok.json.verification.hosts[0].level, 'connected');
    assert.equal(ok.json.verification.hosts[0].connection_checked, true);
    assert.equal(existsSync(configPath(okHome, 'claude')), true);

    const badFake = join(badHome, 'fake-claude');
    writeFileSync(badFake, '#!/bin/sh\nprintf \'tabellio: /fake - ✗ Failed to connect\\n\'\n', { mode: 0o755 });
    chmodSync(badFake, 0o755);
    const bad = cli(['setup', '--home', badHome, '--host', 'claude', '--write', '--verify', '--json'], {
      store: join(badHome, 'store'),
      env: { TABELLIO_CLAUDE_BIN: badFake },
    });
    assert.equal(bad.code, 1);
    assert.equal(bad.json.ok, true, 'setup 本身写成功了');
    assert.equal(bad.json.verification.ok, false);
    assert.equal(bad.json.verification.hosts[0].level, 'failed');
    assert.equal(existsSync(configPath(badHome, 'claude')), true, '验证失败不该回滚配置');
  } finally {
    rm(okHome);
    rm(badHome);
  }
});

test('setup：坏 JSON 整单拒绝，文件保持原样', () => {
  const home = homeDir('memory-setup-bad-');
  try {
    const path = configPath(home, 'claude');
    writeFileSync(path, '{ not json', 'utf8');
    const r = cli(['setup', '--home', home, '--host', 'claude', '--write', '--json'], { store: join(home, 'store') });
    assert.equal(r.code, 1);
    assert.equal(r.json.reason, 'invalid_config');
    assert.equal(readFileSync(path, 'utf8'), '{ not json');
    assert.equal(backupFiles(home, 'claude').length, 0);
  } finally {
    rm(home);
  }
});

test('setup：已有不同配置默认冲突，--force 才覆盖', () => {
  const home = homeDir('memory-setup-conflict-');
  try {
    const path = configPath(home, 'claude');
    const original = { mcpServers: { tabellio: { command: 'old-node', args: ['old'] } } };
    writeFileSync(path, JSON.stringify(original, null, 2) + '\n', 'utf8');
    const store = join(home, 'store');

    const conflict = cli(['setup', '--home', home, '--host', 'claude', '--write', '--json'], { store });
    assert.equal(conflict.code, 1);
    assert.equal(conflict.json.reason, 'conflict');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);

    const forced = cli(['setup', '--home', home, '--host', 'claude', '--write', '--force', '--json'], { store });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.json.hosts[0].action, 'update');
    const updated = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(updated.mcpServers.tabellio.command, process.execPath);
    assert.equal(backupFiles(home, 'claude').length, 1);
  } finally {
    rm(home);
  }
});

test('setup：Cursor 的 --read-only 不写 --allow-write', () => {
  const home = homeDir('memory-setup-readonly-');
  try {
    const store = join(home, 'store');
    const dry = cli(['setup', '--home', home, '--host', 'cursor', '--read-only', '--json'], { store });
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json.hosts[0].desired.args.includes('--allow-write'), false);
    assert.deepEqual(dry.json.hosts[0].desired.args.slice(-2), ['--store', store]);
    assert.equal(dry.json.hosts[0].read_only, true);
  } finally {
    rm(home);
  }
});

test('setup：Codex TOML 只替换自己的段，保留其他段与注释', () => {
  const home = homeDir('memory-setup-codex-');
  try {
    const path = configPath(home, 'codex');
    mkdirSync(dirname(path), { recursive: true });
    const original = '# keep\n\n[mcp_servers.node_repl]\ncommand = "node"\nargs = []\n';
    writeFileSync(path, original, 'utf8');
    const store = join(home, 'store');

    const first = cli(['setup', '--home', home, '--host', 'codex', '--write', '--json'], { store });
    assert.equal(first.code, 0, first.stderr);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /# keep/);
    assert.match(text, /\[mcp_servers\.node_repl\]/);
    assert.match(text, /\[mcp_servers\.tabellio\]/);
    assert.match(text, new RegExp('--store'));
    assert.equal((text.match(/\[mcp_servers\.tabellio\]/g) || []).length, 1);

    const second = cli(['setup', '--home', home, '--host', 'codex', '--write', '--json'], { store });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.hosts[0].action, 'unchanged');
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.equal(backupFiles(home, 'codex').length, 1);
  } finally {
    rm(home);
  }
});

test('setup：all 只处理已安装宿主；空 HOME 报 no_host_detected', () => {
  const home = homeDir('memory-setup-all-');
  try {
    const store = join(home, 'store');
    const none = cli(['setup', '--home', home, '--json'], { store });
    assert.equal(none.code, 1);
    assert.equal(none.json.reason, 'no_host_detected');
    assert.deepEqual(none.json.hosts, []);

    mkdirSync(join(home, '.cursor'), { recursive: true });
    const cursorOnly = cli(['setup', '--home', home, '--json'], { store });
    assert.equal(cursorOnly.code, 0, cursorOnly.stderr);
    assert.deepEqual(cursorOnly.json.hosts.map((h) => h.host), ['cursor']);
    assert.equal(existsSync(configPath(home, 'cursor')), false, 'dry-run 仍然不写');
  } finally {
    rm(home);
  }
});

test('setup：未知宿主与缺参数退出 2', () => {
  const home = homeDir('memory-setup-args-');
  try {
    const unknown = cli(['setup', '--home', home, '--host', 'emacs', '--json'], { store: join(home, 'store') });
    assert.equal(unknown.code, 1);
    assert.equal(unknown.json.reason, 'unknown_host');

    const missingHost = cli(['setup', '--home', home, '--host'], { store: join(home, 'store') });
    assert.equal(missingHost.code, 2);
  } finally {
    rm(home);
  }
});

test('setup --json 不回显宿主配置整体（preview 不参与序列化）', () => {
  const home = homeDir('memory-setup-preview-');
  try {
    const path = configPath(home, 'claude');
    writeFileSync(path, JSON.stringify({ env: { SECRET: 'super-secret-value' }, mcpServers: { other: { command: 'x' } } }, null, 2) + '\n', 'utf8');
    const store = join(home, 'store');

    const dry = cli(['setup', '--home', home, '--host', 'claude', '--json'], { store });
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.stdout.includes('super-secret-value'), false, 'dry-run JSON 不能带出配置文件正文');
    assert.equal(dry.json.hosts[0].preview, undefined);

    const written = cli(['setup', '--home', home, '--host', 'claude', '--write', '--json'], { store });
    assert.equal(written.code, 0, written.stderr);
    assert.equal(written.stdout.includes('super-secret-value'), false, '--write JSON 也不能带出配置文件正文');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(config.env.SECRET, 'super-secret-value', '写入时必须保留其他字段');
    assert.equal(config.mcpServers.tabellio.command, process.execPath);
  } finally {
    rm(home);
  }
});
