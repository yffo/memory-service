#!/usr/bin/env node
/**
 * core-30-v1 三臂评测 —— 取上下文一律走**子进程调 CLI**，不 import 被测代码的内部模块。
 *
 * 三臂：
 *   none    空上下文（退化基线：什么都不给）
 *   new     node bin/memory search --query "<q>" --json   ← 被测系统
 *   legacy  /Users/yangfu/yffto/dsh-engramory-recall 的 BM25（子进程 import 它的 store.js + bm25.js，只读）
 *
 * 回答器是 `none`（不是模型）：echo（默认，回显全部注入上下文）或 first-hit（只回显 rank-1 那篇）。
 * 所以这个跑分器**零模型成本**，它量的是「检索有没有把正确笔记拿进上下文」，不是「模型会不会用」。
 *
 * 用法：
 *   node bench/run-eval.mjs                      # 三臂，Markdown 表打到 stdout
 *   node bench/run-eval.mjs --json                # 机器可读（纯 JSON，提示走 stderr）
 *   node bench/run-eval.mjs --dry                 # 不调 CLI，只跑 none 臂 + 评分路径
 *   node bench/run-eval.mjs --arms none,new --out /tmp/eval.md
 *   node bench/run-eval.mjs --legacy-store ~/memory/engramory --legacy-repo /path/to/repo
 *
 * 关键选项：
 *   --tasks <file>        题集（默认 bench/core-30-v1/tasks.json）
 *   --library <dir>       虚构语料库（默认 bench/core-30-v1/library）
 *   --cli <path>          被测 CLI（默认 bin/memory）
 *   --store <dir>         new 臂要读的库（默认 = 语料库的**临时副本**，见下）
 *   --store-mode <mode>   怎么把库告诉 CLI：auto（默认，同时给 --store 与 MEMORY_STORE）/ flag / env / plain
 *   --same-corpus         legacy 臂也读同一份虚构语料（默认读 ~/memory/engramory 私人库）
 *   --cli-args <str>      追加给 CLI 的参数（空格分隔，便于 CLI 改口径时对齐）
 *   --answerer <mode>     echo（默认）| first-hit
 *   --k <n>               recall@k（默认 5）
 *   --timeout <ms>        单次 CLI 调用超时（默认 20000）
 *   --keep-scratch        保留临时库（默认跑完删掉）
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
import { estimateTokens, round, scoreRun, THRESHOLDS } from './scorer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_TASKS = path.join(HERE, 'core-30-v1', 'tasks.json');
const DEFAULT_LIBRARY = path.join(HERE, 'core-30-v1', 'library');
const DEFAULT_CLI = path.join(ROOT, 'bin', 'memory');
const DEFAULT_LEGACY_REPO = '/Users/yangfu/yffto/dsh-engramory-recall';
const DEFAULT_LEGACY_STORE = path.join(os.homedir(), 'memory', 'engramory');

export const ARM_META = Object.freeze({
  none: { label: '无记忆', how: '空上下文' },
  new: { label: 'memory-service', how: 'node bin/memory search --query <q> --json' },
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
    k: 5,
    timeout: 20000,
    out: null,
    json: false,
    dry: false,
    showIds: false,
    sameCorpus: false,
    keepScratch: false,
    help: false,
  };
  const value = (name) => {
    const i = argv.indexOf(name);
    return i === -1 || argv[i + 1] === undefined ? null : String(argv[i + 1]);
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const key = arg.split('=')[0];
    if (!flags.has(key) && !['--tasks', '--library', '--cli', '--store', '--store-mode', '--cli-args', '--legacy-repo', '--legacy-store', '--arms', '--answerer', '--k', '--timeout', '--out'].includes(key)) {
      throw new Error(`未知参数 ${arg}（--help 看用法）`);
    }
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
  opts.k = Number(pick('--k', opts.k));
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
  if (opts.dry) opts.arms = ['none'];
  for (const arm of opts.arms) if (!ARM_META[arm]) throw new Error(`未知臂 ${arm}（可选 none/new/legacy）`);
  if (!['echo', 'first-hit'].includes(opts.answerer)) throw new Error(`未知回答器 ${opts.answerer}（可选 echo/first-hit）`);
  if (!Number.isInteger(opts.k) || opts.k < 1) throw new Error('--k 必须是正整数');
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
  const args = [opts.cli, 'search', '--query', task.prompt, '--json'];
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
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
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
    chunks.push({ file: maskIds ? `note#${chunks.length + 1}` : file, text: `[${label}] ${text}` });
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

/* ────────────────────────── 一轮跑分 ────────────────────────── */

