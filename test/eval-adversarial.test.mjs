import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_WRONG_ACCEPT_RATE,
  judgeCases,
  loadAdversarial,
} from '../bench/judge-adversarial.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'bench', 'judge-adversarial.mjs');
const TASKS = path.join(HERE, '..', 'bench', 'core-30-v1', 'tasks.json');
const SUITE = path.join(HERE, '..', 'bench', 'core-30-v1', 'adversarial.json');

const factTask = {
  id: 't1',
  kind: 'fact_recall',
  prompt: '生产环境监听哪个端口？',
  expect: ['8443'],
  forbid: [],
  source: ['project-orchid-deploy-port.md'],
  answer_aliases: [],
};
const refusalTask = {
  id: 't2',
  kind: 'refusal',
  prompt: '上线时间定了吗？',
  expect: [],
  forbid: ['9.99'],
  source: [],
  answer_aliases: [],
};

const syntheticCases = [
  { id: 'c1', task_id: 't1', label: 'correct', answer: '生产环境监听 8443。', accept: true },
  { id: 'c2', task_id: 't1', label: 'ambiguous_wrong', answer: '这个我不知道。', accept: false },
  { id: 'c3', task_id: 't2', label: 'correct_refusal', answer: '资料里没有提到上线时间。', accept: true },
  { id: 'c4', task_id: 't2', label: 'hallucinated', answer: '9.99 美元，下周上线。', accept: false },
];

test('loadAdversarial：真实题集与对抗集能对上（56 题 / 106 条）', () => {
  const { tasks, cases } = loadAdversarial({ tasksPath: TASKS, suitePath: SUITE });
  assert.equal(tasks.length, 56);
  assert.equal(cases.length, 106);
  const ids = new Set(tasks.map((task) => task.id));
  for (const testCase of cases) assert.ok(ids.has(testCase.task_id), `${testCase.id} 指向未知题`);
});

test('judgeCases：该收的收、该拒的拒，误收/误拒分开计', () => {
  const report = judgeCases([factTask, refusalTask], syntheticCases);
  assert.equal(report.cases, 4);
  assert.equal(report.correct_total, 2);
  assert.equal(report.correct_accepted, 2);
  assert.equal(report.correct_accept_rate, 1);
  assert.equal(report.wrong_total, 2);
  assert.equal(report.wrong_accepted, 0);
  assert.equal(report.wrong_accept_rate, 0);
  assert.deepEqual(report.false_rejects, []);
  assert.deepEqual(report.missed_wrong, []);
  assert.equal(report.gate.pass, true);
  assert.equal(report.by_label.correct_refusal.accepted, 1);
});

test('judgeCases：误收一条就会失败，失败用例能定位到 task', () => {
  const leaky = [factTask, refusalTask];
  const badCases = [
    { id: 'c1', task_id: 't1', label: 'correct', answer: '8443。', accept: true },
    { id: 'c2', task_id: 't1', label: 'ambiguous_wrong', answer: '8443 或 9443 吧。', accept: false },
  ];
  const report = judgeCases(leaky, badCases);
  assert.equal(report.wrong_accept_rate, 1);
  assert.deepEqual(report.missed_wrong, ['c2']);
  assert.equal(report.gate.pass, false);
  assert.ok(MAX_WRONG_ACCEPT_RATE > 0 && MAX_WRONG_ACCEPT_RATE < 1);
});

test('judgeCases：正确改述被拒也算失败，不能只看误收', () => {
  const report = judgeCases([factTask], [
    { id: 'c1', task_id: 't1', label: 'correct', answer: '我不知道。', accept: true },
  ]);
  assert.equal(report.wrong_accept_rate, null, '没有应拒绝用例时误收率算不出来，不能当 0');
  assert.equal(report.correct_accept_rate, 0);
  assert.deepEqual(report.false_rejects, ['c1']);
  assert.equal(report.gate.pass, false);
});

test('judgeCases：未知 task_id / 非字符串 answer 直接报错，不悄悄跳过', () => {
  assert.throws(
    () => judgeCases([factTask], [{ id: 'x', task_id: 'nope', label: 'correct', answer: '8443', accept: true }]),
    /不存在的题目/,
  );
  assert.throws(
    () => judgeCases([factTask], [{ id: 'x', task_id: 't1', label: 'correct', answer: 8443, accept: true }]),
    /缺少字符串 answer/,
  );
  assert.throws(
    () => judgeCases([factTask], [{ id: 'x', task_id: 't1', label: 'correct', answer: '8443' }]),
    /缺少布尔 accept/,
  );
});

test('真实 106 条对抗集：误收率 0，gate 通过', () => {
  const { tasks, cases } = loadAdversarial({ tasksPath: TASKS, suitePath: SUITE });
  const report = judgeCases(tasks, cases);
  assert.equal(report.wrong_accept_rate, 0);
  assert.ok(report.correct_accept_rate >= 0.95);
  assert.equal(report.gate.pass, true);
  assert.deepEqual(report.false_rejects, []);
  assert.deepEqual(report.missed_wrong, []);
});

test('CLI：真实跑退出 0 且 --json 可解析，参数/文件错误退出 2', () => {
  const ok = spawnSync(process.execPath, [RUNNER, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.cases, 106);
  assert.equal(report.gate.pass, true);

  const help = spawnSync(process.execPath, [RUNNER, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /judge-adversarial/);

  const badArg = spawnSync(process.execPath, [RUNNER, '--nope'], { encoding: 'utf8' });
  assert.equal(badArg.status, 2);

  const badFile = spawnSync(process.execPath, [RUNNER, '--suite', '/nonexistent-adversarial.json'], { encoding: 'utf8' });
  assert.equal(badFile.status, 2);
  assert.match(badFile.stderr, /judge-adversarial/);
});
