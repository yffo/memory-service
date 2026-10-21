#!/usr/bin/env node
/**
 * judge 变体扫描：只量「judge 会不会把 gold 裁掉」，不跑作答模型。
 *
 *   EVAL_LLM_API_KEY=... node bench/user-sim/judge-sweep.mjs \
 *     --store bench/user-sim/runs/combined --concurrency 8
 *
 * 召回口径固定为候选配置（0.12/0.1/0.1、8 条、includeCore true），
 * 送审与插件一致：前 4 条。变量只有三个：
 *   snippet  每条送审的正文字符数（200 = 插件现状）
 *   prompt   strict（"Be strict"，插件现状）/ soft（"含答案线索就留"）
 *   keepTop  是否强制保留第 1 条（最高分那条）
 *
 * 产出：可答题的 gold 存活率（被 judge 留下的 gold 条数 / 召回里的 gold 条数）、
 * 全部 gold 存活的题数、不可答题留下的条数（噪声），以及 judge 延迟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const { openStore, recallQuery } = await import(path.join(REPO, 'src/api.js'));

const BASE_URL = (process.env.EVAL_LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.EVAL_LLM_MODEL || 'deepseek-flash';
const API_KEY = process.env.EVAL_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const JUDGE_MAX_NOTES = 4;
const REL = 0.12;
const SCORE = 0.1;
const COV = 0.1;

function parseArgs(argv) {
  const out = { store: null, queries: null, concurrency: 6, out: null, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--store') out.store = argv[++i];
    else if (a === '--queries') out.queries = argv[++i];
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
  }
  if (!out.store) {
    console.error('用法：node bench/user-sim/judge-sweep.mjs --store <dir> [--limit N] [--concurrency N] [--out json]');
    process.exit(2);
  }
  out.queries = out.queries ?? path.join(out.store, 'queries.json');
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!API_KEY) {
  console.error('缺少 API key：EVAL_LLM_API_KEY');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(args.queries, 'utf8'));
const queries = args.limit ? data.queries.slice(0, args.limit) : data.queries;
const ctx = openStore(args.store);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(messages, { maxTokens = 800, temperature = 0, label = '' } = {}) {
  let lastError = null;
  let budget = maxTokens;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: budget, stream: false }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      if (!res.ok) throw new Error(`http ${res.status} ${(await res.text()).slice(0, 160)}`);
      const body = await res.json();
      const msg = body?.choices?.[0]?.message ?? {};
      const content = String(msg.content ?? '').trim();
      if (content) return content;
      lastError = new Error('empty content');
      budget = Math.min(4000, budget * 2);
    } catch (error) {
      lastError = error;
      await sleep(600 * (attempt + 1) + Math.floor(Math.random() * 400));
    }
  }
  throw new Error(`${label} failed: ${lastError?.message}`);
}

const PROMPTS = {
  strict: [
    'You are filtering a personal memory store before it is injected into a chat.',
    'Decide which numbered notes actually help answer the question. Be strict:',
    'a shared word is not enough; the note must contain facts the question asks for.',
    'Answer with JSON only: {"keep":[1,3]} — empty array when none of them help.',
  ],
  soft: [
    'You are filtering a personal memory store before it is injected into a chat.',
    'Keep every note that could plausibly contain facts the question asks for.',
    'The excerpt may be cut off before the answer sentence appears — when unsure, keep it.',
    'Only drop notes that are clearly about something else.',
    'Answer with JSON only: {"keep":[1,3]} — empty array only when none of them could help.',
  ],
};

function buildPrompt(prompt, query, notes, snippet) {
  const lines = notes.map((note, index) => {
    const body = String(note.body ?? '').replace(/\s+/g, ' ').slice(0, snippet);
    return `[${index + 1}] ${note.title ?? ''}\n${body}`;
  });
  return [
    ...PROMPTS[prompt],
    '',
    `Question: ${String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)}`,
    '',
    'Notes:',
    ...lines,
  ].join('\n');
}

function parseKeep(reply, count) {
  const text = String(reply ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.keep)) return null;
  const keep = new Set();
  for (const raw of parsed.keep) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= count) keep.add(n - 1);
  }
  return [...keep].sort((a, b) => a - b);
}

const VARIANTS = [
  { name: 'strict200w4', prompt: 'strict', snippet: 200, keepTop: false, window: 4 },
  { name: 'strict200w8', prompt: 'strict', snippet: 200, keepTop: false, window: 8 },
  { name: 'soft200w4', prompt: 'soft', snippet: 200, keepTop: false, window: 4 },
  { name: 'soft500w4', prompt: 'soft', snippet: 500, keepTop: false, window: 4 },
  { name: 'soft200w8', prompt: 'soft', snippet: 200, keepTop: false, window: 8 },
];

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

const results = {};
for (const variant of VARIANTS) {
  const rows = await mapLimit(queries, args.concurrency, async (q) => {
    const result = recallQuery(ctx, q.query, {
      maxNotes: 8,
      budgetTokens: 3000,
      maxChars: 1200,
      minRelevance: REL,
      minScore: SCORE,
      minCoverage: COV,
      includeCore: true,
    });
    const items = (result.items ?? []).map((item) => ({ id: String(item.id), title: item.title, body: item.content }));
    const gold = new Set((q.gold ?? []).map(String));
    const notes = items.slice(0, variant.window);
    const started = Date.now();
    let keep = null;
    let error = null;
    if (notes.length) {
      try {
        const reply = await chat([{ role: 'user', content: buildPrompt(variant.prompt, q.query, notes, variant.snippet) }], { label: 'judge' });
        keep = parseKeep(reply, notes.length);
        if (!keep) error = 'unparsed';
      } catch (e) {
        error = e.message;
      }
    } else {
      keep = [];
    }
    const elapsed = Date.now() - started;
    const keptIdx = error || !keep ? notes.map((_, i) => i) : keep;
    if (variant.keepTop && notes.length && !keptIdx.includes(0)) keptIdx.unshift(0);
    const kept = keptIdx.map((i) => notes[i]);
    const goldInRecall = notes.filter((n) => gold.has(n.id)).length + items.slice(variant.window).filter((n) => gold.has(n.id)).length;
    const goldKept = kept.filter((n) => gold.has(n.id)).length + items.slice(variant.window).filter((n) => gold.has(n.id)).length;
    return {
      id: q.id,
      answerable: q.answerable,
      goldInRecall,
      goldKept,
      kept_top: kept.length,
      tail: items.slice(variant.window).length,
      error,
      elapsed,
    };
  });
  const answerable = rows.filter((r) => r.answerable);
  const refusable = rows.filter((r) => !r.answerable);
  const goldTotal = answerable.reduce((a, r) => a + r.goldInRecall, 0);
  const goldKept = answerable.reduce((a, r) => a + r.goldKept, 0);
  const allKept = answerable.filter((r) => r.goldInRecall > 0 && r.goldKept === r.goldInRecall).length;
  const recalled = answerable.filter((r) => r.goldInRecall > 0).length;
  const mean = (list, key) => (list.length ? list.reduce((a, r) => a + r[key], 0) / list.length : 0);
  const keptMean = mean(rows, 'kept_top');
  const tailMean = mean(rows, 'tail');
  const refusableEmpty = refusable.filter((r) => r.kept_top === 0).length;
  const answerKept = mean(answerable, 'kept_top');
  results[variant.name] = {
    variant: variant.name,
    gold_survival: goldTotal ? goldKept / goldTotal : 1,
    all_gold_kept: `${allKept}/${recalled}`,
    kept_top_mean: Number(keptMean.toFixed(2)),
    answerable_kept_top: Number(answerKept.toFixed(2)),
    tail_mean: Number(tailMean.toFixed(1)),
    noise_empty: `${refusableEmpty}/${refusable.length}`,
    errors: rows.filter((r) => r.error).length,
    p50_ms: rows.map((r) => r.elapsed).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  };
  console.log(variant.name, JSON.stringify(results[variant.name]));
}

if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify({ model: MODEL, config: { rel: REL, score: SCORE, cov: COV, maxNotes: 8 }, results }, null, 2));
  console.log('写入', args.out);
}
