// M5 夹具契约测试。
//
// 这一组用例守的不是「数字好看」，而是**夹具本身说的那几句话是不是真的**：
//   ① 判别词的 df 随语料规模真实增长（旧夹具恒为 12，那是失真）；
//   ② 可答题「证据在库、答案唯一」；
//   ③ 不可答题「近邻同服务、同词表，但那个事实库里没有」—— 不许用生僻词造难度；
//   ④ 两类题的形状同形，差别只在「那个知识点号有没有覆盖这个服务」。
//
// 为什么要写成用例而不是只写在文档里：夹具失真的故障现象是「读数突然变好看」，
// 而不是报错。没有断言守着的合成语料，会在某次无关改动里悄悄退化成一台
// 「怎么改常量都通过」的橡皮图章 —— 旧夹具就是这么用了三个里程碑的。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAINS,
  SERVICES,
  buildCorpus,
  serviceCount,
  serviceSpan,
  verifyCorpus,
  bigramsOf,
} from '../bench/sweep-fixtures.mjs';
import { INFORMATIVE_DF_RATIO, buildIndex, isInformativeTerm } from '../src/core/bm25.js';
import { PROD_PARAMS, judgeQuery, runPoint } from '../bench/sweep.mjs';

const TIERS = [50, 200, 500, 1000, 2000];
const kpName = (i) => `kp${String(i).padStart(5, '0')}`;

test('夹具契约：判别词的 df 随语料规模真实增长（旧夹具恒为 12）', () => {
  const rows = TIERS.map((n) => {
    const corpus = buildCorpus(n);
    const index = buildIndex(corpus.notes);
    const df = (t) => index.postings.get(t)?.length ?? 0;
    return {
      n,
      svc: df(SERVICES[0].toLowerCase()),
      subject: df(DOMAINS[0].subject.slice(0, 2)),
    };
  });
  // 服务名这一维：每一档都必须真的在库里活着，而且随规模长。
  for (const r of rows) {
    assert.ok(r.svc >= 2, `n=${r.n} 服务名 df=${r.svc}：判别词不能是孤例`);
    assert.ok(r.svc <= r.n, `n=${r.n} 服务名 df=${r.svc} 超过笔记数`);
  }
  assert.ok(rows[0].svc < rows[rows.length - 1].svc,
    `服务名 df 没随规模增长：${rows.map((r) => r.svc).join(' → ')}`);
  // 领域属性词同一件事，而且它要长得比服务名快（它按领域铺开，不按服务）。
  assert.ok(rows[0].subject < rows[rows.length - 1].subject,
    `领域属性 df 没随规模增长：${rows.map((r) => r.subject).join(' → ')}`);
  // 旧夹具的病：df 恒为 12，与 n 无关。这里显式否定它。
  const distinct = new Set(rows.map((r) => r.subject));
  assert.ok(distinct.size >= 4, `领域属性 df 只有 ${distinct.size} 个不同取值，说明没跟着规模动`);
});

