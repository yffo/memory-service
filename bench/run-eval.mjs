#!/usr/bin/env node
/**
 * core-30-v1 三臂评测 —— 取上下文一律走**子进程调 CLI**，不 import 被测代码的内部模块。
 *
 * 检索层三臂：
 *   none    空上下文（退化基线：什么都不给）
 *   new     node bin/memory search --query "<q>" --json   ← 被测系统
 *   legacy  ~/yffto/dsh-engramory-recall 的 BM25（子进程 import 它的 store.js + bm25.js，只读）
 *
 * 回答层三臂（02 §4.5 要求的三档对照）：
 *   none      = closed_book，模型只看题面
 *   new       = real，模型看检索注入的上下文
 *   oracle    = oracle_gold，模型只看 gold 笔记正文（检索上限）
 *   跑满三档：`--arms none,new,oracle --answerer llm --runs 3`
 *   回答器默认仍是 echo（不是模型）：零 API 成本、不联网，量的是「检索有没有把正确笔记拿进上下文」；
 *   只有 `--answerer llm` 才调模型，并额外给出 acc / negative_transfer / oracle_gap / 成本。
 *
 * 用法：
 *   node bench/run-eval.mjs                      # 三臂检索层，Markdown 表打到 stdout
 *   node bench/run-eval.mjs --json                # 机器可读（纯 JSON，提示走 stderr）
 *   node bench/run-eval.mjs --dry                 # 不调 CLI/模型，只跑 none 臂 + 评分路径
 *   node bench/run-eval.mjs --arms none,new --out /tmp/eval.md
 *   node bench/run-eval.mjs --legacy-store ~/memory/engramory --legacy-repo /path/to/repo
 *   node bench/run-eval.mjs --arms none,new,oracle --answerer llm --runs 3 --concurrency 4
 *
 * 关键选项：
 *   --tasks <file>        题集（默认 bench/core-30-v1/tasks.json）
 *   --library <dir>       虚构语料库（默认 bench/core-30-v1/library）
 *   --cli <path>          被测 CLI（默认 bin/memory）
 *   --store <dir>         new 臂要读的库（默认 = 语料库的**临时副本**，见下）
 *   --store-mode <mode>   怎么把库告诉 CLI：auto（默认，同时给 --store 与 MEMORY_STORE）/ flag / env / plain
 *   --same-corpus         legacy 臂也读同一份虚构语料（默认读 ~/memory/engramory 私人库）
 *   --cli-args <str>      追加给 CLI 的参数（空格分隔，便于 CLI 改口径时对齐）
 *   --arms <list>         逗号分隔，默认 none,new,legacy；回答层用 none,new,oracle
 *   --answerer <mode>     echo（默认）| first-hit | llm
 *   --runs <n>            每臂重复几轮（默认 1；02 要求 ≥3 才报均值/极差，成本按 n 倍算）
 *   --concurrency <n>     llm 回答器并发数（默认 1；4 左右安全）
 *   --k <n>               recall@k（默认 5）
 *   --inject-k <n>        实际注入 top-n 条笔记的正文（默认 = --k；与 recall 口径解耦）
 *   --timeout <ms>        单次 CLI 调用超时（默认 20000）
 *   --keep-scratch        保留临时库（默认跑完删掉）
 *
 * 环境变量（只有 --answerer llm 用）：EVAL_LLM_API_KEY / DEEPSEEK_API_KEY、
 *   EVAL_LLM_BASE_URL（默认 https://api.deepseek.com）、EVAL_LLM_MODEL（默认 deepseek-flash）、
 *   EVAL_LLM_TIMEOUT_MS、EVAL_LLM_MAX_TOKENS、EVAL_LLM_TEMPERATURE。
 *
 * 为什么默认跑临时副本：CLI 的库是 `notes/*.md` 布局，而题集语料是 flat 的 `library/*.md`；
 * 且 CLI 会往库里写索引/账本。所以跑分时把语料**复制**到 /tmp 的临时库里跑，
 * 仓库里的语料库本体一个字都不会被改写（要指到别处就用 --store）。
 *
 * 隐私：库路径落在仓库之外时，报告与 JSON 里的笔记 id 一律打码成 note#N ——
 *      跑私人库不会把私人笔记名写进任何报告。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answerAccuracy,
  answerTokenEfficiency,
  CAPABILITIES,
  estimateTokens,
  negativeTransfer,
  oracleGap,
  round,
  scoreRun,
  taskCapability,
  THRESHOLDS,
} from './scorer.mjs';
import { answerQuestion, estimateCostUsd, resolveConfig as resolveLlmConfig } from './llm-answerer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_TASKS = path.join(HERE, 'core-30-v1', 'tasks.json');
const DEFAULT_LIBRARY = path.join(HERE, 'core-30-v1', 'library');
const DEFAULT_CLI = path.join(ROOT, 'bin', 'memory');
const DEFAULT_LEGACY_REPO = '~/yffto/dsh-engramory-recall';
const DEFAULT_LEGACY_STORE = path.join(os.homedir(), 'memory', 'engramory');

export const ARM_META = Object.freeze({
  none: { label: '无记忆（closed_book）', how: '空上下文' },
  new: { label: 'tabellio（real）', how: 'node bin/memory search --query <q> --json' },
  oracle: { label: 'gold（oracle_gold）', how: '只把题集声明的 gold 笔记正文喂给回答器（检索上限）' },
  legacy: { label: 'dsh-engramory-recall', how: '旧库 BM25（store.js + bm25.js，子进程只读）' },
});

const log = (msg) => process.stderr.write(String(msg) + '\n');

/* ────────────────────────── 参数 ────────────────────────── */

export function parseArgs(argv) {
  const flags = new Set(['--json', '--dry', '--help', '-h', '--show-ids', '--same-corpus', '--keep-scratch']);
  const opts = {
    tasks: DEFAULT_TASKS,
    library: DEFAULT_LIBRARY,
    cli: DEFAULT_CLI,
    store: null,
    storeMode: 'auto',
    cliArgs: '',
    legacyRepo: DEFAULT_LEGACY_REPO,
    legacyStore: DEFAULT_LEGACY_STORE,
    arms: ['none', 'new', 'legacy'],
    answerer: 'echo',
    runs: 1,
    concurrency: 1,
    k: 5,
    injectK: null,
    timeout: 20000,
    out: null,
    json: false,
    dry: false,
    showIds: false,
    sameCorpus: false,
    keepScratch: false,
    help: false,
  };
  const valueFlags = new Set(['--tasks', '--library', '--cli', '--store', '--store-mode', '--cli-args', '--legacy-repo', '--legacy-store', '--arms', '--answerer', '--runs', '--concurrency', '--k', '--inject-k', '--timeout', '--out']);
  const value = (name) => {
    const prefix = name + '=';
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline !== undefined) return inline.slice(prefix.length);
    const i = argv.indexOf(name);
    return i === -1 || argv[i + 1] === undefined ? null : String(argv[i + 1]);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (!flags.has(key) && !valueFlags.has(key)) {
      throw new Error(`未知参数 ${arg}（--help 看用法）`);
    }
    // --cli-args 等的值本身可能以 -- 开头，别把值当顶层参数校验。
    if (valueFlags.has(key) && eq === -1) i += 1;
  }
  const pick = (name, current) => (value(name) === null ? current : value(name));
  opts.tasks = pick('--tasks', opts.tasks);
  opts.library = pick('--library', opts.library);
  opts.cli = pick('--cli', opts.cli);
  opts.store = pick('--store', opts.store);
  opts.storeMode = pick('--store-mode', opts.storeMode);
  opts.cliArgs = pick('--cli-args', opts.cliArgs);
  opts.legacyRepo = pick('--legacy-repo', opts.legacyRepo);
  opts.legacyStore = pick('--legacy-store', opts.legacyStore);
  opts.answerer = pick('--answerer', opts.answerer);
  opts.runs = Number(pick('--runs', opts.runs));
  opts.concurrency = Number(pick('--concurrency', opts.concurrency));
  opts.k = Number(pick('--k', opts.k));
  opts.injectK = pick('--inject-k', null) === null ? null : Number(pick('--inject-k', null));
  opts.timeout = Number(pick('--timeout', opts.timeout));
  opts.out = pick('--out', opts.out);
  opts.json = argv.includes('--json');
  opts.dry = argv.includes('--dry');
  opts.showIds = argv.includes('--show-ids');
  opts.sameCorpus = argv.includes('--same-corpus');
  opts.keepScratch = argv.includes('--keep-scratch');
  opts.help = argv.includes('--help') || argv.includes('-h');
  const arms = pick('--arms', null);
  if (arms) opts.arms = String(arms).split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.dry) {
    // 干跑只验评分路径：不调 CLI，也不调模型（否则 --dry 会悄悄花掉 API 钱）。
    opts.arms = ['none'];
    opts.answerer = 'echo';
  }
  for (const arm of opts.arms) if (!ARM_META[arm]) throw new Error(`未知臂 ${arm}（可选 none/new/oracle/legacy）`);
  if (!['echo', 'first-hit', 'llm'].includes(opts.answerer)) throw new Error(`未知回答器 ${opts.answerer}（可选 echo/first-hit/llm）`);
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs 必须是正整数');
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error('--concurrency 必须是正整数');
  if (opts.arms.includes('oracle') && opts.answerer !== 'llm') {
    throw new Error('oracle 臂要配 --answerer llm：gold 笔记正文不是答案，回显它会得出假的准确率');
  }
  if (opts.answerer === 'llm' && opts.runs < 3) log('提示：--runs < 3，单次/两次结果只能当冒烟，不能当结论（02 §4.7 要求 ≥3 次）。');
  if (!Number.isInteger(opts.k) || opts.k < 1) throw new Error('--k 必须是正整数');
  if (opts.injectK !== null && (!Number.isInteger(opts.injectK) || opts.injectK < 1)) throw new Error('--inject-k 必须是正整数');
  if (!['auto', 'flag', 'env', 'plain'].includes(opts.storeMode)) throw new Error('--store-mode 只能是 auto/flag/env/plain');
  return opts;
}

