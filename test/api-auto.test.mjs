/**
 * 自动巩固闭环（API 层）：发现 → 提案文件 → 人工批准/拒绝 → 执行层回执/撤销。
 *
 * 最重要的边界：dry-run 一个字节都不写；批准前源被改动，提案必须 stale，
 * 不能拿旧 hash 去合新正文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, rm } from './helpers.mjs';
import {
  openStore,
  remember,
  read,
  status,
  sweepConsolidation,
  listProposals,
  reviewProposals,
  undoContentConsolidation,
} from '../src/api.js';

const COMMON =
  '项目约定：所有构建都从仓库根目录执行，安装依赖统一用 pnpm，提交前必须跑全量测试，发布走 GitHub Actions。';

function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    if (!existsSync(abs)) return;
    for (const item of readdirSync(abs, { withFileTypes: true })) {
      const child = rel ? rel + '/' + item.name : item.name;
      if (item.isDirectory()) walk(child);
      else out[child] = readFileSync(join(dir, child), 'utf8');
    }
  };
  walk('');
  return out;
}

function seedPair(prefix) {
  const dir = tempDir(prefix);
  const ctx = openStore(dir);
  ctx.ensure();
  const noteText = (title, tail) =>
    ['---', 'kind: semantic', 'trust: user_stated', '---', '', '# ' + title, '', COMMON + tail, ''].join('\n');
  const a = remember(ctx, { text: noteText('构建约定 A', ' 文档统一放 docs 目录。'), writtenBy: 'test:auto' });
  const b = remember(ctx, {
    text: noteText('构建约定 B', ' 文档统一放 docs 目录，变更写 CHANGELOG。'),
    writtenBy: 'test:auto',
  });
  assert.equal(a.ok, true, a.reason);
  assert.equal(b.ok, true, b.reason);
  return { dir, ctx, a, b };
}

test('sweep dry-run：发现近似重复但整棵库逐字节不变', () => {
  const { dir, ctx } = seedPair('memory-auto-dry-');
  try {
    const before = snapshot(dir);
    const r = sweepConsolidation(ctx, { dry: true });
    assert.equal(r.ok, true);
    assert.equal(r.dry_run, true);
    assert.equal(r.discovered, 1);
    assert.equal(r.created_count, 0);
    assert.equal(r.items.length, 1);
    assert.deepEqual(snapshot(dir), before, 'dry-run 不能写提案、不能 ensure 新目录');
    assert.equal(status(ctx).proposals, 0);
  } finally {
    rm(dir);
  }
});

test('sweep --write：落提案、可列出、重复 sweep 不重复写', () => {
  const { dir, ctx } = seedPair('memory-auto-write-');
  try {
    const first = sweepConsolidation(ctx, { dry: false });
    assert.equal(first.ok, true);
    assert.equal(first.created_count, 1);
    const id = first.created[0].id;
    assert.match(id, /^prop_[a-z0-9]{20}$/);
    assert.equal(existsSync(join(dir, 'runs', 'proposals', id + '.json')), true);
    assert.equal(status(ctx).proposals, 1);
    assert.ok(status(ctx).warnings.some((w) => w.includes('自动巩固提案')), status(ctx).warnings.join('\n'));

    const listed = listProposals(ctx);
    assert.equal(listed.count, 1);
    assert.equal(listed.proposals[0].id, id);
    assert.deepEqual([...listed.proposals[0].source_ids].sort(), [first.created[0].source_ids[0], first.created[0].source_ids[1]].sort());

    const again = sweepConsolidation(ctx, { dry: false });
    assert.equal(again.created_count, 0);
    assert.equal(again.existing_count, 1);
    assert.equal(again.existing[0].id, id);
  } finally {
    rm(dir);
  }
});

test('reviewProposals：源被改动后整单 stale，不写任何笔记', () => {
  const { dir, ctx, a } = seedPair('memory-auto-stale-');
  try {
    const swept = sweepConsolidation(ctx, { dry: false });
    const id = swept.created[0].id;
    writeFileSync(a.path, readFileSync(a.path, 'utf8') + '\n新增了一句：改用 npm。\n', 'utf8');
    // 快照必须在「人改了源」之后取：要证明的是 stale 之后没有新增/改动任何文件，
    // 不是证明人自己的编辑没发生。
    const before = snapshot(dir);

    const r = reviewProposals(ctx, { accept: [id] });
    assert.equal(r.ok, false);
    assert.equal(r.failed_count, 1);
    assert.equal(r.failed[0].reason, 'proposal_stale');
    assert.deepEqual(snapshot(dir), before, 'stale 提案不能写目标、不能动源、不能写回执');
    assert.equal(read(ctx, a.id).note.status, 'active');
    assert.equal(listProposals(ctx).count, 1, 'stale 提案保留，让人重新看');
  } finally {
    rm(dir);
  }
});

test('reviewProposals：批准走执行层、源被关闭、回执可撤销，提案移到 accepted', () => {
  const { dir, ctx, a, b } = seedPair('memory-auto-accept-');
  try {
    const swept = sweepConsolidation(ctx, { dry: false });
    const id = swept.created[0].id;
    const r = reviewProposals(ctx, { accept: [id] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.accepted_count, 1);
    assert.equal(r.accepted[0].status, 'applied');
    const targetId = r.accepted[0].target_id;
    assert.ok(r.accepted[0].run_id);
    assert.equal(existsSync(join(dir, 'runs', 'proposals', 'accepted', id + '.json')), true);

    assert.equal(read(ctx, targetId).note.status, 'active');
    for (const sourceId of [a.id, b.id]) {
      const after = read(ctx, sourceId);
      assert.equal(after.note.superseded_by, targetId);
      assert.ok(after.note.valid_to);
    }
    assert.equal(listProposals(ctx).count, 0);
    assert.equal(status(ctx).proposals, 0);

    const undo = undoContentConsolidation(ctx, r.accepted[0].run_id);
    assert.equal(undo.ok, true, undo.reason);
    assert.equal(read(ctx, targetId).ok, false);
    for (const sourceId of [a.id, b.id]) {
      const after = read(ctx, sourceId);
      assert.equal(after.note.superseded_by, null);
      assert.equal(after.note.valid_to, null);
    }
  } finally {
    rm(dir);
  }
});

test('reviewProposals：reject 只归档提案，不改笔记；dry-run 不动文件', () => {
  const { dir, ctx } = seedPair('memory-auto-reject-');
  try {
    const swept = sweepConsolidation(ctx, { dry: false });
    const id = swept.created[0].id;
    const before = snapshot(dir);

    const dry = reviewProposals(ctx, { reject: [id], dry: true });
    assert.equal(dry.rejected_count, 1);
    assert.equal(dry.rejected[0].status, 'planned');
    assert.deepEqual(snapshot(dir), before);

    const r = reviewProposals(ctx, { reject: [id] });
    assert.equal(r.ok, true);
    assert.equal(r.rejected_count, 1);
    assert.equal(existsSync(join(dir, 'runs', 'proposals', 'rejected', id + '.json')), true);
    assert.equal(listProposals(ctx).count, 0);
    assert.equal(status(ctx).notes, 2);
  } finally {
    rm(dir);
  }
});
