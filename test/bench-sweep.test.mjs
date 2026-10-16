// 常量扫描装置（`bench/sweep.mjs`）的用例。
//
// 这台装置是「`MIN_COVERAGE` / `INFORMATIVE_DF_RATIO` / `INFORMATIVE_MIN_DOCS`
// 只在 51 篇与 1321 篇两个点上验过」这个缺口的补充，所以用例要盯：
//   ① 同参数两次逐字一致（曲线要能对比）；
//   ② 曲线**真的会随参数变**（不是一根平线 —— 平线等于什么都没测）；
//   ③ 装置自己的计数口径对：拒答的题不算召回（第一版漏了这个，虚报过 0.833）；
//   ④ 语料档位真的换了规模（不是把同一份语料标成不同的 n）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus, judgeQuery, runPoint, sweep, recommend } from '../bench/sweep.mjs';
import { buildIndex, INFORMATIVE_DF_RATIO, INFORMATIVE_MIN_DOCS } from '../src/core/bm25.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWEEP = path.join(HERE, '..', 'bench', 'sweep.mjs');

/** 一次扫描里取某一格。 */
function cell(result, { docs, minCoverage = 0.6, dfRatio = INFORMATIVE_DF_RATIO, minDocs = INFORMATIVE_MIN_DOCS }) {
  return result.points.find((p) => p.docs === docs
    && p.minCoverage === minCoverage
    && p.dfRatio === dfRatio
    && p.minDocs === minDocs);
}

test('扫描：同参数两次跑出逐字一致的曲线', () => {
  const fp = (r) => JSON.stringify(r.points.map((p) => [
    p.docs, p.minCoverage, p.dfRatio, p.minDocs, p.recall_at_k, p.correct_refusal_rate,
  ]));
  const a = sweep({ docs: [50, 200] });
  const b = sweep({ docs: [50, 200] });
  assert.equal(fp(a), fp(b));

  // CLI 也要一致：装置是给 CI 看的，进程内的相等不能替它担保。
  const r1 = spawnSync(process.execPath, [SWEEP, '--json', '--docs', '50'], { encoding: 'utf8' });
  const r2 = spawnSync(process.execPath, [SWEEP, '--json', '--docs', '50'], { encoding: 'utf8' });
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, r2.stdout);
  assert.equal(r1.stderr, '');
  assert.doesNotThrow(() => JSON.parse(r1.stdout)); // stdout 里混一点进度就炸
});

test('扫描：语料档位真的换了规模（不是把同一份语料标成不同的 n）', () => {
  const c50 = buildCorpus(50);
  const c200 = buildCorpus(200);
  const c2000 = buildCorpus(2000);
  // 规模必须真的随档位涨（服务数与每服务条数一起缩放）。
  assert.ok(c50.notes.length < c200.notes.length, `${c50.notes.length} !< ${c200.notes.length}`);
  assert.equal(c200.notes.length, 200);
  assert.equal(c2000.notes.length, 2000);
  // id 不能撞（撞了就等于同一篇笔记被算了两次）。
  const ids = new Set(c200.notes.map((n) => n.id));
  assert.equal(ids.size, c200.notes.length);
  // 每篇都要有标题行：`docs/08-eval-runbook.md` 的语料校验要求正文以 `# ` 开头。
  for (const n of c200.notes) assert.match(n.body, /^# /);
});

test('扫描：装置真的会动 —— 关掉证据性闸门就能答题，打开就答不了', () => {
  // 这一条是整台装置的存在理由：`INFORMATIVE_MIN_DOCS = 200` 恰好卡在
  // 「闸门关闭」与「闸门打开」的边界上，而生产值 `INFORMATIVE_DF_RATIO = 0.05`
  // 在刚打开的语料上会把可答题一起拒掉。曲线如果不动，说明装置没接上。
  const corpus = buildCorpus(200);
  const index = buildIndex(corpus.notes);
  const base = { k: 5, minRelevance: 0.15, minScore: 0.18, minCoverage: 0.6 };

  const off = runPoint(corpus, { ...base, dfRatio: null, minDocs: 0 });
  const on = runPoint(corpus, { ...base, dfRatio: INFORMATIVE_DF_RATIO, minDocs: INFORMATIVE_MIN_DOCS });
  assert.ok(off.recall_at_k > 0, '闸门关掉时应该还能答上一些题');
  assert.ok(on.recall_at_k < off.recall_at_k,
    `打开闸门（df/n ≤ ${INFORMATIVE_DF_RATIO}）反而没损失召回：off=${off.recall_at_k} on=${on.recall_at_k}`);

  // 而且这条查询确实被判成「没有证据词」—— 拒答理由是那句 no_informative_term。
  const answerable = corpus.tasks.find((t) => t.kind === 'answerable');
  const refused = judgeQuery(index, answerable.query, { ...base, dfRatio: INFORMATIVE_DF_RATIO, minDocs: INFORMATIVE_MIN_DOCS });
  assert.equal(refused.refused, true);
  assert.equal(refused.refuseReason, 'no_informative_term');
  assert.equal(refused.informativeCount, 0);
});

test('扫描：拒答的题不算召回（计数口径不能自己给自己记功）', () => {
  const corpus = buildCorpus(50);
  const index = buildIndex(corpus.notes);
  const point = runPoint(corpus, {
    k: 5, minRelevance: 0.15, minScore: 0.18,
    // 覆盖率闸门收到 1.0：几乎全拒，于是 recall 必须掉下来，而不是「命中就在候选里」照记。
    minCoverage: 1, dfRatio: null, minDocs: 0,
  });
  const hitRows = point.rows.filter((r) => r.kind === 'answerable' && r.hit);
  for (const row of hitRows) assert.equal(row.refused, false, `${row.id} 被拒答了却记成了命中`);
  assert.ok(point.recalls <= point.answerable);
  assert.equal(point.recall_at_k, point.answerable ? point.recalls / point.answerable : null);
});

test('扫描：建议值必须满足「先保召回」这条硬约束', () => {
  const result = sweep({ docs: [50, 200] });
  const rec = recommend(result, { recallFloor: 0.95 });
  assert.equal(rec.recallFloor, 0.95);
  // 语料两档上 recall 都到不了 0.95（这正是本装置的结论），所以不该硬凑一个建议出来。
  if (rec.best) {
    assert.ok(rec.best.worst_recall >= 0.95, '建议值的召回不能低于地板');
  } else {
    assert.equal(rec.feasible, 0);
    assert.ok(rec.combos.length > 0, '即使没有可行解，也要把扫过的组合报出来');
  }
});

test('扫描 CLI：`--json` 是纯 JSON，参数错误退出码 2', () => {
  const bad = spawnSync(process.execPath, [SWEEP, '--docs', 'x'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--docs/);
  assert.equal(bad.stdout, '');

  const unknown = spawnSync(process.execPath, [SWEEP, '--nope'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /不认识的参数/);

  const help = spawnSync(process.execPath, [SWEEP, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--docs/);

  // Markdown 输出至少要有两张曲线表和一段建议。
  const md = spawnSync(process.execPath, [SWEEP, '--docs', '50'], { encoding: 'utf8' });
  assert.equal(md.status, 0);
  assert.match(md.stdout, /## 曲线/);
  assert.match(md.stdout, /## 建议/);
});