export function usage() {
  return fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
}

/* ────────────────────────── 题集与语料 ────────────────────────── */

export function loadTasks(tasksPath) {
  const set = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  if (!Array.isArray(set.tasks)) throw new Error(`${tasksPath} 里没有 tasks 数组`);
  return set;
}

export function stripFrontmatter(text) {
  const m = String(text).match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? String(text).slice(m[0].length) : String(text);
}

export function readLibrary(dir) {
  const notes = new Map();
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
    notes.set(file, { file, body: stripFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8')).trim() });
  }
  return notes;
}

/* ────────────────────────── 库的预备（临时副本） ────────────────────────── */

/**
 * 预备 new 臂要读的库。默认把语料库复制到 /tmp 的临时库（`notes/*.md` 布局，CLI 自己的形状），
 * 这样：① 仓库里的语料库本体不会被 CLI 的索引/账本写脏；② 语料是 flat 的 `*.md`，正是题集要的样子。
 */
export function prepareStore(opts, libraryPath) {
  if (opts.store) return { store: path.resolve(opts.store), kind: 'explicit（--store）', scratch: null, copied: 0 };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'core30-eval-'));
  const store = path.join(scratch, 'store');
  fs.mkdirSync(path.join(store, 'notes'), { recursive: true });
  let copied = 0;
  for (const file of fs.readdirSync(libraryPath)) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
    fs.copyFileSync(path.join(libraryPath, file), path.join(store, 'notes', file));
    copied += 1;
  }
  return { store, kind: `语料库临时副本（${copied} 篇 → notes/）`, scratch, copied };
}

/** legacy 臂要读同一份语料时，另做一份 flat 临时库（旧仓库的 readDocs 读 `store/*.md`）。 */
export function prepareLegacyCorpus(libraryPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core30-legacy-'));
  let copied = 0;
  for (const file of fs.readdirSync(libraryPath)) {
    if (!file.endsWith('.md')) continue; // MEMORY.md 也复制：旧 readDocs 会把索引排除
    fs.copyFileSync(path.join(libraryPath, file), path.join(dir, file));
    copied += 1;
  }
  return { dir, copied };
}

/** 读一个库目录里有哪些笔记 id（认 flat `*.md` 与 `notes/*.md` 两种布局）。 */
export function noteIdsIn(storePath) {
  const out = new Set();
  for (const dir of [storePath, path.join(storePath, 'notes')]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.md') && name !== 'MEMORY.md') out.add(name.replace(/\.md$/, ''));
    }
  }
  return [...out];
}

/** 预检 CLI：看不看得见库。（只在临时副本上 --rebuild-index，绝不改真库。） */
export function preflightCli(opts, store, { rebuild }) {
  const args = [opts.cli, 'status', '--json', '--store', store];
  if (rebuild) args.push('--rebuild-index');
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: opts.timeout, env: childEnv(), cwd: ROOT });
  if (res.error) return { ok: false, error: res.error.message };
  if (res.status !== 0) return { ok: false, error: `exit ${res.status}: ${String(res.stderr || '').trim().split('\n').slice(-1)[0] ?? ''}` };
  try {
    const d = JSON.parse(res.stdout);
    return {
      ok: d.ok === true,
      notes: d.notes ?? null,
      parseFailures: d.parseFailures ?? null,
      indexExists: d.indexExists ?? null,
      warnings: d.warnings ?? [],
    };
  } catch {
    return { ok: false, error: `status 输出不是 JSON：${String(res.stdout).trim().slice(0, 120)}` };
  }
}

/* ────────────────────────── 取上下文：三个臂 ────────────────────────── */

function childEnv() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return env;
}

/** new 臂：子进程调 CLI，拿 {hits, tokens, refused, reason}。任何失败都记成 error，绝不静默当空上下文。 */
export function callNewArm(task, opts) {
  const store = opts.store ?? opts.library;
  const args = [opts.cli, 'search', '--query', task.prompt, '--json', '--costs'];
  if (opts.storeMode === 'auto' || opts.storeMode === 'flag') args.push('--store', store);
  if (opts.cliArgs) args.push(...String(opts.cliArgs).split(/\s+/).filter(Boolean));
  const env = childEnv();
  if (opts.storeMode === 'auto' || opts.storeMode === 'env') env.MEMORY_STORE = store;
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: opts.timeout, env, cwd: ROOT });
  if (res.error) return { error: `spawn: ${res.error.message}`, hits: [] };
  if (res.status !== 0) return { error: `exit ${res.status}: ${String(res.stderr || '').trim().split('\n').slice(-1)[0] ?? ''}`, hits: [] };
  let payload;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    return { error: `输出不是 JSON：${String(res.stdout).trim().slice(0, 120)}`, hits: [] };
  }
  const rawHits = Array.isArray(payload.hits) ? payload.hits : [];
  // 成本只认「实际注入的笔记」：CLI 的总 tokens 是 top-8 候选预算，不是注入成本。
  const costById = new Map(
    (Array.isArray(payload.costs) ? payload.costs : [])
      .filter((x) => x && Number.isFinite(x.cost))
      .map((x) => [String(x.id), x.cost]),
  );
  const hits = rawHits.map((h) => (costById.has(String(h.id)) ? { ...h, cost: costById.get(String(h.id)) } : h));
  return {
    hits,
    tokens: Number.isFinite(payload.tokens) ? payload.tokens : null,
    refused: payload.refused === true,
    reason: payload.reason ?? null,
  };
}

/** 旧库 BM25 桥：子进程 import 旧仓库自己的 store.js + bm25.js（只读，不写它一个字）。 */
const LEGACY_BRIDGE = `
const repo = process.env.EVAL_LEGACY_REPO;
const store = process.env.EVAL_LEGACY_STORE;
const query = process.env.EVAL_LEGACY_QUERY;
const limit = Number(process.env.EVAL_LEGACY_LIMIT || 5);
const base = new URL('file://' + repo + '/');
const { readDocs } = await import(new URL('store.js', base));
const { buildIndex, search } = await import(new URL('bm25.js', base));
const docs = readDocs(store);
const index = buildIndex(docs);
const hits = search(index, query, limit).map((h) => ({ id: h.id, title: h.title, score: h.score, snippet: h.snippet }));
process.stdout.write(JSON.stringify({ hits, note_count: Array.isArray(docs) ? docs.length : null }));
`;

