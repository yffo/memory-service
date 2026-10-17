// 注入成本口径：旧实现把 CLI 的 top-8 候选预算当成 top-k 实际注入成本，报告因此虚报。
// 这组用例盯三件事：--inject-k 与 recall 口径解耦、逐条成本透传、有成本时绝不再看 cliTokens。
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContext, countInjectedTokens, parseArgs } from '../bench/run-eval.mjs';

test('parseArgs：--inject-k 独立于 --k，默认 null', () => {
  assert.equal(parseArgs([]).injectK, null);
  const opts = parseArgs(['--k', '5', '--inject-k', '2']);
  assert.equal(opts.k, 5, 'recall@k 的口径不能被注入条数带偏');
  assert.equal(opts.injectK, 2);
  assert.throws(() => parseArgs(['--inject-k', '0']), /--inject-k/);
  assert.throws(() => parseArgs(['--inject-k', 'x']), /--inject-k/);
});

test('parseArgs：--cli-args 的值以 -- 开头时不被当成顶层参数', () => {
  const opts = parseArgs(['--cli-args', '--min-coverage 0.55']);
  assert.equal(opts.cliArgs, '--min-coverage 0.55');
  const eq = parseArgs(['--cli-args=--min-coverage=0.55']);
  assert.equal(eq.cliArgs, '--min-coverage=0.55');
  assert.throws(() => parseArgs(['--min-coverage', '0.55']), /未知参数/);
});

test('buildContext：只注入 top-k，且逐条 cost 原样透传', () => {
  const hits = [
    { id: 'a', title: 'A', cost: 7 },
    { id: 'b', title: 'B', cost: 5 },
  ];
  const one = buildContext({ hits, k: 1, readNote: () => '正文' });
  assert.equal(one.length, 1);
  assert.equal(one[0].text, '[a] 正文');
  assert.equal(one[0].cost, 7);

  const two = buildContext({ hits, k: 2, readNote: () => '正文' });
  assert.deepEqual(two.map((c) => c.cost), [7, 5]);
});

test('countInjectedTokens：有逐条成本时求和，绝不拿 cliTokens 冒充', () => {
  const chunks = [{ cost: 7 }, { cost: 5 }];
  assert.equal(
    countInjectedTokens({ arm: 'new', refused: false, chunks, cliTokens: 999, injected: 'x' }),
    12,
    'cliTokens 是候选预算，不是实际注入量',
  );
  assert.equal(countInjectedTokens({ arm: 'new', refused: true, chunks, cliTokens: 999, injected: 'REFUSED' }), 0);
  // 老 CLI / 无成本时退回估算，但仍不能拿 top-8 预算顶替 new 臂的实际注入。
  assert.equal(countInjectedTokens({ arm: 'new', refused: false, chunks: [], cliTokens: 999, injected: 'abcd' }), 2);
  // legacy 没有逐条成本，cliTokens 本来就是它的注入统计，保持不变。
  assert.equal(countInjectedTokens({ arm: 'legacy', refused: false, chunks: [], cliTokens: 999, injected: 'abcd' }), 999);
});
