/**
 * tabellio schedule 的 CLI 端到端：默认 dry-run、写 plist、假 launchctl 加载/失败/卸载。
 *
 * 安全边界：所有用例都把 --home 指向临时目录，并用 TABELLIO_LAUNCHCTL_BIN
 * 指向假的 launchctl；真实 ~/Library/LaunchAgents 和 launchd 不碰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'memory');

function cli(args, { store, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TABELLIO_SCHEDULE_PLATFORM: 'darwin',
      ...(store ? { MEMORY_STORE: store } : {}),
      ...(env ?? {}),
    },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function launchctlScript(home, { failBootstrap = false, log } = {}) {
  const path = join(home, 'fake-launchctl');
  const logPath = log ?? join(home, 'launchctl.log');
  const body = [
    '#!/bin/sh',
    'printf "%s\\n" "$@" >> "' + logPath + '"',
    ...(failBootstrap
      ? ['if [ "$1" = "bootstrap" ]; then', '  echo "Bootstrap failed: 5: Input/output error" >&2', '  exit 1', 'fi']
      : []),
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
  return { path, logPath };
}

test('schedule install 默认 dry-run：只预览，不创建 plist、不调 launchctl', () => {
  const home = tempDir('memory-cli-schedule-dry-');
  try {
    const store = join(home, 'store');
    const fake = launchctlScript(home);
    const r = cli(['schedule', 'install', '--home', home, '--store', store, '--json'], {
      store,
      env: { TABELLIO_LAUNCHCTL_BIN: fake.path },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.action, 'create');
    assert.equal(r.json.would_write, true);
    assert.equal(existsSync(r.json.path), false);
    assert.equal(existsSync(fake.logPath), false);
    assert.match(r.json.preview, /--auto/);
  } finally {
    rm(home);
  }
});

test('schedule install --write：写 plist 并加载；status 读到已加载；重复安装是 unchanged', () => {
  const home = tempDir('memory-cli-schedule-write-');
  try {
    const store = join(home, 'store');
    const fake = launchctlScript(home);
    const env = { TABELLIO_LAUNCHCTL_BIN: fake.path };
    const r = cli(['schedule', 'install', '--home', home, '--store', store, '--write', '--json'], { store, env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.written, true);
    assert.equal(r.json.loaded, true);
    assert.equal(existsSync(r.json.path), true);
    assert.match(readFileSync(r.json.path, 'utf8'), /consolidate/);

    const log = readFileSync(fake.logPath, 'utf8').trim().split('\n');
    assert.deepEqual(log, ['bootout', 'gui/' + process.getuid() + '/io.github.yffo.tabellio.sweep', 'bootstrap', 'gui/' + process.getuid(), r.json.path]);

    const status = cli(['schedule', 'status', '--home', home, '--json'], { env });
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.json.installed, true);
    assert.equal(status.json.loaded, true);
    assert.equal(status.json.interval_minutes, 360);
    assert.equal(status.json.store, store);

    const again = cli(['schedule', 'install', '--home', home, '--store', store, '--write', '--json'], { store, env });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.action, 'unchanged');
    assert.equal(again.json.written, false);
    assert.equal(again.json.loaded, true);
  } finally {
    rm(home);
  }
});

test('schedule install --write：launchctl 加载失败退 1，但 plist 保留', () => {
  const home = tempDir('memory-cli-schedule-loadfail-');
  try {
    const store = join(home, 'store');
    const fake = launchctlScript(home, { failBootstrap: true });
    const r = cli(['schedule', 'install', '--home', home, '--store', store, '--write', '--json'], {
      store,
      env: { TABELLIO_LAUNCHCTL_BIN: fake.path },
    });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, 'load_failed');
    assert.equal(r.json.written, true);
    assert.equal(r.json.loaded, false);
    assert.equal(existsSync(r.json.path), true);
  } finally {
    rm(home);
  }
});

test('schedule uninstall --write：卸载并删除 plist；再卸一次是 unchanged', () => {
  const home = tempDir('memory-cli-schedule-uninstall-');
  try {
    const store = join(home, 'store');
    const fake = launchctlScript(home);
    const env = { TABELLIO_LAUNCHCTL_BIN: fake.path };
    const installed = cli(['schedule', 'install', '--home', home, '--store', store, '--write', '--json'], { store, env });
    assert.equal(installed.code, 0, installed.stderr);
    const path = installed.json.path;

    const r = cli(['schedule', 'uninstall', '--home', home, '--write', '--json'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.removed, true);
    assert.equal(existsSync(path), false);

    const again = cli(['schedule', 'uninstall', '--home', home, '--write', '--json'], { env });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.action, 'unchanged');
    assert.equal(again.json.reason, 'not_installed');
  } finally {
    rm(home);
  }
});

test('schedule --interval 解析与参数错误退 2', () => {
  const home = tempDir('memory-cli-schedule-interval-');
  try {
    const store = join(home, 'store');
    const fake = launchctlScript(home);
    const env = { TABELLIO_LAUNCHCTL_BIN: fake.path };
    const halfHour = cli(['schedule', 'install', '--home', home, '--store', store, '--interval', '30m', '--write', '--json'], { store, env });
    assert.equal(halfHour.code, 0, halfHour.stderr);
    assert.equal(halfHour.json.interval_minutes, 30);

    for (const args of [
      ['schedule', 'install', '--home', home, '--store', store, '--interval', '5m'],
      ['schedule', 'install', '--home', home, '--store', store, '--interval'],
      ['schedule', 'install', '--home'],
      ['schedule', 'nope'],
    ]) {
      const r = cli(args, { store, env });
      assert.equal(r.code, 2, args.join(' '));
    }
  } finally {
    rm(home);
  }
});

test('schedule status：没装时退 0 并说明；不支持的平台明确说只支持 macOS', () => {
  const home = tempDir('memory-cli-schedule-status-');
  try {
    const missing = cli(['schedule', 'status', '--home', home, '--json']);
    assert.equal(missing.code, 0, missing.stderr);
    assert.equal(missing.json.installed, false);
    assert.equal(missing.json.loaded, false);

    const unsupported = cli(['schedule', 'status', '--home', home, '--json'], {
      env: { TABELLIO_SCHEDULE_PLATFORM: 'linux' },
    });
    assert.equal(unsupported.code, 0, unsupported.stderr);
    assert.equal(unsupported.json.supported, false);
    assert.equal(unsupported.json.reason, 'unsupported_platform');

    const install = cli(['schedule', 'install', '--home', home, '--store', join(home, 'store'), '--json'], {
      env: { TABELLIO_SCHEDULE_PLATFORM: 'linux' },
    });
    assert.equal(install.code, 1);
    assert.equal(install.json.reason, 'unsupported_platform');
  } finally {
    rm(home);
  }
});