export function callLegacyArm(task, opts) {
  const env = childEnv();
  env.EVAL_LEGACY_REPO = opts.legacyRepo;
  env.EVAL_LEGACY_STORE = opts.legacyStore;
  env.EVAL_LEGACY_QUERY = task.prompt;
  env.EVAL_LEGACY_LIMIT = String(opts.k);
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', LEGACY_BRIDGE], {
    encoding: 'utf8',
    timeout: opts.timeout,
    env,
    cwd: opts.legacyRepo,
  });
  if (res.error) return { error: `spawn: ${res.error.message}`, hits: [], fallback: false };
  if (res.status !== 0) return { error: `exit ${res.status}: ${String(res.stderr || '').trim().split('\n').slice(-1)[0] ?? ''}`, hits: [] };
  try {
    const payload = JSON.parse(res.stdout);
    return { hits: Array.isArray(payload.hits) ? payload.hits : [], noteCount: payload.note_count ?? null };
  } catch {
    return { error: `桥输出不是 JSON：${String(res.stdout).trim().slice(0, 120)}`, hits: [] };
  }
}

/**
 * 兜底：旧仓库不在场时，用「读索引 → 关键词召回」的土办法代替（题面里会标明 legacy-fallback）。
 * 中文没有词边界，用字符二元组重合度打分；够土，但比「假装跑了旧系统」诚实。
 */
export function legacyFallbackSearch(store, query, limit = 5) {
  const index = path.join(store, 'MEMORY.md');
  if (!fs.existsSync(index)) return { hits: [], error: `没有索引 ${index}` };
  const files = fs
    .readFileSync(index, 'utf8')
    .split('\n')
    .map((line) => line.match(/^-\s+(\S+\.md)\s+—\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ id: m[1], text: `${m[1]} ${m[2]}` }));
  const grams = (s) => {
    const clean = String(s).replace(/[\s\p{P}]+/gu, '');
    const out = new Set();
    for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
    return out;
  };
  const q = grams(query);
  const scored = files
    .map((f) => {
      const g = grams(f.text);
      let overlap = 0;
      for (const gram of q) if (g.has(gram)) overlap += 1;
      return { id: f.id, score: q.size === 0 ? 0 : overlap / q.size };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
  return { hits: scored.slice(0, limit) };
}

/* ────────────────────────── 注入与回答 ────────────────────────── */

/** 把命中变成真正写进上下文的文本。库在仓库外时 id 打码 —— 报告里不允许出现私人笔记名。 */
export function buildContext({ hits, store, maskIds, readNote, k = 5 }) {
  const chunks = [];
  for (const hit of (hits ?? []).slice(0, k)) {
    const file = hit.id ?? hit.title;
    const body = file ? readNote(file) : null;
    const text = body ?? hit.snippet ?? hit.title ?? '';
    if (!text) continue;
    const label = maskIds ? `note#${chunks.length + 1}` : String(file);
    const cost = Number.isFinite(hit.cost) ? hit.cost : null;
    chunks.push({ file: maskIds ? `note#${chunks.length + 1}` : file, text: `[${label}] ${text}`, cost });
  }
  void store;
  return chunks;
}

export function answerFor(mode, { injected, chunks }) {
  if (injected.startsWith('REFUSED')) return { answer: '', refused: true };
  if (mode === 'first-hit') {
    const first = chunks?.[0]?.text ?? '';
    return { answer: first, refused: first.trim() === '' };
  }
  return { answer: injected, refused: injected.trim() === '' };
}

/** 简单并发闸：保持输入顺序，limit=1 就是顺序执行。llm 回答器靠它把 3 轮压进几分钟。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** oracle 臂：只读题集声明的 gold 笔记，不走检索。读不到是数据错误，必须浮出来。 */
export function goldChunks(task, ctx, k = 5) {
  const sources = (Array.isArray(task.source) ? task.source : []).slice(0, k);
  const chunks = [];
  const missing = [];
  for (const file of sources) {
    const body = ctx.readNote(file);
    if (body === null || body === undefined) {
      missing.push(String(file));
      continue;
    }
    const label = ctx.maskIds ? `note#${chunks.length + 1}` : String(file);
    const text = `[${label}] ${body}`;
    chunks.push({ file: label, text, cost: estimateTokens(text) });
  }
  return { chunks, sources, missing };
}

/** 一次真实模型回答；顺带记账（token / 成本 / 延迟）。失败往上抛，由 runArm 记成 error。 */
async function answerViaLlm(task, injected, opts, stats) {
  const res = await answerQuestion({ prompt: task.prompt, context: injected, config: opts.llm });
  const usage = res.usage ?? {};
  const model = res.model ?? opts.llm.model;
  const cost = estimateCostUsd(usage, model);
  if (Number.isFinite(usage.prompt_tokens)) stats.prompt_tokens += usage.prompt_tokens;
  if (Number.isFinite(usage.completion_tokens)) stats.completion_tokens += usage.completion_tokens;
  if (Number.isFinite(usage.total_tokens)) stats.total_tokens += usage.total_tokens;
  stats.calls += 1;
  stats.latency_ms_total += Number.isFinite(res.latencyMs) ? res.latencyMs : 0;
  if (cost !== null && Number.isFinite(cost)) stats.cost_usd += cost;
  return { answer: String(res.text ?? '').trim(), usage, model, cost, latencyMs: res.latencyMs ?? null };
}

/* ────────────────────────── 一轮跑分 ────────────────────────── */

/** 实际注入成本：有逐条 cost 就求和；否则退回旧估算，但绝不拿 top-8 候选预算冒充 top-k 注入。 */
export function countInjectedTokens({ arm, refused, chunks, cliTokens, injected }) {
  if (refused) return 0;
  const allCosted = chunks.length > 0 && chunks.every((c) => Number.isFinite(c.cost));
  if (allCosted) return chunks.reduce((s, c) => s + c.cost, 0);
  if (arm === 'new') return estimateTokens(injected);
  const cliTokensValid = Number.isFinite(cliTokens) && cliTokens !== null;
  return cliTokensValid ? cliTokens : estimateTokens(injected);
}

export async function runArm(arm, tasks, opts, ctx) {
  const llmStats =
    opts.answerer === 'llm'
      ? { calls: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, latency_ms_total: 0 }
      : null;
  const processed = await mapLimit(tasks, opts.answerer === 'llm' ? opts.concurrency : 1, async (task) => {
    let hits = [];
    let cliTokens = null;
    let refused = false;
    let reason = null;
    let oracle = null;
    if (arm === 'new') {
      const raw = callNewArm(task, opts);
      if (raw.error) return { task_id: task.id, error: raw.error };
      hits = raw.hits ?? [];
      cliTokens = raw.tokens;
      refused = raw.refused === true;
      reason = raw.reason ?? null;
    } else if (arm === 'legacy') {
      const raw = callLegacyArm(task, opts);
      if (raw.error) return { task_id: task.id, error: raw.error };
      hits = raw.hits ?? [];
    } else if (arm === 'oracle') {
      oracle = goldChunks(task, ctx, opts.injectK ?? opts.k);
      if (oracle.sources.length > 0 && oracle.chunks.length === 0) {
        return { task_id: task.id, error: `gold 笔记读不到：${oracle.missing.join('、')}` };
      }
      hits = oracle.sources.map((id) => ({ id, score: 1 }));
    }
    const chunks = oracle ? oracle.chunks : buildContext({
      hits,
      store: ctx.store,
      maskIds: ctx.maskIds,
      readNote: ctx.readNote,
      k: opts.injectK ?? opts.k,
    });
    const injected = refused ? `REFUSED: ${reason ?? 'no relevant note'}` : chunks.map((c) => c.text).join('\n\n');
    let answer = '';
    let answerLlm = null;
    let refusedNow = refused;
    if (opts.answerer === 'llm') {
      if (!refused) {
        try {
          answerLlm = await answerViaLlm(task, injected, opts, llmStats);
          answer = answerLlm.answer;
        } catch (err) {
          llmStats.errors += 1;
          return { task_id: task.id, error: `llm: ${err.message}` };
        }
      }
    } else {
      const a = answerFor(opts.answerer, { injected, chunks });
      answer = a.answer;
      refusedNow = a.refused;
    }
    // 只记**实际注入**的成本。CLI 的 tokens 是候选预算（top-8），把它当注入成本会虚报。
    const tokens = countInjectedTokens({ arm, refused, chunks, cliTokens, injected });
    let libraryHitCount = 0;
    if (arm === 'new') for (const hit of hits) if (ctx.libraryFiles.has(String(hit.id))) libraryHitCount += 1;
    if (arm === 'oracle') libraryHitCount = oracle.chunks.length;
    return {
      task_id: task.id,
      run: {
        task_id: task.id,
        answer,
        injected,
        // hits 保持**原样**（判分要用真 id）；打码只影响输出，见 hits_display。
        hits,
        hits_display: hits.map((h, i) => ({
          rank: i + 1,
          id: ctx.maskIds ? `note#${i + 1}` : String(h.id ?? ''),
          score: Number.isFinite(h.score) ? round(h.score, 4) : null,
        })),
        tokens,
        refused: refusedNow,
        reason,
        error: null,
        llm_usage: answerLlm?.usage ?? null,
        llm_model: answerLlm?.model ?? null,
        llm_cost_usd: answerLlm?.cost ?? null,
        llm_latency_ms: answerLlm?.latencyMs ?? null,
      },
      success: true,
      cliToken: Number.isFinite(cliTokens) && cliTokens !== null,
      libraryHitCount,
    };
  });

  const runs = [];
  let errors = 0;
  let successes = 0;
  let tokensFromCli = 0;
  let libraryHits = 0;
  for (const item of processed) {
    if (item.error) {
      errors += 1;
      runs.push({ task_id: item.task_id, answer: '', injected: '', hits: [], tokens: 0, error: item.error });
      log(`  [${arm}] ${item.task_id} 失败：${item.error}`);
      continue;
    }
    successes += 1;
    if (item.cliToken) tokensFromCli += 1;
    libraryHits += item.libraryHitCount;
    runs.push(item.run);
  }
  const result = scoreRun(tasks, runs, { k: opts.k, arm, errors });
  result.answerer = opts.answerer;
  result.arm_diagnostics = {
    errors,
    successes,
    tokens_from_cli: tokensFromCli,
    tokens_estimated: arm === 'new' ? successes - tokensFromCli : 0,
    library_hits: libraryHits,
  };
  if (llmStats) {
    llmStats.cost_usd = round(llmStats.cost_usd, 6);
    llmStats.latency_ms_mean = llmStats.calls > 0 ? round(llmStats.latency_ms_total / llmStats.calls, 1) : null;
    delete llmStats.latency_ms_total;
    result.llm = llmStats;
  }
  // 逐题的运行明细（注入 token / 是否拒答 / 回答 / 召回了哪些笔记）—— 排障要靠它，判分不靠它。
  result.runs = runs.map((r) => ({
    task_id: r.task_id,
    tokens: r.tokens,
    refused: r.refused,
    answer: opts.answerer === 'echo' ? undefined : String(r.answer ?? '').slice(0, 400),
    reason: r.reason,
    error: r.error,
    hits: r.hits_display,
    llm: r.llm_usage ?? undefined,
  }));
  return result;
}

/* ────────────────────────── 报告 ────────────────────────── */

const fmt = (v, digits = 3) => (v === null || v === undefined ? '—' : typeof v === 'number' ? String(round(v, digits) ?? '—') : String(v));
const mark = (row) => (row.refusal_task ? (row.correct_refusal ? '✓' : '✗') : `${row.recall_at_k ? 'R' : '-'}${row.match ? '✓' : '✗'}`);

function answererLabel(opts) {
  if (opts.answerer === 'llm') return `llm（真实模型：${opts.llm?.model ?? '—'}）`;
  if (opts.answerer === 'first-hit') return 'first-hit（只回显 rank-1，非模型，零成本）';
  return 'echo（回显全部注入上下文，非模型，零成本）';
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

/* ────────────────────────── 多轮合并 ────────────────────────── */

const ROUND_METRICS = [
  'recall_at_5',
  'correct_refusal_rate',
  'refusal_calibration',
  'answered_rate',
  'match_rate',
  'expect_hit_rate',
  'hit_but_unused_rate',
  'injected_tokens_mean',
  'token_efficiency',
  'trap_fall_rate',
];

const meanOf = (values) => {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? round(nums.reduce((a, v) => a + v, 0) / nums.length, 4) : null;
};
const ratio = (numerator, denominator) => (denominator === 0 ? null : round(numerator / denominator, 4));

/** 一个题组的汇总；by_kind 与 by_capability 共用，顺便把陷阱率算进去。 */
function summarizeRows(rows) {
  const answerable = rows.filter((row) => !row.refusal_task);
  const refusals = rows.filter((row) => row.refusal_task);
  const trapRows = rows.filter((row) => row.trap_fall === true || row.trap_fall === false);
  const trapFalls = trapRows.filter((row) => row.trap_fall === true).length;
  return {
    tasks: rows.length,
    answerable_tasks: answerable.length,
    refusal_tasks: refusals.length,
    recall_at_5: ratio(answerable.filter((row) => row.recall_at_k).length, answerable.length),
    correct_refusal_rate: ratio(refusals.filter((row) => row.correct_refusal).length, refusals.length),
    match_rate: ratio(rows.filter((row) => row.match).length, rows.length),
    hit_but_unused_rate: ratio(rows.filter((row) => row.expect_hit && !row.expect_used).length, rows.length),
    trap_tasks: trapRows.length,
    trap_falls: trapFalls,
    trap_fall_rate: ratio(trapFalls, trapRows.length),
  };
}

function groupRowsBy(rows, keyOf) {
  const groups = {};
  for (const row of rows) {
    const key = keyOf(row) || 'unknown';
    (groups[key] ??= []).push(row);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, groupRows]) => [key, summarizeRows(groupRows)]));
}

