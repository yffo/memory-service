// 诊断：逐题看「查询词项在库里的 df / 算不算证据 / 命中的是哪条笔记 / 那条笔记的覆盖率」。
//
// 它回答的是 M4 那句结论的**机制**问题，而不是重跑一遍曲线：
// 「两类题在覆盖率上完全不可分」到底是①不可答题的查询词项也在库里大量存在
// （于是覆盖率必然高），还是②机制缺一条（没有任何一个常量能让它们分开）。
// 两者的修法完全不同：①要重造夹具，②要加机制。
//
// 零依赖，不起子进程，只读 src。
//
// 用法：
//   node bench/sweep-diag.mjs --docs 50,200 --kind all|refusal|answerable --limit 12
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpus, judgeQuery, PROD_PARAMS } from './sweep.mjs';
import { buildIndex } from '../src/core/bm25.js';
import { expandQuery } from '../src/core/tokenize.js';
import { saturateRelevance } from '../src/core/score.js';

export function parseArgs(argv) {
  const o = { docs: [200], kind: 'all', limit: 12, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (a === '--docs') o.docs = next().split(',').map(Number);
    else if (a === '--kind') o.kind = next();
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--json') o.json = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return o;
}

/** 库里「有哪些词项存在」的 df 表 + 每个词项算不算证据。 */
export function termProfile(index, query, { dfRatio = 0.05, dfFloor = 64 } = {}) {
  const exps = expandQuery(query);
  return exps.map((e) => {
    const df = index.postings.get(e.term)?.length ?? 0;
    const present = df > 0;
    const informative = present && (df <= dfFloor || df / index.n <= dfRatio);
    return { term: e.term, weight: e.weight, source: e.source, df, present, informative };
  });
}

/** 逐题一行。 */
export function diagnoseTask(corpus, index, task, params) {
  const prof = termProfile(index, task.query, {
    dfRatio: params.dfRatio ?? 0.05, dfFloor: params.dfFloor ?? 64,
  });
  const present = prof.filter((p) => p.present);
  const info = prof.filter((p) => p.informative);
  const j = judgeQuery(index, task.query, params);
  const top = j.hits[0] ?? null;
  return {
    id: task.id,
    kind: task.kind,
    level: task.level ?? null,
    query: task.query,
    n_terms: prof.length,
    n_present: present.length,
    n_informative: info.length,
    terms: prof,
    refused: j.refused,
    reason: j.refuseReason,
    eligible: j.eligibleCount,
    top: top ? { id: top.id, coverage: top.coverage, relevance: top.relevance, score: top.score } : null,
    gold: task.gold ?? null,
    gold_rank: task.gold ? (j.hits.findIndex((h) => h.id === task.gold) + 1 || null) : null,
    // 直接关掉覆盖率闸门看「top-5 里最大的覆盖率」——M4 用的就是这个读数。
    max_cov_any: (() => {
      const off = judgeQuery(index, task.query, { ...params, minCoverage: null });
      return off.hits.slice(0, 5).reduce((m, h) => Math.max(m, h.coverage ?? 0), 0);
    })(),
  };
}

export function diagnose(n, { params = PROD_PARAMS } = {}) {
  const corpus = buildCorpus(n);
  const index = buildIndex(corpus.notes);
  return corpus.tasks.map((t) => diagnoseTask(corpus, index, t, params));
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const out = [];
  for (const n of o.docs) {
    const rows = diagnose(n);
    for (const r of rows) {
      if (o.kind !== 'all' && r.kind !== o.kind) continue;
      out.push({ ...r, docs: n });
    }
  }
  if (o.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  for (const n of o.docs) {
    const rows = out.filter((r) => r.docs === n).slice(0, o.limit);
    process.stdout.write(`\n=== n=${n}（显示前 ${rows.length} 题）===\n`);
    for (const r of rows) {
      process.stdout.write(`\n[${r.kind}${r.level ? `/${r.level}` : ''}] ${r.id}  「${r.query}」\n`);
      process.stdout.write(`  判定 ${r.refused ? `拒(${r.reason})` : `答(eligible=${r.eligible})`}`
        + `  词项 ${r.n_present}/${r.n_terms} 在库, 其中证据词 ${r.n_informative}`
        + `  top=${r.top ? `${r.top.id} cov=${r.top.coverage.toFixed(3)} rel=${r.top.relevance.toFixed(3)}` : '—'}`
        + `  top5max_cov=${r.max_cov_any.toFixed(3)}`
        + `${r.gold ? `  gold_rank=${r.gold_rank ?? '—'}` : ''}\n`);
      const big = r.terms.filter((t) => t.present).sort((a, b) => b.df - a.df).slice(0, 8);
      process.stdout.write(`  在库词项: ${big.map((t) => `${t.term}(df=${t.df}${t.informative ? '*' : ''})`).join(' ')}\n`);
      const miss = r.terms.filter((t) => !t.present).map((t) => t.term);
      if (miss.length) process.stdout.write(`  库里没有: ${miss.join(' ')}\n`);
    }
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
