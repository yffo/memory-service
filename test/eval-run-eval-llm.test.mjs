import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mergeRounds } from '../bench/run-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'bench', 'run-eval.mjs');

const fakeRound = (overrides = {}) => ({
  arm: 'none',
  recall_at_5: 0.5,
  correct_refusal_rate: 1,
  refusal_calibration: 1,
  answered_rate: 0.5,
  match_rate: 0.5,
  expect_hit_rate: 0.5,
  hit_but_unused_rate: 0,
  injected_tokens: 100,
  injected_tokens_mean: 2,
  token_efficiency: 1,
  rows: [
    { task_id: 'a', kind: 'fact', refusal_task: false, match: true, recall_at_k: true, correct_refusal: null, tokens: 4, expect_hit: true, expect_used: true },
    { task_id: 'b', kind: 'refusal', refusal_task: true, match: true, recall_at_k: false, correct_refusal: true, tokens: 0, expect_hit: false, expect_used: false },
  ],
  runs: [{ task_id: 'a', tokens: 4 }],
  arm_diagnostics: { errors: 0, successes: 2, tokens_from_cli: 0, tokens_estimated: 2, library_hits: 0 },
  verdict: { missing_tasks: 0, errors: 0 },
  llm: { calls: 2, errors: 0, prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost_usd: 0.000003, latency_ms_mean: 100 },
  ...overrides,
});

test('mergeRounds：率取轮均值，逐题取多数票，token/成本/延迟累计', () => {
  const r1 = fakeRound();
  const r2 = fakeRound({
    recall_at_5: 1,
    match_rate: 1,
    rows: [
      { task_id: 'a', kind: 'fact', refusal_task: false, match: true, recall_at_k: true, correct_refusal: null, tokens: 6, expect_hit: true, expect_used: true },
      { task_id: 'b', kind: 'refusal', refusal_task: true, match: false, recall_at_k: false, correct_refusal: false, tokens: 0, expect_hit: false, expect_used: false },
    ],
    arm_diagnostics: { errors: 1, successes: 1, tokens_from_cli: 0, tokens_estimated: 1, library_hits: 0 },
    verdict: { missing_tasks: 1, errors: 1 },
    llm: { calls: 3, errors: 1, prompt_tokens: 30, completion_tokens: 15, total_tokens: 45, cost_usd: 0.000004, latency_ms_mean: 200 },
  });

  const merged = mergeRounds([r1, r2], 'none');
  assert.equal(merged.recall_at_5, 0.75);
  assert.equal(merged.match_rate, 0.75);
  assert.equal(merged.injected_tokens, 100);
  assert.equal(merged.rows.length, 2);
  // 第 2 轮题 b 判错 → 两轮里 1:1，不算多数（多数要求严格过半）→ 判错。
  assert.equal(merged.rows.find((r) => r.task_id === 'b').match, false);
  assert.equal(merged.rows.find((r) => r.task_id === 'b').correct_refusal, false);
  assert.equal(merged.rows.find((r) => r.task_id === 'a').tokens, 5);
  assert.equal(merged.task_unanimous_rate, 0.5);
  assert.equal(merged.llm.calls, 5);
  assert.equal(merged.llm.cost_usd, 0.000007);
  assert.equal(merged.llm.latency_ms_mean, 160);
  assert.equal(merged.arm_diagnostics.errors, 1);
  assert.equal(merged.arm_diagnostics.successes, 3);
  assert.equal(merged.verdict.missing_tasks, 1);
  assert.equal(merged.verdict.errors, 1);
  assert.equal(merged.verdict.pass, false);
  assert.equal(merged.rounds.length, 2);
  assert.equal(merged.rounds[1].llm.calls, 3);
});

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`超时：run-eval 没在 120s 内结束
${stderr.slice(-2000)}`));
    }, 120_000);
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** 本地假模型端点：把 <notes> 原文当答案返回；没有笔记就拒答。绝不联网。 */
async function startMockProvider() {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      state.requests += 1;
      const body = JSON.parse(raw || '{}');
      const user = (body.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => String(m.content ?? ''))
        .join('\n');
      const notes = user.match(/<notes>([\s\S]*?)<\/notes>/)?.[1]?.trim() ?? '';
      const content = notes === '' ? '没有记录' : notes;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: body.model ?? 'deepseek-flash',
          choices: [{ message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, state, port: server.address().port };
}

test('run-eval --answerer llm：closed_book 与 oracle_gold 走本地 mock，不联网', async (t) => {
  const { server, state, port } = await startMockProvider();
  t.after(() => server.close());
  const { code, stdout, stderr } = await runNode(
    [SCRIPT, '--arms', 'none,oracle', '--answerer', 'llm', '--concurrency', '4', '--json'],
    {
      EVAL_LLM_BASE_URL: `http://127.0.0.1:${port}`,
      EVAL_LLM_API_KEY: 'test-key-not-real',
      EVAL_LLM_MODEL: 'deepseek-flash',
    },
  );
  assert.equal(code, 0, stderr.slice(-3000));
  const report = JSON.parse(stdout);
  assert.equal(report.answerer, 'llm');
  assert.equal(report.llm_model, 'deepseek-flash');
  assert.deepEqual(report.arms.map((a) => a.arm), ['none', 'oracle']);
  // 56 题 × 2 臂，全部打到本地 mock；没有 new 臂 → 不碰 CLI，但仍过预检。
  assert.equal(state.requests, 112);
  const none = report.arms.find((a) => a.arm === 'none');
  const oracle = report.arms.find((a) => a.arm === 'oracle');
  // closed_book：全部「没有记录」→ 20 道拒答题答对，36 道可答题答不出。20/56 = 0.3571。
  assert.equal(none.metrics.answer_accuracy, 0.3571);
  assert.equal(none.metrics.injected_tokens, 0);
  // oracle_gold：gold 笔记正文就是答案 → 55/56；个别 gold 笔记正文里也带干扰值，扣 1 题。
  assert.equal(oracle.metrics.answer_accuracy, 0.9821);
  assert.ok(oracle.metrics.injected_tokens > 0);
  assert.equal(report.answer_level.accuracy.oracle, 55 / 56); // answer_level 存未舍入的原值
  assert.equal(report.answer_level.negative_transfer, null); // 没有 real 臂，负迁移算不出来
  assert.equal(report.answer_level.oracle_gap, null); // 没跑 real 臂，算不出 gap
  assert.equal(oracle.llm.calls, 56);
  assert.equal(oracle.llm.prompt_tokens, 56 * 50);
  assert.ok(oracle.llm.cost_usd > 0);
  // 缺 new 臂 → 回答层判定必须明确「算不出来」，不许冒充达标。
  assert.deepEqual(report.judgement_answer.blockers, ['缺 new 臂（closed_book / real / oracle_gold 三档要一起跑）']);
  assert.equal(report.judgement_answer.verdict, '算不出来');
});