/**
 * 多轮重复的合并口径（02 §4.7）：率取轮均值，逐题取多数票，token 取单题均值。
 * 逐题的 unanimous 只作诊断——模型波动不该被当成检索指标，也不该被平均掉。
 */
export function mergeRounds(roundResults, arm) {
  if (!roundResults.length) throw new Error('mergeRounds 需要至少一轮结果');
  const merged = { ...roundResults[0], arm };
  merged.rounds = roundResults.map((r, i) => ({
    round: i + 1,
    recall_at_5: r.recall_at_5,
    correct_refusal_rate: r.correct_refusal_rate,
    match_rate: r.match_rate,
    injected_tokens_mean: r.injected_tokens_mean,
    token_efficiency: r.token_efficiency,
    llm: r.llm ? { calls: r.llm.calls, errors: r.llm.errors, cost_usd: r.llm.cost_usd } : null,
  }));
  for (const key of ROUND_METRICS) merged[key] = meanOf(roundResults.map((r) => r[key]));
  merged.injected_tokens = round(meanOf(roundResults.map((r) => r.injected_tokens)) ?? 0, 0);

  // 逐题：match/recall/correct_refusal 取多数票，token 取均值。
  const taskIds = roundResults[0].rows.map((row) => row.task_id);
  merged.rows = taskIds.map((id) => {
    const rows = roundResults.map((r) => r.rows.find((x) => x.task_id === id)).filter(Boolean);
    if (!rows.length) return { task_id: id, kind: 'unknown', capability: 'unknown', refusal_task: false, match: false, recall_at_k: false, tokens: 0, trap_fall: null };
    const first = rows[0];
    const majority = (fn) => rows.filter(fn).length * 2 > rows.length;
    return {
      ...first,
      capability: first.capability ?? 'unknown',
      trap_fall:
        first.trap_fall === null || first.trap_fall === undefined ? null : majority((r) => r.trap_fall === true),
      match: majority((r) => r.match),
      recall_at_k: majority((r) => r.recall_at_k === true),
      correct_refusal: first.refusal_task ? majority((r) => r.correct_refusal) : null,
      tokens: round(rows.reduce((a, r) => a + (Number(r.tokens) || 0), 0) / rows.length, 2),
    };
  });
  const answerable = merged.rows.filter((row) => !row.refusal_task);
  const refusals = merged.rows.filter((row) => row.refusal_task);
  merged.recall_hits = answerable.filter((row) => row.recall_at_k).length;
  merged.refusal_correct = refusals.filter((row) => row.correct_refusal).length;
  merged.task_unanimous_rate = merged.rows.length
    ? round(
        merged.rows.filter((row) =>
          roundResults.every((r) => {
            const x = r.rows.find((y) => y.task_id === row.task_id);
            return x ? x.match === row.match : false;
          }),
        ).length / merged.rows.length,
        4,
      )
    : null;

  const summary = summarizeRows(merged.rows);
  merged.trap_tasks = summary.trap_tasks;
  merged.trap_falls = summary.trap_falls;
  merged.trap_fall_rate = summary.trap_fall_rate;
  merged.by_kind = groupRowsBy(merged.rows, (row) => row.kind);
  merged.by_capability = groupRowsBy(merged.rows, (row) => row.capability);

  merged.arm_diagnostics = {
    errors: roundResults.reduce((a, r) => a + (r.arm_diagnostics?.errors ?? 0), 0),
    successes: roundResults.reduce((a, r) => a + (r.arm_diagnostics?.successes ?? 0), 0),
    tokens_from_cli: roundResults.reduce((a, r) => a + (r.arm_diagnostics?.tokens_from_cli ?? 0), 0),
    tokens_estimated: roundResults.reduce((a, r) => a + (r.arm_diagnostics?.tokens_estimated ?? 0), 0),
    library_hits: roundResults.reduce((a, r) => a + (r.arm_diagnostics?.library_hits ?? 0), 0),
  };

  if (roundResults.some((r) => r.llm)) {
    const llm = { calls: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, latency_ms_mean: null };
    let latencyTotal = 0;
    for (const r of roundResults) {
      if (!r.llm) continue;
      llm.calls += r.llm.calls;
      llm.errors += r.llm.errors;
      llm.prompt_tokens += r.llm.prompt_tokens;
      llm.completion_tokens += r.llm.completion_tokens;
      llm.total_tokens += r.llm.total_tokens;
      llm.cost_usd += r.llm.cost_usd ?? 0;
      latencyTotal += (r.llm.latency_ms_mean ?? 0) * r.llm.calls;
    }
    llm.cost_usd = round(llm.cost_usd, 6);
    llm.latency_ms_mean = llm.calls ? round(latencyTotal / llm.calls, 1) : null;
    merged.llm = llm;
  }

  // 逐轮明细留档（JSON 里能看到每轮答案），Markdown 只用上面的均值。
  merged.runs = roundResults.flatMap((r, i) => (r.runs ?? []).map((x) => ({ ...x, round: i + 1 })));

  const missing = Math.max(...roundResults.map((r) => r.verdict?.missing_tasks ?? 0));
  const errors = merged.arm_diagnostics.errors;
  const verdict = {
    arm,
    recall_at_5: merged.recall_at_5 === null ? null : merged.recall_at_5 >= THRESHOLDS.recallAt5,
    correct_refusal_rate:
      merged.correct_refusal_rate === null ? null : merged.correct_refusal_rate >= THRESHOLDS.correctRefusalRate,
    injected_tokens:
      merged.injected_tokens_mean === null ? null : merged.injected_tokens_mean <= THRESHOLDS.maxInjectedTokensPerQuery,
    missing_tasks: missing,
    errors,
  };
  verdict.pass =
    verdict.recall_at_5 === true &&
    verdict.correct_refusal_rate === true &&
    verdict.injected_tokens === true &&
    missing === 0 &&
    errors === 0;
  merged.verdict = verdict;
  return merged;
}

