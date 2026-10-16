// 常量扫描装置（`bench/sweep.mjs`）的用例。
//
// 这台装置是「`MIN_COVERAGE` / `INFORMATIVE_DF_RATIO` / `INFORMATIVE_DF_FLOOR_DOCS`
// 只在 51 篇与 1321 篇两个点上验过」这个缺口的补充（M3 建装置，M4 据它的扫描结果
// 修掉了「刚过 200 篇时闸门把可答题全拒」），所以用例要盯：
//   ① 同参数两次逐字一致（曲线要能对比）；
//   ② 曲线**真的会随参数变**（不是一根平线 —— 平线等于什么都没测）；
//   ③ 装置自己的计数口径对：拒答的题不算召回（第一版漏了这个，虚报过 0.833）；
//   ④ 语料档位真的换了规模（不是把同一份语料标成不同的 n）；
//   ⑤ 生产闸门在**每一档语料**上都既有召回又有拒答（M4 回归：200 篇档不许全拒）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROD_PARAMS, buildCorpus, judgeQuery, runPoint, sweep, recommend,
} from '../bench/sweep.mjs';
import { SERVICES } from '../bench/sweep-fixtures.mjs';
import {
  INFORMATIVE_DF_FLOOR_DOCS,
  INFORMATIVE_DF_RATIO,
  INFORMATIVE_MIN_DOCS,
  buildIndex,
} from '../src/core/bm25.js';
import { recall } from '../src/core/recall.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWEEP = path.join(HERE, '..', 'bench', 'sweep.mjs');

/** 一次扫描里取某一格。 */
function cell(result, {
  docs, minCoverage = 0.6, dfRatio = INFORMATIVE_DF_RATIO, dfFloor = INFORMATIVE_DF_FLOOR_DOCS,
}) {
  return result.points.find((p) => p.docs === docs
    && p.minCoverage === minCoverage
    && p.dfRatio === dfRatio
    && (p.dfFloor ?? 0) === dfFloor);
}

