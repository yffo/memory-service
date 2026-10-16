/**
 * `src/core/bm25.js`：纯词法检索（零依赖、零网络、零模型）。
 *
 * 重点断言的是**参数取舍**与**桶化**，不是具体分值：
 *  - `B = 0.4` 而不是教科书的 0.75（长笔记在这个语料里是常态，长度归一化会变成
 *    「谁长谁输」）；这里用「同内容的长短两篇，长的那篇不能被打到地板」来守它。
 *  - 一条 267KB 的巨型笔记曾经在 30 条查询里压住 17 条（旧项目实测），
 *    所以正文按 400 字切桶：桶让长笔记的命中不被自身长度稀释。
 *  - 「一篇笔记仍然只是一条命中」：桶是实现细节，不能漏到接口上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  K1,
  B,
  TITLE_EXTRA,
  TAG_EXTRA,
  QUERY_TERM_CAP,
  PHRASE_BONUS,
  INDEX_VERSION,
  INDEX_BUILDER,
  sectionsOf,
  tokenizeRecord,
  buildIndex,
  serializeIndex,
  deserializeIndex,
  selectTerms,
  scoreDocs,
  aggregateByNote,
  isInformativeTerm,
  INFORMATIVE_DF_RATIO,
  INFORMATIVE_MIN_DOCS,
} from '../src/core/bm25.js';
import { expandQuery } from '../src/core/tokenize.js';

const doc = (id, title, body, extra = {}) => ({ id, section: 0, title, body, tags: [], ...extra });
const idx = (docs) => buildIndex(docs);

test('参数是刻意取的值：B=0.4 不是 0.75，短语加成是 0', () => {
  assert.equal(K1, 1.2);
  assert.equal(B, 0.4, 'B 改回 0.75 会让长笔记系统性掉分（这个语料里长笔记是常态）');
  assert.equal(PHRASE_BONUS, 0, '整句子串加成被实测否决：奖励抄了题面的笔记，把对的挤下去');
  assert.equal(TITLE_EXTRA, 3, '标题权重回到 3：24 那次数值是用「标题当查询」的控制集调出来的，结构性偏向标题');
  assert.equal(TAG_EXTRA, 2);
  assert.equal(QUERY_TERM_CAP, 24);
  assert.equal(INDEX_VERSION, 1);
  assert.equal(INDEX_BUILDER, 'bm25-lexical-1');
});

test('buildIndex：空语料不炸、不产生 NaN', () => {
  const index = idx([]);
  assert.equal(index.n, 0);
  assert.equal(index.avgLen, 0);
  assert.deepEqual(scoreDocs(index, '任何查询'), []);
});

test('scoreDocs：完全无关的查询得 0 分且**不进结果**（不是得个很小的分）', () => {
  const index = idx([doc('a', '构建命令', '用 pnpm 构建')]);
  assert.deepEqual(scoreDocs(index, '量子色动力学'), []);
});

test('scoreDocs：纯函数 —— 同一索引同一查询，两次结果完全一致', () => {
  const index = idx([doc('a', '标题一', '正文一'), doc('b', '标题二', '正文二')]);
  const q = expandQuery('正文');
  const r1 = scoreDocs(index, q);
  const r2 = scoreDocs(index, q);
  assert.deepEqual(r1, r2, '可回放是审计地基：打分不许有隐藏状态');
});

test('scoreDocs：命中更罕见的词得分更高（IDF 在起作用）', () => {
  // 「通用」出现在每篇；「独角兽」只出现一次
  const docs = [
    doc('a', '通用一', '通用 独角兽'),
    doc('b', '通用二', '通用'),
    doc('c', '通用三', '通用'),
  ];
  const index = idx(docs);
  const rare = scoreDocs(index, '独角兽');
  const common = scoreDocs(index, '通用');
  assert.equal(rare.length, 1);
  assert.equal(index.metas[rare[0].docIndex].id, 'a');
  assert.ok(rare[0].score > common[0].score, '罕见词的单次命中必须比常见词值钱');
});

test('长度归一化：**同内容**的长短两篇，长的不能被压到地板（B=0.4 的守门用例）', () => {
  const tail = '填充句子。'.repeat(40);
  const index = idx([
    doc('short', '部署步骤', '部署步骤是三步。'),
    doc('long', '部署步骤', `部署步骤是三步。${tail}`),
  ]);
  const scored = scoreDocs(index, '部署步骤');
  const byId = Object.fromEntries(scored.map((h) => [index.metas[h.docIndex].id, h.score]));
  assert.ok(byId.long > 0 && byId.short > 0);
  const ratio = byId.long / byId.short;
  assert.ok(ratio > 0.25, `长笔记被压得太狠（比值 ${ratio.toFixed(3)}）：B 调大了或者桶没生效`);
});

test('标题权重：标题命中排在正文命中之前（TITLE_EXTRA=3）', () => {
  const index = idx([
    doc('by-title', '缓存策略', '这一篇讲别的。'),
    doc('by-body', '别的主题', '顺便提一句缓存策略。'),
  ]);
  const scored = scoreDocs(index, '缓存策略');
  assert.equal(index.metas[scored[0].docIndex].id, 'by-title');
});

test('标签权重：命中标签也能召回（TAG_EXTRA=2）', () => {
  const index = idx([
    doc('tagged', '一篇笔记', '正文里没有那个词。', { tags: ['部署'] }),
    doc('other', '另一篇', '正文里也没有。'),
  ]);
  const scored = scoreDocs(index, '部署');
  assert.equal(scored.length, 1);
  assert.equal(index.metas[scored[0].docIndex].id, 'tagged');
});

test('sectionsOf：短正文一个桶；长正文按 400 字切且**标题只喂首桶**', () => {
  const short = sectionsOf(doc('a', '标题', '短正文'));
  assert.equal(short.length, 1);
  assert.equal(short[0].section, 0);
  assert.equal(short[0].title, '标题');

  const long = sectionsOf(doc('b', '标题', '字'.repeat(1000)));
  assert.equal(long.length, 3);
  assert.equal(long[0].title, '标题');
  assert.equal(long[1].title, '', '标题重复喂给每个桶会把长笔记的分数抬虚');
  assert.equal(long[1].section, 1);
  assert.equal(long[1].weightLabel, '§2');
  assert.ok(long.every((s) => s.id === 'b'));
});

test('sectionsOf：桶数有上限（一条巨型笔记不能吃掉整个索引）', () => {
  const huge = sectionsOf(doc('big', '', '字'.repeat(400 * 500)));
  assert.ok(huge.length <= 40, `桶数 ${huge.length} 超过上限`);
});

test('长笔记：正文尾部的内容仍然能被搜到（这就是切桶的理由）', () => {
  const head = '前面全是无关内容。'.repeat(100);
  const index = idx([doc('long', '长笔记', `${head}尾巴上的独角兽结论。`)]);
  const scored = scoreDocs(index, '独角兽结论');
  assert.equal(scored.length, 1, '不切桶的话尾部词项的相对权重会被整篇长度吃掉');
});

test('tokenizeRecord：tf 按标题×3、标签×2、正文×1 累加', () => {
  const { tf, len } = tokenizeRecord({ title: '部署', body: '部署', tags: ['部署'] });
  assert.equal(tf.get('部署'), 1 + TITLE_EXTRA + TAG_EXTRA);
  assert.equal(len, 1 + TITLE_EXTRA + TAG_EXTRA);
});

test('selectTerms：查询词项多于上限时按 IDF 选最 specific 的（总词数会砍，但不能砍错）', () => {
  // 中文二字组会被切开，所以用一个**切出来只有一项**的查询词：
  // 「独角兽」→ 独角/角兽 两项，要控制的是「同一批 expansions 里哪一项 IDF 高」。
  const docs = [];
  for (let i = 0; i < 30; i++) docs.push(doc(`d${i}`, `标题${i}`, i === 0 ? '独角兽' : '通用的句子'));
  const index = idx(docs);
  const expansions = [...expandQuery('独角兽'), ...expandQuery('通用的句子')];
  const kept = selectTerms(index, expansions, 1);
  assert.equal(kept.length, 1);
  const idfOf = (t) => Math.log(1 + (index.n - index.postings.get(t).length + 0.5) / (index.postings.get(t).length + 0.5));
  const rarest = expansions.reduce((a, b) => (idfOf(b.term) > idfOf(a.term) ? b : a));
  assert.equal(kept[0].term, rarest.term, `该留 IDF 最高的「${rarest.term}」`);
  // 不在索引里的词项直接被滤掉（它们本来也贡献 0 分，留着只会挤掉有用的）
  assert.deepEqual(selectTerms(index, expandQuery('根本不存在的词')), []);
});

test('aggregateByNote：同一篇笔记的多个桶只算一条命中，且取**最高分桶**', () => {
  // 直接喂桶级结果：真实打分下同一篇笔记的各个桶常常同分（同内容重复的语料），
  // 那测不出「取最高」这件事。这里要验的是聚合规则本身。
  // 同一篇笔记（id 'a'）的两个桶
  const index = idx([
    { id: 'a', section: 0, title: '标题', body: '正文' },
    { id: 'a', section: 1, title: '', body: '正文后半' },
    { id: 'b', section: 0, title: '别的', body: '别的正文' },
  ]);
  const agg = aggregateByNote(
    [
      { docIndex: 0, score: 2.5, terms: [] }, // a 的桶 0（最高）
      { docIndex: 2, score: 1.0, terms: [] }, // b 的桶 0
      { docIndex: 1, score: 0.4, terms: [] }, // a 的桶 1（较低）
    ],
    index,
  );
  const ids = agg.map((h) => h.id);
  assert.deepEqual(ids, ['a', 'b'], '按笔记聚合后按分数降序');
  const a = agg.find((h) => h.id === 'a');
  assert.equal(a.score, 2.5, '分数取最高桶，不是求和也不是平均');
  assert.deepEqual(a.sections.sort(), [0, 1], '命中的桶号仍然可查（诊断用）');
});

test('aggregateByNote：真实打分路径下同一 id 也绝不重复出现', () => {
  const index = idx([doc('a', '标题', '字符'.repeat(600)), doc('b', '别的', '别的正文')]);
  const agg = aggregateByNote(scoreDocs(index, '字符'), index);
  const ids = agg.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, `同一 id 出现了两次：${ids}`);
  assert.ok(agg.some((h) => h.id === 'a'));
});

test('aggregateByNote：按分数降序、同分按 id 稳定排序（顺序确定才可回放）', () => {
  const index = idx([doc('b', '同样的词', '同样的词'), doc('a', '同样的词', '同样的词')]);
  const agg = aggregateByNote(scoreDocs(index, '同样的词'), index);
  assert.deepEqual(agg.map((h) => h.id), ['a', 'b'], '同分时必须按 id 定序，不能靠 Map 插入顺序');
});

test('序列化 round-trip：Map 变数组再变回来，打分结果一模一样', () => {
  const docs = [doc('a', '标题一', '正文内容一'), doc('b', '标题二', '正文内容二')];
  const index = idx(docs);
  const raw = serializeIndex(index);
  assert.ok(!(raw.postings instanceof Map), 'JSON 不认 Map，必须转成数组');
  const back = deserializeIndex(raw);
  assert.equal(back.n, index.n);
  assert.equal(back.version, index.version);
  assert.deepEqual(scoreDocs(back, '正文内容一'), scoreDocs(index, '正文内容一'));
});

test('deserializeIndex：fingerprint 不匹配一律返回 null —— fail-closed，让调用方去重建', () => {
  const raw = serializeIndex(idx([doc('a', 't', 'b')]));
  assert.equal(deserializeIndex({ ...raw, builder: '别的构建器' }), null, '构建器指纹不同 = 索引口径变了，必须重建');
  assert.equal(deserializeIndex({ ...raw, version: INDEX_VERSION + 1 }), null, 'schema 版本不同 = 字段语义可能变了');
  assert.notEqual(deserializeIndex(raw), null, '对照组：原样的索引必须能读回来');
});

test('deserializeIndex：坏输入返回 null 而不是抛（索引坏了该重建，不该让进程死）', () => {
  for (const bad of [null, undefined, {}, [], 'not-an-object', 42, { version: INDEX_VERSION, builder: INDEX_BUILDER }]) {
    assert.equal(deserializeIndex(bad), null, `${JSON.stringify(bad)} 应该返回 null`);
  }
  // 结构对但内部破损：postings 形状不对、meta 数与 n 不符
  const raw = serializeIndex(idx([doc('a', 't', 'b')]));
  assert.equal(deserializeIndex({ ...raw, postings: [['x', 'not-an-array']] }), null);
  assert.equal(deserializeIndex({ ...raw, n: 99 }), null);
  assert.equal(deserializeIndex({ ...raw, docLen: [] }), null);
});

// ── 分母退化保护：查询没有「有信息量的词项」时不算证据（M2） ──────────────────
//
// 实测病灶：真实库（1321 篇）上「量子色动力学里的胶子禁闭」只剩 `里的`（df 96）
// 一个词项，于是**每一篇含 `里的` 的笔记覆盖率都是 1.0**（1/1），92 篇无关笔记
// 全部越过 minCoverage=0.6 的拒答闸。这不是「覆盖得很全」，是分母塌了。

test('INFORMATIVE_DF_RATIO：小语料下闸不生效（df/n 在 5 篇上没有统计意义）', () => {
  // 守住「评测语料 51 篇不许被误拒」这条：小语料一律算有信息量。
  assert.equal(isInformativeTerm(5, 5), true);
  assert.equal(isInformativeTerm(51, 51), true);
  assert.equal(INFORMATIVE_MIN_DOCS, 200);
  assert.ok(INFORMATIVE_MIN_DOCS > 51, '阈值必须大于计分集语料规模，否则会误拒真答案');
});

test('INFORMATIVE_DF_RATIO：大语料下按 5% 判（1321 篇里 df 66 是分界）', () => {
  const n = 1321;
  assert.equal(isInformativeTerm(1, n), true, '罕见词当然是证据');
  assert.equal(isInformativeTerm(66, n), true, '正好 5% 仍然算（保守一侧）');
  assert.equal(isInformativeTerm(67, n), false, '越过 5% 就不算证据了');
  assert.equal(isInformativeTerm(115, n), false, '「什么」这种满库皆是的词必须被判掉');
  assert.equal(isInformativeTerm(0, n), true, 'df=0（库里没有）不能算「没信息量」');
});

test('scoreDocs：查询里一个「有信息量」的词项都没有时，queryInfo 明说（分母 = 0）', () => {
  const n = 400;
  // 造一个「闸门」在 200/400 篇里都出现的大语料 —— 等于 df/n = 50%，远超 5%
  const docs = [];
  for (let i = 0; i < n; i++) {
    docs.push(doc(`d${i}`, `标题${i}`, i < 200 ? '闸门 别的东西' : `独有的内容${i}`));
  }
  const index = idx(docs);
  // 「闸门的默认值」在边界改造后只剩 `闸门`/`默认`/`认值` 三个词项，
  // 其中 `闸门` df=200（50%），另两个 df=0 —— 于是**没有一个**算证据。
  const scored = scoreDocs(index, expandQuery('闸门的默认值'));
  assert.equal(scored.queryInfo.informativeGateEnabled, true);
  assert.deepEqual(scored.queryInfo.informativeTerms, [], '没有证据词项时必须是空数组');
  assert.equal(scored.queryInfo.queryMass, 0, '分母塌成 0');
  assert.ok(scored.length > 0, '候选仍然照常返回（诊断/nearest 要看得到东西）');
  for (const hit of scored) assert.equal(hit.coverage, 0, '每篇覆盖率都要是 0，不能有一篇 1.0');
});

test('scoreDocs：有信息量词项在场时，常见词项不参与分母（不是「打折」是「不算」）', () => {
  const n = 400;
  const docs = [];
  for (let i = 0; i < n; i++) docs.push(doc(`d${i}`, `标题${i}`, i < 200 ? '闸门' : `独有${i}`));
  // 最后一篇同时含常见词（闸门）与罕见词（kestrel）
  docs.push(doc('rare', 'Kestrel 闸门', 'kestrel 闸门'));
  const index = idx(docs);
  const scored = scoreDocs(index, expandQuery('闸门的 kestrel'));
  const terms = scored.queryInfo.informativeTerms;
  assert.ok(terms.includes('kestrel'), `kestrel 必须算证据：${terms}`);
  assert.ok(!terms.includes('闸门'), `闸门 df/n=50% 不该算证据：${terms}`);
  // 只有 kestrel 的笔记拿到 1.0；只含闸门的一大批必须是 0
  const byId = new Map(scored.map((s) => [index.metas[s.docIndex].id, s]));
  assert.equal(byId.get('rare').coverage, 1);
  assert.equal(byId.get('d0').coverage, 0, '只命中了常见词的那些不能靠它拿到覆盖率');
});

test('scoreDocs：keepCommon（诊断路径）不走这道闸 —— 它要看的正是原始匹配', () => {
  const n = 400;
  const docs = [];
  for (let i = 0; i < n; i++) docs.push(doc(`d${i}`, `标题${i}`, i < 200 ? '闸门' : `独有${i}`));
  const index = idx(docs);
  const scored = scoreDocs(index, expandQuery('闸门的默认值'), { keepCommon: true });
  assert.equal(scored.queryInfo.informativeGateEnabled, false, '诊断路径明说闸没开');
  assert.ok(scored.length > 0, '原始匹配仍然要算出来，否则拒答时给不出 nearest');
});

test('scoreDocs：queryInfo 是**不可枚举**属性（返回值必须还是「一个数组」）', () => {
  const index = idx([doc('a', '甲', '内容')]);
  const scored = scoreDocs(index, expandQuery('内容'));
  assert.deepEqual(scored, [...scored], 'deepEqual 不该看见 queryInfo');
  assert.ok(Array.isArray(scored));
  assert.equal(
    Object.keys(scored).length,
    scored.length,
    '可枚举键只能有数组下标，不能多出 queryInfo',
  );
  assert.ok(!Object.keys(scored).includes('queryInfo'));
  assert.equal(Object.getOwnPropertyDescriptor(scored, 'queryInfo').enumerable, false);
  assert.ok(scored.queryInfo, '但按属性名读得到');
  assert.ok(Object.isFrozen(scored.queryInfo), '挂上去的口径不许被下游改写');
});
