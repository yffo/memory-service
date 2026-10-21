#!/usr/bin/env node
/**
 * 模拟用户端到端评测：召回 → judge → 注入块 → 真模型作答 → LLM 打分。
 *
 *   EVAL_LLM_API_KEY=... node bench/user-sim/e2e.mjs --store bench/user-sim/runs/combined \
 *     --config core:0.15,0.18,0.6 --config plugin:0.12,0.1,0.33 --runs 1 --concurrency 8 \
 *     --out bench/user-sim/runs/e2e-round1.md
 *
 * 每一步都尽量对齐插件默认：budgetTokens 436、maxNotes 6、includeCore true、
 * judge 只看前 4 条（200 字摘要）、注入 formatRecall(1400 字 / 前 2 条全文)。
 * judge prompt 与 tabellio-dsh/src/judge.js 同文（此处复制，避免 bench 反向依赖插件包）。
 *
 * 打分：答对率（可答题）、拒答率（不可答题）、误答率（不可答题却回答了）、注入 token。
 * 只读库；--json 时把逐条结果写到 <out>.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DSHSRC = path.resolve(REPO, '../tabellio-dsh/src');
const { openStore, recallQuery } = await import(path.join(REPO, 'src/api.js'));
const { formatRecall } = await import(path.join(DSHSRC, 'render.js'));

const BASE_URL = (process.env.EVAL_LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.EVAL_LLM_MODEL || 'deepseek-flash';
const API_KEY = process.env.EVAL_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '';

function parseArgs(argv) {
  const out = { store: null, queries: null, configs: [], json: false, limit: null, concurrency: 6, out: null, repeats: 1, maxNotes: 6, budgetTokens: 436, maxChars: 0, judge: true, judgeWindow: 4, fullNotes: 2, snippetChars: 120, injectMaxChars: 1400 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--store') out.store = argv[++i];
    else if (a === '--queries') out.queries = argv[++i];
    else if (a === '--config') out.configs.push(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--runs') out.repeats = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--max-notes') out.maxNotes = Number(argv[++i]);
    else if (a === '--budget-tokens') out.budgetTokens = Number(argv[++i]);
    else if (a === '--push-max-notes') out.pushMaxNotes = Number(argv[++i]);
    else if (a === '--push-max-tokens') out.pushMaxTokens = Number(argv[++i]);
    else if (a === '--max-chars') out.maxChars = Number(argv[++i]);
    else if (a === '--no-judge') out.judge = false;
    else if (a === '--judge-window') out.judgeWindow = Number(argv[++i]);
    else if (a === '--full-notes') out.fullNotes = Number(argv[++i]);
    else if (a === '--snippet-chars') out.snippetChars = Number(argv[++i]);
    else if (a === '--inject-max-chars') out.injectMaxChars = Number(argv[++i]);
  }
  if (!out.store) {
    console.error('用法：node bench/user-sim/e2e.mjs --store <dir> --config name:rel,score,cov [--limit N] [--out md] [--json]');
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
const queries = (args.limit ? data.queries.slice(0, args.limit) : data.queries);
const ctx = openStore(args.store);
const scan = ctx.scan();
const byId = new Map(scan.notes.map((n) => [String(n.id), n]));

const configs = (args.configs.length ? args.configs : ['plugin:0.12,0.1,0.33']).map((spec) => {
  const [name, nums] = spec.split(':');
  const [rel, score, cov] = nums.split(',').map(Number);
  return { name, rel, score, cov };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One chat call; adaptive max_tokens for reasoning models (content empty when reasoning ate it). */
async function chat(messages, { maxTokens = 700, temperature = 0, label = '' } = {}) {
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
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`http ${res.status} ${text.slice(0, 200)}`);
      }
      const body = await res.json();
      const msg = body?.choices?.[0]?.message ?? {};
      const content = String(msg.content ?? '').trim();
      if (content) return { content, reasoning: String(msg.reasoning_content ?? '') };
      lastError = new Error('empty content');
      budget = Math.min(4000, budget * 2);
    } catch (error) {
      lastError = error;
      await sleep(600 * (attempt + 1) + Math.floor(Math.random() * 400));
    }
  }
  throw new Error(`${label} failed: ${lastError?.message}`);
}

// ---------- judge（与插件同文） ----------
const JUDGE_MAX_NOTES = 4;
const SNIPPET_CHARS = 200;

function buildJudgePrompt(query, notes) {
  const lines = notes.map((note, index) => {
    const body = String(note.body ?? '').replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS);
    return `[${index + 1}] ${note.title ?? ''}\n${body}`;
  });
  return [
    'You are filtering a personal memory store before it is injected into a chat.',
    'Decide which numbered notes actually help answer the question. Be strict:',
    'a shared word is not enough; the note must contain facts the question asks for.',
    'Answer with JSON only: {"keep":[1,3]} — empty array when none of them help.',
    '',
    `Question: ${String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)}`,
    '',
    'Notes:',
    ...lines,
  ].join('\n');
}

