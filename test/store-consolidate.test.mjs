/**
 * 巩固 run 的落盘层用例：原子写、拒绝覆盖、回执读取与篡改可见。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, rm } from './helpers.mjs';
import { planConsolidation, buildConsolidateReceipt } from '../src/core/consolidate.js';
import {
  isRunId,
  runPlanPath,
  runReceiptPath,
  runUndoPath,
  writeRunPlan,
  writeRunReceipt,
  writeUndoRecord,
  readRunPlan,
  readRunReceipt,
  readUndoRecord,
} from '../src/store/consolidate.js';

const RUN = 'run_01M554B3JYZ1NH8QZCQ73Q6CSX';
const NOW = Date.parse('2026-10-17T12:00:00+08:00');

function fixture(over = {}) {
  const plan = planConsolidation({
    entries: [
      { id: 'A', note: { id: 'A', status: 'active', valid_to: null, superseded_by: null, supersedes: [], valid_from: null }, body: '# A' },
      { id: 'B', note: { id: 'B', status: 'active', valid_to: null, superseded_by: null, supersedes: ['A'], valid_from: null }, body: '# B' },
    ],
    nowMs: NOW,
    runId: RUN,
  });
  const applied = plan.operations.map((op) => ({ ...op, before_text_sha256: 'a'.repeat(32), after_text_sha256: 'b'.repeat(32) }));
  const receipt = buildConsolidateReceipt({ plan, store: '/tmp/example-store', applied, nowMs: NOW, ...over });
  return { plan, receipt };
}

test('store：写计划/回执/撤销记录，读回形状一致', () => {
  const dir = tempDir('memory-store-consolidate-');
  try {
    const { plan, receipt } = fixture();
    assert.equal(isRunId(RUN), true);
    assert.equal(isRunId('run_bad'), false);
    assert.equal(runPlanPath(dir, 'bad'), null);
    assert.ok(runReceiptPath(dir, RUN).endsWith(RUN + '.json'));
    assert.ok(runUndoPath(dir, RUN).endsWith(RUN + '.undo.json'));

    const planSaved = writeRunPlan(dir, plan);
    assert.equal(planSaved.ok, true);
    const planRead = readRunPlan(dir, RUN);
    assert.equal(planRead.ok, true);
    assert.equal(planRead.plan.schema, 'tabellio.consolidate.plan/1');
    assert.equal(planRead.plan.operations.length, 1);

    const receiptSaved = writeRunReceipt(dir, receipt);
    assert.equal(receiptSaved.ok, true);
    const receiptRead = readRunReceipt(dir, RUN);
    assert.equal(receiptRead.ok, true);
    assert.equal(receiptRead.receipt.runId, RUN);
    assert.deepEqual(receiptRead.integrity, { ok: true, problems: [] });

    const undo = { schema: 'tabellio.undo/1', runId: RUN, restored: ['A'], hash: 'c'.repeat(32) };
    const undoSaved = writeUndoRecord(dir, undo);
    assert.equal(undoSaved.ok, true);
    const undoRead = readUndoRecord(dir, RUN);
    assert.equal(undoRead.ok, true);
    assert.deepEqual(undoRead.doc.restored, ['A']);
  } finally {
    rm(dir);
  }
});

test('store：拒绝覆盖同 id，且不改旧文件', () => {
  const dir = tempDir('memory-store-consolidate-noclobber-');
  try {
    const { plan, receipt } = fixture();
    assert.equal(writeRunPlan(dir, plan).ok, true);
    const before = readFileSync(runPlanPath(dir, RUN), 'utf8');
    const again = writeRunPlan(dir, plan);
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'E_RUN_EXISTS');
    assert.equal(readFileSync(runPlanPath(dir, RUN), 'utf8'), before);

    assert.equal(writeRunReceipt(dir, receipt).ok, true);
    const dup = writeRunReceipt(dir, receipt);
    assert.equal(dup.ok, false);
    assert.equal(dup.error.code, 'E_RUN_EXISTS');
  } finally {
    rm(dir);
  }
});

test('store：回执 hash 不匹配时拒写；读取端只报 integrity，不拒绝打开', () => {
  const dir = tempDir('memory-store-consolidate-hash-');
  try {
    const { receipt } = fixture();
    const broken = { ...receipt, store: '/tmp/changed-store' };
    const rejected = writeRunReceipt(dir, broken);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'E_RUN_HASH_MISMATCH');

    assert.equal(writeRunReceipt(dir, receipt).ok, true);
    const path = runReceiptPath(dir, RUN);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    onDisk.store = '/tmp/tampered-store';
    writeFileSync(path, JSON.stringify(onDisk, null, 2), 'utf8');
    const got = readRunReceipt(dir, RUN);
    assert.equal(got.ok, true, '读取端要能打开被篡改的回执，交给 undo 报 tampered');
    assert.equal(got.integrity.ok, false);
  } finally {
    rm(dir);
  }
});

test('store：坏 JSON / 缺文件 / 非法 id 的错误码', () => {
  const dir = tempDir('memory-store-consolidate-bad-');
  try {
    assert.equal(readRunReceipt(dir, 'nope').error.code, 'E_RUN_ID_INVALID');
    assert.equal(readRunReceipt(dir, RUN).error.code, 'E_RUN_NOT_FOUND');

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json', 'utf8');
    assert.equal(readRunReceipt(dir, bad).error.code, 'E_RUN_PARSE');

    const wrongSchema = join(dir, 'wrong.json');
    writeFileSync(wrongSchema, JSON.stringify({ schema: 'other' }), 'utf8');
    assert.equal(readRunReceipt(dir, wrongSchema).error.code, 'E_RUN_SCHEMA');

    assert.equal(readUndoRecord(dir, RUN).error.code, 'E_UNDO_NOT_FOUND');
  } finally {
    rm(dir);
  }
});