test('夹具契约：可答题证据在库、答案唯一；不可答题近邻在库但事实不同', () => {
  for (const n of TIERS) {
    const corpus = buildCorpus(n);
    // verifyCorpus 会在夹具违反契约时抛异常，这里再断言它的计数覆盖了两类题。
    const v = verifyCorpus(corpus);
    assert.ok(v.answerable > 0, `n=${n} 没有可答题`);
    assert.ok(v.refusal > 0, `n=${n} 没有不可答题`);
    assert.equal(v.refused, v.refusal);
    // 每篇笔记的 id 唯一、正文以 '# ' 开头（语料校验的硬要求）。
    const ids = new Set(corpus.notes.map((x) => x.id));
    assert.equal(ids.size, corpus.notes.length, `n=${n} 有重复 id`);
    for (const note of corpus.notes) assert.match(note.body, /^# /);
  }
});

test('夹具契约：不可答题靠的是「组合不存在」，不是「生僻词」', () => {
  for (const n of TIERS) {
    const corpus = buildCorpus(n);
    const index = buildIndex(corpus.notes);
    const present = (t) => (index.postings.get(t)?.length ?? 0) > 0;
    const refusals = corpus.tasks.filter((t) => t.kind === 'refusal');
    assert.ok(refusals.length > 0, `n=${n} 没有不可答题`);
    for (const t of refusals) {
      const [svc, kp] = t.missing.split('|');
      // 近邻在库：服务名与知识点号都必须真的存在（存在 ≠ 这个组合存在）。
      assert.ok(present(svc.toLowerCase()), `n=${n} ${t.id}：服务名不在库`);
      assert.ok(present(kp), `n=${n} ${t.id}：知识点号不在库`);
      // 被问的属性名是中文词：切词之后是二元组，逐元组查（整串当然不在库里，
      // 那正是「这个事实没写过」的意思，不是生僻词的证据）。
      for (const gram of bigramsOf(t.subject)) {
        assert.ok(present(gram), `n=${n} ${t.id}：属性词的切词结果 ${gram} 不在库（成了生僻词）`);
      }
      // 事实不在库：那个组合确实没有对应笔记。
      assert.ok(!corpus.notes.some((x) => x.id === `${svc.toLowerCase()}-${kp}`),
        `n=${n} ${t.id}：被问的组合其实在库`);
      // 判据：库里有近邻 —— 同一服务下至少有别的知识点号存在。
      const sameSvc = corpus.notes.filter((x) => x.id.startsWith(`${svc.toLowerCase()}-`));
      assert.ok(sameSvc.length >= 2, `n=${n} ${t.id}：同服务下没有近邻`);
    }
  }
});

test('夹具契约：两类题题面同形，且不可答题的判别词不是生僻词', () => {
  const corpus = buildCorpus(500);
  const index = buildIndex(corpus.notes);
  const shapes = new Set();
  for (const t of corpus.tasks) {
    // 同形 = 「服务 的 属性 号 是多少？」这一个模板，只有槽位不同。
    assert.match(t.query, /^\S+ 的\S+ kp\d{5} 是多少？$/, `${t.id} 题面形状不同：${t.query}`);
    shapes.add(t.kind);
  }
  assert.deepEqual([...shapes].sort(), ['answerable', 'refusal']);
  // 判别词的 df 不许是 1（那是生僻词），也不许是整库（那没有鉴别力）。
  for (const t of corpus.tasks.filter((x) => x.kind === 'refusal')) {
    const df = index.postings.get(t.anchor)?.length ?? 0;
    assert.ok(df >= 2 && df < index.n, `${t.id} 判别词 df=${df} 落在生僻/无鉴别区间`);
  }
});

test('归因：覆盖率闸门结构上无法拒绝「近邻命中了判别词」的题（钉子用例）', () => {
  // 这条用例把 M5 的结论钉住，防止它被「调参调好了」的假象覆盖。
  //
  // 机理：`coveredIds` 的分母是「证据词的 idf×权重之和」，每个词项**只算一次**；
  // 分子是命中词的 `qWeight·tf(k1+1)/(tf+k1·norm)`，单词命中可以放大到 ≈2.2×。
  // 于是只要近邻命中一个证据词，它的覆盖率就可能 ≥ 1；而「金标 + 被问事实不同」
  // 这两件事在覆盖率里**长得一样** —— 除非近邻一个证据词都不命中。
  //
  // 可直接观测的推论：生产口径在新夹具五档上一条都不拒。
  for (const n of TIERS) {
    const point = runPoint(buildCorpus(n), PROD_PARAMS);
    assert.ok(point.recall_at_k >= 0.80, `n=${n} 召回掉到 ${point.recall_at_k}`);
    assert.equal(point.correct_refusal_rate, 0,
      `n=${n} 拒答率变成 ${point.correct_refusal_rate}：机理假设被推翻，请重新归因`);
  }
});

test('归因：闸门的两条口径都在按设计工作，废不掉的是覆盖率这一支', () => {
  // 这条用例把「机制缺哪一条」钉死，防止归因被写成「阈值再严一点就好了」。
  //
  // ① 比例口径确实在丢常见词：服务名 df=168/2000（8.4%），超过 0.05 → 判非证据。
  const index2000 = buildIndex(buildCorpus(2000).notes);
  const svcDf = index2000.postings.get(SERVICES[0].toLowerCase())?.length ?? 0;
  assert.ok(svcDf / index2000.n > INFORMATIVE_DF_RATIO,
    `服务名占比没超过比例线：df=${svcDf} n=${index2000.n}`);
  assert.ok(!isInformativeTerm(svcDf, index2000.n),
    `服务名 df=${svcDf} 在比例口径下仍算证据`);

  // ② 但每个知识点号是**孤例级**的稀罕词（n=2000 时 df=4），它自己就过了闸门；
  //    也就是说「证据词」这一支在不可答题上照样成立 —— 缺的不是筛证据词。
  for (const n of [200, 2000]) {
    const corpus = buildCorpus(n);
    const index = buildIndex(corpus.notes);
    const refusals = corpus.tasks.filter((t) => t.kind === 'refusal');
    for (const t of refusals.slice(0, 5)) {
      const df = index.postings.get(t.anchor)?.length ?? 0;
      assert.ok(isInformativeTerm(df, index.n),
        `n=${n} ${t.id}：判别词 df=${df} 竟然不是证据词，归因要重写`);
    }
  }

  // ③ 真正废掉的是覆盖率这一支：只要是**孤例级**判别词，命中它的文档覆盖率
  //    就被 `Math.min(1, mass/totalMass)` 顶到 1.000 —— 分母里这个判别词只算一次，
  //    分子里 `tf(k1+1)/(tf+k1·norm)` 能把它放大到 ≈2.2 倍。于是「金标」与
  //    「近邻命中了同一个判别词」在覆盖率上完全同形：这道题就是它的钉子。
  const corpus = buildCorpus(2000);
  const index = buildIndex(corpus.notes);
  const refusal = corpus.tasks.find((t) => t.kind === 'refusal');
  const judged = judgeQuery(index, refusal.query, { ...PROD_PARAMS, minCoverage: null });
  assert.equal(judged.refused, false, '新夹具上不可答题仍然被判成「答」——这正是要归因的现象');
  assert.ok(judged.informativeCount >= 1, '判别词过了闸门，所以拒绝它不是证据词的问题');
  assert.equal(judged.hits[0].coverage, 1, `top-1 覆盖率=${judged.hits[0].coverage}：饱和效应应当顶到 1`);
  // 而且被判「答」的理由是命中了一个**同一判别词、不同服务**的近邻 —— 形状对，
  // 就是覆盖面这一支区分不出来。
  const topNote = corpus.notes.find((x) => x.id === judged.hits[0].id);
  assert.ok(topNote.title.includes(refusal.anchor), `top-1 命中的不是判别词：${topNote.title}`);
  assert.ok(!topNote.id.startsWith(refusal.missing.split('|')[0].toLowerCase() + '-'),
    `top-1 竟然就是金标服务自己的笔记：${topNote.title}`);
});
