/**
 * 宿主连接验证的分级规则。
 *
 * 关键不是「跑通了」，而是：Claude 说 Connected 才算 connected；Codex 只接受配置
 * 就只能报 configured；Cursor 没有无头检查就必须说 unverified。测试把这条边界钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, rm } from './helpers.mjs';
import { verifyHosts } from '../src/hostverify.js';

function fakeRun(handler) {
  const calls = [];
  return {
    calls,
    run(bin, args, options) {
      calls.push({ bin, args, options });
      return handler(bin, args, options);
    },
  };
}

test('claude：只有宿主自己报 ✓ Connected 才记为 connected，且用临时配置副本', () => {
  const home = tempDir('memory-hostverify-claude-');
  try {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { tabellio: { command: 'node', args: [] } } }), 'utf8');
    let copied = '';
    let seen = null;
    const { run } = fakeRun((bin, args, options) => {
      seen = { bin, args, env: options.env };
      copied = readFileSync(join(options.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8');
      return { status: 0, stdout: 'Checking MCP server health…\n\ntabellio: /fake/node --store /tmp/store - ✓ Connected\n', stderr: '' };
    });
    const v = verifyHosts({ hosts: ['claude'], home, env: { PATH: '' }, binaries: { claude: '/fake/claude' }, run });
    assert.equal(v.ok, true);
    assert.equal(v.checked, 1);
    assert.equal(v.hosts[0].level, 'connected');
    assert.equal(v.hosts[0].connection_checked, true);
    assert.equal(v.hosts[0].config_path, join(home, '.claude.json'));
    assert.deepEqual(seen.args, ['mcp', 'list']);
    assert.equal(seen.env.HOME, home);
    assert.notEqual(seen.env.CLAUDE_CONFIG_DIR, home, '验证必须用临时副本');
    assert.match(seen.env.CLAUDE_CONFIG_DIR, /tabellio-host-verify-/);
    assert.match(copied, /"tabellio"/);
  } finally {
    rm(home);
  }
});

test('claude：宿主报 Failed to connect 是 failed，整体 ok=false', () => {
  const home = tempDir('memory-hostverify-claude-fail-');
  try {
    const { run } = fakeRun(() => ({
      status: 0,
      stdout: 'Checking MCP server health…\n\ntabellio: /fake/node /fake/bin/memory-mcp - ✗ Failed to connect\n',
      stderr: '',
    }));
    const v = verifyHosts({ hosts: ['claude'], home, env: { PATH: '' }, binaries: { claude: '/fake/claude' }, run });
    assert.equal(v.ok, false);
    assert.equal(v.hosts[0].level, 'failed');
    assert.match(v.hosts[0].detail, /Failed to connect/);
  } finally {
    rm(home);
  }
});

test('claude：命令跑完但没有 tabellio 行是 missing，不是假成功', () => {
  const home = tempDir('memory-hostverify-claude-missing-');
  try {
    const { run } = fakeRun(() => ({ status: 0, stdout: 'No MCP servers configured.\n', stderr: '' }));
    const v = verifyHosts({ hosts: ['claude'], home, env: { PATH: '' }, binaries: { claude: '/fake/claude' }, run });
    assert.equal(v.ok, false);
    assert.equal(v.hosts[0].level, 'missing');
    assert.match(v.hosts[0].detail, /没有 tabellio/);
  } finally {
    rm(home);
  }
});

test('claude：宿主命令失败时保留退出码，不把 stderr 吞成成功', () => {
  const home = tempDir('memory-hostverify-claude-error-');
  try {
    const { run } = fakeRun(() => ({ status: 7, stdout: '', stderr: 'config is broken' }));
    const v = verifyHosts({ hosts: ['claude'], home, env: { PATH: '' }, binaries: { claude: '/fake/claude' }, run });
    assert.equal(v.ok, false);
    assert.equal(v.hosts[0].level, 'failed');
    assert.match(v.hosts[0].detail, /退出码 7/);
    assert.match(v.hosts[0].detail, /config is broken/);
  } finally {
    rm(home);
  }
});

test('codex：mcp list 显示 enabled 只记为 configured，不能冒充 connected', () => {
  const home = tempDir('memory-hostverify-codex-');
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.tabellio]\ncommand = "node"\nargs = []\n', 'utf8');
    let copied = '';
    let seen = null;
    const { run } = fakeRun((bin, args, options) => {
      seen = { bin, args, env: options.env };
      copied = readFileSync(join(options.env.CODEX_HOME, 'config.toml'), 'utf8');
      return {
        status: 0,
        stdout: 'Name      Command  Args  Env  Cwd  Status   Auth\ntabellio  node     -     -    -    enabled  Unsupported\n',
        stderr: '',
      };
    });
    const v = verifyHosts({ hosts: ['codex'], home, env: { PATH: '' }, binaries: { codex: '/fake/codex' }, run });
    assert.equal(v.ok, true);
    assert.equal(v.checked, 1);
    assert.equal(v.hosts[0].level, 'configured');
    assert.equal(v.hosts[0].connection_checked, false);
    assert.match(v.hosts[0].detail, /不提供连接检查/);
    assert.deepEqual(seen.args, ['mcp', 'list']);
    assert.match(seen.env.CODEX_HOME, /tabellio-host-verify-/);
    assert.match(copied, /\[mcp_servers\.tabellio\]/);
  } finally {
    rm(home);
  }
});

test('codex：disabled 是 failed；没有 tabellio 行是 missing', () => {
  const home = tempDir('memory-hostverify-codex-bad-');
  try {
    const disabled = fakeRun(() => ({
      status: 0,
      stdout: 'tabellio  node  -  -  -  disabled  Unsupported\n',
      stderr: '',
    }));
    const v1 = verifyHosts({ hosts: ['codex'], home, env: { PATH: '' }, binaries: { codex: '/fake/codex' }, run: disabled.run });
    assert.equal(v1.ok, false);
    assert.equal(v1.hosts[0].level, 'failed');

    const missing = fakeRun(() => ({ status: 0, stdout: 'Name  Command\n', stderr: '' }));
    const v2 = verifyHosts({ hosts: ['codex'], home, env: { PATH: '' }, binaries: { codex: '/fake/codex' }, run: missing.run });
    assert.equal(v2.ok, false);
    assert.equal(v2.hosts[0].level, 'missing');
  } finally {
    rm(home);
  }
});

test('cursor：没有无头检查就诚实地报 unverified；找不到宿主 CLI 是 unavailable 而非失败', () => {
  const home = tempDir('memory-hostverify-cursor-');
  try {
    const cursor = verifyHosts({ hosts: ['cursor'], home, env: { PATH: '' }, run: fakeRun(() => assert.fail('Cursor 不该被调用')).run });
    assert.equal(cursor.ok, true);
    assert.equal(cursor.checked, 0);
    assert.equal(cursor.hosts[0].level, 'unverified');
    assert.match(cursor.hosts[0].detail, /Cursor 没有无头/);

    const claude = verifyHosts({ hosts: ['claude'], home, env: { PATH: '' }, run: fakeRun(() => assert.fail('不该调用')).run });
    assert.equal(claude.ok, true);
    assert.equal(claude.checked, 0);
    assert.equal(claude.hosts[0].level, 'unavailable');
    assert.match(claude.hosts[0].detail, /没有找到 claude/);
  } finally {
    rm(home);
  }
});
