/**
 * 定时自动发现（macOS launchd）：计划/应用/状态。
 *
 * 这些用例只碰临时 HOME 和假的 launchctl，不写真实的
 * ~/Library/LaunchAgents，也不去加载任何 launchd 任务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, rm } from './helpers.mjs';
import {
  SCHEDULE_DEFAULT_INTERVAL_MINUTES,
  SCHEDULE_LABEL,
  applyScheduleInstall,
  parseIntervalMinutes,
  planScheduleInstall,
  renderSchedulePlist,
  schedulePaths,
  scheduleStatus,
} from '../src/schedule.js';

function fakeRun(handler) {
  const calls = [];
  const run = (bin, args, options) => {
    calls.push({ bin, args, options });
    return handler ? handler(bin, args, options) : { status: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
}

function basePlan(home, overrides = {}) {
  return planScheduleInstall({
    platform: 'darwin',
    home,
    bin: join(home, 'bin', 'memory'),
    store: join(home, 'store'),
    command: '/usr/local/bin/node',
    ...overrides,
  });
}

test('schedule plan：默认只算不写，plist 是每 6 小时一次的 consolidate --auto --write', () => {
  const home = tempDir('memory-schedule-plan-');
  try {
    const plan = basePlan(home);
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(plan.action, 'create');
    assert.equal(plan.would_write, true);
    assert.equal(plan.interval_minutes, SCHEDULE_DEFAULT_INTERVAL_MINUTES);
    assert.equal(existsSync(plan.path), false);
    assert.match(plan.preview, /<string>io\.github\.yffo\.tabellio\.sweep<\/string>/);
    assert.match(plan.preview, /<integer>21600<\/integer>/);
    assert.match(plan.preview, /<string>consolidate<\/string>/);
    assert.match(plan.preview, /<string>--auto<\/string>/);
    assert.match(plan.preview, /<string>--write<\/string>/);
    assert.match(plan.preview, /<string>--store<\/string>/);
    assert.match(plan.preview, /<string>--json<\/string>/);
    assert.match(plan.preview, /<false\/>/);
    assert.equal(plan.program_arguments[0], '/usr/local/bin/node');
    assert.equal(plan.program_arguments[1], join(home, 'bin', 'memory'));
  } finally {
    rm(home);
  }
});

test('schedule apply：写 plist / 建日志目录 / 先 bootout 再 bootstrap', () => {
  const home = tempDir('memory-schedule-apply-');
  try {
    const plan = basePlan(home);
    const run = fakeRun();
    const applied = applyScheduleInstall(plan, { run, uid: 501, launchctl: '/fake/launchctl', env: {} });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.written, true);
    assert.equal(applied.loaded, true);
    assert.equal(existsSync(plan.path), true);
    assert.equal(existsSync(plan.log_dir), true);
    assert.equal(readFileSync(plan.path, 'utf8'), plan.preview);
    assert.deepEqual(run.calls.map((call) => call.args), [
      ['bootout', 'gui/501/' + SCHEDULE_LABEL],
      ['bootstrap', 'gui/501', plan.path],
    ]);
    assert.equal(run.calls[0].bin, '/fake/launchctl');
  } finally {
    rm(home);
  }
});

test('schedule apply：相同配置不改文件；已加载就不再 bootstrap', () => {
  const home = tempDir('memory-schedule-unchanged-');
  try {
    const first = basePlan(home);
    applyScheduleInstall(first, { run: fakeRun(), uid: 501, launchctl: 'launchctl', env: {} });
    const again = basePlan(home);
    assert.equal(again.action, 'unchanged');
    assert.equal(again.would_write, false);
    const run = fakeRun();
    const applied = applyScheduleInstall(again, { run, uid: 501, launchctl: 'launchctl', env: {} });
    assert.equal(applied.ok, true);
    assert.equal(applied.written, false);
    assert.equal(applied.loaded, true);
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.calls[0].args, ['print', 'gui/501/' + SCHEDULE_LABEL]);
  } finally {
    rm(home);
  }
});

test('schedule apply：已有不同 plist 不 --force 拒绝，--force 才备份并替换', () => {
  const home = tempDir('memory-schedule-conflict-');
  try {
    const first = basePlan(home);
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(first.path, 'old plist\n', 'utf8');
    const conflict = basePlan(home);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.action, 'conflict');
    const refused = applyScheduleInstall(conflict, { run: fakeRun(), uid: 501, launchctl: 'launchctl', env: {} });
    assert.equal(refused.ok, false);
    assert.equal(readFileSync(first.path, 'utf8'), 'old plist\n');

    const forced = basePlan(home, { force: true });
    assert.equal(forced.action, 'update');
    assert.ok(forced.backup);
    const applied = applyScheduleInstall(forced, { run: fakeRun(), uid: 501, launchctl: 'launchctl', env: {} });
    assert.equal(applied.ok, true);
    assert.equal(readFileSync(first.path, 'utf8'), forced.preview);
    assert.equal(readFileSync(forced.backup, 'utf8'), 'old plist\n');
  } finally {
    rm(home);
  }
});

test('schedule apply：launchctl 加载失败时 plist 保留，结果明确说未加载', () => {
  const home = tempDir('memory-schedule-loadfail-');
  try {
    const plan = basePlan(home);
    const run = fakeRun((bin, args) => {
      if (args[0] === 'bootstrap') return { status: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const applied = applyScheduleInstall(plan, { run, uid: 501, launchctl: 'launchctl', env: {} });
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, 'load_failed');
    assert.equal(applied.written, true);
    assert.equal(applied.loaded, false);
    assert.equal(existsSync(plan.path), true);
    assert.match(applied.error, /Bootstrap failed/);
  } finally {
    rm(home);
  }
});

test('schedule uninstall：卸载后删除 plist；本来没装就是 unchanged', () => {
  const home = tempDir('memory-schedule-uninstall-');
  try {
    const absent = basePlan(home, { uninstall: true });
    assert.equal(absent.action, 'unchanged');
    assert.equal(absent.reason, 'not_installed');
    const first = basePlan(home);
    applyScheduleInstall(first, { run: fakeRun(), uid: 501, launchctl: 'launchctl', env: {} });
    const plan = basePlan(home, { uninstall: true });
    assert.equal(plan.action, 'uninstall');
    const run = fakeRun();
    const applied = applyScheduleInstall(plan, { run, uid: 501, launchctl: 'launchctl', env: {} });
    assert.equal(applied.ok, true);
    assert.equal(applied.removed, true);
    assert.equal(existsSync(plan.path), false);
    assert.deepEqual(run.calls.map((call) => call.args), [['bootout', 'gui/501/' + SCHEDULE_LABEL]]);
  } finally {
    rm(home);
  }
});

test('schedule status：没装 / 装了并加载 / 装了但 launchctl 找不到', () => {
  const home = tempDir('memory-schedule-status-');
  try {
    const missing = scheduleStatus({ platform: 'darwin', home, run: fakeRun(), uid: 501, env: {} });
    assert.equal(missing.installed, false);
    assert.equal(missing.loaded, false);

    const plan = basePlan(home);
    applyScheduleInstall(plan, { run: fakeRun(), uid: 501, launchctl: 'launchctl', env: {} });
    const loaded = scheduleStatus({ platform: 'darwin', home, run: fakeRun(), uid: 501, env: {} });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.installed, true);
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.interval_minutes, 360);
    assert.equal(loaded.store, join(home, 'store'));

    const noService = fakeRun(() => ({ status: 113, stdout: '', stderr: 'Could not find service "io.github.yffo.tabellio.sweep" in domain for user gui: 501' }));
    const notLoaded = scheduleStatus({ platform: 'darwin', home, run: noService, uid: 501, env: {} });
    assert.equal(notLoaded.checked, true);
    assert.equal(notLoaded.loaded, false);

    const unavailable = fakeRun(() => ({ status: -1, stdout: '', stderr: '', error: new Error('spawnSync launchctl ENOENT') }));
    const noCli = scheduleStatus({ platform: 'darwin', home, run: unavailable, uid: 501, env: {} });
    assert.equal(noCli.checked, false);
    assert.equal(noCli.loaded, false);
    assert.equal(noCli.error, 'launchctl_unavailable');
  } finally {
    rm(home);
  }
});

test('schedule plan：平台/路径/间隔/XML 转义都有明确拒绝或输出', () => {
  const home = tempDir('memory-schedule-invalid-');
  try {
    assert.equal(basePlan(home, { platform: 'linux' }).reason, 'unsupported_platform');
    assert.equal(basePlan(home, { bin: 'memory' }).reason, 'invalid_path');
    assert.equal(basePlan(home, { command: 'node' }).reason, 'invalid_command');
    assert.equal(basePlan(home, { intervalMinutes: 5 }).reason, 'invalid_interval');
    assert.equal(parseIntervalMinutes('6h'), 360);
    assert.equal(parseIntervalMinutes('30m'), 30);
    assert.equal(parseIntervalMinutes('1d'), 1440);
    assert.equal(parseIntervalMinutes('360'), 360);
    assert.equal(parseIntervalMinutes('14m'), null);
    assert.equal(parseIntervalMinutes('8d'), null);
    assert.equal(parseIntervalMinutes('soon'), null);

    const paths = schedulePaths({ home, platform: 'darwin' });
    const plist = renderSchedulePlist({
      home: join(home, 'a&b'),
      command: '/usr/local/bin/node',
      bin: join(home, 'bin', 'memory'),
      store: join(home, 'a&b', 'store'),
      intervalMinutes: 60,
      outLog: paths.out_log,
      errLog: paths.err_log,
    });
    assert.match(plist, /a&amp;b/);
    assert.match(plist, /<integer>3600<\/integer>/);
  } finally {
    rm(home);
  }
});
