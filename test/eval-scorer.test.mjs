/**
 * 判分器的单元测试。判分器是**纯函数**，所以这里不碰文件系统、不起进程：
 * 手写 task/run 对象，断言每个指标的定义。
 *
 * 覆盖的坑（都是踩过或想清楚了的）：
 *   - 归一化：全角/半角、空格、大小写必须吃掉，否则「2 GB」和「2GB」会被判成两回事；
 *   - 别名：笔记写「每秒 12 次」而题面写「12 次/秒」时要算命中（换算在判分器这侧）；
 *   - 拒答：提到 forbid 里那个编造值就不算干净拒答；
 *   - forbid 出现在**上下文**里不算答错，出现在**答案**里才算；
 *   - 缺题必须浮出来（不能悄悄按跑过的题算分）；
 *   - 纯函数：跑两遍结果一样，且不改入参。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES,
  EXPECT_ALIASES,
  REFUSAL_PATTERNS,
  THRESHOLDS,
  answerTokenEfficiency,
  coveredTaskIds,
  estimateTokens,
  isRefusalTask,
  isSourceHit,
  missingTaskIds,
  normalizeText,
  recallAtK,
  round,
  scoreRun,
  scoreTask,
  taskAnswerAliases,
  taskCapability,
  taskExpectAll,
  taskNegativeTransferProbe,
  termVariants,
} from '../bench/scorer.mjs';

const BENCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench');
const RUNNER = path.join(BENCH, 'run-eval.mjs');
/** 真实题集的题数：跑分器输出契约要对得上题集本身，而不是写死一个数。 */
const SUITE_TASKS = JSON.parse(fs.readFileSync(path.join(BENCH, 'core-30-v1', 'tasks.json'), 'utf8')).tasks.length;

const fact = (id = 'f01') => ({
  id,
  kind: 'fact_recall',
  prompt: '某个东西的端口是多少？',
  expect: ['8443'],
  forbid: ['9443'],
  source: ['project-orchid-deploy-port.md'],
});
const refusal = (id = 'r01') => ({
  id,
  kind: 'refusal',
  prompt: '语料里根本没写的那件事是什么？',
  expect: [],
  forbid: ['9999'],
  source: null,
});

test('normalizeText：NFKC + 去空白 + 小写', () => {
  assert.equal(normalizeText(' 2 GB '), '2gb');
  assert.equal(normalizeText('２GB'), '2gb'); // 全角数字
  assert.equal(normalizeText('PG\tNOT\nNULL'), 'pgnotnull');
  assert.equal(normalizeText('ＡＢＣ'), 'abc');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(8443), '8443');
});

test('estimateTokens：只在 CLI 没报 token 时兜底，空串是 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('一二三四'), 2);
  assert.equal(estimateTokens('一二三'), 2); // 向上取整，宁可高估
});

test('isRefusalTask：source 空数组/缺省 = 拒答题', () => {
  assert.equal(isRefusalTask(fact()), false);
  assert.equal(isRefusalTask(refusal()), true);
  assert.equal(isRefusalTask({ source: [] }), true);
  assert.equal(isRefusalTask({}), true);
});

test('isSourceHit：文件名、去后缀、带路径三种写法都认', () => {
  assert.equal(isSourceHit({ id: 'project-orchid-deploy-port' }, 'project-orchid-deploy-port.md'), true);
  assert.equal(isSourceHit({ id: 'project-orchid-deploy-port.md' }, 'project-orchid-deploy-port.md'), true);
  assert.equal(isSourceHit({ id: 'notes/project-orchid-deploy-port.md' }, 'project-orchid-deploy-port.md'), true);
  assert.equal(isSourceHit({ id: '项目/Project-Orchid-Deploy-Port.md' }, 'project-orchid-deploy-port.md'), true);
  assert.equal(isSourceHit({ title: 'project-orchid-deploy-port' }, 'project-orchid-deploy-port.md'), true);
  assert.equal(isSourceHit({ id: 'reference-orchid-staging-port' }, 'project-orchid-deploy-port.md'), false);
  assert.equal(isSourceHit(null, 'x.md'), false);
  assert.equal(isSourceHit({ id: 'project-x' }, 'project-orchid-deploy-port.md'), false, '子串不算命中');
});

