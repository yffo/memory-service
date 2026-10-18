/**
 * 内容类提案的 API 层用例：真临时库、真扫描，但**不落盘**。
 *
 * 这里最重要的断言不是草稿内容，而是调用前后整棵库目录逐字节不变：
 * 提案层一旦偷偷 ensure / 写 run / 写候选，就必须在这里失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, rm } from './helpers.mjs';
import { openStore, remember, read, proposeConsolidation, applyContentConsolidation, undoContentConsolidation, listCandidates } from '../src/api.js';

function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    if (!existsSync(abs)) return;
    for (const item of readdirSync(abs, { withFileTypes: true })) {
      const child = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) walk(child);
      else out[child] = readFileSync(join(dir, child), 'utf8');
    }
  };
  walk('');
  return out;
}

function seedPair(prefix = 'memory-api-propose-') {
  const dir = tempDir(prefix);
  const ctx = openStore(dir);
  ctx.ensure();
  const a = remember(ctx, {
    text: '---\nkind: semantic\ntrust: user_stated\n---\n\n# 构建命令\n\n共同事实：构建从仓库根目录执行。\n\n只有 A 的细节：先安装依赖。\n',
    writtenBy: 'test:propose',
  });
  const b = remember(ctx, {
    text: '---\nkind: semantic\ntrust: user_stated\n---\n\n# 构建命令 v2\n\n共同事实：构建从仓库根目录执行。\n\n只有 B 的细节：发布前跑全量测试。\n',
    writtenBy: 'test:propose',
  });
  assert.equal(a.ok, true, a.reason);
  assert.equal(b.ok, true, b.reason);
  return { dir, ctx, a: a.id, b: b.id };
}


test('API applyContentConsolidation：merge 写目标、关源、回执可撤销', () => {
  const { dir, ctx, a, b } = seedPair('memory-api-content-apply-');
  try {
    const r = applyContentConsolidation(ctx, { mode: 'merge', ids: [a, b], apply: true, maxChangeRatio: 1 });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.status, 'applied');
    assert.equal(r.target.status, 'active');
    assert.equal(r.receipt.schema, 'tabellio.consolidate.content/1');
    assert.equal(r.receipt.target.id, r.target.id);
    const target = read(ctx, r.target.id);
    assert.equal(target.ok, true);
    assert.match(target.body, /^# 合并：/);
    assert.doesNotMatch(target.body, /提案草稿，未写入库/);
    const aAfter = read(ctx, a);
    assert.equal(aAfter.note.superseded_by, r.target.id);
    assert.ok(aAfter.note.valid_to);

    const undo = undoContentConsolidation(ctx, r.run_id);
    assert.equal(undo.ok, true, undo.reason);
    assert.equal(undo.target_deleted, true);
    assert.equal(read(ctx, r.target.id).ok, false);
    const aRestored = read(ctx, a);
    assert.equal(aRestored.note.valid_to, null);
    assert.equal(aRestored.note.superseded_by, null);
    assert.equal(undoContentConsolidation(ctx, r.run_id).status, 'already_undone');
  } finally {
    rm(dir);
  }
});

test('API applyContentConsolidation：默认 5% 保险丝拒绝小库 merge，且不写文件', () => {
  const { dir, ctx, a, b } = seedPair('memory-api-content-ratio-');
  try {
    const before = snapshot(dir);
    const r = applyContentConsolidation(ctx, { mode: 'merge', ids: [a, b], apply: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'change_ratio_exceeded');
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(readdirSync(join(dir, 'runs')), []);
  } finally {
    rm(dir);
  }
});

test('API applyContentConsolidation：promote 只写候选，不关源；undo 删候选', () => {
  const dir = tempDir('memory-api-content-promote-');
  const ctx = openStore(dir);
  ctx.ensure();
  const ids = [];
  try {
    for (let i = 1; i <= 3; i += 1) {
      const r = remember(ctx, {
        text: [
          '---',
          'kind: semantic',
          'trust: user_stated',
          `valid_from: 2026-10-0${i}`,
          '---',
          '',
          `# 观察 ${i}`,
          '',
          `第 ${i} 天观察到：发布前跑全量测试。`,
        ].join('\n'),
        writtenBy: 'test:content',
      });
      assert.equal(r.ok, true, r.reason);
      ids.push(r.id);
    }
    const r = applyContentConsolidation(ctx, { mode: 'promote', ids, apply: true, maxChangeRatio: 1 });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.target.bucket, 'candidates');
    assert.equal(r.target.status, 'draft');
    assert.equal(listCandidates(ctx).count, 1);
    for (const id of ids) assert.equal(read(ctx, id).note.status, 'active');
    assert.equal(read(ctx, r.target.id).ok, false);

    const undo = undoContentConsolidation(ctx, r.run_id);
    assert.equal(undo.ok, true, undo.reason);
    assert.equal(undo.target_deleted, true);
    assert.equal(listCandidates(ctx).count, 0);
  } finally {
    rm(dir);
  }
});

test('API proposeConsolidation：merge 只返回提案，库目录逐字节不变', () => {
  const { dir, ctx, a, b } = seedPair();
  try {
    const before = snapshot(dir);
    const plan = proposeConsolidation(ctx, { mode: 'merge', ids: [a, b] });
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(plan.status, 'proposed');
    assert.equal(plan.dry_run, true);
    assert.equal(plan.apply_supported, true);
    assert.equal(plan.would_write, false);
    assert.equal(plan.target.path.startsWith('notes/'), true);
    assert.equal(plan.target.status, 'draft');
    assert.deepEqual(plan.target.supersedes, [a, b]);
    assert.match(plan.target.body, /共同事实/);
    assert.equal(plan.store, ctx.store);
    assert.deepEqual(snapshot(dir), before, '提案调用不得改动库目录');
    assert.deepEqual(readdirSync(join(dir, 'runs')), []);
    // ensure() 现在会建候选目录；提案层要保证的是「不往里面写东西」。
    assert.deepEqual(readdirSync(join(dir, 'notes', 'candidates')), []);
  } finally {
    rm(dir);
  }
});

test('API proposeConsolidation：源不存在时拒绝，且仍然不写任何文件', () => {
  const { dir, ctx, a } = seedPair('memory-api-propose-missing-');
  try {
    const before = snapshot(dir);
    const plan = proposeConsolidation(ctx, { mode: 'merge', ids: [a, '01M554B3JYZ1NH8QZCQ73Q6CSX'] });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, 'source_invalid');
    assert.equal(plan.would_write, false);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rm(dir);
  }
});

test('API proposeConsolidation：summarize 一条长记录，目标只在提案里', () => {
  const dir = tempDir('memory-api-propose-summarize-');
  const ctx = openStore(dir);
  ctx.ensure();
  try {
    const r = remember(ctx, {
      text: [
        '---',
        'kind: semantic',
        'trust: user_stated',
        '---',
        '',
        '# 发布流程',
        '',
        '第一段记录发布流程：先跑全量测试，再打标签，最后上传构建产物，任何一步失败都停止。',
        '',
        '第二段记录回滚流程：发现线上异常先停流量，再回滚到上一个稳定版本，最后补一条事故记录。',
        '',
        '第三段记录排障经验：缓存命中旧版本时先清缓存再重试，不要直接改依赖版本，否则会把问题藏起来。',
        '',
        '第四段补充：发布脚本必须先检查当前分支，避免把未合并的改动带上线，也避免把别人的提交一起发布。',
        '',
        '第五段记录监控：发布后观察错误率和延迟十分钟，异常就回滚，不要等到用户投诉再处理。',
        '',
      ].join('\n'),
      writtenBy: 'test:propose',
    });
    assert.equal(r.ok, true, r.reason);
    const before = snapshot(dir);
    const plan = proposeConsolidation(ctx, { mode: 'summarize', ids: [r.id] });
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(plan.mode, 'summarize');
    assert.equal(plan.target.draft_kind, 'extractive');
    assert.match(plan.target.body, /^# 摘要提案：发布流程/);
    assert.match(plan.target.body, /<!-- 摘要自：/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rm(dir);
  }
});

test('API undoContentConsolidation：目标被改过时整单拒绝，源保持关闭', () => {
  const { dir, ctx, a, b } = seedPair('memory-api-content-undo-conflict-');
  try {
    const r = applyContentConsolidation(ctx, { mode: 'merge', ids: [a, b], apply: true, maxChangeRatio: 1 });
    assert.equal(r.ok, true, r.reason);
    const file = join(dir, r.target.path);
    writeFileSync(file, readFileSync(file, 'utf8') + '\n外部追加。\n', 'utf8');
    const undo = undoContentConsolidation(ctx, r.run_id);
    assert.equal(undo.ok, false);
    assert.equal(undo.status, 'conflict');
    assert.ok(undo.conflicts.some((c) => c.reason === 'target_changed'));
    assert.equal(read(ctx, r.target.id).ok, true);
    assert.equal(read(ctx, a).note.superseded_by, r.target.id);
  } finally {
    rm(dir);
  }
});
