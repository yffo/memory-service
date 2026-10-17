#!/usr/bin/env node
/**
 * core-30-v1 判分器对抗集 —— 打自己的裁判，不打被测系统。
 *
 * 判分器是纯函数，所以这里不需要模型、不联网、不起 CLI：
 *   输入 = 题集 + 对抗用例（正确答案 / 含糊但切题的错答案 / 干净拒答 / 带编造值的假拒答）
 *   输出 = 误收率（该拒的收了）与误拒率（该收的拒了）。
 *
 * 判据（docs/02-evaluation.md §6）：
 *   误收率 < 0.20 才算合格；误拒率目标 0（正确改述被拒也是判分器 bug）。
 *
 * 用法：
 *   node bench/judge-adversarial.mjs
 *   node bench/judge-adversarial.mjs --json
 *   node bench/judge-adversarial.mjs --verbose
 *   node bench/judge-adversarial.mjs --suite bench/core-30-v1/adversarial.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRefusalTask, scoreTask } from './scorer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS = path.join(HERE, 'core-30-v1', 'tasks.json');
const DEFAULT_SUITE = path.join(HERE, 'core-30-v1', 'adversarial.json');
export const MAX_WRONG_ACCEPT_RATE = 0.2;
export const MIN_CORRECT_ACCEPT_RATE = 0.95;

export function loadAdversarial({ tasksPath = DEFAULT_TASKS, suitePath = DEFAULT_SUITE } = {}) {
  const taskSet = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  if (!Array.isArray(taskSet.tasks)) throw new Error(`${tasksPath} 里没有 tasks 数组`);
  const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
  if (!Array.isArray(suite.cases)) throw new Error(`${suitePath} 里没有 cases 数组`);
  return { tasks: taskSet.tasks, cases: suite.cases };
}

/**
 * 逐条判分。accepted 的定义与 run-eval 一致：
 *   可答题 = match（答了、命中 expect/alias、且没命中 forbid）
 *   拒答题 = correct_refusal（干净拒答、且没把编造值端出来）
 */
export function judgeCases(tasks, cases) {
  const byId = new Map((tasks ?? []).map((task) => [task.id, task]));
  const rows = cases.map((testCase) => {
    const task = byId.get(testCase.task_id);
    if (!task) throw new Error(`对抗用例 ${testCase.id} 指向不存在的题目 ${testCase.task_id}`);
    if (typeof testCase.answer !== 'string') throw new Error(`对抗用例 ${testCase.id} 缺少字符串 answer`);
    if (typeof testCase.accept !== 'boolean') throw new Error(`对抗用例 ${testCase.id} 缺少布尔 accept`);
    const score = scoreTask(task, {
      answer: testCase.answer,
      refused: testCase.refused === true,
      injected: '',
      hits: [],
      tokens: 0,
    });
    const accepted = isRefusalTask(task) ? score.correct_refusal === true : score.match === true;
    return {
      ...testCase,
      accepted,
      pass: accepted === testCase.accept,
      score: {
        expect_used: score.expect_used,
        forbid_used: score.forbid_used,
        refused: score.refused,
        correct_refusal: score.correct_refusal,
        match: score.match,
        alias_used: score.alias_used,
      },
    };
  });

  const correct = rows.filter((row) => row.accept === true);
  const wrong = rows.filter((row) => row.accept === false);
  const rate = (numerator, denominator) => (denominator === 0 ? null : Number((numerator / denominator).toFixed(4)));
  const wrongAccepted = wrong.filter((row) => row.accepted);
  const correctRejected = correct.filter((row) => !row.accepted);
  const wrongAcceptRate = rate(wrongAccepted.length, wrong.length);
  const correctAcceptRate = rate(correct.length - correctRejected.length, correct.length);
  const gate =
    wrongAcceptRate !== null &&
    correctAcceptRate !== null &&
    wrongAcceptRate < MAX_WRONG_ACCEPT_RATE &&
    correctAcceptRate >= MIN_CORRECT_ACCEPT_RATE;

  const labels = [...new Set(rows.map((row) => row.label ?? 'unknown'))];
  const byLabel = Object.fromEntries(
    labels.map((label) => {
      const group = rows.filter((row) => (row.label ?? 'unknown') === label);
      return [label, {
        cases: group.length,
        expected_accept: group.filter((row) => row.accept === true).length,
        accepted: group.filter((row) => row.accepted).length,
        failures: group.filter((row) => !row.pass).length,
      }];
    }),
  );

  return {
    tasks: tasks.length,
    cases: rows.length,
    correct_total: correct.length,
    correct_accepted: correct.length - correctRejected.length,
    correct_accept_rate: correctAcceptRate,
    wrong_total: wrong.length,
    wrong_accepted: wrongAccepted.length,
    wrong_accept_rate: wrongAcceptRate,
    false_rejects: correctRejected.map((row) => row.id),
    missed_wrong: wrongAccepted.map((row) => row.id),
    by_label: byLabel,
    gate: {
      wrong_accept_below: MAX_WRONG_ACCEPT_RATE,
      correct_accept_at_least: MIN_CORRECT_ACCEPT_RATE,
      pass: gate,
    },
    rows,
  };
}

