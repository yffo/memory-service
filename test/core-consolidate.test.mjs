/**
 * 巩固计划的纯决策层用例：不碰文件系统，只验证「哪些能改、哪些碰不得」。
 *
 * 这一层最重要的不是 happy path，而是**拒绝的边界**：歧义、缺目标、已经关过的、
 * 时间上还没生效的，都必须只进 skipped 而不进 operations。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planConsolidation,
  buildConsolidateReceipt,
  consolidateReceiptProblems,
  consolidateReceiptHash,
  receiptIntegrity,
  sameFields,
  DEFAULT_MAX_CHANGE_RATIO,
} from '../src/core/consolidate.js';
import { isoLocal } from '../src/util/clock.js';

const NOW = Date.parse('2026-10-17T12:00:00+08:00');
const RUN = 'run_01M554B3JYZ1NH8QZCQ73Q6CSX';

function entry(id, over = {}) {
  return {
    id,
    body: '# ' + id + '\n\n正文',
    note: {
      id,
      status: 'active',
      kind: 'semantic',
      scope: 'user',
      valid_from: null,
      valid_to: null,
      superseded_by: null,
      supersedes: [],
      ...over,
    },
  };
}

test('planConsolidation：显式 supersedes 生成一条 invalidate，只动三个元数据', () => {
  const a = entry('A');
  const b = entry('B', { supersedes: ['A'] });
  const plan = planConsolidation({ entries: [a, b], nowMs: NOW, runId: RUN });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.runId, RUN);
  assert.equal(plan.operations.length, 1);
  const op = plan.operations[0];
  assert.equal(op.op, 'invalidate');
  assert.equal(op.id, 'A');
  assert.equal(op.superseded_by, 'B');
  assert.equal(op.valid_to, isoLocal(NOW));
  assert.deepEqual(op.before, { status: 'active', valid_to: null, superseded_by: null, body_sha256: op.before.body_sha256 });
  assert.equal(op.before.body_sha256, op.after.body_sha256, '正文 hash 前后必须一致');
  assert.equal(op.after.valid_to, isoLocal(NOW));
  assert.equal(op.after.superseded_by, 'B');
  assert.equal(plan.stats.scanned, 2);
  assert.equal(plan.stats.planned, 1);
  assert.equal(plan.stats.allowed, 1);
  assert.equal(plan.stats.change_ratio, 0.5);
});

test('planConsolidation：同一个目标被两个 successor 声明时不替人做决定', () => {
  const plan = planConsolidation({
    entries: [entry('A'), entry('B', { supersedes: ['A'] }), entry('C', { supersedes: ['A'] })],
    nowMs: NOW,
    runId: RUN,
  });
  assert.equal(plan.operations.length, 0);
  const skip = plan.skipped.find((s) => s.id === 'A');
  assert.equal(skip.reason, 'ambiguous_supersedes');
  assert.deepEqual(skip.successors, ['B', 'C']);
});

test('planConsolidation：自指、缺目标、未解析目标都只跳过', () => {
  const plan = planConsolidation({
    entries: [
      entry('A', { supersedes: ['A'] }),
      entry('B', { supersedes: ['ghost'] }),
      entry('C', { supersedes: ['D'] }),
      { id: 'D', note: null, body: '' },
    ],
    nowMs: NOW,
    runId: RUN,
  });
  const byId = new Map(plan.skipped.map((s) => [s.id + ':' + s.reason, s]));
  assert.ok(byId.has('A:self_supersede'));
  assert.ok(byId.has('ghost:missing_target'));
  assert.ok(byId.has('D:target_unparsed'));
  assert.equal(plan.operations.length, 0);
});

test('planConsolidation：已关、已过期、未来才生效的目标都不动', () => {
  const future = isoLocal(NOW + 86400000);
  const plan = planConsolidation({
    entries: [
      entry('A', { superseded_by: 'X' }),
      entry('B', { valid_to: future }),
      entry('C', { valid_from: future }),
      entry('D', { status: 'draft' }),
      entry('E', { supersedes: ['A', 'B', 'C', 'D'] }),
    ],
    nowMs: NOW,
    runId: RUN,
  });
  const reasons = new Map(plan.skipped.map((s) => [s.id, s.reason]));
  assert.equal(reasons.get('A'), 'target_already_superseded');
  assert.equal(reasons.get('B'), 'target_has_valid_to');
  assert.equal(reasons.get('C'), 'target_not_valid_at_now');
  assert.equal(reasons.get('D'), 'target_not_active');
  assert.equal(plan.operations.length, 0);
});

test('planConsolidation：5% 保险丝超限时 aborted，但仍带计划供人看', () => {
  const entries = [];
  for (let i = 0; i < 26; i += 1) entries.push(entry('F' + i));
  entries.push(entry('A1'), entry('A2'), entry('B1', { supersedes: ['A1'] }), entry('B2', { supersedes: ['A2'] }));
  const plan = planConsolidation({ entries, nowMs: NOW, runId: RUN });
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 'aborted');
  assert.equal(plan.reason, 'change_ratio_exceeded');
  assert.equal(plan.operations.length, 2);
  assert.equal(plan.stats.scanned, 30);
  assert.equal(plan.stats.allowed, 1);
  assert.equal(plan.stats.change_ratio, 0.0667);
});

test('planConsolidation：小库至少允许 1 条；比例放宽后放行', () => {
  const entries = [entry('A1'), entry('A2'), entry('B1', { supersedes: ['A1'] }), entry('B2', { supersedes: ['A2'] })];
  const fuse = planConsolidation({ entries, nowMs: NOW, runId: RUN });
  assert.equal(fuse.ok, false);
  assert.equal(fuse.stats.allowed, 1);
  const wide = planConsolidation({ entries, nowMs: NOW, maxChangeRatio: 0.5, runId: RUN });
  assert.equal(wide.ok, true);
  assert.equal(wide.operations.length, 2);
  assert.equal(wide.stats.allowed, 2);
});

test('planConsolidation：非法比例直接 abort，不猜默认值', () => {
  const plan = planConsolidation({ entries: [entry('A')], nowMs: NOW, maxChangeRatio: 1.5, runId: RUN });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'invalid_max_change_ratio');
  assert.equal(plan.operations.length, 0);
  assert.equal(DEFAULT_MAX_CHANGE_RATIO, 0.05);
});

test('planConsolidation：scope / kinds 过滤后，目标不可见就按缺目标处理', () => {
  const a = entry('A', { scope: 'project', kind: 'procedural' });
  const b = entry('B', { scope: 'project', kind: 'semantic', supersedes: ['A'] });
  const plan = planConsolidation({ entries: [a, b], nowMs: NOW, kinds: ['semantic'], runId: RUN });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.skipped[0].reason, 'missing_target', 'B 被 kind 过滤后，A 就不该被关闭');
});

test('巩固回执：可核验 hash、不含正文、篡改能被发现', () => {
  const plan = planConsolidation({ entries: [entry('A'), entry('B', { supersedes: ['A'] })], nowMs: NOW, runId: RUN });
  const applied = plan.operations.map((op) => ({ ...op, before_text_sha256: 'aaa', after_text_sha256: 'bbb' }));
  const receipt = buildConsolidateReceipt({ plan, store: '/tmp/example-store', applied, nowMs: NOW });
  assert.equal(receipt.schema, 'tabellio.consolidate/1');
  assert.equal(receipt.kind, 'consolidate');
  assert.equal(receipt.runId, RUN);
  assert.equal(receipt.reversible, true);
  assert.equal(receipt.operations.length, 1);
  assert.equal(receipt.stats.applied, 1);
  assert.equal(typeof receipt.hash, 'string');
  assert.equal(receipt.hash.length, 32);
  assert.ok(!JSON.stringify(receipt).includes('正文'), '回执只存 hash，不复制正文');
  assert.deepEqual(consolidateReceiptProblems(receipt), []);
  assert.deepEqual(receiptIntegrity(receipt), { ok: true, problems: [] });
  assert.equal(consolidateReceiptHash(receipt), receipt.hash);
  const tampered = { ...receipt, store: '/tmp/other-store' };
  assert.equal(receiptIntegrity(tampered).ok, false);
});

test('sameFields：null 与空字符串等价，只比较三个字段', () => {
  assert.equal(sameFields({ status: 'active', valid_to: null, superseded_by: null }, { status: 'active', valid_to: '', superseded_by: '' }), true);
  assert.equal(sameFields({ status: 'active', valid_to: null, superseded_by: null }, { status: 'active', valid_to: '2026-10-17T12:00:00+08:00', superseded_by: null }), false);
});
