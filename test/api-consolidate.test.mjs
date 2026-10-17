/**
 * consolidate / undo 的 API 层用例：真临时库、真文件、真回执。
 *
 * 这里重点验证三件在纯决策层测不到的事：
 *  1. apply 只改元数据，正文逐字节不变；
 *  2. 回执写不进去时，已经改掉的元数据必须回滚；
 *  3. undo 是整单事务，冲突时一条都不恢复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, rm } from './helpers.mjs';
import { openStore, remember, read, consolidate, undoConsolidation } from '../src/api.js';
import { readUndoRecord } from '../src/store/consolidate.js';

const RUN = 'run_01M554B3JYZ1NH8QZCQ73Q6CSX';

function seedPair(prefix = 'memory-api-consolidate-') {
  const dir = tempDir(prefix);
  const ctx = openStore(dir);
  ctx.ensure();
  const a = remember(ctx, {
    text: '---\nkind: semantic\ntrust: user_stated\n---\n\n# 构建命令\n\n旧构建命令是 pnpm run build。\n',
    writtenBy: 'test:consolidate',
  });
  const b = remember(ctx, {
    text: `---\nkind: semantic\ntrust: user_stated\nsupersedes: [${a.id}]\n---\n\n# 构建命令 v2\n\n新的构建命令是 npm run build。\n`,
    writtenBy: 'test:consolidate',
  });
  assert.equal(a.ok, true, a.reason);
  assert.equal(b.ok, true, b.reason);
  return { dir, ctx, a: a.id, b: b.id };
}

function bodyOf(ctx, id) {
  const got = read(ctx, id, { withText: true });
  assert.equal(got.ok, true);
  return got.body;
}

test('API consolidate：默认 dry-run，只出计划，不改笔记也不写 run 文件', () => {
  const { dir, ctx, a } = seedPair('memory-api-consolidate-dry-');
  try {
    const before = bodyOf(ctx, a);
    const plan = consolidate(ctx, { nowMs: Date.now() });
    assert.equal(plan.ok, true);
    assert.equal(plan.status, 'planned');
    assert.equal(plan.dry_run, true);
    assert.match(plan.run_id, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(plan.operations.length, 1);
    assert.equal(read(ctx, a).note.valid_to, null);
    assert.equal(bodyOf(ctx, a), before);
    assert.equal(existsSync(join(dir, 'runs', `${plan.run_id}.plan.json`)), false);
  } finally {
    rm(dir);
  }
});

test('API consolidate --apply：只改元数据、正文不变、计划与回执落盘', () => {
  const { dir, ctx, a, b } = seedPair('memory-api-consolidate-apply-');
  try {
    const before = bodyOf(ctx, a);
    const r = consolidate(ctx, { apply: true, nowMs: Date.now() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.status, 'applied');
    assert.equal(r.dry_run, false);
    assert.equal(r.applied, 1);
    assert.equal(r.reversible, true);
    assert.equal(r.receipt.schema, 'tabellio.consolidate/1');
    assert.ok(r.receipt_path.endsWith(`${r.run_id}.json`));
    assert.ok(existsSync(r.plan_path));
    assert.ok(existsSync(r.receipt_path));
    assert.ok(!JSON.stringify(r.receipt).includes('旧构建命令'), '回执不许复制正文');

    const after = read(ctx, a);
    assert.equal(after.note.valid_to !== null, true);
    assert.equal(after.note.superseded_by, b);
    assert.equal(after.note.status, 'active');
    assert.equal(bodyOf(ctx, a), before, '正文必须逐字节不变');
  } finally {
    rm(dir);
  }
});

test('API undo：恢复元数据并写撤销记录；第二次是 already_undone', () => {
  const { dir, ctx, a } = seedPair('memory-api-consolidate-undo-');
  try {
    const r = consolidate(ctx, { apply: true, nowMs: Date.now() });
    assert.equal(r.ok, true);
    const undo = undoConsolidation(ctx, r.run_id, { nowMs: Date.now() });
    assert.equal(undo.ok, true, JSON.stringify(undo));
    assert.equal(undo.status, 'undone');
    assert.equal(undo.restored, 1);
    const restored = read(ctx, a);
    assert.equal(restored.note.valid_to, null);
    assert.equal(restored.note.superseded_by, null);
    const record = readUndoRecord(dir, r.run_id);
    assert.equal(record.ok, true);
    assert.deepEqual(record.doc.restored, [a]);

    const again = undoConsolidation(ctx, r.run_id);
    assert.equal(again.ok, true);
    assert.equal(again.status, 'already_undone');
    assert.equal(again.restored, 0);
  } finally {
    rm(dir);
  }
});

test('API undo：正文被外部改过时整单 conflict，不恢复任何字段', () => {
  const { dir, ctx, a } = seedPair('memory-api-consolidate-conflict-');
  try {
    const r = consolidate(ctx, { apply: true, nowMs: Date.now() });
    assert.equal(r.ok, true);
    const notePath = join(dir, 'notes', `${a}.md`);
    writeFileSync(notePath, readFileSync(notePath, 'utf8') + '\n外部补充。\n', 'utf8');
    const undo = undoConsolidation(ctx, r.run_id);
    assert.equal(undo.ok, false);
    assert.equal(undo.status, 'conflict');
    assert.equal(undo.conflicts[0].id, a);
    assert.equal(undo.conflicts[0].reason, 'body_changed');
    assert.equal(read(ctx, a).note.valid_to !== null, true, '冲突时不许部分撤销');
    assert.equal(readUndoRecord(dir, r.run_id).error.code, 'E_UNDO_NOT_FOUND');
  } finally {
    rm(dir);
  }
});

test('API undo：回执被篡改时拒绝，且不改笔记', () => {
  const { dir, ctx, a } = seedPair('memory-api-consolidate-tampered-');
  try {
    const r = consolidate(ctx, { apply: true, nowMs: Date.now() });
    assert.equal(r.ok, true);
    const doc = JSON.parse(readFileSync(r.receipt_path, 'utf8'));
    doc.store = '/tmp/another-store';
    writeFileSync(r.receipt_path, JSON.stringify(doc, null, 2), 'utf8');
    const undo = undoConsolidation(ctx, r.run_id);
    assert.equal(undo.ok, false);
    assert.equal(undo.status, 'tampered');
    assert.ok(undo.problems.length >= 1);
    assert.equal(read(ctx, a).note.valid_to !== null, true);
  } finally {
    rm(dir);
  }
});

test('API apply：回执写失败时回滚已改的笔记，绝不留下无账状态', () => {
  const { dir, ctx, a } = seedPair('memory-api-consolidate-rollback-');
  try {
    // 预先占住回执路径：plan 能写成功，但 receipt 的 rename 目标已存在。
    mkdirSync(join(dir, 'runs', `${RUN}.json`), { recursive: true });
    const r = consolidate(ctx, { apply: true, runId: RUN, nowMs: Date.now() });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'aborted');
    assert.equal(r.reason, 'receipt_write_failed');
    assert.equal(r.rolled_back, true, JSON.stringify(r));
    const note = read(ctx, a).note;
    assert.equal(note.valid_to, null);
    assert.equal(note.superseded_by, null);
  } finally {
    rm(dir);
  }
});

test('API apply：超过 5% 保险丝时 aborted，且不改任何笔记', () => {
  const dir = tempDir('memory-api-consolidate-fuse-');
  const ctx = openStore(dir);
  ctx.ensure();
  try {
    const ids = [];
    for (let i = 0; i < 30; i += 1) {
      const r = remember(ctx, { text: `---\nkind: semantic\ntrust: user_stated\n---\n\n# 记录 ${i}\n\n内容 ${i}\n`, writtenBy: 'test:fuse' });
      assert.equal(r.ok, true);
      ids.push(r.id);
    }
    for (let i = 0; i < 2; i += 1) {
      const r = remember(ctx, {
        text: `---\nkind: semantic\ntrust: user_stated\nsupersedes: [${ids[i]}]\n---\n\n# 替代 ${i}\n\n新内容 ${i}\n`,
        writtenBy: 'test:fuse',
      });
      assert.equal(r.ok, true);
    }
    const plan = consolidate(ctx, { apply: true, nowMs: Date.now() });
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 'aborted');
    assert.equal(plan.reason, 'change_ratio_exceeded');
    assert.equal(read(ctx, ids[0]).note.valid_to, null);
    assert.equal(read(ctx, ids[1]).note.valid_to, null);
  } finally {
    rm(dir);
  }
});

test('API undo：run id 不存在时返回 unreadable', () => {
  const dir = tempDir('memory-api-consolidate-norun-');
  const ctx = openStore(dir);
  ctx.ensure();
  try {
    const r = undoConsolidation(ctx, RUN);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'unreadable');
    assert.equal(r.error.code, 'E_RUN_NOT_FOUND');
  } finally {
    rm(dir);
  }
});
