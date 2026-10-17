/**
 * `src/core/receipt.js`：回执的规范化、生成、核验与解释。
 *
 * 这里钉住四条性质：
 *  1. hash 建立在稳定序列化上，不随对象 key 的写入顺序变化；
 *  2. 回执**不复制正文**，只记正文 hash；
 *  3. verify 必须区分「回执被改」（tampered）和「笔记变了」（drifted / missing）；
 *  4. explain 只读回执，能说清每一条为什么没纳入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECEIPT_SCHEMA,
  buildRecallReceipt,
  canonicalJson,
  explainReceipt,
  receiptHash,
  verifyReceipt,
} from '../src/core/receipt.js';
import { recall } from '../src/core/recall.js';
import { sha256 } from '../src/util/text.js';
import { parseTime } from '../src/util/clock.js';

const NOW = parseTime('2026-10-17T12:00:00+08:00');
const entry = (id, body, over = {}) => ({
  id,
  title: over.title ?? `标题 ${id}`,
  body,
  name: `${id}.md`,
  file: `${id}.md`,
  bytes: body.length,
  note: {
    id,
    kind: 'semantic',
    trust: 'user_stated',
    scope: 'user',
    confidence: 0.9,
    valid_from: '2026-10-10T12:00:00+08:00',
    valid_to: null,
    mtime: '2026-10-10T12:00:00+08:00',
    provenance: { written_by: 'cli:remember', source_ref: null },
    ...(over.note ?? {}),
  },
  ...(over.entry ?? {}),
});

const CORPUS = [
  entry('build-cmd', 'acme-widget 的构建命令是 pnpm run build，产物在 dist 目录。'),
  entry('deploy-steps', '部署三步：先构建，再同步到 staging，最后跑冒烟脚本。回滚就是同步回上一次产物。', {
    note: { kind: 'procedural' },
  }),
  entry('test-runner', '单测用 node --test 跑，端到端用例放在 e2e 目录下、默认不跑。'),
  entry('proxy-node', '代理节点用 hysteria2，监听 8443 端口，走 UDP。'),
  entry('garden', '园艺：番茄浇水与土壤酸碱度测量方法，见手册第七章。'),
];

function receiptOf(query = 'acme-widget 的构建命令是什么', options = {}) {
  const result = recall({ entries: CORPUS, query, options: { nowMs: NOW, ...options } });
  return {
    result,
    receipt: buildRecallReceipt({
      result,
      entries: CORPUS,
      store: '/tmp/tabellio-test',
      query,
      options: { nowMs: NOW, ...options },
      nowMs: NOW,
      receiptId: 'rcp_01J9Z000000000000000000000',
    }),
  };
}

test('canonicalJson：key 递归排序、数组保序、忽略 undefined、拒绝函数', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }),
    '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
  );
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([undefined, 1]), '[null,1]');
  assert.throws(() => canonicalJson({ a: () => 1 }), TypeError);
});

test('receiptHash：与 key 写入顺序无关，内容一变 hash 就变', () => {
  const one = { schema: RECEIPT_SCHEMA, query: 'a', items: [{ id: 'x', score: { total: 1, relevance: 2 } }] };
  const two = { items: [{ score: { relevance: 2, total: 1 }, id: 'x' }], query: 'a', schema: RECEIPT_SCHEMA };
  assert.equal(receiptHash(one), receiptHash(two));
  const changed = { ...one, query: 'b' };
  assert.notEqual(receiptHash(one), receiptHash(changed));
});

test('buildRecallReceipt：记录决定、预算、分数与正文 hash，但不复制正文', () => {
  const { result, receipt } = receiptOf();
  assert.equal(receipt.schema, RECEIPT_SCHEMA);
  assert.equal(receipt.kind, 'recall');
  assert.match(receipt.receiptId, /^rcp_/);
  assert.equal(receipt.createdAt, '2026-10-17T12:00:00+08:00');
  assert.equal(receipt.decision.status, 'ok');
  assert.equal(receipt.decision.refused, false);
  assert.equal(receipt.budget.requested, 500);
  assert.equal(receipt.budget.used, result.tokens);
  assert.ok(receipt.items.length >= 1);
  const first = receipt.items[0];
  assert.equal(first.id, 'build-cmd');
  assert.ok(!('content' in first), '回执不许复制正文');
  assert.ok(!('body' in first), '回执不许复制正文');
  assert.equal(first.noteSha256, sha256(CORPUS[0].body, 16));
  assert.deepEqual(first.score, result.items[0].score);
  assert.equal(receipt.hash, receiptHash(receipt));
  assert.equal(receipt.hash.length, 32);
});

test('buildRecallReceipt：拒答回执带 nearest，没有纳入项', () => {
  // 用「阈值抬到不可能达到」强制拒答：nearest 的契约是拒答时给最接近的候选，
  // 而完全无词法重叠的查询会得到空 nearest（那种情况下没有「最接近」可言）。
  const { receipt } = receiptOf('acme-widget 的构建命令是什么', { minScore: 1.01 });
  assert.equal(receipt.decision.refused, true);
  assert.equal(receipt.items.length, 0);
  assert.ok(Array.isArray(receipt.nearest));
  assert.ok(receipt.nearest.length >= 1);
  assert.ok(receipt.nearest[0].noteSha256);
  assert.equal(receipt.hash, receiptHash(receipt));
});

test('verifyReceipt：同一份语料 verified；正文变了 drifted；元数据变了也能报出来', () => {
  const { receipt } = receiptOf();
  const good = verifyReceipt(receipt, CORPUS);
  assert.equal(good.ok, true);
  assert.equal(good.status, 'verified');
  assert.equal(good.matched, good.checked);

  const changedCorpus = CORPUS.map((e) => (e.id === 'build-cmd' ? { ...e, body: `${e.body}\n补一句。` } : e));
  const drifted = verifyReceipt(receipt, changedCorpus);
  assert.equal(drifted.ok, false);
  assert.equal(drifted.status, 'drifted');
  assert.equal(drifted.changed.length, 1);
  assert.equal(drifted.changed[0].id, 'build-cmd');
  assert.ok(drifted.changed[0].fields.includes('noteSha256'));

  const trustChanged = CORPUS.map((e) => (e.id === 'build-cmd' ? { ...e, note: { ...e.note, trust: 'external' } } : e));
  const drifted2 = verifyReceipt(receipt, trustChanged);
  assert.equal(drifted2.status, 'drifted');
  assert.ok(drifted2.changed[0].fields.includes('trust'));
});

test('verifyReceipt：笔记消失报 missing；回执被改报 tampered', () => {
  const { receipt } = receiptOf();
  const missing = verifyReceipt(receipt, CORPUS.filter((e) => e.id !== 'build-cmd'));
  assert.equal(missing.status, 'drifted');
  assert.equal(missing.missing.length, 1);
  assert.equal(missing.missing[0].id, 'build-cmd');

  const tampered = structuredClone(receipt);
  tampered.query = '被改过的查询';
  const t = verifyReceipt(tampered, CORPUS);
  assert.equal(t.ok, false);
  assert.equal(t.status, 'tampered');
  assert.equal(t.problems[0].code, 'E_RECEIPT_HASH_MISMATCH');
});

test('explainReceipt：不重跑检索，按阈值给每条未纳入项归因', () => {
  const { receipt } = receiptOf();
  const copy = structuredClone(receipt);
  copy.thresholds = { minRelevance: 0.15, minScore: 0.18, minCoverage: 0.6 };
  copy.coverageGate = 0.6;
  copy.diagnostics.ignoredTotal = 5;
  copy.diagnostics.ignoredShown = 5;
  copy.diagnostics.ignored = [
    { id: 'rel', score: 0.9, relevance: 0.1, coverage: 1, cooccurrence: null },
    { id: 'score', score: 0.1, relevance: 0.9, coverage: 1, cooccurrence: null },
    { id: 'cover', score: 0.9, relevance: 0.9, coverage: 0.2, cooccurrence: null },
    { id: 'cooc', score: 0.9, relevance: 0.9, coverage: 0.9, cooccurrence: { ok: false } },
    { id: 'other', score: 0.9, relevance: 0.9, coverage: 0.9, cooccurrence: { ok: true } },
  ];
  copy.budget.dropped = [{ id: 'dropped', title: 'D', reason: 'maxNotes', limitReason: null, hard: true }];
  const ex = explainReceipt(copy);
  assert.equal(ex.ok, true);
  assert.equal(ex.summary.notRecalled, 5);
  const reasons = Object.fromEntries(ex.notRecalled.map((x) => [x.id, x.reason]));
  assert.equal(reasons.rel, 'below_min_relevance');
  assert.equal(reasons.score, 'below_min_score');
  assert.equal(reasons.cover, 'below_min_coverage');
  assert.equal(reasons.cooc, 'cooccurrence_missing');
  assert.equal(reasons.other, 'unknown');
  assert.equal(ex.summary.dropped, 1);
  assert.equal(ex.integrity.hashOk, false, '改过 ignored 后 hash 已经对不上');
});

test('buildRecallReceipt：诊断列表截断到 100，但保留总数', () => {
  const { result } = receiptOf();
  const ignored = Array.from({ length: 150 }, (_, i) => ({
    id: `note-${i}`,
    score: 0.1,
    relevance: 0.1,
    coverage: 0.1,
    cooccurrence: null,
  }));
  const big = { ...result, diagnostics: { ...result.diagnostics, ignored } };
  const receipt = buildRecallReceipt({
    result: big,
    entries: CORPUS,
    query: 'q',
    options: { nowMs: NOW },
    nowMs: NOW,
    receiptId: 'rcp_01J9Z000000000000000000000',
  });
  assert.equal(receipt.diagnostics.ignoredTotal, 150);
  assert.equal(receipt.diagnostics.ignoredShown, 100);
  assert.equal(receipt.diagnostics.ignored.length, 100);
});
