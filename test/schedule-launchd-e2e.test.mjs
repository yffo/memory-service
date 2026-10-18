/**
 * 真实 launchd 的 gated E2E：plist 必须被系统接受，不能只靠假 launchctl 自证。
 *
 * 默认跳过；显式 TABELLIO_SCHEDULE_E2E=1 才跑，且只使用临时 HOME、临时 label，
 * 装完立刻卸载，不碰用户真实的 tabellio 定时任务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';
import { applyScheduleInstall, planScheduleInstall, scheduleStatus } from '../src/schedule.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'memory');
const enabled = process.env.TABELLIO_SCHEDULE_E2E === '1' && process.platform === 'darwin';

test('schedule E2E：真实 launchctl 接受 plist，status 看到 loaded，随后可卸载', { skip: !enabled }, () => {
  const home = tempDir('memory-schedule-e2e-');
  const label = 'io.github.yffo.tabellio.sweep.e2e.' + process.pid;
  const store = join(home, 'store');
  const base = { platform: 'darwin', home, label, bin: CLI, store, command: process.execPath };
  try {
    const plan = planScheduleInstall(base);
    assert.equal(plan.ok, true, plan.reason);
    try {
      const applied = applyScheduleInstall(plan);
      assert.equal(applied.ok, true, applied.error || applied.reason);
      assert.equal(applied.loaded, true);
      assert.equal(existsSync(plan.path), true);
      const status = scheduleStatus({ platform: 'darwin', home, label });
      assert.equal(status.installed, true);
      assert.equal(status.loaded, true, status.detail || status.error);
      assert.equal(status.interval_minutes, 360);
    } finally {
      const uninstall = planScheduleInstall({ ...base, uninstall: true });
      const removed = applyScheduleInstall(uninstall);
      assert.equal(removed.ok, true, removed.error || removed.reason);
    }
    assert.equal(existsSync(plan.path), false);
  } finally {
    rm(home);
  }
});
