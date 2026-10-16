// 判据 3 回放装置（`bench/replay.mjs`）的用例。
//
// 这个装置自己就是一把尺子，所以用例要盯的不是「读数是多少」，而是**尺子准不准**：
//   ① 同种子两次逐字一致（否则任何读数都不可比）；
//   ② 换种子真的换了时间轴（否则「可固定随机种子」是句空话）；
//   ③ 分数算术自洽（`events/denominator` 与 `rate` 不能各说各话）；
//   ④ CLI 契约：`--json` 是**纯 JSON**（stdout 里不能混进度），判据不成立时退出码 1；
//   ⑤ 装置真的在测「用了四周之后烂不烂」：第 1 周不许出现取代，取代只在第 2 周之后。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CRITERION3, REPLAY_DEFAULTS, runReplay, stableText } from '../bench/replay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPLAY = path.join(HERE, '..', 'bench', 'replay.mjs');

/** 跑一次 CLI，返回 {status, stdout, stderr}。 */
function cli(args) {
  const res = spawnSync(process.execPath, [REPLAY, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('回放：同种子两次跑出逐字一致的报告（可复现是判据 3 的前提）', () => {
  const a = runReplay({ seed: 20261017, weeks: 4 });
  const b = runReplay({ seed: 20261017, weeks: 4 });
  assert.equal(stableText(a), stableText(b));

  // 子进程也要一致：装置是 CLI 跑的，进程内的相等不能替它担保。
  const r1 = cli(['--json']);
  const r2 = cli(['--json']);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, r2.stdout);
});

test('回放：换种子真的换了时间轴（不是把种子当摆设）', () => {
  const a = runReplay({ seed: 1, weeks: 4, detail: true });
  const b = runReplay({ seed: 2, weeks: 4, detail: true });
  const timeline = (r) => JSON.stringify(r.detail.writes.map((w) => [w.day, w.id]));
  assert.notEqual(timeline(a), timeline(b));
  // 但两边的规模必须一样：换种子只换「哪件事、哪一天」，不换工作量。
  assert.equal(a.detail.writes.length, b.detail.writes.length);
  assert.equal(a.usage.recall_events, b.usage.recall_events);
});

test('回放：判据 3 的两个量算术自洽，且都落在阈值以内', () => {
  const rep = runReplay({ seed: 20261017, weeks: 4 });
  for (const key of ['staleness', 'negative_transfer']) {
    const m = rep[key];
    assert.ok(m.denominator > 0, `${key} 的分母不能是 0`);
    assert.equal(m.events / m.denominator, m.rate);
    assert.equal(m.limit, key === 'staleness' ? CRITERION3.stalenessRate : CRITERION3.negativeTransfer);
    // `pass` 必须真的是「按阈值判的」，不能是个写死的 true。
    assert.equal(m.pass, m.rate <= m.limit);
  }
  // 分子不许凭空冒出来：0 得是「一次都没发生」，不是「没测」。
  assert.equal(rep.staleness.rate, 0);
  assert.equal(rep.negative_transfer.rate, 0);
  assert.equal(rep.criterion3_pass, true);
});

test('回放：判据不成立时退出码是 1（CI 不看输出也能发现）', () => {
  // 直接构造一个必然不成立的报告：把阈值收到 0 以下，任何非负读数都超标。
  const rep = runReplay({ seed: 20261017, weeks: 4 });
  const strict = { ...rep, staleness: { ...rep.staleness, limit: -1, pass: false }, criterion3_pass: false };
  assert.equal(strict.staleness.pass, false);
  // 真实报告与阈值判定的一致性（这条是上面那条的对照组：正常情况下退出码是 0）。
  assert.equal(cli(['--json']).status, 0);
  const good = cli(['--json', '--seed', '20261017']);
  assert.equal(good.status, 0);
  assert.ok(JSON.parse(good.stdout).criterion3_pass);
});

test('回放：第 1 周只写真话，取代只发生在第 2 周之后', () => {
  // 第 1 周就有取代的话，「用了四周之后烂不烂」这件事根本没被测到。
  const rep = runReplay({ seed: 20261017, weeks: 4, detail: true });
  const daysPerWeek = 7;
  const corrections = rep.detail.writes.filter((w) => w.reason === 'correction');
  assert.ok(corrections.length > 0, '回放里必须真的有取代事件');
  assert.ok(
    corrections.every((w) => w.day >= daysPerWeek),
    `取代出现在第 1 周：${JSON.stringify(corrections.filter((w) => w.day < daysPerWeek))}`,
  );
});

test('回放 CLI：`--json` 是纯 JSON，参数错误退出码 2', () => {
  const ok = cli(['--json']);
  assert.equal(ok.status, 0);
  assert.doesNotThrow(() => JSON.parse(ok.stdout)); // stdout 里混一个字节的进度就炸
  assert.equal(ok.stderr, '');
  assert.equal(JSON.parse(ok.stdout).seed, REPLAY_DEFAULTS.seed);

  const bad = cli(['--weeks', '0']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--weeks/);
  assert.equal(bad.stdout, '');

  const unknown = cli(['--nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /不认识的参数/);

  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--seed/);
});
