#!/usr/bin/env node
/**
 * 模拟用户语料上的召回评测（不调模型）：多组准入阈值并排比较。
 *
 *   node bench/user-sim/evaluate.mjs --store bench/user-sim/runs/smoke \
 *     --config core:0.15,0.18,0.6 --config plugin:0.12,0.1,0.33 --config cand:0.12,0.1,0.4
 *
 * 口径对齐插件默认：budgetTokens 436、maxNotes 6、includeCore true。
 * 只读；不写库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const { openStore, recallQuery } = await import(path.join(REPO, 'src/api.js'));

function parseArgs(argv) {
  const out = { store: null, queries: null, configs: [], json: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--store') out.store = argv[++i];
    else if (a === '--queries') out.queries = argv[++i];
    else if (a === '--config') out.configs.push(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
  }
  if (!out.store) {
    console.error('用法：node bench/user-sim/evaluate.mjs --store <dir> [--queries q.json] --config name:rel,score,cov ...');
    process.exit(2);
  }
  out.queries = out.queries ?? path.join(out.store, 'queries.json');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const data = JSON.parse(fs.readFileSync(args.queries, 'utf8'));
const queries = args.limit ? data.queries.slice(0, args.limit) : data.queries;
const ctx = openStore(args.store);
const scan = ctx.scan();
const byId = new Map(scan.notes.map((n) => [String(n.id), n]));

const configs = (args.configs.length ? args.configs : ['plugin:0.12,0.1,0.33']).map((spec) => {
  const [name, nums] = spec.split(':');
  const [rel, score, cov] = nums.split(',').map(Number);
  return { name, rel, score, cov };
});

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

const rowsByConfig = new Map();
for (const cfg of configs) {
  const rows = [];
  const lat = [];
  for (const q of queries) {
    const started = process.hrtime.bigint();
    const r = recallQuery(ctx, q.query, {
      budgetTokens: 436,
      maxNotes: 6,
      includeCore: true,
      minRelevance: cfg.rel,
      minScore: cfg.score,
      minCoverage: cfg.cov,
    });
    lat.push(Number(process.hrtime.bigint() - started) / 1e6);
    const items = r.items ?? [];
    const ids = items.map((it) => String(it.id));
    const gold = (q.gold ?? []).map(String);
    const hit = gold.filter((g) => ids.includes(g));
    const scoreRank = gold.map((g) => {
      const i = (r.scores ?? []).findIndex((s) => String(s.id) === g);
      return i < 0 ? Infinity : i + 1;
    });
    rows.push({
      id: q.id,
      persona: q.persona,
      query: q.query,
      answerable: q.answerable,
      refused: r.refused === true,
      reason: r.reason,
      items: items.length,
      pull: (r.split ?? {}).items ?? (r.split ?? {}).pull ?? 0,
      tokens: r.tokens ?? 0,
      goldHit: hit.length,
      goldTotal: gold.length,
      allGold: gold.length > 0 && hit.length === gold.length,
      bestRank: Math.min(...scoreRank, Infinity),
      topTitles: items.slice(0, 3).map((it) => it.title),
      goldTitles: gold.map((g) => byId.get(g)?.title ?? g),
    });
  }
  rowsByConfig.set(cfg.name, rows);
}

function summarize(rows) {
  const ans = rows.filter((r) => r.answerable);
  const neg = rows.filter((r) => !r.answerable);
  const any = ans.filter((r) => r.goldHit > 0).length;
  const all = ans.filter((r) => r.allGold).length;
  const multi = ans.filter((r) => r.goldTotal > 1);
  const multiAll = multi.filter((r) => r.allGold).length;
  const refusedNeg = neg.filter((r) => r.refused).length;
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    answerable: ans.length,
    anyHit: any / ans.length,
    allGold: multiAll / (multi.length || 1),
    multiCount: multi.length,
    avgItems: avg(rows.map((r) => r.items)),
    avgTokens: avg(rows.map((r) => r.tokens)),
    negRefused: refusedNeg / neg.length,
    negNoise: avg(neg.map((r) => r.items)),
    negTokens: avg(neg.map((r) => r.tokens)),
  };
}

if (args.json) {
  const out = {};
  for (const cfg of configs) out[cfg.name] = { summary: summarize(rowsByConfig.get(cfg.name)), rows: rowsByConfig.get(cfg.name) };
  console.log(JSON.stringify(out, null, 1));
} else {
  console.log(`库：${args.store}（${scan.notes.length} 篇）  查询：${queries.length} 条（可答 ${queries.filter((q) => q.answerable).length}）\n`);
  console.log('配置           rel  score cov  | 可答命中  双gold全中  拒答(不可答)  均条数  均token  不可答噪声');
  for (const cfg of configs) {
    const s = summarize(rowsByConfig.get(cfg.name));
    console.log(
      `${cfg.name.padEnd(12)}  ${String(cfg.rel).padEnd(4)} ${String(cfg.score).padEnd(5)} ${String(cfg.cov).padEnd(4)} | ${pct(s.anyHit).padStart(6)}     ${s.allGold.toFixed(2)} (${s.multiCount})     ${pct(s.negRefused).padStart(6)}       ${s.avgItems.toFixed(2)}     ${s.avgTokens.toFixed(0).padStart(4)}      ${s.negNoise.toFixed(2)} 条 / ${s.negTokens.toFixed(0)} tok`,
    );
  }
  console.log('\n漏掉的查询（按第一个配置列出）：');
  for (const r of rowsByConfig.get(configs[0].name).filter((x) => x.answerable && x.goldHit === 0)) {
    console.log(`  ${r.id} [${r.persona}] ${r.query}  → gold=${r.goldTitles.join(' | ')}  判=${r.refused ? r.reason : 'no-hit'}`);
  }
  console.log('\n不可答却注入的（前 8 条）：');
  for (const r of rowsByConfig.get(configs[0].name).filter((x) => !x.answerable && x.items > 0).slice(0, 8)) {
    console.log(`  ${r.id} ${r.query}  → ${r.items} 条：${r.topTitles.join(' / ')}`);
  }
}
