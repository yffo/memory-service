/**
 * 真实 Claude Code SessionEnd 钩子 E2E：默认跳过。
 *
 * 只验证「钩子真的被宿主调用、配置格式被接受、候选真的落盘」，
 * 不验证 Claude 的回答质量，也不要求已登录——未登录时 -p 会失败，但 SessionEnd 仍会触发。
 * 需要已安装 claude CLI：TABELLIO_HOOK_E2E=1 node --test test/hook-claude-e2e.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'memory');

test('真实 Claude Code：SessionEnd 钩子触发，只写候选，不写主库', (t) => {
  if (process.env.TABELLIO_HOOK_E2E !== '1') {
    return t.skip('设置 TABELLIO_HOOK_E2E=1 才跑真实宿主 E2E');
  }
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return t.skip('claude CLI 不可用');
  }

  const home = tempDir('memory-hook-e2e-');
  try {
    const store = join(home, 'store');
    const settingsPath = join(home, 'settings.json');
    const settings = {
      hooks: {
        SessionEnd: [
          {
            hooks: [
              {
                type: 'command',
                command: process.execPath,
                args: [CLI, 'hook', 'claude-session-end', '--store', store],
                timeout: 15,
              },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    const run = spawnSync(
      'claude',
      [
        '-p',
        '以后都用 pnpm，不要用 npm。只回复：好',
        '--settings',
        settingsPath,
        '--setting-sources',
        'local',
        '--output-format',
        'json',
        '--max-turns',
        '1',
        '--tools',
        '',
      ],
      { cwd: home, encoding: 'utf8', timeout: 120000, env: { ...process.env } },
    );
    assert.equal(run.error, undefined, String(run.error));

    const inbox = spawnSync(process.execPath, [CLI, 'inbox', '--store', store, '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(inbox.status, 0, inbox.stderr);
    const listed = JSON.parse(inbox.stdout);
    assert.equal(listed.count, 1, '宿主触发钩子后应恰好有一条候选：' + (run.stdout || '') + (run.stderr || ''));
    assert.match(listed.candidates[0].source, /^claude:session-end:/);
    assert.equal(listed.candidates[0].title.includes('pnpm'), true);

    const status = spawnSync(process.execPath, [CLI, 'status', '--store', store, '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(status.status, 0, status.stderr);
    const s = JSON.parse(status.stdout);
    assert.equal(s.notes, 0, '钩子不能写主库');
    assert.equal(s.candidates, 1);
    assert.equal(existsSync(join(store, 'notes', 'candidates')), true);

    // 保留候选文件的可读证据，失败时方便排查。
    const candidatePath = listed.candidates[0].path;
    assert.equal(readFileSync(candidatePath, 'utf8').includes('pnpm'), true);
  } finally {
    rm(home);
  }
});
