/**
 * 时间解析。**一个地方定死口径**，别在各模块各写一遍（时区混用是
 * `05-agi-direction.md §5.2` 点名的会咬人的边界之一）。
 *
 * 口径：
 *  - 带时区的 ISO 时间（`2026-10-17T02:56:53+08:00` / `...Z`）→ `Date.parse`；
 *  - 不带时区的 ISO 本地时间（`2026-10-17T02:56:53`）→ 按**本机时区**解析
 *    （`new Date(...)` 的天然行为，Node 与用户直觉一致）；
 *  - 纯日期（`2026-10-17`）→ 见 `parseDateOnlyAsNoon`：**正午**，不是午夜；
 *  - 数字 → 毫秒时间戳（允许秒级：小于 1e12 时按秒算）；
 *  - 其它 → `null`（调用方自己决定是报错还是忽略，绝不猜）。
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  const m = DATE_ONLY.exec(s);
  if (m) return parseDateOnlyAsNoon(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * date-only 解析到**当天正午**。
 *
 * 为什么不是午夜：as-of 查询 `--as-of 2026-10-17` 的语义是「10-17 这一天结束时为真的事实」，
 * 解析到 00:00 会把当天写下的记忆判成「还没发生」——这是 `§3.3` 明令要进评测用例的四条边界之一。
 * 取正午而不是 23:59 是刻意的：正午是个不含糊的点，谁想精确到小时就写完整时间戳。
 */
export function parseDateOnlyAsNoon(value) {
  const m = DATE_ONLY.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const local = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  // **回读校验**：`new Date(2026, 12, 45)` 不报错，它悄悄滚成 2027-02-14。
  // 不回读的话 `valid_from: 2026-13-45` 会被存成一个两个月后的时间戳，
  // 于是「这条笔记什么时候开始为真」变成一个人和机器都算错的数，
  // 而错误只在 as-of 查询里显形——典型的静默损坏。
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null;
  return local.getTime();
}

/** 现在（可注入，`core` 不直接读时钟）。 */
export function nowMs() {
  return Date.now();
}

/** 本地时区的「今天」字符串（`YYYY-MM-DD`）。 */
export function todayLocal(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 本地 ISO（带时区偏移）。写 `valid_from` 用它：旧项目写的是不带时区的本地 ISO，
 * 那在跨时区同步时会变成「同一时刻的两个时间」。带上 `+08:00` 就没有歧义。
 */
export function isoLocal(now = Date.now()) {
  const d = new Date(now);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 天数差（`to - from`，可为负）。 */
export function daysBetween(fromMs, toMs) {
  return (toMs - fromMs) / 86400000;
}