test('recallAtK：第 k 名算命中，第 k+1 名不算；多来源要全中；拒答题返回 null', () => {
  const hits = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }];
  assert.equal(recallAtK({ ...fact(), source: ['a.md'] }, hits, 5), true);
  assert.equal(recallAtK({ ...fact(), source: ['e.md'] }, hits, 5), true, '第 5 名（index 4）算命中');
  assert.equal(recallAtK({ ...fact(), source: ['f.md'] }, hits, 5), false, '第 6 名不算');
  assert.equal(recallAtK({ ...fact(), source: ['a.md', 'z.md'] }, hits, 5), false, '双来源要都在 top-k 里');
  assert.equal(recallAtK({ ...fact(), source: ['a.md', 'b.md'] }, hits, 5), true);
  assert.equal(recallAtK(refusal(), hits, 5), null, '拒答题不进 recall 分母');
  assert.equal(recallAtK({ ...fact(), source: ['a.md'] }, [], 5), false);
});

test('termVariants：别名白名单能把题面写法换算成笔记写法', () => {
  // 变体是**原样**给出的（匹配时两边都会归一化），所以这里也比归一化后的串。
  const variants = (t) => termVariants(t).map(normalizeText);
  assert.ok(variants('12 次/秒').includes('每秒12次'), '速率');
  assert.ok(variants('周二和周四 09:15').includes('每周二、周四09:15'), '周几');
  assert.ok(
    termVariants('$HOME/.config/kestrel/config.toml').includes('~/.config/kestrel/config.toml'),
    '家目录',
  );
  assert.deepEqual(termVariants('8443'), ['8443'], '没有别名的原样返回一条');
  assert.equal(termVariants('').length, 0);
  for (const alias of EXPECT_ALIASES) {
    assert.equal(typeof alias.name, 'string', '每条别名要有名字（报告里要解释为什么算命中）');
    assert.ok(alias.from instanceof RegExp);
    assert.equal(typeof alias.to, 'function');
  }
  assert.ok(EXPECT_ALIASES.length >= 3);
});

test('taskAnswerAliases：顶层与 expected 两种位置都认，脏值丢掉', () => {
  assert.deepEqual(taskAnswerAliases({ answer_aliases: [' 400 行以内 ', 3, '', null] }), ['400 行以内']);
  assert.deepEqual(taskAnswerAliases({ expected: { answer_aliases: ['500元/月', '每月 500'] } }), ['500元/月', '每月 500']);
  assert.deepEqual(taskAnswerAliases({}), []);
  assert.deepEqual(taskAnswerAliases({ answer_aliases: '400 行' }), [], '非数组不算别名，避免字符串被逐字拆开');
});

test('scoreTask：题级 answer_aliases 接受正确改述，但不绕过 forbid', () => {
  const task = {
    ...fact('p02'),
    expect: ['不超过 400 行'],
    forbid: ['800 行'],
    answer_aliases: ['400 行以内'],
  };
  const row = scoreTask(task, {
    hits: [{ id: 'project-orchid-deploy-port' }],
    injected: '单个 PR 的 diff 不超过 400 行',
    answer: '单个 PR 控制在 400 行以内。',
    tokens: 50,
  });
  assert.equal(row.expect_used, true, '别名也算命中 expect');
  assert.equal(row.match, true);
  assert.deepEqual(row.alias_used, ['400 行以内']);
  assert.equal(row.details.answer_aliases[0].used, true);

  const dirty = scoreTask(task, {
    answer: '单个 PR 控制在 400 行以内，800 行也能接受。',
  });
  assert.equal(dirty.forbid_used, true);
  assert.equal(dirty.match, false, '别名不能绕过 forbid');
});

test('scoreTask：别名只在上下文里时 expect_hit 为真、expect_used 仍为假', () => {
  const task = { ...fact('p02'), expect: ['不超过 400 行'], forbid: [], answer_aliases: ['400 行以内'] };
  const row = scoreTask(task, { injected: '单个 PR 控制在 400 行以内', answer: '这个我不知道。' });
  assert.equal(row.expect_hit, true);
  assert.equal(row.expect_used, false);
  assert.equal(row.hit_but_unused, true);
});

test('scoreTask：没有别名的题行为不变', () => {
  const row = scoreTask(fact(), {
    hits: [{ id: 'project-orchid-deploy-port' }],
    injected: '生产环境监听 8443',
    answer: '监听 8443。',
    tokens: 120,
  });
  assert.equal(row.match, true);
  assert.deepEqual(row.alias_used, []);
  assert.deepEqual(row.details.answer_aliases, []);
});

