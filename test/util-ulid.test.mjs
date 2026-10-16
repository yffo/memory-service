/**
 * `src/util/ulid.js` + `src/store/ids.js`（转发层）。
 *
 * 三条性质是真正在用的，所以三条都测：时间有序、同毫秒单调、可注入。
 * 另外测转发层与实现层**是同一个东西**（防的正是「两份实现各自腐烂」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUlidFactory, ulid, isUlid, ulidTime, ULID_ALPHABET } from '../src/util/ulid.js';
import { ulid as ulidViaStore, isUlid as isUlidViaStore, resetUlidState } from '../src/store/ids.js';

test('ULID：26 位、Crockford 字母表、形状校验', () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(isUlid(id));
  // Crockford 去掉 I/L/O/U：出现任何一个都说明字母表写错了
  assert.doesNotMatch(id, /[ILOU]/);
  assert.equal(ULID_ALPHABET.length, 32);
});

test('ULID：前 10 位是毫秒时间戳，能还原', () => {
  const ms = 1_700_000_000_000;
  const id = createUlidFactory()(ms);
  assert.equal(ulidTime(id), ms);
  // 时间有序：同一个生成器，时间大的 id 字符串更大
  const later = createUlidFactory()(ms + 1000);
  assert.ok(later > id);
});

test('ULID：同一毫秒内单调递增（不重复、不等待时钟）', () => {
  const gen = createUlidFactory();
  const ms = 1_700_000_000_000;
  const a = gen(ms);
  const b = gen(ms);
  const c = gen(ms);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.ok(b > a, `${b} 应该大于 ${a}`);
  assert.ok(c > b, `${c} 应该大于 ${b}`);
  assert.equal(ulidTime(a), ms);
  assert.equal(ulidTime(c), ms);
});

test('ULID：可注入随机源（测试要确定性）', () => {
  const fixed = () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const gen = createUlidFactory({ rand: fixed });
  const a = gen(1_700_000_000_000);
  const gen2 = createUlidFactory({ rand: fixed });
  const b = gen2(1_700_000_000_000);
  assert.equal(a, b, '同样的注入随机源应该给出同样的 id');
});

test('ULID：非法输入不抛异常，只是判否', () => {
  assert.equal(isUlid('太短'), false);
  assert.equal(isUlid(''), false);
  assert.equal(isUlid(null), false);
  assert.equal(isUlid(undefined), false);
  assert.equal(isUlid(12345678901234567890123456), false);
  assert.equal(isUlid('I'.repeat(26)), false, 'I 不在 Crockford 字母表里');
  assert.equal(ulidTime('不是 ulid'), null);
});

test('ULID：store/ids.js 与 util/ulid.js 是同一台生成器（不是两份实现）', () => {
  resetUlidState();
  const ms = 1_700_000_000_000;
  const a = ulidViaStore(ms);
  const b = ulid(ms);
  // 同一个模块级生成器连续两次调用，所以是相邻的两个 id 而不是相等
  assert.equal(a.slice(0, 10), b.slice(0, 10));
  assert.ok(b > a);
  assert.ok(isUlidViaStore(a));
  assert.equal(ulidTime(a), ms);
});

test('ULID：resetUlidState() 之后同毫秒不再单调（测试隔离的代价与效果）', () => {
  const ms = 1_700_000_000_000;
  const before = ulidViaStore(ms);
  resetUlidState();
  const after = ulidViaStore(ms);
  // reset 只清单调计数，不清时间；两个 id 都合法、时间都对
  assert.ok(isUlid(after));
  assert.equal(ulidTime(after), ms);
  assert.equal(before.length, after.length);
});