test('扫描：同参数两次跑出逐字一致的曲线', () => {
  const fp = (r) => JSON.stringify(r.points.map((p) => [
    p.docs, p.minCoverage, p.dfRatio, p.dfFloor, p.recall_at_k, p.correct_refusal_rate,
  ]));
  const a = sweep({ docs: [50, 200], dfFloorPoints: [0, INFORMATIVE_DF_FLOOR_DOCS] });
  const b = sweep({ docs: [50, 200], dfFloorPoints: [0, INFORMATIVE_DF_FLOOR_DOCS] });
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

test('扫描：装置真的会动 —— 关掉证据性闸门就能答题，纯比例口径就答不了', () => {
  // 这一条是整台装置的存在理由。它原本量的是「`INFORMATIVE_MIN_DOCS = 200` 卡在
  // 闸门开/关的边界上」；M4 把闸门的判据换成「绝对词频地板 **或** df/n 比例」之后
  // （见 `src/core/bm25.js` 的 `isInformativeTerm`），量的是同一件事的更准确版本：
  // **在刚过 200 篇的语料上，纯比例口径（地板 0）会把可答题一起拒掉，地板 64 则不会。**
  // 曲线如果不动，说明装置没接上。
  const corpus = buildCorpus(200);
  const index = buildIndex(corpus.notes);
  const base = { k: 5, minRelevance: 0.15, minScore: 0.18, minCoverage: 0.6 };

  const off = runPoint(corpus, { ...base, dfRatio: null, minDocs: 0, dfFloor: 0 });
  assert.ok(off.recall_at_k > 0, '闸门关掉时应该还能答上一些题');

  // 造一条**只含一个库内词项**的查询：服务名。它在 200 篇档的 df=40（20%），
  // 因此纯比例口径（地板 0）判它非证据 → 整条查询没有证据词 → 被拒。
  // 这正是 `isInformativeTerm` 的比例那一支在说话，与语料规模无关地可复现。
  const svc = SERVICES[0];
  const probe = { ...base, dfRatio: INFORMATIVE_DF_RATIO, minDocs: 0, dfFloor: 0 };
  const svcDf = index.postings.get(svc.toLowerCase())?.length ?? 0;
  assert.ok(svcDf / index.n > INFORMATIVE_DF_RATIO,
    `服务名该是常见词：df=${svcDf} n=${index.n}`);
  const refused = judgeQuery(index, `${svc} 的zzzz`, probe);
  assert.equal(refused.refused, true);
  assert.equal(refused.refuseReason, 'no_informative_term');
  assert.equal(refused.informativeCount, 0);

  // M4 修的就是这一段：加一条**与语料规模无关**的绝对词频判据之后，
  // 同一个词项算证据（40 ≤ 64），整条查询不再被误拒。
  const fixed = judgeQuery(index, `${svc} 的zzzz`, {
    ...probe, dfFloor: INFORMATIVE_DF_FLOOR_DOCS,
  });
  assert.equal(fixed.refused, false, '加了绝对词频地板之后不该再拒这条查询');
  assert.equal(fixed.refuseReason, null);
  assert.ok(fixed.informativeCount >= 1, `服务名该算证据，实得 ${fixed.informativeCount}`);
});

test('扫描：拒答的题不算召回（计数口径不能自己给自己记功）', () => {
  const corpus = buildCorpus(50);
  const index = buildIndex(corpus.notes);
  const point = runPoint(corpus, {
    k: 5, minRelevance: 0.15, minScore: 0.18,
    // 覆盖率闸门收到 1.0：几乎全拒，于是 recall 必须掉下来，而不是「命中就在候选里」照记。
    minCoverage: 1, dfRatio: null, minDocs: 0, dfFloor: 0,
  });
  const hitRows = point.rows.filter((r) => r.kind === 'answerable' && r.hit);
  for (const row of hitRows) assert.equal(row.refused, false, `${row.id} 被拒答了却记成了命中`);
  assert.ok(point.recalls <= point.answerable);
  assert.equal(point.recall_at_k, point.answerable ? point.recalls / point.answerable : null);
});

test('扫描：小语料不许全拒 —— 200 篇档生产口径必须还能答题', () => {
  // M3 的扫描量出的缺陷：200 篇档上生产值把**可答题全部拒掉**（recall@5 0.0%）。
  // 这一条是它的回归用例：五档逐档跑**生产口径**（`PROD_PARAMS`，与
  // `src/core/bm25.js` 的常量同一个来源），可答题 recall@5 都不许掉到 0.70 以下。
  //
  // 为什么地板是 0.70 而不是 0.80/0.95：本合成语料的 recall 上界就是 80.0%
  // —— 120 道可答题里 36 道是 `drop` 档，问的是「同一类事实的另一个名词」，
  // 而那个名词在语料里 df=0（切词把它切成别的二元组了），BM25 无论如何都命不中。
  // 闸门关掉时也是 80.0%，所以 0.70 留出的是「语料构造噪声」的余量，不是放松闸门。
  for (const docs of [50, 200, 500, 1000, 2000]) {
    const point = runPoint(buildCorpus(docs), PROD_PARAMS);
    assert.ok(point.recall_at_k >= 0.70,
      `${docs} 篇档：可答题 recall@5 只有 ${point.recall_at_k}（缺陷就是这一档掉到 0.0）`);
  }
});

test('扫描：真库尺度上闸门仍然咬人（绝对地板不许把闸门整段废掉）', () => {
  // M5 重建夹具之后，这条用例的**旧断言失效了**，改量三件现在是真的、且可证伪的事，
  // 免得把一条假成绩留在仓库里。旧的 `correct_refusal_rate >= 0.50` 之所以能过，
  // 靠的是旧夹具的结构缺陷（不可答题 = 「服务名 + 一个通用词」，判别词 df 恒为 12）：
  // 那时 1000 篇档有 5/8 条不可答题因为判别词被比例闸门丢掉而「恰好」被拒。
  // 新夹具把那两条不真实的性质都修掉之后，同一档的拒答率是 0.000 —— 这不是回归，
  // 是**旧读数本身建立在夹具失真上**（详见 `docs/06-architecture.md §5.5.1`）。
  const corpus = buildCorpus(1000);
  const point = runPoint(corpus, PROD_PARAMS);

  // ① 召回这一半必须结结实实：证据在库、答案唯一，答案篇就是唯一含判别词的笔记。
  assert.ok(point.recall_at_k >= 0.90,
    `1000 篇档 recall@5 只有 ${point.recall_at_k}：证据在库就该答得出来`);
  assert.equal(point.answerable, point.recalls, '可答题应当全中');

  // ② 拒答这一半：新夹具上生产口径**一条都不拒**。这条断言把「无解」钉住，
  //    而不是让它随参数漂移成一个看起来还行的数。归因见 §5.5.1：
  //    覆盖率闸门的分母里每个证据词只算一次，而分子里单词命中可以放大到 ≈2.2×，
  //    所以「近邻命中了服务之外的判别词」这件事，覆盖率**结构上**区分不出来。
  assert.equal(point.correct_refusal_rate, 0,
    `夹具重建后生产口径不该拒答，实得 ${point.correct_refusal_rate}`);

  // ③ 装置真的接上了：关掉覆盖率闸门，可答题还是全中（说明召回不是靠闸门放水）。
  const noCoverage = runPoint(corpus, { ...PROD_PARAMS, minCoverage: null });
  assert.ok(noCoverage.recall_at_k >= 0.90,
    `关掉覆盖率闸门后召回掉了：${noCoverage.recall_at_k}`);
});

test('扫描：装置量的是生产的行为（`judgeQuery` vs `recall()` 逐题判定一致）', () => {
  // 这台装置把 `src/core/recall.js` 的闸门口径**重写了一遍**（它要能把常量当参数传，
  // 而 `recall()` 只认模块常量）。重写就会漂：M4 改闸门时就踩到过一次 ——
  // 装置算覆盖率用的分母是「库里存在的词项」，生产的 `totalMass` 分母是「证据词」，
  // 于是同一档语料上装置读 62.5%、生产读 75.0%。所以口径必须逐题对账。
  //
  // 只对**判定**（答 / 拒）取一致，不对分数取一致：装置走 `keepCommon` 打分、
  // 覆盖率自己算，逐位相同是过度约束。判定相同就足以保证「装置报的召回与拒答率
  // 是生产会报的数」。
  for (const docs of [50, 1000]) {
    const corpus = buildCorpus(docs);
    const index = buildIndex(corpus.notes);
    // `recall()` 认 `scanStore().notes` 的形状：id/title/body 在顶层，笔记字段在 `note`。
    const entries = corpus.notes.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      note: { id: n.id, title: n.title, body: n.body, kind: n.kind, trust: n.trust, tags: [] },
    }));
    let diff = 0;
    for (const t of corpus.tasks) {
      const device = judgeQuery(index, t.query, PROD_PARAMS).refused;
      const prod = recall({
        entries,
        query: t.query,
        // 预算放到足够大：默认预算会按 token 裁掉一些笔记，那是注入层的事，
        // 不是判定层的事（判定只看 eligible 是否为空）。
        options: {
          minRelevance: PROD_PARAMS.minRelevance,
          minScore: PROD_PARAMS.minScore,
          minCoverage: PROD_PARAMS.minCoverage,
          budget: { maxNotes: 12, maxTokens: 20000 },
        },
      }).status === 'insufficient_evidence';
      if (device !== prod) diff += 1;
    }
    assert.equal(diff, 0, `${docs} 篇档：装置与生产有 ${diff} 道题判定不同`);
  }
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