export function renderMarkdown(report) {
  const { opts, results, meta } = report;
  const arms = results.map((r) => r.arm);
  const out = [];
  out.push(`# core-30-v1 评测报告（${meta.mode}）`);
  out.push('');
  out.push(`- 时间：${meta.startedAt}`);
  out.push(`- 题集：${meta.tasksPath}（${meta.taskCount} 题：${meta.kindCount}）`);
  out.push(`- 能力分布：${meta.capabilityCount ?? '—'}（按题集 capability；陷阱题才有陷阱率）`);
  out.push(`- 语料库：${meta.library}（${meta.noteCount} 篇，虚构）`);
  out.push(`- new 臂 CLI：${opts.cli}${fs.existsSync(opts.cli) ? '' : '（**不存在**）'}`);
  out.push(`- new 臂库：${meta.storeKind ?? '—'} → ${meta.store}`);
  if (meta.preflight) {
    out.push(
      meta.preflight.ok
        ? `- 预检：status → notes ${meta.preflight.notes}，parseFailures ${meta.preflight.parseFailures}，index ${meta.preflight.indexExists ? '有' : '无'}${(meta.preflight.warnings ?? []).length ? `，warnings ${meta.preflight.warnings.length} 条` : ''}`
        : `- 预检失败：${meta.preflight.error}`,
    );
  }
  out.push(`- legacy：${opts.legacyRepo}（库 ${opts.legacyStore}${meta.legacyStoreExists === false ? '，**不存在**' : ''}${meta.legacySameCorpus ? '，同一份虚构语料' : ''}）`);
  out.push(`- 回答器：${answererLabel(opts)}；recall@${opts.k}（命中判定：gold 笔记进没进 top-${opts.k}）；实际注入 top-${opts.injectK ?? opts.k}`);
  if (opts.llm) out.push(`- 模型端点：${hostOf(opts.llm.baseUrl)}；温度 ${opts.llm.temperature}；max_tokens ${opts.llm.maxTokens}；轮次 ${opts.runs}（并发 ${opts.concurrency}）`);
  else if (opts.runs > 1) out.push(`- 轮次：${opts.runs}（指标取均值）`);
  out.push(`- 臂：${arms.map((a) => `${a}（${ARM_META[a].label}）`).join(' / ')}`);
  if (opts.dry) out.push('- **--dry 模式**：没有调用 CLI/模型，new/legacy/oracle 未跑；这张表只验证评分路径。');
  if (meta.masked) out.push('- 库在仓库之外，报告里的笔记 id 已打码（note#N）；要保真用 --show-ids。');
  out.push('');

  out.push('## 指标 × 臂');
  out.push('');
  out.push(`| 指标 | ${arms.join(' | ')} | 判据 |`);
  out.push(`| --- | ${arms.map(() => '---').join(' | ')} | --- |`);
  const rows = [
    ['recall@5（有来源的题）', (r) => fmt(r.recall_at_5), `≥ ${THRESHOLDS.recallAt5}`],
    ['correct_refusal_rate（拒答题）', (r) => fmt(r.correct_refusal_rate), `≥ ${THRESHOLDS.correctRefusalRate}`],
    ['refusal_calibration（文档口径）', (r) => fmt(r.refusal_calibration), '参照'],
    ['match_rate（答案逐字命中）', (r) => fmt(r.match_rate), '参照'],
    ['expect_hit_rate（信息进了上下文）', (r) => fmt(r.expect_hit_rate), '参照'],
    ['injected_tokens（合计）', (r) => fmt(r.injected_tokens, 0), '—'],
    ['injected_tokens_mean（单题均值）', (r) => fmt(r.injected_tokens_mean, 1), `≤ ${THRESHOLDS.maxInjectedTokensPerQuery}`],
    ['token_efficiency（命中/千 token）', (r) => fmt(r.token_efficiency), '越大越好'],
    ['hit_but_unused_rate（漏用率）', (r) => fmt(r.hit_but_unused_rate), '越小越好'],
    ['answered_rate（没拒答的比例）', (r) => fmt(r.answered_rate), '参照'],
    ['trap_fall_rate（陷阱题落入率）', (r) => fmt(r.trap_fall_rate), '规则口径，越小越好'],
    ['调用失败数 / 缺题数', (r) => `${r.arm_diagnostics.errors} / ${r.verdict.missing_tasks}`, '0'],
  ];
  for (const [name, read, gate] of rows) out.push(`| ${name} | ${results.map(read).join(' | ')} | ${gate} |`);
  out.push('');

  out.push('## 判据 1（core-30-v1）');
  out.push('');
  const judge = report.judgement;
  for (const line of judge.lines) out.push(`- ${line}`);
  out.push('');
  out.push(`**结论：${judge.verdict}**`);
  if (judge.blockers.length) {
    out.push('');
    out.push('算不出来的原因（先解决这些，再说达标与否）：');
    for (const b of judge.blockers) out.push(`- ${b}`);
  }
  out.push('');

  if (opts.answerer === 'llm') {
    out.push('## 回答层（真实模型，三档对照）');
    out.push('');
    out.push('| 臂 | acc（match_rate） | 单题注入 token | API 调用 | 输入/输出 token | 成本 USD | 平均延迟 ms |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of results) {
      const l = r.llm;
      out.push(
        l
          ? `| ${r.arm} | ${fmt(r.match_rate)} | ${fmt(r.injected_tokens_mean, 1)} | ${l.calls} | ${l.prompt_tokens}/${l.completion_tokens} | ${fmt(l.cost_usd, 4)} | ${fmt(l.latency_ms_mean, 0)} |`
          : `| ${r.arm} | ${fmt(r.match_rate)} | ${fmt(r.injected_tokens_mean, 1)} | — | — | — | — |`,
      );
    }
    out.push('');
    const al = report.answerLevel;
    out.push(`- negative_transfer：${fmt(al.negative_transfer)}（≤ ${THRESHOLDS.negativeTransfer}；正值=有害）`);
    out.push(`- oracle_gap：${fmt(al.oracle_gap)}（参照，越小说明检索越接近 oracle_gold 上限）`);
    out.push(`- answer token_efficiency：${fmt(al.answer_token_efficiency)}（≥ ${THRESHOLDS.answerTokenEfficiency}）`);
    const ja = report.judgementAnswer;
    out.push('');
    for (const line of ja.lines) out.push(`- ${line}`);
    out.push('');
    out.push(`**结论：${ja.verdict}**`);
    if (ja.blockers.length) {
      out.push('');
      out.push('回答层算不出来的原因：');
      for (const b of ja.blockers) out.push(`- ${b}`);
    }
    out.push('');
  }

  if (opts.runs > 1) {
    out.push('## 逐轮稳定性');
    out.push('');
    out.push('| 臂 | 轮 | recall@5 | correct_refusal | match_rate | 单题注入 token | 成本 USD |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of results) {
      for (const rd of r.rounds ?? []) {
        out.push(
          `| ${r.arm} | ${rd.round} | ${fmt(rd.recall_at_5)} | ${fmt(rd.correct_refusal_rate)} | ${fmt(rd.match_rate)} | ${fmt(rd.injected_tokens_mean, 1)} | ${fmt(rd.llm?.cost_usd ?? null, 4)} |`,
        );
      }
    }
    out.push('');
  }

  out.push('## 按题型');
  out.push('');
  const kinds = [...new Set(results.flatMap((r) => Object.keys(r.by_kind)))];
  out.push(`| 题型 | 臂 | 题数 | recall@5 | correct_refusal | match_rate | 漏用率 |`);
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const kind of kinds) {
    for (const r of results) {
      const k = r.by_kind[kind];
      if (!k) continue;
      out.push(`| ${kind} | ${r.arm} | ${k.tasks} | ${fmt(k.recall_at_5)} | ${fmt(k.correct_refusal_rate)} | ${fmt(k.match_rate)} | ${fmt(k.hit_but_unused_rate)} |`);
    }
  }
  out.push('');

  out.push('## 按能力');
  out.push('');
  const capabilities = [...CAPABILITIES, 'unknown'].filter((capability) =>
    results.some((r) => r.by_capability?.[capability]),
  );
  out.push(`| 能力 | 臂 | 题数 | recall@5 | correct_refusal | match_rate | 漏用率 | 陷阱落入率 |`);
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const capability of capabilities) {
    for (const r of results) {
      const c = r.by_capability?.[capability];
      if (!c) continue;
      out.push(
        `| ${capability} | ${r.arm} | ${c.tasks} | ${fmt(c.recall_at_5)} | ${fmt(c.correct_refusal_rate)} | ${fmt(c.match_rate)} | ${fmt(c.hit_but_unused_rate)} | ${fmt(c.trap_fall_rate)} |`,
      );
    }
  }
  out.push('');

  out.push('## 逐题（R=来源进 top-k，✓=判对，✗=判错）');
  out.push('');
  out.push(`| 题 | 题型 | 题面 | ${arms.join(' | ')} |`);
  out.push(`| --- | --- | --- | ${arms.map(() => '---').join(' | ')} |`);
  const byArm = new Map(results.map((r) => [r.arm, new Map(r.rows.map((row) => [row.task_id, row]))]));
  for (const task of report.tasks) {
    const cells = arms.map((a) => {
      const row = byArm.get(a)?.get(task.id);
      return row ? mark(row) : '—';
    });
    out.push(`| ${task.id} | ${task.kind} | ${task.prompt} | ${cells.join(' | ')} |`);
  }
  out.push('');

  const notes = [];
  if (opts.answerer === 'echo') notes.push('回答器是 echo（回显全部注入上下文），所以 hit_but_unused_rate 结构性为 0；要看漏用信号用 --answerer first-hit。');
  if (opts.answerer === 'llm') {
    notes.push(`回答器是真实模型（${opts.llm?.model}，温度 ${opts.llm?.temperature}）：accuracy 的波动来自模型，不来自检索；${opts.runs} 轮取均值。`);
    notes.push('成本口径：deepseek-flash 输入 $0.15/1M、输出 $0.60/1M（2026-10 非高峰价）；换模型/调价要同步改 bench/llm-answerer.mjs 的价格表。');
    notes.push('real 与 oracle_gold 的差（oracle_gap）才是检索/注入的损失；negative_transfer 为正说明记忆净伤害。');
    if (opts.runs < 3) notes.push('--runs < 3：波动未估计，只能当冒烟，不能当结论（02 §4.7 要求 ≥3 次）。');
  }
  if (meta.legacyFallback) notes.push('legacy 臂走的是索引关键词兜底（旧仓库的桥没跑通），数字只作参照。');
  if (results.some((r) => r.arm === 'new' && r.arm_diagnostics.tokens_estimated > 0)) notes.push('new 臂有一部分 token 是估算的（CLI 没报 tokens），token_efficiency 只作参照。');
  if (results.some((r) => (r.trap_tasks ?? 0) > 0)) {
    notes.push('trap_fall_rate 是规则判分口径：只统计答案里出现 negative_transfer_probe.fall_patterns 的比例，分母只有带探针的题；它不是 LLM 裁判给的陷阱率。');
    notes.push('temporal 题测的是同一份当前库里的时间点/时长对齐；as-of 版本回放由 bench/replay.mjs 单独负责。');
  }
  if (!meta.cliPresent) notes.push('**bin/memory 还没落地**：new 臂现在跑不出数字，等 A 交付后必须重跑本报告。');
  if (opts.storeMode === 'plain') notes.push('--store-mode plain：CLI 读到哪个库不由本跑分器决定，recall 数字可能整体失真。');
  if (notes.length) {
    out.push('## 备注');
    out.push('');
    for (const n of notes) out.push(`- ${n}`);
    out.push('');
  }
  return out.join('\n');
}