test('scoreTask：expect 只在上下文里时 hit_but_unused 为真、不算答对', () => {
  const row = scoreTask(fact(), {
    hits: [{ id: 'project-orchid-deploy-port' }],
    injected: '[project-orchid-deploy-port] 生产环境监听 8443',
    answer: '', // 回答器什么都没说
    tokens: 120,
  });
  assert.equal(row.recall_at_k, true);
  assert.equal(row.expect_hit, true);
  assert.equal(row.expect_used, false);
  assert.equal(row.hit_but_unused, true, '信息进了上下文但没进答案');
  assert.equal(row.refused, true, '空答案按拒答算');
  assert.equal(row.match, false);
  assert.equal(row.tokens, 120);
});

test('scoreTask：别名写法也算命中（每秒 12 次 ⇄ 12 次/秒）', () => {
  const row = scoreTask(
    { ...fact('f06'), expect: ['12 次/秒'], forbid: [], source: ['project-orchid-api-rate-limit.md'] },
    {
      hits: [{ id: 'project-orchid-api-rate-limit' }],
      injected: '公开接口限流每秒 12 次，超过就 429',
      answer: '公开接口限流每秒 12 次，超过就 429',
      tokens: 90,
    },
  );
  assert.equal(row.expect_hit, true, '上下文里的笔记写法应该被别名换算后命中');
  assert.equal(row.expect_used, true);
  assert.equal(row.match, true);
  assert.equal(row.hit_but_unused, false);
});

test('scoreTask：答案里出现 forbid 就是错，哪怕 expect 也在', () => {
  const row = scoreTask(fact(), {
    hits: [{ id: 'project-orchid-deploy-port' }],
    injected: '生产环境监听 8443',
    answer: '预发是 9443，生产是 8443',
    tokens: 100,
  });
  assert.equal(row.expect_used, true);
  assert.equal(row.forbid_used, true);
  assert.equal(row.match, false, '编造值与真值同时出现不算答对');
});

test('scoreTask：forbid 只出现在上下文里不算答错（那是检索的锅，不是答案的锅）', () => {
  const row = scoreTask(fact(), {
    hits: [{ id: 'project-orchid-deploy-port' }, { id: 'reference-orchid-staging-port' }],
    injected: '生产环境监听 8443；预发环境监听 9443',
    answer: '生产环境监听 8443。',
    tokens: 200,
  });
  assert.equal(row.forbid_hit, true, '陷阱进了上下文');
  assert.equal(row.forbid_used, false, '但答案没用它');
  assert.equal(row.match, true);
});

test('scoreTask：拒答题只在干净拒答时算对', () => {
  const clean = scoreTask(refusal(), { hits: [], answer: '没有找到相关记录。', refused: true, tokens: 0 });
  assert.equal(clean.correct_refusal, true);
  assert.equal(clean.match, true);
  assert.equal(clean.recall_at_k, null);

  const dirty = scoreTask(refusal(), {
    hits: [{ id: 'reference-orchid-log-location' }],
    answer: '我记得是 9999 天。',
    refused: false,
    tokens: 80,
  });
  assert.equal(dirty.correct_refusal, false, '把编造值端出来不算拒答');
  assert.equal(dirty.forbid_used, true);

  const hedged = scoreTask(refusal(), {
    hits: [],
    answer: '这个我不确定，可能是 9999 吧',
    refused: false,
    tokens: 10,
  });
  assert.equal(hedged.correct_refusal, false, '一边说不确定一边给编造值 = 不干净');
  assert.ok(REFUSAL_PATTERNS.length >= 4);
});

test('scoreTask：硬答一道没有证据的题就是错，且不占 recall 分母', () => {
  const row = scoreTask(refusal(), { hits: [{ id: 'x' }], answer: '是 CSV。', refused: false, tokens: 50 });
  assert.equal(row.refusal_task, true);
  assert.equal(row.correct_refusal, false);
  assert.equal(row.recall_at_k, null);
});

test('scoreTask：error 字段进报告，不被悄悄丢掉', () => {
  const row = scoreTask(fact(), { error: 'exit 1: boom', hits: [], tokens: 0 });
  assert.equal(row.error, 'exit 1: boom');
  assert.equal(row.recall_at_k, false);
});

