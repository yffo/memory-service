/**
 * tabellio hook 的 CLI 端到端：安装/卸载，以及 SessionEnd 内部命令落候选。
 *
 * 安全边界：所有安装用例都用 --home 指向临时目录；真实 ~/.claude/settings.json 不碰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'memory');

function cli(args, { store, input } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...(store ? { MEMORY_STORE: store } : {}) },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function settingsPath(home) {
  return join(home, '.claude', 'settings.json');
}

function seedSettings(home) {
  mkdirSync(join(home, '.claude'), { recursive: true });
  const path = settingsPath(home);
  writeFileSync(
    path,
    JSON.stringify(
      {
        env: { SECRET_TOKEN: 'super-secret-value' },
        hooks: {
          SessionEnd: [{ hooks: [{ type: 'command', command: 'echo', args: ['keep-me'] }] }],
        },
      },
      null,
      2,
    ) + '\n',
  );
  return path;
}

test('hook install 默认 dry-run：只预览，不创建 settings，也不输出凭据', () => {
  const home = tempDir('memory-cli-hook-dry-');
  try {
    const store = join(home, 'store');
    const seeded = seedSettings(home);
    const before = readFileSync(seeded, 'utf8');
    const r = cli(['hook', 'install', '--home', home, '--store', store, '--json'], { store });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.action, 'append');
    assert.equal(r.json.would_write, true);
    assert.equal(r.stdout.includes('super-secret-value'), false);
    assert.equal(r.stdout.includes('preview'), false);
    assert.equal(readFileSync(seeded, 'utf8'), before, 'dry-run 不能改文件');
  } finally {
    rm(home);
  }
});

test('hook install --write：追加、保留其他钩子/env、幂等；uninstall 只删自己', () => {
  const home = tempDir('memory-cli-hook-write-');
  try {
    const store = join(home, 'store');
    const seeded = seedSettings(home);
    const first = cli(['hook', 'install', '--home', home, '--store', store, '--write', '--json'], { store });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.written, true);
    assert.equal(first.stdout.includes('super-secret-value'), false);
    assert.equal(existsSync(first.json.backup), true);

    const config = JSON.parse(readFileSync(seeded, 'utf8'));
    assert.equal(config.env.SECRET_TOKEN, 'super-secret-value');
    assert.equal(config.hooks.SessionEnd.length, 2);
    const hook = config.hooks.SessionEnd[1].hooks[0];
    assert.equal(hook.type, 'command');
    assert.equal(hook.timeout, 15);
    assert.deepEqual(hook.args.slice(0, 3), [CLI, 'hook', 'claude-session-end']);
    assert.deepEqual(hook.args.slice(-2), ['--store', store]);

    const again = cli(['hook', 'install', '--home', home, '--store', store, '--write', '--json'], { store });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.action, 'unchanged');
    assert.equal(again.json.written, false);

    const removed = cli(['hook', 'uninstall', '--home', home, '--store', store, '--write', '--json'], { store });
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(removed.json.removed, 1);
    const after = JSON.parse(readFileSync(seeded, 'utf8'));
    assert.equal(after.env.SECRET_TOKEN, 'super-secret-value');
    assert.equal(after.hooks.SessionEnd.length, 1);
    assert.equal(after.hooks.SessionEnd[0].hooks[0].args[0], 'keep-me');
  } finally {
    rm(home);
  }
});

test('hook install：已有别处 store 时先冲突退 1，--force 才替换', () => {
  const home = tempDir('memory-cli-hook-conflict-');
  try {
    const storeA = join(home, 'store-a');
    const storeB = join(home, 'store-b');
    const first = cli(['hook', 'install', '--home', home, '--store', storeA, '--write', '--json'], { store: storeA });
    assert.equal(first.code, 0, first.stderr);

    const conflict = cli(['hook', 'install', '--home', home, '--store', storeB, '--json'], { store: storeB });
    assert.equal(conflict.code, 1);
    assert.equal(conflict.json.ok, false);
    assert.equal(conflict.json.action, 'conflict');

    const forced = cli(
      ['hook', 'install', '--home', home, '--store', storeB, '--write', '--force', '--json'],
      { store: storeB },
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.json.action, 'update');
    const config = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
    assert.deepEqual(config.hooks.SessionEnd[0].hooks[0].args.slice(-2), ['--store', storeB]);
  } finally {
    rm(home);
  }
});

test('hook install --session-start：两个事件都装，uninstall 都清掉', () => {
  const home = tempDir('memory-cli-hook-start-install-');
  try {
    const store = join(home, 'store');
    seedSettings(home);
    const installed = cli(
      ['hook', 'install', '--home', home, '--store', store, '--session-start', '--write', '--json'],
      { store },
    );
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(installed.json.written, true);
    const config = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
    assert.equal(config.hooks.SessionEnd.length, 2);
    assert.equal(config.hooks.SessionStart.length, 1);
    assert.deepEqual(config.hooks.SessionStart[0].hooks[0].args.slice(0, 3), [CLI, 'hook', 'claude-session-start']);

    const again = cli(
      ['hook', 'install', '--home', home, '--store', store, '--session-start', '--write', '--json'],
      { store },
    );
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.action, 'unchanged');

    const removed = cli(['hook', 'uninstall', '--home', home, '--store', store, '--write', '--json'], { store });
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(removed.json.removed, 2);
    const after = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
    assert.equal(after.hooks.SessionEnd.length, 1);
    assert.equal(after.hooks.SessionStart, undefined);
  } finally {
    rm(home);
  }
});

test('hook install --auto-consolidate：SessionEnd 带开关，SessionStart 一并装上', () => {
  const home = tempDir('memory-cli-hook-auto-install-');
  try {
    const store = join(home, 'store');
    const installed = cli(
      ['hook', 'install', '--home', home, '--store', store, '--auto-consolidate', '--write', '--json'],
      { store },
    );
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(installed.json.written, true);
    const config = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
    assert.deepEqual(config.hooks.SessionEnd[0].hooks[0].args.slice(0, 3), [CLI, 'hook', 'claude-session-end']);
    assert.equal(config.hooks.SessionEnd[0].hooks[0].args.at(-1), '--auto-consolidate');
    assert.deepEqual(config.hooks.SessionStart[0].hooks[0].args.slice(0, 3), [CLI, 'hook', 'claude-session-start']);

    const removed = cli(['hook', 'uninstall', '--home', home, '--store', store, '--write', '--json'], { store });
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(removed.json.removed, 2);
  } finally {
    rm(home);
  }
});

test('SessionStart 内部命令：只提示候选数，不写库；无候选/坏事件都退 0', () => {
  const home = tempDir('memory-cli-hook-start-');
  try {
    const store = join(home, 'store');
    const event = { session_id: 's-start', hook_event_name: 'SessionStart', source: 'startup' };
    const empty = cli(['hook', 'claude-session-start', '--store', store, '--json'], {
      store,
      input: JSON.stringify(event),
    });
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal(empty.json.candidates, 0);
    assert.equal(empty.json.prompted, false);
    assert.equal(empty.json.additionalContext, undefined);
    assert.equal(empty.stdout.includes('hookSpecificOutput'), false);

    const file = join(home, 'candidate.md');
    writeFileSync(file, '# 待批准候选\n\n会话开始时应该提示这条。\n');
    const captured = cli(['capture', '--file', file, '--store', store, '--json'], { store });
    assert.equal(captured.code, 0, captured.stderr);

    const prompted = cli(['hook', 'claude-session-start', '--store', store], { store, input: JSON.stringify(event) });
    assert.equal(prompted.code, 0, prompted.stderr);
    assert.equal(prompted.stderr, '');
    const protocol = JSON.parse(prompted.stdout);
    assert.equal(protocol.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(protocol.hookSpecificOutput.additionalContext, /1 条候选待确认/);
    assert.match(protocol.hookSpecificOutput.additionalContext, /tabellio inbox/);
    assert.match(protocol.hookSpecificOutput.additionalContext, /--accept/);

    const debug = cli(['hook', 'claude-session-start', '--store', store, '--json'], {
      store,
      input: JSON.stringify(event),
    });
    assert.equal(debug.code, 0, debug.stderr);
    assert.equal(debug.json.candidates, 1);
    assert.equal(debug.json.prompted, true);
    assert.equal(debug.json.source, 'startup');

    assert.equal(cli(['inbox', '--store', store, '--json'], { store }).json.count, 1, '提示不能批准或删除候选');

    const bad = cli(['hook', 'claude-session-start', '--store', store, '--json'], { store, input: '{' });
    assert.equal(bad.code, 0);
    assert.equal(bad.json.reason, 'invalid_event');
  } finally {
    rm(home);
  }
});

test('SessionStart 内部命令：store 读不了也退 0，不阻塞会话开始', () => {
  const home = tempDir('memory-cli-hook-start-store-');
  try {
    const store = join(home, 'store');
    writeFileSync(store, 'not a directory\n');
    const r = cli(['hook', 'claude-session-start', '--store', store, '--json'], {
      store,
      input: JSON.stringify({ session_id: 's-start-error', hook_event_name: 'SessionStart' }),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.reason, 'store_unreadable');
    assert.equal(r.stderr, '');
  } finally {
    rm(home);
  }
});

test('SessionEnd 内部命令：只写候选，不写主库；重复事件不重复落盘', () => {
  const home = tempDir('memory-cli-hook-capture-');
  try {
    const store = join(home, 'store');
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        sessionId: 's-cli-hook',
        message: { role: 'user', content: '以后都用 pnpm，不要用 npm。' },
      }) + '\n',
    );
    const event = {
      session_id: 's-cli-hook',
      transcript_path: transcript,
      hook_event_name: 'SessionEnd',
      reason: 'other',
    };
    const internal = cli(['hook', 'claude-session-end', '--store', store, '--json'], {
      store,
      input: JSON.stringify(event),
    });
    assert.equal(internal.code, 0, internal.stderr);
    assert.equal(internal.json.ok, true);
    assert.equal(internal.json.captured.length, 1);
    const id = internal.json.captured[0].id;

    const inbox = cli(['inbox', '--store', store, '--json'], { store });
    assert.equal(inbox.code, 0, inbox.stderr);
    assert.equal(inbox.json.count, 1);
    assert.equal(inbox.json.candidates[0].source, 'claude:session-end:s-cli-hook');

    const statusBefore = cli(['status', '--store', store, '--json'], { store });
    assert.equal(statusBefore.json.notes, 0);
    assert.equal(statusBefore.json.candidates, 1);

    const duplicate = cli(['hook', 'claude-session-end', '--store', store, '--json'], {
      store,
      input: JSON.stringify(event),
    });
    assert.equal(duplicate.code, 0);
    assert.equal(duplicate.json.captured.length, 0);
    assert.equal(duplicate.json.rejected[0].reason, 'duplicate');
    assert.equal(cli(['status', '--store', store, '--json'], { store }).json.candidates, 1);

    const accept = cli(['inbox', '--accept', id, '--store', store, '--json'], { store });
    assert.equal(accept.code, 0, accept.stderr);
    assert.equal(accept.json.accepted_count, 1);
    const statusAfter = cli(['status', '--store', store, '--json'], { store });
    assert.equal(statusAfter.json.notes, 1);
    assert.equal(statusAfter.json.candidates, 0);
  } finally {
    rm(home);
  }
});

test('SessionEnd --auto-consolidate：没有可抓线索也自动发现近似笔记，只写提案', () => {
  const home = tempDir('memory-cli-hook-auto-sweep-');
  try {
    const store = join(home, 'store');
    const common =
      '项目约定：所有构建都从仓库根目录执行，安装依赖统一用 pnpm，提交前必须跑全量测试，发布走 GitHub Actions。';
    const notes = [
      ['a.md', '构建约定 A', common + ' 文档统一放 docs 目录。'],
      ['b.md', '构建约定 B', common + ' 文档统一放 docs 目录，变更写 CHANGELOG。'],
    ];
    for (const [name, title, body] of notes) {
      const file = join(home, name);
      writeFileSync(
        file,
        ['---', 'kind: semantic', 'trust: user_stated', '---', '', '# ' + title, '', body, ''].join('\n'),
      );
      const remembered = cli(['remember', '--file', file, '--store', store, '--json'], { store });
      assert.equal(remembered.code, 0, remembered.stderr);
    }

    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        sessionId: 's-auto-sweep',
        message: { role: 'user', content: '今天先把 README 看一遍。' },
      }) + '\n',
    );
    const event = {
      session_id: 's-auto-sweep',
      transcript_path: transcript,
      hook_event_name: 'SessionEnd',
      reason: 'other',
    };
    const r = cli(['hook', 'claude-session-end', '--store', store, '--auto-consolidate', '--json'], {
      store,
      input: JSON.stringify(event),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.captured.length, 0, '闲聊不产生候选');
    assert.equal(r.json.proposals.created, 1);
    assert.equal(r.json.proposals.failed, 0);

    const status = cli(['status', '--store', store, '--json'], { store });
    assert.equal(status.json.notes, 2, '自动发现不改正式笔记');
    assert.equal(status.json.candidates, 0);
    assert.equal(status.json.proposals, 1);

    const start = cli(['hook', 'claude-session-start', '--store', store], {
      store,
      input: JSON.stringify({ session_id: 's-auto-sweep', hook_event_name: 'SessionStart' }),
    });
    assert.equal(start.code, 0, start.stderr);
    const protocol = JSON.parse(start.stdout);
    assert.match(protocol.hookSpecificOutput.additionalContext, /1 条自动巩固提案/);
    assert.match(protocol.hookSpecificOutput.additionalContext, /tabellio inbox/);
  } finally {
    rm(home);
  }
});

test('SessionEnd 内部命令：密钥句不进候选；缺 transcript 也退 0', () => {
  const home = tempDir('memory-cli-hook-secret-');
  try {
    const store = join(home, 'store');
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        sessionId: 's-secret',
        message: { role: 'user', content: '记住我的 token 是 sk-1234567890abcdef12345678。' },
      }) + '\n',
    );
    const secret = cli(['hook', 'claude-session-end', '--store', store, '--json'], {
      store,
      input: JSON.stringify({ session_id: 's-secret', transcript_path: transcript }),
    });
    assert.equal(secret.code, 0, secret.stderr);
    assert.equal(secret.json.captured.length, 0);
    assert.ok(secret.json.stats.secret >= 1);
    assert.equal(cli(['inbox', '--store', store, '--json'], { store }).json.count, 0);

    const missing = cli(['hook', 'claude-session-end', '--store', store, '--json'], {
      store,
      input: JSON.stringify({ session_id: 's-missing', transcript_path: join(home, 'nope.jsonl') }),
    });
    assert.equal(missing.code, 0);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.reason, 'transcript_missing');

    const bad = cli(['hook', 'claude-session-end', '--store', store, '--json'], { store, input: '{' });
    assert.equal(bad.code, 0);
    assert.equal(bad.json.reason, 'invalid_event');
  } finally {
    rm(home);
  }
});

test('SessionEnd 内部命令：store 不可写也退 0，不阻塞宿主退出', () => {
  const home = tempDir('memory-cli-hook-store-error-');
  try {
    const store = join(home, 'store');
    writeFileSync(store, 'not a directory\n');
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        sessionId: 's-store-error',
        message: { role: 'user', content: '以后都用 pnpm，不要用 npm。' },
      }) + '\n',
    );
    const r = cli(['hook', 'claude-session-end', '--store', store, '--json'], {
      store,
      input: JSON.stringify({ session_id: 's-store-error', transcript_path: transcript }),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, 'store_write_failed');
    assert.equal(r.json.captured.length, 0);
    assert.equal(r.stderr, '');
  } finally {
    rm(home);
  }
});

test('hook 用法错误退 2：未知子命令 / 参数缺值', () => {
  const unknown = cli(['hook', 'nope']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /hook 需要/);

  const missingHost = cli(['hook', 'install', '--host']);
  assert.equal(missingHost.code, 2);
  assert.match(missingHost.stderr, /参数缺值/);
});