/* ────────────────────────── 主流程 ────────────────────────── */

export function judgeNewArm(result, meta) {
  const lines = [];
  const blockers = [];
  const r = result;
  const gate = (name, actual, limit, ok) => {
    lines.push(`${name}：new 臂 ${actual === null ? '算不出来' : fmt(actual)} → ${actual === null ? '缺数字' : ok ? '达标' : '不达标'}（阈值 ${limit}）`);
  };
  gate('recall@5', r.recall_at_5, THRESHOLDS.recallAt5, r.recall_at_5 !== null && r.recall_at_5 >= THRESHOLDS.recallAt5);
  gate('correct_refusal_rate', r.correct_refusal_rate, THRESHOLDS.correctRefusalRate, r.correct_refusal_rate !== null && r.correct_refusal_rate >= THRESHOLDS.correctRefusalRate);
  gate('单题注入 token 均值', r.injected_tokens_mean, THRESHOLDS.maxInjectedTokensPerQuery, r.injected_tokens_mean !== null && r.injected_tokens_mean <= THRESHOLDS.maxInjectedTokensPerQuery);
  const d = r.arm_diagnostics ?? { errors: 0, successes: 0, library_hits: 0, tokens_from_cli: 0, tokens_estimated: 0 };
  if (meta.dry) blockers.push('本次是 --dry 干跑：没有调用 CLI，new 臂没有数字（等 bin/memory 落地后用实跑重跑）');
  else if (d.errors > 0) blockers.push(`new 臂有 ${d.errors} 次调用失败（CLI 不存在 / 非零退出 / 输出不是 JSON）`);
  if (r.verdict.missing_tasks > 0) blockers.push(`new 臂缺 ${r.verdict.missing_tasks} 题的运行记录`);
  if (d.successes > 0 && d.library_hits === 0) blockers.push(`new 臂的命中没有一个落在 ${meta.library} 里 —— 很可能搜的是别的库（用 --store 指过去）`);
  const verdict = blockers.length
    ? '算不出来'
    : r.verdict.pass
      ? '判据 1 成立（三件都达标）'
      : '判据 1 不成立（有指标没达标）';
  if (!blockers.length) {
    const gaps = [];
    if (r.recall_at_5 !== null && r.recall_at_5 < THRESHOLDS.recallAt5) gaps.push(`recall@5 差 ${fmt(THRESHOLDS.recallAt5 - r.recall_at_5)}`);
    if (r.correct_refusal_rate !== null && r.correct_refusal_rate < THRESHOLDS.correctRefusalRate) gaps.push(`correct_refusal_rate 差 ${fmt(THRESHOLDS.correctRefusalRate - r.correct_refusal_rate)}`);
    if (r.injected_tokens_mean !== null && r.injected_tokens_mean > THRESHOLDS.maxInjectedTokensPerQuery) gaps.push(`单题 token 超 ${fmt(r.injected_tokens_mean - THRESHOLDS.maxInjectedTokensPerQuery, 1)}`);
    lines.push(gaps.length ? `差距：${gaps.join('；')}` : '三条指标都在阈值内。');
  }
  lines.push(`参照：none 臂 recall@5 = ${fmt(meta.noneRecall)}（该臂什么都看不到，是退化基线）`);
  return { lines, blockers, verdict };
}