test('scoreRun：指标定义（recall 只看有来源的题、拒答单独算、token_efficiency 按千 token）', () => {
  const tasks = [fact('f01'), { ...fact('f02'), expect: ['2 GB'], source: ['project-kestrel-token-budget.md'] }, refusal('r01'), refusal('r02')];
  const runs = [
    { task_id: 'f01', hits: [{ id: 'project-orchid-deploy-port' }], injected: '8443', answer: '8443', tokens: 100 },
    { task_id: 'f02', hits: [], injected: '', answer: '', tokens: 0 },
    { task_id: 'r01', hits: [], answer: '', refused: true, tokens: 0 },
    { task_id: 'r02', hits: [{ id: 'x' }], answer: '是 JSON。', tokens: 100 },
  ];
  const run = scoreRun(tasks, runs, { arm: 'new' });
  assert.equal(run.arm, 'new');
  assert.equal(run.tasks, 4);
  assert.equal(run.answerable_tasks, 2);
  assert.equal(run.refusal_tasks, 2);
  assert.equal(run.recall_at_5, 0.5, '两道有来源的题里中了一道');
  assert.equal(run.recall_hits, 1);
  assert.equal(run.correct_refusal_rate, 0.5, '两道拒答题里对了一道');
  assert.equal(run.injected_tokens, 200);
  assert.equal(run.injected_tokens_mean, 50);
  assert.equal(run.expect_hit_rate, 0.25, '4 题里 1 题的 expect 进了上下文');
  assert.equal(run.token_efficiency, 5, '1 次命中 / (200/1000) 千 token');
  assert.equal(run.hit_but_unused_rate, 0, '命中且被用上了');
  assert.equal(run.match_rate, 0.5, 'f01 与 r01 答对');
  assert.deepEqual(Object.keys(run.by_kind).sort(), ['fact_recall', 'refusal']);
  assert.equal(run.by_kind.fact_recall.recall_at_5, 0.5);
  assert.equal(run.by_kind.refusal.correct_refusal_rate, 0.5);
});

test('scoreRun：命中但没被用上时 hit_but_unused_rate > 0；分母为 0 时是 null', () => {
  const tasks = [fact('f01'), fact('f02')];
  const runs = [
    { task_id: 'f01', hits: [{ id: 'project-orchid-deploy-port' }], injected: '8443', answer: '', tokens: 10 },
    { task_id: 'f02', hits: [], injected: '', answer: '', tokens: 10 },
  ];
  const run = scoreRun(tasks, runs);
  assert.equal(run.expect_hits, 1);
  assert.equal(run.hit_but_unused, 1);
  assert.equal(run.hit_but_unused_rate, 1);
  const empty = scoreRun([fact('f01')], [{ task_id: 'f01', hits: [], injected: '', answer: '', tokens: 0 }]);
  assert.equal(empty.expect_hits, 0);
  assert.equal(empty.hit_but_unused_rate, null, '分母 0 → null，不是 0（0 会被误读成「完美」）');
  assert.equal(empty.token_efficiency, null, '没有 token 就没有效率可算');
});

test('scoreRun：缺题与调用失败必须让 verdict 不通过（不能按跑过的题算分）', () => {
  const tasks = [fact('f01'), fact('f02')];
  const missing = scoreRun(tasks, [{ task_id: 'f01', hits: [{ id: 'project-orchid-deploy-port' }], injected: '8443', answer: '8443', tokens: 10 }]);
  assert.deepEqual(missingTaskIds(tasks, [{ task_id: 'f01' }]), ['f02']);
  assert.deepEqual(coveredTaskIds(tasks, [{ task_id: 'f02' }]), ['f02']);
  assert.equal(missing.verdict.missing_tasks, 1);
  assert.equal(missing.verdict.pass, false);

  const errored = scoreRun(tasks, [
    { task_id: 'f01', hits: [{ id: 'project-orchid-deploy-port' }], injected: '8443', answer: '8443', tokens: 10 },
    { task_id: 'f02', error: 'CLI 挂了', hits: [], injected: '', answer: '', tokens: 0 },
  ], { errors: 1 });
  assert.equal(errored.verdict.errors, 1);
  assert.equal(errored.verdict.pass, false);
});

