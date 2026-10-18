/**
 * tabellio doctor：只读体检。
 *
 * 断言的重点不是文案，而是：
 *  - 不建库、不写配置、不修索引；
 *  - 发现解析失败/宿主冲突时退出 1，普通待办只给建议；
 *  - --verify 才调用宿主 CLI，且沿用 hostverify 的分级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';
import { openStore, remember, addCandidate } from '../src/api.js';
import { buildDoctorReport } from '../src/doctor.js';
import { applyHookInstall, claudeSettingsPath, planHookInstall } from '../src/hooks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'memory');

function cli(args, { store, env } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
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

function reportOf(dir, extra = {}) {
  const ctx = openStore(join(dir, 'store'));
  return buildDoctorReport({
    ctx,
    bin: '/tmp/tabellio',
    mcpBin: '/tmp/tabellio-mcp',
    home: join(dir, 'home'),
    platform: 'linux',
    ...extra,
  });
}

function writeServerConfig(home, store, server) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { tabellio: server } }, null, 2) + '\n');
}

test('doctor：空库只读体检，不创建任何目录，给出建库/宿主/定时建议', () => {
  const dir = tempDir('memory-doctor-empty-');
  try {
    const report = reportOf(dir);
    assert.equal(report.ok, true);
    assert.equal(report.store.exists, false);
    assert.equal(existsSync(join(dir, 'store')), false, 'doctor 不能 ensure 建库');
    assert.deepEqual(report.hosts.detected, []);
    assert.equal(report.hook, null);
    assert.equal(report.schedule.supported, false);
    assert.equal(report.actions.some((a) => a.id === 'store:empty'), true);
    assert.equal(report.actions.some((a) => a.id === 'host:none'), true);
  } finally {
    rm(dir);
  }
});

test('doctor：笔记和待批准候选都算进报告，候选只给 warn 不改变退出码', () => {
  const dir = tempDir('memory-doctor-pending-');
  try {
    const ctx = openStore(join(dir, 'store'));
    const note = remember(ctx, {
      text: '---\nkind: semantic\ntrust: user_stated\n---\n\n# 构建命令\n\n构建从仓库根目录执行。\n',
      writtenBy: 'test:doctor',
    });
    assert.equal(note.ok, true, note.reason);
    const candidate = addCandidate(ctx, { text: '# 候选\n\n这条还没批准。', source: 'test:doctor' });
    assert.equal(candidate.ok, true, candidate.reason);

    const report = reportOf(dir);
    assert.equal(report.store.notes, 1);
    assert.equal(report.store.candidates, 1);
    assert.equal(report.ok, true);
    const pending = report.actions.find((a) => a.id === 'inbox:pending');
    assert.equal(pending?.severity, 'warn');
    assert.match(pending.title, /候选/);
  } finally {
    rm(dir);
  }
});

test('doctor：宿主配置已指向当前库时不再提 setup；冲突时报告为错误', () => {
  const dir = tempDir('memory-doctor-host-');
  try {
    const store = join(dir, 'store');
    const home = join(dir, 'home');
    const server = { command: '/usr/bin/node', args: ['/tmp/tabellio-mcp', '--store', store, '--allow-write'] };
    writeServerConfig(home, store, server);

    const okReport = reportOf(dir, { command: '/usr/bin/node' });
    assert.deepEqual(okReport.hosts.detected, ['claude']);
    assert.equal(okReport.hosts.items[0].action, 'unchanged');
    assert.equal(okReport.actions.some((a) => a.id === 'host:claude'), false);

    writeServerConfig(home, store, { command: '/usr/bin/node', args: ['/tmp/other-mcp', '--store', '/tmp/other'] });
    const conflict = reportOf(dir, { command: '/usr/bin/node', verify: true, run: () => { throw new Error('不应验证旧配置'); } });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.hosts.verification, undefined, '配置不匹配时不应拿旧配置去验证');
    const action = conflict.actions.find((a) => a.id === 'host:claude');
    assert.equal(action?.severity, 'error');
    assert.match(action.command, /--force/);
  } finally {
    rm(dir);
  }
});

test('doctor：Claude 钩子已装齐时识别出 SessionEnd/SessionStart/自动发现', () => {
  const dir = tempDir('memory-doctor-hook-');
  try {
    const store = join(dir, 'store');
    const home = join(dir, 'home');
    const bin = '/tmp/tabellio';
    const applied = applyHookInstall(planHookInstall({
      home,
      bin,
      store,
      command: '/usr/bin/node',
      events: ['session-end', 'session-start'],
      autoConsolidate: true,
    }));
    assert.equal(applied.ok, true);
    assert.equal(existsSync(claudeSettingsPath(home)), true);

    const report = reportOf(dir, { bin, command: '/usr/bin/node' });
    assert.equal(report.hook.ok, true);
    assert.equal(report.hook.session_end, true);
    assert.equal(report.hook.session_start, true);
    assert.equal(report.hook.auto_consolidate, true);
    assert.equal(report.hook.matches_current, true);
    assert.equal(report.actions.some((a) => String(a.id).startsWith('hook:')), false);
  } finally {
    rm(dir);
  }
});

test('doctor --verify：只在显式要求时调用宿主 CLI，并沿用 connected/failed 分级', () => {
  const dir = tempDir('memory-doctor-verify-');
  try {
    const store = join(dir, 'store');
    const home = join(dir, 'home');
    writeServerConfig(home, store, { command: '/usr/bin/node', args: ['/tmp/tabellio-mcp', '--store', store, '--allow-write'] });
    let calls = 0;
    const run = (bin, args) => {
      calls += 1;
      assert.equal(bin, '/bin/sh');
      assert.deepEqual(args, ['mcp', 'list']);
      return { status: 0, stdout: 'tabellio: /usr/bin/node /tmp/tabellio-mcp - ✓ Connected\n', stderr: '' };
    };
    const report = reportOf(dir, { command: '/usr/bin/node', verify: true, env: { TABELLIO_CLAUDE_BIN: '/bin/sh' }, run });
    assert.equal(calls, 1);
    assert.equal(report.hosts.verification.ok, true);
    assert.equal(report.hosts.verification.hosts[0].level, 'connected');
  } finally {
    rm(dir);
  }
});

test('doctor CLI：空库退 0，输出可机读；不写库', () => {
  const dir = tempDir('memory-doctor-cli-');
  try {
    const store = join(dir, 'store');
    const home = join(dir, 'home');
    const r = cli(['doctor', '--store', store, '--home', home, '--json'], {
      env: { TABELLIO_SCHEDULE_PLATFORM: 'linux' },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.store.exists, false);
    assert.equal(r.json.schedule.supported, false);
    assert.equal(existsSync(store), false);
  } finally {
    rm(dir);
  }
});

test('doctor CLI：解析失败算错误，退 1；建议里直接给 status 命令', () => {
  const dir = tempDir('memory-doctor-bad-');
  try {
    const store = join(dir, 'store');
    const home = join(dir, 'home');
    mkdirSync(join(store, 'notes'), { recursive: true });
    writeFileSync(join(store, 'notes', 'bad.md'), 'not a note\n');
    const r = cli(['doctor', '--store', store, '--home', home, '--json'], {
      env: { TABELLIO_SCHEDULE_PLATFORM: 'linux' },
    });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.store.parse_failures, 1);
    const action = r.json.actions.find((a) => a.id === 'store:parse-failures');
    assert.equal(action?.severity, 'error');
    assert.match(action.command, /tabellio status/);
  } finally {
    rm(dir);
  }
});


test('doctor CLI：宿主配置里的 env/token 不出现在报告里', () => {
  const dir = tempDir('memory-doctor-secret-');
  try {
    const store = join(dir, 'store');
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      env: { SECRET_TOKEN: 'super-secret-value' },
      mcpServers: {
        tabellio: { command: '/usr/bin/node', args: ['/tmp/old-mcp'], env: { TOKEN: 'super-secret-value' } },
        other: { command: 'other', env: { TOKEN: 'super-secret-value' } },
      },
    }, null, 2) + '\n');
    const r = cli(['doctor', '--store', store, '--home', home, '--json'], {
      env: { TABELLIO_SCHEDULE_PLATFORM: 'linux' },
    });
    assert.equal(r.stdout.includes('super-secret-value'), false);
    assert.equal(r.json.hosts.items[0].action, 'conflict');
  } finally {
    rm(dir);
  }
});

test('doctor CLI：--home 缺值退 2', () => {
  const r = cli(['doctor', '--home', '--json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--home/);
});