function parseJudgeReply(reply, count) {
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
  const keepValue = parsed?.keep;
  if (!Array.isArray(keepValue)) return null;
  const keep = new Set();
  for (const raw of keepValue) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= count) keep.add(n - 1);
  }
  return [...keep].sort((a, b) => a - b);
}

async function judgeItems(query, items) {
  // 召回条目的正文在 `content`；插件侧是 `read(store, id).body`。这里必须显式
  // 映射，否则 judge 只看到标题 —— 实测会把一半 gold 判成无关。
  const window = args.judgeWindow;
  const notes = items.slice(0, window).map((item) => ({ ...item, body: item.body ?? item.content ?? '' }));
  try {
    const { content } = await chat([
      { role: 'user', content: buildJudgePrompt(query, notes) },
    ], { maxTokens: 800, label: 'judge' });
    const keep = parseJudgeReply(content, notes.length);
    if (!keep) return { ok: false, keep: notes.map((_, i) => i), raw: content };
    const kept = keep.map((i) => notes[i]);
    // 超出 4 条的尾巴本来就没送审，按插件行为保留。
    return { ok: true, keep, items: [...kept, ...items.slice(window)], raw: content };
  } catch (error) {
    return { ok: false, keep: notes.map((_, i) => i), error: error.message };
  }
}

// ---------- 作答与打分 ----------
const ANSWER_SYSTEM = [
  '你是用户的私人助理，正在回答用户关于他自己历史记录的问题。',
  '只能用下面提供的「本地记忆」内容回答；记忆里没有的信息就说「我这边没有记过」，不要猜。',
  '回答 1–3 句，直接给事实（数字、日期、结论），不要复述记忆块。',
].join('\n');

async function answer(query, block) {
  const content = block ? `${block}\n\n用户问题：${query}` : `用户问题：${query}`;
  const { content: reply } = await chat([
    { role: 'system', content: ANSWER_SYSTEM },
    { role: 'user', content },
  ], { maxTokens: 900, label: 'answer' });
  return reply;
}

async function score(q, reply) {
  const goldBodies = (q.gold ?? [])
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((n) => `# ${n.title}\n${String(n.body ?? '').slice(0, 600)}`)
    .join('\n\n');
  const rubric = q.answerable
    ? [
        '你要判断「助理的回答」是否正确用到了「参考笔记」里的事实。',
        '标准：核心事实（数字/日期/结论/做法）与参考笔记不矛盾且覆盖了问题所问；只答对一部分也算不正确。',
        '回答拒绝作答或说没有记录 = 不正确（本题库里确实有答案）。',
        '只输出 JSON：{"correct":true|false,"abstained":true|false,"reason":"一句话"}',
      ].join('\n')
    : [
        '「参考笔记」是无关资料（本题库里并没有答案）。判断助理是否正确地表示「没有记过 / 无法回答」。',
        '助理编造事实或把无关笔记硬套 = 不正确。',
        '只输出 JSON：{"correct":true|false,"abstained":true|false,"reason":"一句话"}',
      ].join('\n');
  const prompt = [
    rubric,
    '',
    `用户问题：${q.query}`,
    q.answerable ? `\n参考笔记：\n${goldBodies || '(missing)'}` : '',
    `\n助理的回答：\n${String(reply).slice(0, 1200)}`,
  ].join('\n');
  const { content } = await chat([{ role: 'user', content: prompt }], { maxTokens: 800, label: 'score' });
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return { correct: parsed.correct === true, abstained: parsed.abstained === true, reason: String(parsed.reason ?? '') };
  } catch {
    return { correct: false, abstained: /没有记过|不知道|无法回答/.test(reply), reason: `unparsed: ${content.slice(0, 80)}` };
  }
}