test('scoreRun：三条判据各自独立判定，算不出来是 null 不是 false', () => {
  const nothing = scoreRun([refusal('r01')], [{ task_id: 'r01', hits: [], answer: '', refused: true, tokens: 0 }]);
  assert.equal(nothing.recall_at_5, null, '没有有来源的题 → recall 算不出来');
  assert.equal(nothing.verdict.recall_at_5, null);
  assert.equal(nothing.verdict.correct_refusal_rate, true);
  assert.equal(nothing.verdict.pass, false, 'null 不算通过（deny-by-default）');
  assert.equal(THRESHOLDS.recallAt5, 0.8);
  assert.equal(THRESHOLDS.correctRefusalRate, 0.75);
  assert.equal(THRESHOLDS.maxInjectedTokensPerQuery, 500);
});

test('scoreRun：只有达到阈值才 pass（0.79 与 0.80 差一条题）', () => {
  // 配一道拒答题：否则 correct_refusal_rate 算不出来，pass 会因为「没证据」而不通过，
  // 边界就测不干净了（判据 1 本来就要求两个指标同时成立）。
  const tasks = [
    ...Array.from({ length: 10 }, (_, i) => ({ ...fact(`f${i}`), source: [`n${i}.md`] })),
    refusal('r01'),
  ];
  const refusalRun = { task_id: 'r01', hits: [], answer: '', refused: true, tokens: 0 };
  const withRefusal = (runs) => [...runs, refusalRun];
  const hitRuns = Array.from({ length: 10 }, (_, i) => ({
    task_id: `f${i}`,
    hits: [{ id: `n${i}` }],
    injected: '8443',
    answer: '8443',
    tokens: 60,
  }));
  const all = scoreRun(tasks, withRefusal(hitRuns));
  assert.equal(all.recall_at_5, 1);
  assert.equal(all.verdict.recall_at_5, true);
  assert.equal(all.verdict.correct_refusal_rate, true);
  assert.equal(all.verdict.pass, true);
  assert.equal(all.injected_tokens, 600, '拒答那题只花了 0 token');
  assert.equal(all.verdict.injected_tokens, true);

  const nine = scoreRun(tasks, withRefusal(hitRuns.map((r, i) => (i === 0 ? { ...r, hits: [] } : r))));
  assert.equal(nine.recall_at_5, 0.9);
  assert.equal(nine.verdict.recall_at_5, true, '0.9 ≥ 0.8 仍达标');
  const eight = scoreRun(tasks, withRefusal(hitRuns.map((r, i) => (i < 2 ? { ...r, hits: [] } : r))));
  assert.equal(eight.recall_at_5, 0.8);
  assert.equal(eight.verdict.recall_at_5, true, '边界 0.8 达标（≥）');
  const seven = scoreRun(tasks, withRefusal(hitRuns.map((r, i) => (i < 3 ? { ...r, hits: [] } : r))));
  assert.equal(seven.recall_at_5, 0.7);
  assert.equal(seven.verdict.recall_at_5, false);
  assert.equal(seven.verdict.pass, false);
});

test('scoreRun：超预算会被判不达标（单题均值 > 500）', () => {
  const tasks = [fact('f01'), refusal('r01')];
  const run = scoreRun(tasks, [
    { task_id: 'f01', hits: [{ id: 'project-orchid-deploy-port' }], injected: '8443', answer: '8443', tokens: 1001 },
    { task_id: 'r01', hits: [], answer: '', refused: true, tokens: 0 },
  ]);
  assert.equal(run.injected_tokens_mean, 500.5);
  assert.equal(run.verdict.injected_tokens, false);
  assert.equal(run.verdict.recall_at_5, true);
  assert.equal(run.verdict.correct_refusal_rate, true);
  assert.equal(run.verdict.pass, false, '只剩预算这一条不达标');
});

test('answerTokenEfficiency：分母必须是单题均值，不是整套题总量', () => {
  // 真踩过的坑：用 injected_tokens（13.25k）当分母，1.383 被算成 0.027，比阈值低 52 倍。
  const real = { match_rate: 0.7, injected_tokens: 5200, injected_tokens_mean: 100 };
  const base = { match_rate: 0.4 };
  assert.equal(answerTokenEfficiency(real, base), 3, '(0.7−0.4) ÷ (100/1000)');
  assert.equal(answerTokenEfficiency({ ...real, injected_tokens: 999999 }, base), 3, '总量不许影响结果');
  assert.equal(answerTokenEfficiency({ ...real, match_rate: 0.3 }, base), -1, 'Δ 为负时保留负号');
  assert.equal(answerTokenEfficiency({ ...real, injected_tokens_mean: 0 }, base), null, '均值为 0 没有分母');
  assert.equal(answerTokenEfficiency(real, { match_rate: null }), null);
});

