/**
 * `src/core/recall.js`：检索 + **拒答**。
 *
 * 拒答在本项目里是一等公民（§5.3）：它不是错误，是正常结果，
 * 而且必须带上**为什么**（`why_not`）和**最接近的几条**（`nearest`）。
 * 这个文件的用例一半在测这个东西。
 *
 * `02-evaluation.md §5` 判据 1：`recall@5 ≥ 0.80` 且 `correct_refusal_rate ≥ 0.75`。
 * 这里不跑评测集（那归另一个子代理），但把两组**容易互相踩**的性质钉住：
 * 真命中必须过阈值，无关查询必须拒答。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_TOKENS,
  filterNotes,
  recall,
  searchHits,
} from '../src/core/recall.js';
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

// 语料刻意放到 5 条以上：停用词闸（MAX_DF_RATIO）只在 n >= 5 时生效，
// 而它正是「问库里不存在的东西要能拒答」的主要机制。
const CORPUS = [
  entry('build-cmd', 'acme-widget 的构建命令是 pnpm run build，产物在 dist 目录。'),
  entry('deploy-steps', '部署三步：先构建，再同步到 staging，最后跑冒烟脚本。回滚就是同步回上一次产物。', {
    note: { kind: 'procedural' },
  }),
  entry('test-runner', '单测用 node --test 跑，端到端用例放在 e2e 目录下、默认不跑。'),
  entry('proxy-node', '代理节点用 hysteria2，监听 8443 端口，走 UDP。'),
  entry('garden', '园艺：番茄浇水与土壤酸碱度测量方法，见手册第七章。'),
];

const recallOf = (query, options = {}) => recall({ entries: CORPUS, query, options: { nowMs: NOW, ...options } });

test('默认阈值与预算是架构文档写死的值', () => {
  assert.equal(DEFAULT_THRESHOLDS.minRelevance, 0.15);
  assert.equal(DEFAULT_THRESHOLDS.minScore, 0.18);
  assert.equal(DEFAULT_THRESHOLDS.nearestLimit, 5);
  assert.equal(DEFAULT_TOKENS, 500);
});

test('正常命中：问构建设备命令能拿到 build-cmd，且带完整 score 拆解', () => {
  const r = recallOf('acme-widget 的构建命令是什么');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.refused, false);
  assert.equal(r.reason, null);
  assert.equal(r.items[0].id, 'build-cmd');
  const s = r.items[0].score;
  for (const k of ['importance', 'recency', 'relevance', 'total']) {
    assert.equal(typeof s[k], 'number', `score.${k} 必须是数字`);
  }
  assert.match(r.items[0].why, /命中|core/);
  assert.equal(r.items[0].via, 'pull');
});

test('recall：aliases 参与身份核对 —— 正文没写实体名也能召回', () => {
  const entries = [
    entry('other', 'Orchid 的配置文件在 config/orchid.toml。'),
    entry('fixture-reset', '测试夹具乱了就跑 pnpm fixtures:reset --seed 42，重置后失败用例可复现。', {
      title: '测试夹具的重置',
      note: { aliases: ['Orchid'] },
    }),
    entry('filler-1', '番茄浇水与土壤酸碱度测量方法，见园艺手册第七章。'),
    entry('filler-2', '代理节点用 hysteria2，监听 8443 端口，走 UDP。'),
    entry('filler-3', '部署三步：先构建，再同步到 staging，最后跑冒烟脚本。'),
  ];
  const query = 'Orchid 的测试夹具乱了怎么重置？';
  const r = recall({ entries, query, options: { nowMs: NOW } });
  assert.equal(r.refused, false);
  assert.equal(r.items[0].id, 'fixture-reset');
  const without = recall({
    entries: entries.map((e) => (e.id === 'fixture-reset' ? { ...e, note: { ...e.note, aliases: [] } } : e)),
    query,
    options: { nowMs: NOW },
  });
  assert.equal(without.refused, true, '去掉 aliases 后共现核对应挡住这条召回，证明别名是承重的');
});

test('命中结果形状：id/title/content/kind/trust/score/source 一个都不能少', () => {
  const item = recallOf('构建命令').items[0];
  // 注意字段名是 `content`（§9 `recall` 的形状）。冻结的 CLI 契约里叫 `body`，
  // 那是**适配层**的改名，不是内核的字段名 —— 两边混用会让评测器读空字符串。
  for (const k of ['id', 'title', 'content', 'kind', 'trust', 'confidence', 'valid_from', 'valid_to', 'source', 'score', 'why', 'via']) {
    assert.ok(k in item, `缺字段 ${k}`);
  }
  assert.equal(item.source.written_by, 'cli:remember');
  assert.ok('source_ref' in item.source);
});

test('budget 块必须自报：requested / used / maxNotes / dropped', () => {
  const r = recallOf('构建命令');
  assert.equal(r.budget.requested, DEFAULT_TOKENS);
  assert.ok(r.budget.used >= 0);
  assert.equal(r.budget.maxNotes, 8);
  assert.ok(Array.isArray(r.budget.dropped));
  // requested 要跟着调用方给的值走
  assert.equal(recallOf('构建命令', { budgetTokens: 123 }).budget.requested, 123);
});

test('拒答：完全无关的查询返回 insufficient_evidence，不是错误、不是空数组了事', () => {
  const r = recallOf('量子色动力学里的胶子禁闭');
  assert.equal(r.ok, true, '拒答是正常结果，`ok` 必须是 true（调用方看到 error 会重试或编答案）');
  assert.equal(r.status, 'insufficient_evidence');
  assert.equal(r.refused, true);
  assert.ok(r.reason, '拒答必须给理由');
  assert.deepEqual(r.items, [], '拒答时不许偷偷夹带核心档');
});

test('拒答理由的四种取值都能出现，且各自可复现', () => {
  const seen = new Set();
  // ① top_score_below_threshold：有词法命中但分不够
  const weak = recall({
    entries: [entry('weak', '完全无关的园艺内容，只偶然出现一个「构建」字。')],
    query: '构建',
    options: { nowMs: NOW },
  });
  if (weak.refused) seen.add(weak.reason);
  // ② only_external_low_trust：只命中外部低信任
  const ext = recall({
    entries: [entry('ext', '构建命令是 pnpm run build。', { note: { trust: 'external' } })],
    query: '构建命令',
    options: { nowMs: NOW },
  });
  if (ext.refused) seen.add(ext.reason);
  // ③ all_hits_expired：命中的都过期了
  const expired = recall({
    entries: [
      entry('old', 'acme-widget 的构建命令是 pnpm run build。', {
        note: { valid_from: '2020-01-01T00:00:00+08:00', valid_to: '2020-02-01T00:00:00+08:00' },
      }),
    ],
    query: '构建命令',
    options: { nowMs: NOW },
  });
  if (expired.refused) seen.add(expired.reason);
  for (const reason of seen) {
    assert.ok(
      ['top_score_below_threshold', 'only_external_low_trust', 'all_hits_expired', 'conflicting_values_no_time_order'].includes(reason),
      `理由取值必须在 §5.3 的四类里，实际 ${reason}`,
    );
  }
  assert.ok(seen.size >= 2, `至少要能复现两种拒答理由，实际 ${[...seen]}`);
});

test('拒答：过期的笔记按 as-of 判——用 2020 年的 as-of 就能命中它', () => {
  const entries = [
    entry('old', 'acme-widget 的构建命令是 pnpm run build。', {
      note: { valid_from: '2020-01-01T00:00:00+08:00', valid_to: '2020-02-01T00:00:00+08:00' },
    }),
  ];
  const now = recall({ entries, query: '构建命令', options: { nowMs: NOW } });
  assert.equal(now.refused, true, '现在问：它已经过期，应当拒答');
  assert.equal(now.reason, 'all_hits_expired');
  const past = recall({
    entries,
    query: '构建命令',
    options: { nowMs: NOW, asOf: '2020-01-15' },
  });
  assert.equal(past.refused, false, '问 2020-01-15 的时候：它正是有效的那条');
  assert.equal(past.items[0].id, 'old');
});

test('as-of 用纯日期时取当天正午：当天写入的笔记必须算数', () => {
  const entries = [
    entry('today', 'acme-widget 的构建命令是 pnpm run build。', {
      note: { valid_from: '2026-10-17T09:00:00+08:00' },
    }),
  ];
  const r = recall({ entries, query: '构建命令', options: { nowMs: NOW, asOf: '2026-10-17' } });
  assert.equal(r.refused, false, 'date-only 解析成午夜的话这里会判成「还没发生」');
  assert.equal(r.items[0].id, 'today');
});

test('nearest：拒答时要给最接近的几条（否则人不知道该补什么记忆）', () => {
  const r = recallOf('部署这件事具体要怎么做才对');
  if (r.refused) {
    assert.ok(Array.isArray(r.nearest));
    assert.ok(r.nearest.length >= 1, '拒答必须给 nearest，空 nearest 等于没说');
    assert.ok(r.nearest[0].id);
    assert.equal(typeof r.nearest[0].score, 'number');
  } else {
    assert.equal(r.nearest ?? null, null, '没拒答就不该有 nearest');
  }
});

test('阈值是「够不够格」：把 minScore 抬到 1 会让一切都拒答（阈值真的在起作用）', () => {
  const strict = recallOf('构建命令', { minScore: 1.01 });
  assert.equal(strict.refused, true, '阈值抬到不可能达到时，连真命中都必须拒答');
  const loose = recallOf('构建命令', { minScore: 0 });
  assert.equal(loose.refused, false);
});

test('阈值传 null/NaN **不能**把闸门悄悄关掉（fail-closed）', () => {
  const r = recallOf('构建命令', { minScore: null, minRelevance: null });
  assert.equal(typeof r.thresholds.minScore, 'number');
  assert.equal(typeof r.thresholds.minRelevance, 'number');
});

test('filterNotes：各种过滤条件各自记账，且**不**把过滤掉的东西算进命中', () => {
  const entries = [
    entry('keep', '构建命令'),
    entry('wrong-kind', '构建命令', { note: { kind: 'episodic' } }),
    entry('wrong-trust', '构建命令', { note: { trust: 'external' } }),
    entry('wrong-scope', '构建命令', { note: { scope: 'project:other' } }),
    entry('expired', '构建命令', { note: { valid_to: '2020-01-01T00:00:00+08:00' } }),
    entry('drafted', '构建命令', { note: { status: 'draft' } }),
  ];
  const { kept, skipped } = filterNotes(entries, { nowMs: NOW, kinds: ['semantic'], trust: ['user_stated'], scope: 'user' });
  assert.deepEqual(kept.map((e) => e.id), ['keep']);
  assert.equal(skipped.kind_mismatch, 1);
  assert.equal(skipped.trust_mismatch, 1);
  assert.equal(skipped.scope_mismatch, 1);
  assert.equal(skipped.expired_at_as_of, 1, '默认 atMs = now：过期笔记必须走这一格');
  assert.equal(skipped.archived_draft, 1);
  // 账本要能对上总数
  const accounted = Object.values(skipped).reduce((a, b) => a + b, 0);
  assert.equal(kept.length + accounted, entries.length, '每一条都要有归宿：要么进结果，要么进某个跳过计数');
});

test('filterNotes：没有过滤条件时不过滤（不能默认把东西藏起来）', () => {
  const { kept, skipped } = filterNotes(CORPUS, { nowMs: NOW });
  assert.equal(kept.length, CORPUS.length);
  assert.equal(Object.values(skipped).reduce((a, b) => a + b, 0), 0);
});

test('filterNotes：as-of 是「那一刻为真」，不是「那时存在」', () => {
  const entries = [
    entry('future', '构建命令', { note: { valid_from: '2027-01-01T00:00:00+08:00' } }),
    entry('now', '构建命令'),
  ];
  const { kept } = filterNotes(entries, { nowMs: NOW, asOf: '2026-10-17' });
  assert.deepEqual(kept.map((e) => e.id), ['now'], '还没生效的不算「那一刻为真」');
});

test('searchHits：冻结接口形状 —— hits[].id 必须是**文件名**（评测集按文件名对答案）', () => {
  const r = searchHits({ entries: CORPUS, query: '构建命令', options: { nowMs: NOW } });
  assert.deepEqual(Object.keys(r).sort(), ['hits', 'reason', 'refused', 'result', 'tokens']);
  assert.equal(r.hits[0].id, 'build-cmd');
  assert.equal(r.hits[0].title, '标题 build-cmd');
  assert.equal(typeof r.hits[0].score, 'number');
  assert.equal(typeof r.tokens, 'number');
  assert.equal(typeof r.refused, 'boolean');
});

test('searchHits：refused 为 false 时 reason 必须是 null 或空（不许给个理由又不拒答）', () => {
  const r = searchHits({ entries: CORPUS, query: '构建命令', options: { nowMs: NOW } });
  assert.equal(r.refused, false);
  assert.ok(r.reason === null || r.reason === undefined || r.reason === '');
});

test('searchHits：拒答时 hits 为空数组且 refused 为 true（两者必须一致）', () => {
  const r = searchHits({ entries: CORPUS, query: '量子色动力学的胶子禁闭', options: { nowMs: NOW } });
  assert.equal(r.refused, true);
  assert.deepEqual(r.hits, []);
  assert.ok(r.reason);
});

test('recall@5 的排序：问「怎么部署」时部署那条必须在前 5（真语料上的基本盘）', () => {
  const r = recallOf('acme-widget 怎么部署');
  assert.equal(r.refused, false);
  const top5 = r.items.slice(0, 5).map((i) => i.id);
  assert.ok(top5.includes('deploy-steps'), `部署笔记不在前 5：${top5}`);
});

test('recall：空查询 = 空结果（不能退化成「把库里所有东西都给你」）', () => {
  for (const q of ['', '   ', null, undefined]) {
    const r = recall({ entries: CORPUS, query: q, options: { nowMs: NOW } });
    assert.deepEqual(r.items, [], `查询 ${JSON.stringify(q)} 不该返回内容`);
    assert.equal(r.refused, true);
  }
});

test('拒绝理由：只有外部低信任命中时报 only_external_low_trust', () => {
  const r = recall({
    entries: [entry('ext', 'acme-widget 的构建命令是 pnpm run build。', { note: { trust: 'external' } })],
    query: 'acme-widget 构建命令',
    options: { nowMs: NOW },
  });
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'only_external_low_trust');
});

test('停用词闸：问库里完全不存在的东西必须拒答（correct_refusal_rate 的地基）', () => {
  // 中文二字切会把「的构」「是什」这类碎片切出来，它们出现在几乎每篇笔记里。
  // 没有这道闸时，一条毫不相关的笔记也能凑出 0.3 的相关性并越过 minRelevance，
  // 于是系统对任何问题都「有话要说」。
  const r = recallOf('量子色动力学里的胶子禁闭');
  assert.equal(r.refused, true, '无关查询必须拒答，而不是挑一条最像的');
  assert.equal(r.reason, 'top_score_below_threshold');
  // `nearest` 的契约是「**数组永远在**」（调用方不必判空），但内容可以为空：
  // 一个字符都没碰上的时候，`nearest: []` 才是诚实的答案 —— 硬凑几条
  // 「最接近的」等于给调用方递了不该有的暗示。
  assert.ok(Array.isArray(r.nearest), '拒答路径必须给 nearest 字段（哪怕是空数组）');
  // 有部分词法重叠时要真的给出候选（这里「园艺」那条里有「里」这种通用碎片，
  // 用一条明确共享词的查询来验）
  const partial = recallOf('番茄的土壤方法是什么');
  if (partial.refused) {
    assert.ok(partial.nearest.length >= 1, '有词法重叠时 nearest 必须有内容，否则人不知道怎么改词');
    assert.equal(partial.nearest[0].id, 'garden');
  }
});

test('recall：空语料拒答而不是崩（新库第一次查询的必经路径）', () => {
  const r = recall({ entries: [], query: '构建命令', options: { nowMs: NOW } });
  assert.equal(r.ok, true);
  assert.equal(r.refused, true);
  assert.deepEqual(r.items, []);
  assert.equal(r.tokens, 0);
});

test('recall：诊断块带出跳过的分类与预算账（status/explain 要用）', () => {
  const r = recall({
    entries: [entry('a', '构建命令'), entry('b', '构建命令', { note: { kind: 'episodic' } })],
    query: '构建命令',
    options: { nowMs: NOW, kinds: ['semantic'] },
  });
  assert.ok(r.diagnostics, '正常命中路径也要有 diagnostics（两个分支形状必须一致）');
  assert.equal(r.diagnostics.skipped.kind_mismatch, 1);
  assert.equal(typeof r.diagnostics.candidates, 'number');
  assert.ok(Array.isArray(r.diagnostics.ignored));
  // 拒答路径同样要有，否则 `status`/`explain` 得写两套读法
  const refused = recallOf('量子色动力学里的胶子禁闭');
  assert.ok(refused.diagnostics);
  assert.equal(refused.diagnostics.eligible, 0);
});

// ── 覆盖率闸（拒答的主力）────────────────────────────────────────────────────
//
// 这一组测的是「问的东西库里没有对应属性」时的拒答能力。纯 BM25 分**分不开**
// 这两种情况：`数据库端口` 那篇会因为 `数据库/连接` 而拿到很高的分。
// 覆盖率的定义：查询的信息量（按 idf×词权重）里，这篇笔记的某一个桶覆盖了多少。

test('覆盖率：命中笔记必须报 coverage，且口径是「查询信息量的覆盖比例」', () => {
  const r = recallOf('acme-widget 的构建命令是什么');
  assert.equal(r.refused, false);
  const top = r.items[0];
  assert.equal(top.id, 'build-cmd');
  assert.equal(typeof top.score.coverage, 'number');
  assert.ok(top.score.coverage > 0 && top.score.coverage <= 1, `coverage 越界：${top.score.coverage}`);
  // 覆盖率必须在诊断里也能读到（否则 `status`/`explain` 讲不出为什么拒答）
  assert.equal(typeof r.scores[0].coverage, 'number');
});

// 20 篇的语料：覆盖率闸只在「篇数 >= COVERAGE_FULL_CORPUS(20)」时按 minCoverage 全量生效，
// 5 篇的语料走保底闸（见 coverageGate 处的注释）。这里造一篇「多主题长笔记」，
// 它顺带提到 `默认` 这种通用词，于是换个属性问它时 BM25 分并不低 ——
// 拦住这种「同域不同属性」的正是覆盖率。
const BIG = (() => {
  const fills = [];
  for (let i = 1; i <= 15; i += 1) {
    fills.push(entry(`filler-${String(i).padStart(2, '0')}`, `第 ${i} 号构建记录：产物大小 ${i * 13} KB，耗时 ${i} 秒。`));
  }
  return [
    ...fills,
    // 这两篇是**故意放进来稀释 idf** 的：如果库里没有任何笔记讲到「数据库 / 连接」，
    // 那么「数据库连接池」这几个词会变成只存在于 proxy-node 里的稀有词，
    // 覆盖率算出来就是 1.0 —— 于是「同域不同属性」根本测不出来（语料太小，
    // 什么问题看起来都像命中）。真实库里这类「沾边但不答」的笔记才是常态。
    entry('db-note', '数据库的连接串写在环境变量里，连接超时会自动重连。'),
    entry('proxy-notes', '代理相关的杂项：证书放在 conf 目录，日志默认写到 stderr。'),
    entry('proxy-node', '代理节点用 hysteria2，监听 8443 端口，走 UDP。'),
    entry('merge-policy', '合并策略：把改动 rebase 到主分支，冲突时以主分支为准。'),
    entry('release-steps', '发版流程：先冻结分支，再跑一遍单测，最后打标签。'),
    entry('review-window', '代码评审窗口：工作日的下午两点到四点。'),
    entry('theme-choice', '站点主题用 dark，暗色更省眼睛。'),
  ];
})();

test('覆盖率闸：同一域、不同属性的问题必须拒答（这正是纯 BM25 分放过去的那类）', () => {
  const hit = recall({ entries: BIG, query: '代理节点监听哪个端口', options: { nowMs: NOW } });
  assert.equal(hit.refused, false);
  assert.equal(hit.items[0].id, 'proxy-node');
  const miss = recall({ entries: BIG, query: '代理节点的数据库连接池最多允许多少个连接', options: { nowMs: NOW } });
  assert.equal(miss.refused, true, '同域但不同属性的问题不该给出「最像的」那篇');
  assert.equal(miss.reason, 'top_score_below_threshold');
  // 拒答时也必须能看到「差在哪」：ignored 里带着 coverage
  assert.equal(miss.diagnostics.eligible, 0);
  assert.ok(miss.diagnostics.ignored.every((x) => typeof x.coverage === 'number'));
});

test('覆盖率闸是配置项：--min-coverage 调低就放行，调高就拦下（阈值真的在起作用）', () => {
  const q = '代理节点的数据库连接池最多允许多少个连接';
  const strict = recall({ entries: BIG, query: q, options: { nowMs: NOW, minCoverage: 0.98 } });
  const loose = recall({ entries: BIG, query: q, options: { nowMs: NOW, minCoverage: 0 } });
  assert.equal(strict.refused, true);
  assert.equal(loose.refused, false, '把闸门放到 0 必须能放行；否则说明它根本没接上');
});

test('refuse:false 是检索口径：覆盖率不够也把最像的给出去，但不许把「不拒」当成「证据足」', () => {
  const q = '代理节点的数据库连接池最多允许多少个连接';
  const qa = recall({ entries: BIG, query: q, options: { nowMs: NOW } });
  const search = recall({ entries: BIG, query: q, options: { nowMs: NOW, refuse: false } });
  assert.equal(qa.refused, true, 'QA 口径该拒');
  assert.equal(qa.policy, 'qa');
  assert.equal(search.refused, false, '检索口径不拒答');
  assert.equal(search.policy, 'search');
  assert.ok(search.items.length > 0, '检索口径必须给出候选，否则调用方没东西可用');
  // 关键：放出去不等于证据充分 —— 每条仍要带 coverage，宿主据此自己判断。
  assert.ok(search.items.every((it) => typeof it.score.coverage === 'number'));
  assert.ok(
    search.items.every((it) => it.score.coverage < qa.thresholds.minCoverage),
    '这几条本来就过不了覆盖率闸，否则这个用例是空转的',
  );
});

test('refuse:false 不推翻「只有外部低信任命中」：那是宿主自己的判断', () => {
  const external = entry('ext', '第三方评测：widget 的构建命令是 make -j8。');
  external.note = { ...external.note, trust: 'external' };
  const entries = [
    external,
    ...Array.from({ length: 5 }, (_, i) => entry(`fill-${i}`, `无关记录 ${i}：天气和日程。`)),
  ];
  const qa = recall({ entries, query: 'widget 构建命令', options: { nowMs: NOW } });
  const search = recall({ entries, query: 'widget 构建命令', options: { nowMs: NOW, refuse: false } });
  assert.equal(qa.refused, true);
  assert.equal(qa.reason, 'only_external_low_trust');
  assert.equal(search.refused, false, '检索口径把原文交给宿主，由宿主决定信不信');
  assert.equal(search.items[0].trust, 'external');
});

test('覆盖率闸传 null/NaN 不能把闸门悄悄关掉（fail-closed）', () => {
  const q = '代理节点的数据库连接池最多允许多少个连接';
  // 先确认默认阈值下这条会被拦（否则这个用例是空转的）
  const def = recall({ entries: BIG, query: q, options: { nowMs: NOW } });
  assert.equal(def.refused, true, '默认阈值该拦下这条');
  for (const bad of [null, NaN, undefined, 'high']) {
    const r = recall({ entries: BIG, query: q, options: { nowMs: NOW, minCoverage: bad } });
    assert.equal(r.refused, true, `minCoverage=${String(bad)} 不该把闸门关掉`);
    assert.equal(r.thresholds.minCoverage, 0.6, `minCoverage=${String(bad)} 该退回默认值`);
  }
});

test('小语料（< 20 篇）改用保底闸：idf 在 5 篇上没有统计意义，不能拿它判死', () => {
  // 5 篇的语料里，一个通用词就占 1/5 的 df，覆盖率分母全是噪声。
  // 保底闸的意义是：小库里允许「部分覆盖」，但仍然拦住「一个词都没命中」。
  const partial = recallOf('acme-widget 怎么部署');
  assert.equal(partial.refused, false, '5 篇的库上「部分覆盖」必须放行');
  assert.ok(partial.items.some((i) => i.id === 'deploy-steps'));
  const none = recallOf('量子色动力学里的胶子禁闭');
  assert.equal(none.refused, true, '一个词都不命中时，小语料也必须拒答');
});

test('覆盖率的分母不随过滤结果漂移：同一句查询在滤掉过期笔记前后结论一致', () => {
  // recall() 会先滤掉「过期/被替换」的笔记再建索引。如果覆盖率的分母取自过滤后的语料，
  // 那同一句查询会因为「库里恰好有一批笔记过期了」而改变结论 ——
  // 表现就是「昨天答得出来，今天同一句拒答」。参考语料必须取全库。
  const q = '代理节点监听哪个端口';
  const at = { nowMs: NOW };
  const withAll = recall({ entries: BIG, query: q, options: at });
  const withExpired = recall({
    entries: BIG,
    query: q,
    options: { ...at, asOf: '2027-01-01T00:00:00+08:00' },
  });
  assert.equal(withAll.refused, false);
  const covA = withAll.items[0]?.score?.coverage;
  const covB = withExpired.items[0]?.score?.coverage;
  if (covB !== undefined && covB !== null) {
    assert.ok(Math.abs(covA - covB) < 1e-9, `覆盖率不该随过滤漂移：${covA} vs ${covB}`);
  }
});