// ---------- 主流程 ----------
async function runOne(cfg, q) {
  const started = Date.now();
  const r = recallQuery(ctx, q.query, {
    budgetTokens: args.budgetTokens,
    maxNotes: args.maxNotes,
    maxChars: args.maxChars,
    includeCore: true,
    minRelevance: cfg.rel,
    minScore: cfg.score,
    minCoverage: cfg.cov,
    ...(args.pushMaxNotes === undefined ? {} : { pushMaxNotes: args.pushMaxNotes }),
    ...(args.pushMaxTokens === undefined ? {} : { pushMaxTokens: args.pushMaxTokens }),
  });
  const recallMs = Date.now() - started;
  let items = r.items ?? [];
  const recallCount = items.length;
  const goldIds = (q.gold ?? []).map(String);
  const goldInRecall = goldIds.filter((id) => items.some((it) => String(it.id) === id)).length;
  let judgeState = 'skipped';
  if (args.judge && items.length > 0) {
    const judged = await judgeItems(q.query, items);
    if (judged.ok) {
      items = judged.items;
      judgeState = `kept ${items.length}/${recallCount}`;
    } else {
      judgeState = 'fail-open';
    }
  }
  const goldKept = goldIds.filter((id) => items.some((it) => String(it.id) === id)).length;
  const filtered = { ...r, items, tokens: r.tokens };
  const block = items.length > 0 ? formatRecall(filtered, { maxChars: args.injectMaxChars, fullNotes: args.fullNotes, snippetChars: args.snippetChars }) : '';
  const t0 = Date.now();
  const reply = await answer(q.query, block);
  const answerMs = Date.now() - t0;
  const verdict = await score(q, reply);
  return {
    id: q.id,
    persona: q.persona,
    answerable: q.answerable,
    query: q.query,
    recallRefused: r.refused === true,
    goldInRecall,
    goldKept,
    recallCount,
    judgeState,
    items: items.length,
    blockChars: block.length,
    blockTokens: Math.ceil(block.length / 1.7),
    reply,
    correct: verdict.correct,
    abstained: verdict.abstained,
    reason: verdict.reason,
    elapsedMs: Date.now() - started,
    recallMs,
    answerMs,
  };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

const results = [];
for (const cfg of configs) {
  for (let run = 0; run < args.repeats; run += 1) {
    const rows = await mapLimit(queries, args.concurrency, (q) =>
      runOne(cfg, q).catch((error) => ({
        id: q.id,
        persona: q.persona,
        answerable: q.answerable,
        query: q.query,
        recallRefused: false,
        goldInRecall: 0,
        goldKept: 0,
        recallCount: 0,
        judgeState: 'error',
        items: 0,
        blockChars: 0,
        blockTokens: 0,
        reply: '',
        correct: false,
        abstained: false,
        reason: `harness error: ${error.message}`,
        elapsedMs: 0,
        recallMs: 0,
        answerMs: 0,
      })),
    );
    const failed = rows.filter((r) => r.judgeState === 'error');
    if (failed.length) console.log(`  ${failed.length} 条因调用失败计为错误`);
    const ans = rows.filter((r) => r.answerable);
    const neg = rows.filter((r) => !r.answerable);
    const summary = {
      config: cfg.name,
      run,
      answerable: ans.length,
      correct: ans.filter((r) => r.correct).length / (ans.length || 1),
      correctNoAbstain: ans.filter((r) => r.correct && !r.abstained).length / (ans.length || 1),
      negAbstained: neg.filter((r) => r.abstained).length / (neg.length || 1),
      negCorrect: neg.filter((r) => r.correct).length / (neg.length || 1),
      negAnswered: neg.filter((r) => !r.abstained).length / (neg.length || 1),
      injected: rows.reduce((a, r) => a + r.items, 0) / rows.length,
      tokens: rows.reduce((a, r) => a + r.blockTokens, 0) / rows.length,
      judgeKept: rows.filter((r) => r.judgeState.startsWith('kept ')).reduce((a, r) => a + Number(r.judgeState.split('/')[0].replace('kept ', '')), 0),
      elapsed: rows.reduce((a, r) => a + r.elapsedMs, 0) / rows.length,
    };
    results.push({ cfg, summary, rows });
    console.log(`[${cfg.name} run${run}] 答对 ${pct(summary.correct)}（不拒答 ${pct(summary.correctNoAbstain)}）| 不可答拒答 ${pct(summary.negAbstained)} 误答 ${pct(summary.negAnswered)} | 注入 ${summary.injected.toFixed(2)} 条 / ${summary.tokens.toFixed(0)} tok | 均耗时 ${summary.elapsed.toFixed(0)}ms`);
  }
}

if (args.out) {
  const lines = [
    '# 模拟用户端到端评测',
    '',
    `库：${args.store}（${scan.notes.length} 篇）  查询：${queries.length} 条（可答 ${queries.filter((q) => q.answerable).length}）  模型：${MODEL}`,
    '',
    '| 配置 | 答对率 | 不拒答答对 | 不可答拒答 | 不可答误答 | 注入条数 | 注入 token | 均耗时 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(({ cfg, summary: s }) => `| ${cfg.name} (${cfg.rel}/${cfg.score}/${cfg.cov}) | ${pct(s.correct)} | ${pct(s.correctNoAbstain)} | ${pct(s.negAbstained)} | ${pct(s.negAnswered)} | ${s.injected.toFixed(2)} | ${s.tokens.toFixed(0)} | ${s.elapsed.toFixed(0)}ms |`),
    '',
    '## 逐条（最后一条配置）',
    '',
    '| id | 可答 | 召回 | judge | 注入 | 答对 | 拒答 | 问题 | 回答摘要 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results[results.length - 1].rows.map((r) => `| ${r.id} | ${r.answerable ? 'Y' : 'N'} | ${r.recallCount} | ${r.judgeState} | ${r.items} | ${r.correct ? '✓' : '✗'} | ${r.abstained ? 'Y' : 'N'} | ${r.query.replace(/\|/g, '\\|')} | ${String(r.reply).replace(/\n/g, ' ').slice(0, 60).replace(/\|/g, '\\|')} |`),
  ];
  fs.writeFileSync(args.out, lines.join('\n'));
  console.log(`报告：${args.out}`);
}
if (args.json) {
  const file = args.out ? `${args.out}.json` : path.join(args.store, 'e2e.json');
  fs.writeFileSync(file, JSON.stringify(results.map(({ cfg, summary, rows }) => ({ cfg, summary, rows })), null, 1));
  console.log(`逐条：${file}`);
}