/**
 * 回答层判定（判据 2 的 token_efficiency + 判据 3 的 negative_transfer）。
 * 与判据 1 分开：判据 1 只看检索，回答层必须有真实模型 + closed_book/oracle_gold/real 三档才有意义。
 * staleness 不在本跑分器里（由 bench/replay.mjs 的时间回放认定），这里不冒充。
 */
export function judgeAnswerLevel(report) {
  const lines = [];
  const blockers = [];
  const { opts, results, answerLevel } = report;
  const byArm = Object.fromEntries(results.map((r) => [r.arm, r]));
  if (opts.answerer !== 'llm') blockers.push('回答层判定要 --answerer llm：echo/first-hit 的"准确率"不是模型答对率');
  for (const arm of ['none', 'new', 'oracle']) if (!byArm[arm]) blockers.push(`缺 ${arm} 臂（closed_book / real / oracle_gold 三档要一起跑）`);
  if (blockers.length) return { lines, blockers, verdict: '算不出来' };
  const acc = answerLevel.accuracy;
  const nt = answerLevel.negative_transfer;
  const eff = answerLevel.answer_token_efficiency;
  const gap = answerLevel.oracle_gap;
  const mean = byArm.new.injected_tokens_mean;
  lines.push(`答对率：closed_book ${fmt(acc.none)} / real ${fmt(acc.new)} / oracle_gold ${fmt(acc.oracle)}（${opts.runs} 轮均值，逐轮见下）`);
  lines.push(
    `negative_transfer = acc(closed_book) − acc(real) = ${fmt(nt)} → ${nt !== null && nt <= THRESHOLDS.negativeTransfer ? '达标' : '不达标'}（阈值 ≤ ${THRESHOLDS.negativeTransfer}，正值=记忆有害）`,
  );
  const effOk = eff !== null && eff >= THRESHOLDS.answerTokenEfficiency;
  lines.push(
    `answer token_efficiency = Δaccuracy ÷（注入千 token） = ${fmt(eff)} → ${effOk ? '达标' : '不达标'}（阈值 ≥ ${THRESHOLDS.answerTokenEfficiency}）`,
  );
  lines.push(`oracle_gap = acc(oracle_gold) − acc(real) = ${fmt(gap)}（参照：>0 说明检索/注入仍丢了本可答对的题）`);
  lines.push(`单题注入 token 均值 ${fmt(mean, 1)}（判据 2 阈值 ≤ 545；判据 1 更严，≤500）`);
  const ok = nt !== null && nt <= THRESHOLDS.negativeTransfer && effOk && mean !== null && mean <= 545;
  lines.push(
    ok
      ? '结论：判据 2 的 token_efficiency、判据 3 的 negative_transfer 在本题集成立；staleness 仍由 bench/replay.mjs 认定。'
      : '结论：有指标没达标，先看差距再改检索/注入/回答器；不要把未达标说成"参照"。',
  );
  return { lines, blockers, verdict: ok ? '判据 2/3（回答层）成立' : '判据 2/3（回答层）不成立' };
}