export function runArm(arm, tasks, opts, ctx) {
  const runs = [];
  let errors = 0;
  let successes = 0;
  let tokensFromCli = 0;
  let libraryHits = 0;
  for (const task of tasks) {
    let raw = { hits: [], tokens: 0, refused: false };
    if (arm === 'new') {
      raw = callNewArm(task, opts);
      if (raw.error) {
        errors += 1;
        runs.push({ task_id: task.id, answer: '', injected: '', hits: [], tokens: 0, error: raw.error });
        log(`  [${arm}] ${task.id} 调用失败：${raw.error}`);
        continue;
      }
      successes += 1;
      for (const hit of raw.hits) if (ctx.libraryFiles.has(String(hit.id))) libraryHits += 1;
    } else if (arm === 'legacy') {
      raw = callLegacyArm(task, opts);
      if (raw.error) {
        errors += 1;
        runs.push({ task_id: task.id, answer: '', injected: '', hits: [], tokens: 0, error: raw.error });
        log(`  [${arm}] ${task.id} 桥失败：${raw.error}`);
        continue;
      }
      successes += 1;
    }
    const chunks = buildContext({
      hits: raw.hits,
      store: ctx.store,
      maskIds: ctx.maskIds,
      readNote: ctx.readNote,
      k: opts.k,
    });
    const injected = raw.refused ? `REFUSED: ${raw.reason ?? 'no relevant note'}` : chunks.map((c) => c.text).join('\n\n');
    const { answer, refused } = answerFor(opts.answerer, { injected, chunks });
    const tokens = Number.isFinite(raw.tokens) && raw.tokens !== null ? raw.tokens : estimateTokens(injected);
    if (Number.isFinite(raw.tokens) && raw.tokens !== null) tokensFromCli += 1;
    runs.push({
      task_id: task.id,
      answer,
      injected,
      // hits 保持**原样**（判分要用真 id）；打码只影响输出，见 hits_display。
      hits: raw.hits ?? [],
      hits_display: (raw.hits ?? []).map((h, i) => ({
        rank: i + 1,
        id: ctx.maskIds ? `note#${i + 1}` : String(h.id ?? ''),
        score: Number.isFinite(h.score) ? round(h.score, 4) : null,
      })),
      tokens,
      refused,
      reason: raw.reason ?? null,
      error: null,
    });
  }
  const result = scoreRun(tasks, runs, { k: opts.k, arm, errors });
  result.arm_diagnostics = {
    errors,
    successes,
    tokens_from_cli: tokensFromCli,
    tokens_estimated: successes - tokensFromCli,
    library_hits: libraryHits,
  };
  // 逐题的运行明细（注入 token / 是否拒答 / 召回了哪些笔记）—— 排障要靠它，判分不靠它。
  result.runs = runs.map((r) => ({
    task_id: r.task_id,
    tokens: r.tokens,
    refused: r.refused,
    reason: r.reason,
    error: r.error,
    hits: r.hits_display,
  }));
  return result;
}

/* ────────────────────────── 报告 ────────────────────────── */

const fmt = (v, digits = 3) => (v === null || v === undefined ? '—' : typeof v === 'number' ? String(round(v, digits) ?? '—') : String(v));
const mark = (row) => (row.refusal_task ? (row.correct_refusal ? '✓' : '✗') : `${row.recall_at_k ? 'R' : '-'}${row.match ? '✓' : '✗'}`);

export function renderMarkdown(report) {
  const { opts, results, meta } = report;
  const arms = results.map((r) => r.arm);
  const out = [];
  out.push(`# core-30-v1 评测报告（${meta.mode}）`);
  out.push('');
  out.push(`- 时间：${meta.startedAt}`);
  out.push(`- 题集：${meta.tasksPath}（${meta.taskCount} 题：${meta.kindCount}）`);
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
  out.push(`- 回答器：${opts.answerer}（none，非模型）；recall@${opts.k}（命中判定：gold 笔记进没进 top-${opts.k}）`);
  out.push(`- 臂：${arms.map((a) => `${a}（${ARM_META[a].label}）`).join(' / ')}`);
  if (opts.dry) out.push('- **--dry 模式**：没有调用 CLI，new/legacy 两臂未跑；这张表只验证评分路径。');
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
  if (meta.legacyFallback) notes.push('legacy 臂走的是索引关键词兜底（旧仓库的桥没跑通），数字只作参照。');
  if (results.some((r) => r.arm === 'new' && r.arm_diagnostics.tokens_estimated > 0)) notes.push('new 臂有一部分 token 是估算的（CLI 没报 tokens），token_efficiency 只作参照。');
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

export function buildReport(opts, results, { tasks, library, noteCount, startedAt, masked, cliPresent, legacyFallback, dry, storeKind, preflight, legacySameCorpus, legacyStoreExists, cliArgsOverride }) {
  const kindCount = Object.entries(
    tasks.reduce((acc, t) => ({ ...acc, [t.kind]: (acc[t.kind] ?? 0) + 1 }), {}),
  )
    .map(([k, v]) => `${k} ${v}`)
    .join('、');
  const newResult = results.find((r) => r.arm === 'new');
  const noneResult = results.find((r) => r.arm === 'none');
  const meta = {
    startedAt,
    mode: dry ? '--dry 干跑' : '实跑',
    tasksPath: opts.tasks,
    taskCount: tasks.length,
    kindCount,
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
  return report;
}

export function main(argv = process.argv.slice(2)) {
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
      results.push(runArm(arm, set.tasks, opts, ctx));
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
    const { answer, refused } = answerFor(opts.answerer, { injected, chunks });
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
    meta: report.meta,
    judgement: report.judgement,
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
      },
      by_kind: r.by_kind,
      diagnostics: r.arm_diagnostics,
      tasks: r.rows,
      runs: r.runs ?? [],
    })),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) {
  // 不用 process.exit(main())：stdout 接到管道时 exit 会截断还没 flush 的写入，
  // `--json | jq` 会拿到半截 JSON（实测 195KB 只出来 65KB）。设 exitCode 让事件循环自然排空。
  process.exitCode = main();
}