export function renderMarkdown(report, { tasksPath, suitePath, verbose = false } = {}) {
  const out = [];
  out.push('# core-30-v1 判分器对抗集');
  out.push('');
  out.push(`- 题集：${tasksPath}（${report.tasks} 题）`);
  out.push(`- 用例：${suitePath}（${report.cases} 条：应接受 ${report.correct_total}，应拒绝 ${report.wrong_total}）`);
  out.push(`- 误收率：${fmtRate(report.wrong_accept_rate)}（应拒绝的 ${report.wrong_total} 条里接受了 ${report.wrong_accepted} 条；阈值 < ${MAX_WRONG_ACCEPT_RATE}）`);
  out.push(`- 正确接受率：${fmtRate(report.correct_accept_rate)}（应接受的 ${report.correct_total} 条里接受了 ${report.correct_accepted} 条；目标 ≥ ${MIN_CORRECT_ACCEPT_RATE}）`);
  out.push('');
  out.push(`**结论：${report.gate.pass ? '通过' : '不通过'}**`);
  out.push('');

  out.push('## 按用例类型');
  out.push('');
  out.push('| label | 用例 | 应接受 | 实际接受 | 失败 |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const [label, value] of Object.entries(report.by_label)) {
    out.push(`| ${label} | ${value.cases} | ${value.expected_accept} | ${value.accepted} | ${value.failures} |`);
  }
  out.push('');

  const failures = report.rows.filter((row) => !row.pass);
  if (failures.length) {
    out.push('## 失败明细');
    out.push('');
    out.push('| 用例 | task | label | 期望 | 实际 | 答案 |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of failures) {
      out.push(`| ${row.id} | ${row.task_id} | ${row.label} | ${row.accept ? '收' : '拒'} | ${row.accepted ? '收' : '拒'} | ${escapeCell(row.answer)} |`);
    }
    out.push('');
  }
  if (verbose) {
    out.push('## 全部用例');
    out.push('');
    out.push('| 用例 | task | label | 期望 | 实际 | 结果 | 答案 |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of report.rows) {
      out.push(`| ${row.id} | ${row.task_id} | ${row.label} | ${row.accept ? '收' : '拒'} | ${row.accepted ? '收' : '拒'} | ${row.pass ? '✅' : '❌'} | ${escapeCell(row.answer)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

const fmtRate = (value) => (value === null ? '—' : value.toFixed(4));
const escapeCell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function parseArgs(argv) {
  const flags = new Set(['--json', '--help', '-h', '--verbose']);
  const values = new Set(['--tasks', '--suite']);
  const opts = {
    tasksPath: DEFAULT_TASKS,
    suitePath: DEFAULT_SUITE,
    json: false,
    verbose: false,
    help: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const key = arg.split('=')[0];
    if (!flags.has(key) && !values.has(key)) throw new Error(`未知参数 ${arg}（--help 看用法）`);
  }
  const value = (name) => {
    const i = argv.indexOf(name);
    return i === -1 || argv[i + 1] === undefined ? null : String(argv[i + 1]);
  };
  opts.tasksPath = value('--tasks') ?? opts.tasksPath;
  opts.suitePath = value('--suite') ?? opts.suitePath;
  opts.json = argv.includes('--json');
  opts.verbose = argv.includes('--verbose');
  opts.help = argv.includes('--help') || argv.includes('-h');
  return opts;
}

function usage() {
  return fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  let loaded;
  let report;
  try {
    loaded = loadAdversarial({ tasksPath: opts.tasksPath, suitePath: opts.suitePath });
    report = judgeCases(loaded.tasks, loaded.cases);
  } catch (error) {
    process.stderr.write(`[judge-adversarial] ${error.message}\n`);
    process.exit(2);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      version: 'core-30-v1-judge-adversarial/1',
      tasks_path: opts.tasksPath,
      suite_path: opts.suitePath,
      ...report,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(renderMarkdown(report, {
      tasksPath: opts.tasksPath,
      suitePath: opts.suitePath,
      verbose: opts.verbose,
    }) + '\n');
  }
  if (!report.gate.pass) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
