/**
 * 真实宿主的 E2E（默认跳过；必须显式打开）。
 *
 * 为什么不让它进默认 npm test：它依赖本机装没装 Claude Code / Codex，且 `claude mcp list`
 * 会真的 spawn 我们的 MCP server。默认跑会让 CI 变成「环境检测」，而不是「代码检测」。
 *
 * 跑法：TABELLIO_HOST_E2E=1 node --test test/host-e2e.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'memory');
const ENABLED = process.env.TABELLIO_HOST_E2E === '1';

function cli(args, { env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}) },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function findOnPath(name) {
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

test('真实宿主：Claude 真连接、Codex 真解析、Cursor 只做配置检查', { skip: ENABLED ? false : '设置 TABELLIO_HOST_E2E=1 才跑' }, (t) => {
  const claude = findOnPath('claude') ?? ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find((p) => existsSync(p));
  if (!claude) {
    t.skip('本机没有 Claude Code');
    return;
  }
  const codex = findOnPath('codex') ?? ['/Applications/Codex.app/Contents/Resources/codex'].find((p) => existsSync(p));
  const home = tempDir('memory-host-e2e-');
  try {
    const store = join(home, 'store');

    const claudeRun = cli(['setup', '--home', home, '--store', store, '--host', 'claude', '--write', '--verify', '--json'], {
      env: { TABELLIO_CLAUDE_BIN: claude },
    });
    assert.equal(claudeRun.code, 0, claudeRun.stderr + '\n' + claudeRun.stdout);
    assert.equal(claudeRun.json.verification.hosts[0].level, 'connected', JSON.stringify(claudeRun.json.verification));
    assert.equal(claudeRun.json.verification.hosts[0].connection_checked, true);

    if (codex) {
      const codexHome = tempDir('memory-host-e2e-codex-');
      try {
        const codexStore = join(codexHome, 'store');
        const codexRun = cli(['setup', '--home', codexHome, '--store', codexStore, '--host', 'codex', '--write', '--verify', '--json'], {
          env: { TABELLIO_CODEX_BIN: codex },
        });
        assert.equal(codexRun.code, 0, codexRun.stderr + '\n' + codexRun.stdout);
        assert.equal(codexRun.json.verification.hosts[0].level, 'configured', JSON.stringify(codexRun.json.verification));
        assert.equal(codexRun.json.verification.hosts[0].connection_checked, false);
      } finally {
        rm(codexHome);
      }
    }

    const cursorRun = cli(['setup', '--home', home, '--store', store, '--host', 'cursor', '--write', '--verify', '--json'], {
      env: { TABELLIO_CLAUDE_BIN: claude },
    });
    assert.equal(cursorRun.code, 0, cursorRun.stderr + '\n' + cursorRun.stdout);
    assert.equal(cursorRun.json.verification.hosts[0].level, 'unverified');
    assert.equal(existsSync(join(home, '.cursor', 'mcp.json')), true);
  } finally {
    rm(home);
  }
});
