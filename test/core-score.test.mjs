/**
 * `src/core/score.js`：三因子打分（importance / recency / relevance）。
 *
 * 三件事必须守住，因为它们是架构文档里写死的取舍：
 *  1. relevance **必须饱和**（`s/(s+1.5)`）：BM25 无上界，不饱和等于让「长」赢回来；
 *  2. recency 的参考时间是 `valid_from` 而不是 mtime（一次批量导入会把全库变「刚刚」）；
 *  3. as-of 的三条边界：`valid_to=null` 是「仍然有效」、date-only 取正午、
 *     `valid_from` 缺失视为一直有效（缺字段不是「不存在」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  W_IMPORTANCE,
  W_RECENCY,
  W_RELEVANCE,
  TAU_DAYS,
  RELEVANCE_K,
  KIND_IMPORTANCE,
  TRUST_FACTOR,
  importanceOf,
  saturateRelevance,
  recencyOf,
  scoreNote,
  asOfTime,
  isValidAt,
  isSince,
  lifecycleOf,
  inDefaultSurface,
} from '../src/core/score.js';
import { parseTime } from '../src/util/clock.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = parseTime('2026-10-17T12:00:00+08:00');
const note = (over = {}) => ({
  id: 'a',
  kind: 'semantic',
  trust: 'user_stated',
  confidence: 0.9,
  valid_from: '2026-10-16T12:00:00+08:00',
  valid_to: null,
  ...over,
});

test('权重与常数是架构文档写死的值', () => {
  assert.equal(W_IMPORTANCE, 0.3);
  assert.equal(W_RECENCY, 0.2);
  assert.equal(W_RELEVANCE, 0.5);
  assert.equal(TAU_DAYS, 30);
  assert.equal(RELEVANCE_K, 1.5);
  // 三因子之和为 1：否则 total 会跑到 [0,1] 之外，阈值就不可比了
  assert.equal(W_IMPORTANCE + W_RECENCY + W_RELEVANCE, 1);
});

test('saturateRelevance：值域 [0,1)、单调、无输入即 0', () => {
  assert.equal(saturateRelevance(0), 0);
  assert.equal(saturateRelevance(-5), 0);
  assert.equal(saturateRelevance(null), 0);
  assert.ok(saturateRelevance(1.5) === 0.5, 's/(s+K)：s 等于 K 时正好一半');
  let prev = -1;
  for (const s of [0.1, 1, 10, 100, 10000]) {
    const v = saturateRelevance(s);
    assert.ok(v > prev, '必须单调递增');
    assert.ok(v < 1, `必须永远小于 1，s=${s} 时得到 ${v}`);
    prev = v;
  }
});

test('importance：kind 与 trust 都影响权重，且方向正确', () => {
  assert.ok(KIND_IMPORTANCE.core > KIND_IMPORTANCE.procedural);
  assert.ok(KIND_IMPORTANCE.procedural > KIND_IMPORTANCE.semantic);
  assert.ok(KIND_IMPORTANCE.semantic > KIND_IMPORTANCE.episodic);
  assert.ok(TRUST_FACTOR.user_stated > TRUST_FACTOR.system_derived);
  assert.ok(TRUST_FACTOR.system_derived > TRUST_FACTOR.external);
  const core = importanceOf(note({ kind: 'core' }));
  const epi = importanceOf(note({ kind: 'episodic' }));
  assert.ok(core > epi);
  const stated = importanceOf(note({ trust: 'user_stated' }));
  const external = importanceOf(note({ trust: 'external' }));
  assert.ok(stated > external);
});

test('importance：confidence 缺失取 0.7 而不是 0（缺字段不是「不可信」）', () => {
  const missing = importanceOf(note({ confidence: undefined }));
  const zero = importanceOf(note({ confidence: 0 }));
  const one = importanceOf(note({ confidence: 1 }));
  assert.ok(missing > zero);
  assert.ok(missing < one);
});

test('importance：confidence 越界被夹住（1.5 不能刷出超过上限的分）', () => {
  assert.equal(importanceOf(note({ confidence: 1.5 })), importanceOf(note({ confidence: 1 })));
  assert.equal(importanceOf(note({ confidence: -1 })), importanceOf(note({ confidence: 0 })));
});

test('recency：τ=30 天时，30 天前 = e^-1，1 天前 ≈ 0.967', () => {
  const fresh = recencyOf(note({ valid_from: new Date(NOW - DAY).toISOString() }), NOW);
  const month = recencyOf(note({ valid_from: new Date(NOW - 30 * DAY).toISOString() }), NOW);
  const quarter = recencyOf(note({ valid_from: new Date(NOW - 90 * DAY).toISOString() }), NOW);
  assert.ok(Math.abs(fresh - Math.exp(-1 / 30)) < 1e-9);
  assert.ok(Math.abs(month - Math.exp(-1)) < 1e-9);
  assert.ok(month > quarter, '越老越低');
  assert.ok(quarter > 0, '永远大于 0（老不等于 0，只是不值钱）');
});

test('recency：用 valid_from 而不是 mtime —— 批量导入不该把所有笔记变成「刚刚」', () => {
  const old = note({ valid_from: '2020-01-01T12:00:00+08:00', mtime: NOW });
  const r = recencyOf(old, NOW);
  assert.ok(r < 0.01, `valid_from 是 2020 年，recency 该接近 0，实际 ${r}`);
  // 对照组：没有 valid_from 才退回 mtime
  const noFrom = note({ valid_from: undefined, mtime: new Date(NOW - DAY).toISOString() });
  assert.ok(recencyOf(noFrom, NOW) > 0.9);
});

test('recency：完全没有时间信息给 0.5（不假装它很新，也不判它死）', () => {
  assert.equal(recencyOf(note({ valid_from: undefined, mtime: undefined }), NOW), 0.5);
});

test('recency：未来时间不产生 >1 的值（时钟漂移不能刷分）', () => {
  const future = note({ valid_from: new Date(NOW + 5 * DAY).toISOString() });
  assert.equal(recencyOf(future, NOW), 1);
});

test('scoreNote：三因子加权和，且 why 是人话', () => {
  const n = note({ kind: 'core' });
  const s = scoreNote({ note: n, bm25: 3, nowMs: NOW });
  const expected = W_IMPORTANCE * s.importance + W_RECENCY * s.recency + W_RELEVANCE * s.relevance;
  assert.ok(Math.abs(s.total - expected) < 1e-6);
  assert.ok(s.total > 0 && s.total <= 1, `total 必须在 (0,1]，实际 ${s.total}`);
  assert.equal(s.bm25, 3);
  assert.match(s.why, /core/);
  // 未命中时 why 必须解释得清「它为什么在结果里」
  const miss = scoreNote({ note: note(), bm25: 0, nowMs: NOW });
  assert.equal(miss.relevance, 0);
  assert.match(miss.why, /未被词法命中/);
});

test('scoreNote：相关性是「够不够格」，不是「排第几」—— 同分同因子时 total 只由 kind/trust 决定', () => {
  const a = scoreNote({ note: note({ kind: 'core' }), bm25: 5, nowMs: NOW });
  const b = scoreNote({ note: note({ kind: 'episodic' }), bm25: 5, nowMs: NOW });
  assert.ok(a.total > b.total, '同样的检索分，core 必须排在 episodic 之前');
});

test('asOfTime：date-only 取当天正午（写当天的人不能被判成「还没发生」）', () => {
  const t = asOfTime('2026-10-17');
  assert.equal(new Date(t).getHours(), 12);
  assert.equal(asOfTime('2026-10-17T00:00:00+08:00'), parseTime('2026-10-17T00:00:00+08:00'));
  assert.equal(asOfTime(null), null);
  assert.equal(asOfTime('胡言乱语'), null);
});

test('isValidAt：valid_from <= at < valid_to，三条边界都钉住', () => {
  const n = note({ valid_from: '2026-10-01T00:00:00+08:00', valid_to: '2026-10-10T00:00:00+08:00' });
  assert.equal(isValidAt(n, parseTime('2026-10-05T00:00:00+08:00')), true);
  assert.equal(isValidAt(n, parseTime('2026-10-01T00:00:00+08:00')), true, '左闭');
  assert.equal(isValidAt(n, parseTime('2026-10-10T00:00:00+08:00')), false, '右开');
  assert.equal(isValidAt(n, parseTime('2026-09-30T00:00:00+08:00')), false);
});

test('isValidAt：valid_to=null 是「仍然有效」，不是「未知」', () => {
  assert.equal(isValidAt(note({ valid_to: null }), parseTime('2099-01-01')), true);
  assert.equal(isValidAt(note({ valid_to: undefined }), parseTime('2099-01-01')), true);
});

test('isValidAt：valid_from 缺失视为一直有效（缺字段 ≠ 不存在）', () => {
  assert.equal(isValidAt(note({ valid_from: undefined }), NOW), true);
  assert.equal(isValidAt(note({ valid_from: '不是时间' }), NOW), true);
});

test('isValidAt：没给 as-of 就是不过滤（返回 true）', () => {
  // 这是刻意的 fail-open：as-of 为空表示「不按时间过滤」，不是「所有东西都过期」。
  // 反过来的错法（空 as-of → 全部 false）症状是「查询突然一条都不返回」，
  // 而那种 bug 会被误诊成「库空了」。
  assert.equal(isValidAt(note(), null), true);
  assert.equal(isValidAt(note(), undefined), true);
});

test('isSince：按 valid_from 截断，没有 valid_from 的用 mtime', () => {
  const since = parseTime('2026-10-15T00:00:00+08:00');
  assert.equal(isSince(note({ valid_from: '2026-10-16T00:00:00+08:00' }), since), true);
  assert.equal(isSince(note({ valid_from: '2026-10-14T00:00:00+08:00' }), since), false);
  assert.equal(isSince(note({ valid_from: undefined, mtime: '2026-10-16T00:00:00+08:00' }), since), true);
  // 没有时间信息 → 不过滤掉（fail-open）。`since` 是增量同步用的**优化**，
  // 漏掉一条真实记忆的代价远大于多同步一条：所以拿不准就带上。
  assert.equal(isSince(note({ valid_from: undefined, mtime: undefined }), since), true);
  assert.equal(isSince(note(), null), true, '没给 since 就是不过滤');
});

test('lifecycleOf：显式 status 优先，其次按有效性与时间推', () => {
  assert.equal(lifecycleOf(note({ status: 'archived' }), NOW), 'archived');
  assert.equal(lifecycleOf(note({ status: 'draft' }), NOW), 'draft');
  assert.equal(lifecycleOf(note({ status: 'superseded' }), NOW), 'superseded');
  // valid_to 已过 → superseded（不是 stale！）
  assert.equal(lifecycleOf(note({ valid_to: '2026-10-01T00:00:00+08:00' }), NOW), 'superseded');
  // superseded_by 显式写了 → superseded
  assert.equal(lifecycleOf(note({ superseded_by: '01ZZZ' }), NOW), 'superseded');
  // 正常 → active。注意「未来才生效」这里也是 active：draft 只认显式 status，
  // 因为「还没生效」的最常见原因是**时钟漂移或提前写入**，把这种笔记判成草稿
  // 会让它在我们最需要它之前一直不可见——stale/superseded 的判定同理，
  // 需要跨轮次证据的东西一律不在这里猜（见函数注释）。
  assert.equal(lifecycleOf(note({ valid_from: '2026-10-16T12:00:00+08:00' }), NOW), 'active');
  assert.equal(lifecycleOf(note({ valid_from: '2027-01-01T00:00:00+08:00' }), NOW), 'active');
});

test('inDefaultSurface：草稿与归档不进默认检索面（但文件还在，只是不主动喂）', () => {
  assert.equal(inDefaultSurface(note(), NOW), true);
  assert.equal(inDefaultSurface(note({ status: 'draft' }), NOW), false);
  assert.equal(inDefaultSurface(note({ status: 'archived' }), NOW), false);
  // superseded 仍然进面（它可能正是要回答「以前是怎么做的」的那条）
  assert.equal(inDefaultSurface(note({ valid_to: '2026-10-01T00:00:00+08:00' }), NOW), true);
});
