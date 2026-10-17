/**
 * `src/util/clock.js`：时间解析（**四个已知陷阱里的三个在这里**）。
 *
 * `02-evaluation.md §5` 点名的四个坑：
 *  ① tag 过滤被静默忽略 ② **纯日期 as-of 解析成午夜** ③ 删除后重建产生重复
 *  ④ **时区混用**。
 * 这个文件负责 ② 与 ④，所以每条都写成用例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, parseDateOnlyAsNoon, isoLocal, daysBetween, todayLocal } from '../src/util/clock.js';

test('parseTime：ISO 带时区按绝对时刻解析', () => {
  const a = parseTime('2026-10-17T03:25:24+08:00');
  const b = parseTime('2026-10-16T19:25:24Z');
  assert.equal(a, b, '同一时刻的两种写法必须得到同一个毫秒数');
  assert.equal(a, Date.UTC(2026, 9, 16, 19, 25, 24));
});

test('parseTime：不带时区的 ISO 当**本地时间**（不是 UTC）', (t) => {
  // 在 UTC 机器上「本地」就是「UTC」，这条性质无从检验（两者本来就该相等）。
  // 跳而不是硬断言：用例要的是「非零偏移时两者被当成不同时刻」，零点机器上它没有实验条件。
  if (new Date().getTimezoneOffset() === 0) {
    t.skip('本机时区偏移为 0（UTC），无法区分本地时间与 UTC');
    return;
  }
  const local = parseTime('2026-10-17T10:00:00');
  const utc = parseTime('2026-10-17T10:00:00Z');
  // 本机在 +08:00 时两者差 8 小时；断言的是「两者被当成不同时刻」这件事本身，
  // 而不是具体偏移（否则这个用例换台机器就红）。
  assert.notEqual(local, utc);
  assert.equal(new Date(local).getHours(), 10);
});

test('parseTime：纯日期解析成**当天中午**，不是午夜', () => {
  const t = parseTime('2026-10-17');
  assert.ok(t !== null);
  const d = new Date(t);
  assert.equal(d.getHours(), 12, '午夜解析会让「10-17 当天写入的笔记」被 as-of 10-17 判成过期');
  assert.equal(d.getDate(), 17);
  assert.equal(parseDateOnlyAsNoon('2026-10-17'), t);
});

test('parseTime：as-of 用纯日期查当天时，当天写入的笔记**算数**（午夜陷阱的回归用例）', () => {
  const written = parseTime('2026-10-17T09:00:00+08:00');
  const asOf = parseTime('2026-10-17');
  assert.ok(asOf > written, `as-of ${new Date(asOf).toISOString()} 应该晚于写入时刻 ${new Date(written).toISOString()}`);
  const asOfMidnight = Date.parse('2026-10-17T00:00:00+08:00');
  assert.ok(asOfMidnight < written, '对照组：真按午夜解析的话就会判成「写入时刻还没到」');
});

test('parseTime：认不出来就返回 null（不抛、不猜成 now）', () => {
  for (const bad of ['', '   ', '昨天', 'not-a-date', null, undefined, {}, [], '2026-13-45']) {
    assert.equal(parseTime(bad), null, `${JSON.stringify(bad)} 应该解析成 null`);
  }
});

test('parseTime：秒/毫秒时间戳两种都收', () => {
  const ms = 1_700_000_000_000;
  assert.equal(parseTime(ms), ms);
  assert.equal(parseTime(Math.floor(ms / 1000)), ms, '秒级时间戳应该被当成秒（10 位数字）');
});

test('isoLocal：输出带本机偏移，能被自己 parse 回去（round-trip 不掉精度）', () => {
  const ms = 1_700_000_000_000;
  const text = isoLocal(ms);
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(parseTime(text), ms);
});

test('daysBetween：按绝对毫秒算，跨时区不会算错一天', () => {
  const a = parseTime('2026-10-17T23:00:00+08:00');
  const b = parseTime('2026-10-18T01:00:00+08:00');
  assert.equal(daysBetween(a, b), 2 / 24, '相隔 2 小时就是 2/24 天，与「日期差」无关');
  assert.equal(daysBetween(a, a), 0);
  assert.ok(daysBetween(b, a) < 0, '反向是负数');
});

test('todayLocal：给出本机当天（时区混用的对照）', () => {
  const t = parseTime('2026-10-17T03:00:00+08:00');
  const text = todayLocal(t);
  assert.match(text, /^\d{4}-\d{2}-\d{2}$/);
  // 本机在 +08:00 时是 10-17；在 UTC 时是 10-16。断言的是「用的是本地日期」。
  const localDate = new Date(t).toLocaleDateString('sv-SE');
  assert.equal(text, localDate);
});
