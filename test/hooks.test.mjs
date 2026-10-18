/**
 * 会话结束钩子：安装计划 / transcript 解析 / 线索提取。
 *
 * 这些用例只碰临时 HOME 和临时 store，绝不读写真实的 ~/.claude/settings.json。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, rm } from './helpers.mjs';
import {
  HOOK_EVENTS,
  HOOK_TIMEOUT_SECONDS,
  applyHookInstall,
  buildCandidateBody,
  claudeSettingsPath,
  extractMemoryCandidates,
  parseTranscript,
  planHookInstall,
} from '../src/hooks.js';

function transcript(...records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function user(text, { sessionId = 'session-1', sidechain = false, content } = {}) {
  return {
    type: 'user',
    ...(sidechain ? { isSidechain: true } : {}),
    sessionId,
    message: { role: 'user', content: content ?? text },
  };
}

function assistant(text, { sessionId = 'session-1' } = {}) {
  return { type: 'assistant', sessionId, message: { role: 'assistant', content: text } };
}

test('parseTranscript：只取真实用户文本，跳过 sidechain / assistant / tool_result / 坏行', () => {
  const text = [
    '这行不是 JSON',
    JSON.stringify({ type: 'queue-operation', content: '记住队列里的东西' }),
    JSON.stringify(assistant('记住：assistant 说不算')),
    JSON.stringify(user('今天天气不错。', { sessionId: 's1' })),
    JSON.stringify(user('记住 sidechain 的东西。', { sessionId: 's1', sidechain: true })),
    JSON.stringify(
      user(null, {
        sessionId: 's2',
        content: [
          { type: 'tool_result', content: '记住 tool_result 里的东西' },
          { type: 'text', text: '以后都用 pnpm。' },
        ],
      }),
    ),
    JSON.stringify(user('<system-reminder>注入的提醒</system-reminder>以后不要用 npm。', { sessionId: 's2' })),
  ].join('\n');

  const parsed = parseTranscript(text);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((item) => item.text), ['今天天气不错。', '以后都用 pnpm。', '以后不要用 npm。']);
  assert.equal(parsed[1].session_id, 's2');
});

test('extractMemoryCandidates：抓到「以后…」偏好，候选正文自带可读标题', () => {
  const result = extractMemoryCandidates(transcript(user('以后都用 pnpm，不要用 npm。', { sessionId: 's-pref' })));
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.cue, 'future');
  assert.equal(candidate.session_id, 's-pref');
  assert.match(candidate.title, /^会话记忆：/);
  assert.equal(candidate.body, '# ' + candidate.title + '\n\n' + candidate.text);
  assert.match(candidate.body, /以后都用 pnpm/);
});

test('extractMemoryCandidates：普通闲聊、疑问句、assistant 文本都不抓', () => {
  const result = extractMemoryCandidates(
    transcript(
      user('今天天气不错。'),
      user('你还记得吗？'),
      user('以后要不要用 pnpm？'),
      assistant('记住：以后都用 pnpm。'),
    ),
  );
  assert.equal(result.candidates.length, 0);
  assert.ok(result.stats.question >= 2);
});

test('extractMemoryCandidates：密钥/口令句子直接跳过，绝不进候选箱', () => {
  const result = extractMemoryCandidates(
    transcript(
      user('记住我的 token 是 sk-1234567890abcdef12345678。'),
      user('记住密码：hunter2。'),
      user('以后都用 pnpm。'),
    ),
  );
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].text, /pnpm/);
  assert.ok(result.stats.secret >= 2);
});

test('extractMemoryCandidates：同一句去重，最多 3 条，多余的记 truncated', () => {
  const result = extractMemoryCandidates(
    transcript(
      user('以后都用 pnpm。以后都用 pnpm。记住用 pnpm 吧。我们决定统一用 pnpm。下次用 pnpm 吧。'),
    ),
  );
  assert.equal(result.candidates.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.stats.duplicate, 1);
  assert.ok(result.stats.truncated >= 1);
});

test('extractMemoryCandidates：英文线索也认，且标题不超长', () => {
  const result = extractMemoryCandidates(transcript(user('From now on, always use pnpm instead of npm.')));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].cue, 'english');
  assert.ok(Array.from(result.candidates[0].title).length <= 5 + 28 + 1);
});

test('buildCandidateBody：标题与正文一致，长度可控，emoji 不被截成半个', () => {
  const { title, body } = buildCandidateBody('记住：' + '很长的规则'.repeat(20));
  assert.equal(body, '# ' + title + '\n\n' + '记住：' + '很长的规则'.repeat(20).slice(0, 240));
  assert.ok(Array.from(title).length <= 5 + 28 + 1);

  const atBoundary = '记住' + 'a'.repeat(237) + '😀';
  const { body: emojiBody } = buildCandidateBody(atBoundary);
  assert.equal(Array.from(atBoundary).length, 240);
  assert.ok(emojiBody.endsWith('😀'), '按码点截断，不能留下半个代理对');
});

test('planHookInstall：默认 dry-run，不写文件，JSON 里不泄露整份 settings', () => {
  const home = tempDir('memory-hook-plan-');
  try {
    const settings = claudeSettingsPath(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ env: { SECRET_TOKEN: 'super-secret-value' } }, null, 2) + '\n');

    const plan = planHookInstall({
      home,
      bin: '/tmp/memory',
      store: '/tmp/store',
      command: '/usr/bin/node',
      now: 1700000000000,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.action, 'append');
    assert.equal(plan.would_write, true);
    assert.equal(plan.desired.timeout, HOOK_TIMEOUT_SECONDS);
    assert.deepEqual(plan.desired.args, ['/tmp/memory', 'hook', 'claude-session-end', '--store', '/tmp/store']);
    assert.equal(JSON.stringify(plan).includes('super-secret-value'), false);
    assert.equal(JSON.stringify(plan).includes('preview'), false);
    assert.equal(readFileSync(settings, 'utf8').includes('SessionEnd'), false, 'dry-run 不能改文件');
  } finally {
    rm(home);
  }
});

test('applyHookInstall：写入、幂等、保留其他钩子和 env 字段', () => {
  const home = tempDir('memory-hook-apply-');
  try {
    const settings = claudeSettingsPath(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      settings,
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

    const plan = planHookInstall({ home, bin: '/tmp/memory', store: '/tmp/store', command: '/usr/bin/node' });
    const applied = applyHookInstall(plan);
    assert.equal(applied.ok, true);
    assert.equal(applied.written, true);
    const config = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(config.env.SECRET_TOKEN, 'super-secret-value');
    assert.equal(config.hooks.SessionEnd.length, 2);
    assert.deepEqual(config.hooks.SessionEnd[1].hooks[0].args, ['/tmp/memory', 'hook', 'claude-session-end', '--store', '/tmp/store']);

    const again = planHookInstall({ home, bin: '/tmp/memory', store: '/tmp/store', command: '/usr/bin/node' });
    assert.equal(again.action, 'unchanged');
    assert.equal(applyHookInstall(again).written, false);

    const removed = applyHookInstall(planHookInstall({ home, uninstall: true }));
    assert.equal(removed.written, true);
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(after.env.SECRET_TOKEN, 'super-secret-value');
    assert.equal(after.hooks.SessionEnd.length, 1);
    assert.equal(after.hooks.SessionEnd[0].hooks[0].args[0], 'keep-me');
  } finally {
    rm(home);
  }
});

test('planHookInstall：--session-start 同时装两个事件，保留别人的 SessionStart，uninstall 全清', () => {
  const home = tempDir('memory-hook-session-start-');
  try {
    const settings = claudeSettingsPath(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify(
        {
          env: { SECRET_TOKEN: 'super-secret-value' },
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo', args: ['keep-start'] }] }],
          },
        },
        null,
        2,
      ) + '\n',
    );

    const plan = planHookInstall({
      home,
      bin: '/tmp/memory',
      store: '/tmp/store',
      command: '/usr/bin/node',
      sessionStart: true,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.action, 'append');
    assert.deepEqual(plan.events.map((item) => item.event), [...HOOK_EVENTS]);
    assert.deepEqual(plan.events.map((item) => item.action), ['append', 'append']);
    assert.match(plan.events[1].desired.args.join(' '), /claude-session-start/);

    const applied = applyHookInstall(plan);
    assert.equal(applied.written, true);
    const config = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(config.env.SECRET_TOKEN, 'super-secret-value');
    assert.equal(config.hooks.SessionEnd.length, 1);
    assert.equal(config.hooks.SessionStart.length, 2);
    assert.equal(config.hooks.SessionStart[0].hooks[0].args[0], 'keep-start');
    assert.deepEqual(config.hooks.SessionStart[1].hooks[0].args.slice(0, 3), ['/tmp/memory', 'hook', 'claude-session-start']);

    const again = planHookInstall({
      home,
      bin: '/tmp/memory',
      store: '/tmp/store',
      command: '/usr/bin/node',
      sessionStart: true,
    });
    assert.equal(again.action, 'unchanged');
    assert.equal(applyHookInstall(again).written, false);

    const removed = planHookInstall({ home, uninstall: true });
    assert.equal(removed.action, 'uninstall');
    assert.equal(removed.removed, 2);
    assert.equal(applyHookInstall(removed).written, true);
    const after = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(after.hooks.SessionStart.length, 1);
    assert.equal(after.hooks.SessionStart[0].hooks[0].args[0], 'keep-start');
    assert.equal(after.hooks.SessionEnd, undefined);
  } finally {
    rm(home);
  }
});

test('planHookInstall：--auto-consolidate 隐含 SessionStart，关掉时原地 update 而不是冲突', () => {
  const home = tempDir('memory-hook-auto-consolidate-');
  try {
    const on = planHookInstall({
      home,
      bin: '/tmp/memory',
      store: '/tmp/store',
      command: '/usr/bin/node',
      autoConsolidate: true,
    });
    assert.equal(on.ok, true);
    assert.deepEqual(on.events.map((item) => item.event), [...HOOK_EVENTS]);
    assert.deepEqual(on.events[0].desired.args.slice(-1), ['--auto-consolidate']);
    assert.equal(on.events[1].desired.args.includes('--auto-consolidate'), false, '提示事件不带开关');
    assert.equal(applyHookInstall(on).written, true);

    const stillOn = planHookInstall({
      home,
      bin: '/tmp/memory',
      store: '/tmp/store',
      command: '/usr/bin/node',
      autoConsolidate: true,
    });
    assert.equal(stillOn.action, 'unchanged');

    // 从开到关：底座命令没变，只差一个开关，应该原地 update 而不是要求 --force。
    const off = planHookInstall({
      home,
      bin: '/tmp/memory',
      store: '/tmp/store',
      command: '/usr/bin/node',
      autoConsolidate: false,
    });
    assert.equal(off.ok, true);
    assert.equal(off.action, 'update');
    assert.equal(off.events.length, 1, '关掉自动发现只改 SessionEnd；提示事件由 uninstall 负责清');
    assert.equal(off.events[0].desired.args.includes('--auto-consolidate'), false);
    assert.equal(applyHookInstall(off).written, true);
    const config = JSON.parse(readFileSync(claudeSettingsPath(home), 'utf8'));
    assert.equal(config.hooks.SessionEnd[0].hooks[0].args.includes('--auto-consolidate'), false);
    // 提示事件仍在：已产生的提案还需要被 session-start 提示，清理由 uninstall 做。
    assert.equal(config.hooks.SessionStart.length, 1);
  } finally {
    rm(home);
  }
});

test('planHookInstall：已有指向别处的 tabellio 钩子先冲突，--force 才替换', () => {
  const home = tempDir('memory-hook-conflict-');
  try {
    const settings = claudeSettingsPath(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    const first = planHookInstall({ home, bin: '/tmp/memory', store: '/tmp/store-a', command: '/usr/bin/node' });
    applyHookInstall(first);

    const conflict = planHookInstall({ home, bin: '/tmp/memory', store: '/tmp/store-b', command: '/usr/bin/node' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.action, 'conflict');
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).hooks.SessionEnd.length, 1);

    const forced = planHookInstall({
      home,
      bin: '/tmp/memory',
      store: '/tmp/store-b',
      command: '/usr/bin/node',
      force: true,
    });
    assert.equal(forced.action, 'update');
    assert.equal(applyHookInstall(forced).written, true);
    const config = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(config.hooks.SessionEnd.length, 1);
    assert.equal(config.hooks.SessionEnd[0].hooks[0].args.at(-1), '/tmp/store-b');
  } finally {
    rm(home);
  }
});

test('planHookInstall：坏 JSON / 不认识的 SessionEnd 结构整份不写', () => {
  const home = tempDir('memory-hook-invalid-');
  try {
    const settings = claudeSettingsPath(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settings, '{not json\n');
    const before = readFileSync(settings, 'utf8');
    const broken = planHookInstall({ home, bin: '/tmp/memory', store: '/tmp/store', command: '/usr/bin/node' });
    assert.equal(broken.ok, false);
    assert.equal(broken.reason, 'invalid_config');
    assert.equal(readFileSync(settings, 'utf8'), before, '计划失败不能动配置');

    writeFileSync(settings, JSON.stringify({ hooks: { SessionEnd: 'nope' } }, null, 2) + '\n');
    const malformed = planHookInstall({ home, bin: '/tmp/memory', store: '/tmp/store', command: '/usr/bin/node' });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.action, 'invalid');
  } finally {
    rm(home);
  }
});

test('planHookInstall：不支持的宿主与「本来就没装」都给出明确结论', () => {
  const home = tempDir('memory-hook-other-');
  try {
    const unsupported = planHookInstall({ host: 'cursor', home, bin: '/tmp/memory', store: '/tmp/store' });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.reason, 'unknown_host');

    const absent = planHookInstall({ home, uninstall: true });
    assert.equal(absent.ok, true);
    assert.equal(absent.action, 'unchanged');
    assert.equal(absent.would_write, false);
    assert.equal(existsSync(claudeSettingsPath(home)), false);
  } finally {
    rm(home);
  }
});