test('跑分器输出契约：--json 走管道也必须是一条完整可解析的 JSON', () => {
  // 这条守着真踩过的坑：进程末尾用 process.exit(code) 会截断还没 flush 的 stdout，
  // `--json | jq` 拿到半截 JSON（195KB 只剩 65KB）。截断在这里会直接 JSON.parse 失败。
  const res = spawnSync(process.execPath, [RUNNER, '--dry', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(res.status, 0, `跑分器退出码非 0：${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.version, 'core-30-v1-eval-v1');
  assert.match(report.mode, /dry/, '干跑模式要自报家门');
  assert.equal(report.thresholds.recallAt5, 0.8);
  assert.ok(report.judgement?.verdict, 'judgement 必须在（判据 1 的结论）');
  const none = report.arms.find((a) => a.arm === 'none');
  assert.ok(none, '空上下文基线臂必须在报告里');
  assert.equal(none.metrics.tasks, SUITE_TASKS, '--dry 也要把题跑齐');
  assert.equal(none.metrics.injected_tokens, 0, '无记忆臂的注入 token 必须是 0');
});

test('taskCapability：显式优先；非法显式不静默套默认；旧 kind 有保守映射', () => {
  assert.deepEqual([...CAPABILITIES], ['single_hop', 'multi_hop', 'temporal', 'knowledge_update', 'abstention', 'negative_transfer']);
  assert.equal(taskCapability({ kind: 'refusal', capability: 'temporal' }), 'temporal', '显式值优先于 kind');
  assert.equal(taskCapability({ kind: 'refusal' }), 'abstention');
  assert.equal(taskCapability({ kind: 'correction' }), 'knowledge_update');
  assert.equal(taskCapability({ kind: 'fact_recall' }), 'single_hop');
  assert.equal(taskCapability({ kind: 'preference' }), 'single_hop');
  assert.equal(taskCapability({ kind: 'procedure' }), 'single_hop');
  assert.equal(taskCapability({ kind: 'mystery' }), 'unknown');
  assert.equal(taskCapability({ kind: 'fact_recall', capability: 'bogus' }), 'unknown', '脏 capability 要浮出来，不能悄悄当 single_hop');
  assert.equal(taskCapability(null), 'unknown');
});

test('taskNegativeTransferProbe / taskExpectAll：半截探针不算，expect_all 只认 true', () => {
  const full = {
    distractor_note: ' reference-x.md ',
    why_wrong: ' 这是另一个环境的配置 ',
    fall_patterns: [' 9443 ', '', 42],
  };
  assert.deepEqual(taskNegativeTransferProbe({ negative_transfer_probe: full }), {
    distractor_note: 'reference-x.md',
    why_wrong: '这是另一个环境的配置',
    fall_patterns: ['9443'],
  });
  assert.equal(taskNegativeTransferProbe({}), null);
  assert.equal(taskNegativeTransferProbe({ negative_transfer_probe: { ...full, why_wrong: ' ' } }), null, '缺 why_wrong 不算探针');
  assert.equal(taskNegativeTransferProbe({ negative_transfer_probe: { ...full, fall_patterns: [] } }), null, '空 fall_patterns 不算探针');
  assert.equal(taskNegativeTransferProbe({ negative_transfer_probe: [] }), null);
  assert.equal(taskExpectAll({ expect_all: true }), true);
  assert.equal(taskExpectAll({ expect_all: 'true' }), false, '字符串 true 不算');
  assert.equal(taskExpectAll({}), false);
});

test('scoreTask：陷阱值出口就算错，哪怕它没写进 forbid；拒答也不许端出陷阱值', () => {
  const trapTask = {
    ...fact('f01'),
    capability: 'negative_transfer',
    forbid: [],
    negative_transfer_probe: {
      distractor_note: 'reference-orchid-staging-port.md',
      why_wrong: '9443 是预发环境端口，不是生产端口',
      fall_patterns: ['9443'],
    },
  };
  const correct = scoreTask(trapTask, { answer: '8443', injected: '8443', hits: [{ id: 'project-orchid-deploy-port' }] });
  assert.equal(correct.trap_fall, false);
  assert.equal(correct.match, true);
  const fell = scoreTask(trapTask, { answer: '8443，也可能是 9443', injected: '8443', hits: [{ id: 'project-orchid-deploy-port' }] });
  assert.equal(fell.trap_fall, true);
  assert.equal(fell.forbid_used, false, 'forbid 里没写这个值');
  assert.equal(fell.match, false, '陷阱值出口不能判对');
  assert.equal(fell.details.trap.fall_patterns[0].hit, true);

  const trapRefusal = {
    ...refusal('r01'),
    negative_transfer_probe: {
      distractor_note: 'reference-x.md',
      why_wrong: '这条值属于别的题目',
      fall_patterns: ['4242'],
    },
  };
  const clean = scoreTask(trapRefusal, { answer: '', refused: true, hits: [] });
  assert.equal(clean.correct_refusal, true);
  const dirty = scoreTask(trapRefusal, { answer: '无法回答，但答案可能是 4242', refused: true, hits: [] });
  assert.equal(dirty.trap_fall, true);
  assert.equal(dirty.correct_refusal, false, '先拒答再端出陷阱值不是干净拒答');
});

test('scoreTask：expect_all 要求整组命中；只答一半不能算对', () => {
  const multi = {
    id: 'm01',
    kind: 'fact_recall',
    capability: 'multi_hop',
    prompt: '两件事分别是什么？',
    expect: ['03:30', '2 GB'],
    expect_all: true,
    forbid: [],
    source: ['a.md', 'b.md'],
  };
  const one = scoreTask(multi, { answer: '03:30', injected: '03:30 和 2 GB', hits: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(one.expect_hit, true, '上下文里两件都在');
  assert.equal(one.expect_used, false, '答案只答了一半');
  assert.equal(one.match, false);
  const both = scoreTask(multi, { answer: '03:30，单次 2 GB', injected: '03:30 和 2 GB', hits: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(both.expect_used, true);
  assert.equal(both.match, true);
  const noContext = scoreTask(multi, { answer: '03:30，单次 2 GB', injected: '', hits: [] });
  assert.equal(noContext.expect_hit, false, '上下文缺一条，expect_hit 也是假');
});

test('scoreRun：by_capability 分组，trap_fall_rate 只拿有探针的题当分母', () => {
  const trapTask = {
    ...fact('f01'),
    capability: 'negative_transfer',
    negative_transfer_probe: {
      distractor_note: 'reference-orchid-staging-port.md',
      why_wrong: '9443 是预发环境端口',
      fall_patterns: ['9443'],
    },
  };
  const plainTask = { ...fact('f02'), expect: ['03:30'], forbid: [], source: ['b.md'], capability: 'single_hop' };
  const runs = (trapAnswer) => [
    { task_id: 'f01', hits: [{ id: 'project-orchid-deploy-port' }], injected: '8443', answer: trapAnswer, tokens: 10 },
    { task_id: 'f02', hits: [{ id: 'b' }], injected: '03:30', answer: '03:30', tokens: 10 },
  ];
  const ok = scoreRun([trapTask, plainTask], runs('8443'));
  assert.equal(ok.by_capability.negative_transfer.tasks, 1);
  assert.equal(ok.by_capability.single_hop.tasks, 1);
  assert.equal(ok.trap_tasks, 1, '只有带探针的题进分母');
  assert.equal(ok.trap_falls, 0);
  assert.equal(ok.trap_fall_rate, 0);
  assert.equal(ok.by_capability.negative_transfer.trap_fall_rate, 0);

  const fell = scoreRun([trapTask, plainTask], runs('9443'));
  assert.equal(fell.trap_falls, 1);
  assert.equal(fell.trap_fall_rate, 1);
  assert.equal(fell.match_rate, 0.5, '陷阱题判错，另一题仍对');
  assert.equal(fell.by_capability.negative_transfer.match_rate, 0);
});

test('纯函数：跑两遍结果一样，且不改入参', () => {
  const tasks = [fact('f01'), refusal('r01')];
  const runs = [
    { task_id: 'f01', hits: [{ id: 'project-orchid-deploy-port' }], injected: '8443', answer: '8443', tokens: 100 },
    { task_id: 'r01', hits: [], answer: '', refused: true, tokens: 0 },
  ];
  const before = JSON.stringify({ tasks, runs });
  const a = scoreRun(tasks, runs, { arm: 'new' });
  const b = scoreRun(tasks, runs, { arm: 'new' });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify({ tasks, runs }), before, '判分器不许改入参');
  assert.deepEqual(round(1.23456), 1.2346);
  assert.equal(round(null), null);
  assert.equal(round(undefined), null);
});