export function buildReport(opts, results, { tasks, library, noteCount, startedAt, masked, cliPresent, legacyFallback, dry, storeKind, preflight, legacySameCorpus, legacyStoreExists, cliArgsOverride }) {
  const kindCount = Object.entries(
    tasks.reduce((acc, t) => ({ ...acc, [t.kind]: (acc[t.kind] ?? 0) + 1 }), {}),
  )
    .map(([k, v]) => `${k} ${v}`)
    .join('、');
  const capabilityTotals = tasks.reduce((acc, t) => {
    const capability = taskCapability(t);
    acc[capability] = (acc[capability] ?? 0) + 1;
    return acc;
  }, {});
  const capabilityCount = [...CAPABILITIES, 'unknown']
    .filter((capability) => capabilityTotals[capability])
    .map((capability) => `${capability} ${capabilityTotals[capability]}`)
    .join('、');
  const newResult = results.find((r) => r.arm === 'new');
  const noneResult = results.find((r) => r.arm === 'none');
  const meta = {
    startedAt,
    mode: dry ? '--dry 干跑' : '实跑',
    tasksPath: opts.tasks,
    taskCount: tasks.length,
    kindCount,
    capabilityCount,
    library,
    noteCount,
    store: opts.store ?? opts.library,
    storeMode: opts.storeMode,
    storeKind: storeKind ?? null,
    preflight: preflight ?? null,
    legacySameCorpus: Boolean(legacySameCorpus),
    legacyStoreExists: legacyStoreExists ?? null,
    cliArgsOverride: cliArgsOverride ?? null,
    masked,
    cliPresent,
    legacyFallback,
  };
  const report = { opts, tasks, results, meta };
  const placeholder = scoreRun(tasks, [], { k: opts.k, arm: 'new', errors: 0 });
  placeholder.arm_diagnostics = { errors: 0, successes: 0, tokens_from_cli: 0, tokens_estimated: 0, library_hits: 0 };
  report.judgement = judgeNewArm(newResult ?? placeholder, { ...meta, noneRecall: noneResult?.recall_at_5 ?? null });
  const byArm = Object.fromEntries(results.map((r) => [r.arm, r]));
  report.answerLevel = {
    accuracy: Object.fromEntries(results.map((r) => [r.arm, answerAccuracy(r)])),
    negative_transfer: byArm.none && byArm.new ? negativeTransfer(byArm.none, byArm.new) : null,
    oracle_gap: byArm.oracle && byArm.new ? oracleGap(byArm.oracle, byArm.new) : null,
    answer_token_efficiency: byArm.new && byArm.none ? answerTokenEfficiency(byArm.new, byArm.none) : null,
  };
  report.judgementAnswer = judgeAnswerLevel(report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(`参数错误：${err.message}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (opts.answerer === 'llm') {
    try {
      opts.llm = resolveLlmConfig();
    } catch (err) {
      log(`模型配置错误：${err.message}`);
      return 2;
    }
  }
  const startedAt = new Date().toISOString();
  const set = loadTasks(path.resolve(opts.tasks));
  const library = path.resolve(opts.library);
  const notes = readLibrary(library);
  const prepared = prepareStore(opts, library);
  const store = prepared.store;
  opts.store = store;
  const cliPresent = fs.existsSync(path.resolve(opts.cli));
  const legacyRepoPresent = fs.existsSync(path.resolve(opts.legacyRepo));
  let legacyCorpus = null;
  if (opts.sameCorpus && legacyRepoPresent) {
    legacyCorpus = prepareLegacyCorpus(library);
    opts.legacyStore = legacyCorpus.dir;
  }
  const legacyStorePresent = fs.existsSync(path.resolve(opts.legacyStore));
  const preflight = opts.dry || !cliPresent ? null : preflightCli(opts, store, { rebuild: prepared.kind !== 'explicit（--store）' });
  const readNote = (file) => {
    // CLI 报的 id 可能不带 .md、也可能带路径；两种都试，再退回语料库本体。
    const base = path.basename(String(file));
    const names = base.endsWith('.md') ? [base, base.slice(0, -3)] : [base, `${base}.md`];
    for (const name of names) {
      for (const dir of [store, path.join(store, 'notes')]) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return stripFrontmatter(fs.readFileSync(candidate, 'utf8')).trim();
      }
    }
    for (const name of names) {
      const known = notes.get(name);
      if (known) return known.body;
    }
    return null;
  };
  const libraryIds = new Set([...notes.keys(), ...[...notes.keys()].map((f) => f.replace(/\.md$/, ''))]);
  // 打码规则：库里只要有一篇**语料之外的**笔记（比如私人记忆库），就把 id 全打码。
  // 语料库自己的临时副本没有外来笔记 → 不打码，报告里能看清到底召回了哪一篇。
  const foreignNotes = [...libraryIds].length
    ? noteIdsIn(store).filter((id) => !libraryIds.has(id) && !libraryIds.has(`${id}.md`))
    : [];
  const maskIds = opts.showIds ? false : foreignNotes.length > 0;
  const ctx = { store, maskIds, libraryFiles: libraryIds, readNote, foreignNotes };
  const cleanup = () => {
    if (opts.keepScratch) return;
    for (const dir of [prepared.scratch, legacyCorpus?.dir]) if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  };

  const results = [];
  let legacyFallback = false;
  try {
    for (const arm of opts.arms) {
      if (arm === 'legacy' && (!legacyRepoPresent || !legacyStorePresent)) {
        legacyFallback = true;
        log(`legacy 臂：旧仓库或旧库不在场（repo=${legacyRepoPresent} store=${legacyStorePresent}），改用索引关键词兜底`);
        results.push(runLegacyFallback(opts, set.tasks, ctx));
        continue;
      }
      log(`跑 ${arm} 臂（${set.tasks.length} 题）…`);
      if (opts.runs > 1 && arm !== 'legacy') {
        const rounds = [];
        for (let i = 1; i <= opts.runs; i += 1) {
          log(`  第 ${i}/${opts.runs} 轮…`);
          rounds.push(await runArm(arm, set.tasks, opts, ctx));
        }
        results.push(mergeRounds(rounds, arm));
      } else {
        results.push(await runArm(arm, set.tasks, opts, ctx));
      }
    }
  } finally {
    cleanup();
  }
  const report = buildReport(opts, results, {
    tasks: set.tasks,
    library,
    noteCount: notes.size,
    startedAt,
    masked: maskIds,
    cliPresent,
    legacyFallback,
    dry: opts.dry,
    storeKind: prepared.kind,
    legacyStoreExists: legacyStorePresent,
    cliArgsOverride: opts.cliArgs && opts.cliArgs.length ? opts.cliArgs : null,
    preflight,
    legacySameCorpus: Boolean(legacyCorpus),
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(serialize(report), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderMarkdown(report)}\n`);
  }
  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.out), `${renderMarkdown(report)}\n`);
    log(`报告写到 ${opts.out}`);
  }
  return 0;
}

/** legacy 兜底臂：旧仓库/旧库不在场时，用索引关键词召回顶上，并如实标注。 */
function runLegacyFallback(opts, tasks, ctx) {
  const runs = [];
  for (const task of tasks) {
    const { hits, error } = legacyFallbackSearch(path.resolve(opts.legacyStore), task.prompt, opts.k);
    if (error) {
      runs.push({ task_id: task.id, answer: '', injected: '', hits: [], tokens: 0, error });
      continue;
    }
    const chunks = buildContext({ hits, store: ctx.store, maskIds: true, readNote: ctx.readNote, k: opts.k });
    const injected = chunks.map((c) => c.text).join('\n\n');
    // legacy 兜底臂是检索层参照；回答器统一退回零成本的 echo（llm 三档不跑 legacy）。
    const { answer, refused } = answerFor(opts.answerer === 'llm' ? 'echo' : opts.answerer, { injected, chunks });
    runs.push({ task_id: task.id, answer, injected, hits, tokens: estimateTokens(injected), refused });
  }
  const result = scoreRun(tasks, runs, { k: opts.k, arm: 'legacy', errors: runs.filter((r) => r.error).length });
  result.arm_diagnostics = {
    errors: result.verdict.errors,
    successes: runs.length - result.verdict.errors,
    tokens_from_cli: 0,
    tokens_estimated: runs.length,
    library_hits: 0,
    fallback: true,
  };
  return result;
}

function serialize(report) {
  return {
    version: 'core-30-v1-eval-v1',
    mode: report.meta.mode,
    started_at: report.meta.startedAt,
    thresholds: THRESHOLDS,
    answerer: report.opts.answerer,
    runs: report.opts.runs,
    llm_model: report.opts.llm?.model ?? null,
    meta: report.meta,
    judgement: report.judgement,
    judgement_answer: report.judgementAnswer,
    answer_level: report.answerLevel,
    arms: report.results.map((r) => ({
      arm: r.arm,
      metrics: {
        tasks: r.tasks,
        recall_at_5: round(r.recall_at_5),
        recall_hits: r.recall_hits,
        correct_refusal_rate: round(r.correct_refusal_rate),
        refusal_calibration: round(r.refusal_calibration),
        match_rate: round(r.match_rate),
        expect_hit_rate: round(r.expect_hit_rate),
        hit_but_unused_rate: round(r.hit_but_unused_rate),
        injected_tokens: r.injected_tokens,
        injected_tokens_mean: r.injected_tokens_mean,
        token_efficiency: round(r.token_efficiency),
        answer_accuracy: round(answerAccuracy(r)),
        task_unanimous_rate: r.task_unanimous_rate ?? null,
        trap_tasks: r.trap_tasks ?? 0,
        trap_falls: r.trap_falls ?? 0,
        trap_fall_rate: round(r.trap_fall_rate),
      },
      by_kind: r.by_kind,
      by_capability: r.by_capability ?? {},
      diagnostics: r.arm_diagnostics,
      llm: r.llm ?? null,
      rounds: r.rounds ?? null,
      tasks: r.rows,
      runs: r.runs ?? [],
    })),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
  // 不用 process.exit(main())：stdout 接到管道时 exit 会截断还没 flush 的写入，
  // `--json | jq` 会拿到半截 JSON（实测 195KB 只出来 65KB）。设 exitCode 让事件循环自然排空。
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log(`评测脚本内部错误：${err?.stack ?? err}`);
      process.exitCode = 1;
    });
}
