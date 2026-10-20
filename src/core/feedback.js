/**
 * 反馈与纠正的**纯函数**部分：把宿主记下的「有用 / 不对 / 过时 / 被纠正」
 * 聚合成每条笔记的排序权重。
 *
 * 纪律（沿用 `recall.js` 的确定性承诺）：
 *  - 反馈**只影响顺序**，从不删除、不注入、不越过召回闸。一条笔记可以因为
 *    多次「不对」沉到后面，但不会因为反馈被塞进结果里。
 *  - 正信号权重小（+3%/次，最多 3 次），负信号权重大（−12%/次，最多 4 次）。
 *    「一次纠错顶四次有用」是有意的：错误记忆的代价远高于漏掉一条。
 *  - 窗口外的反馈不算数，避免一条三年前的差评永久压住笔记。
 */

/** 与宿主约定的事件名。`corrected` 来自「上一轮注入的笔记被下一句话纠正」。 */
export const FEEDBACK_SIGNALS = Object.freeze(['useful', 'wrong', 'stale', 'corrected']);

export const FEEDBACK_DEFAULTS = Object.freeze({
  windowDays: 90,
  usefulStep: 0.03,
  usefulCap: 3,
  badStep: 0.12,
  badCap: 4,
  correctedStep: 0.08,
  correctedCap: 3,
});

/**
 * @param {Array<{id?:string,noteIds?:string[],signal?:string,at?:number}>} rows
 * @param {{days?:number, now?:number}} [options]
 * @returns {Map<string, {useful:number, wrong:number, stale:number, corrected:number}>}
 */
export function aggregateFeedback(rows = [], { days = FEEDBACK_DEFAULTS.windowDays, now = Date.now() } = {}) {
  const since = now - Math.max(0, days) * 24 * 60 * 60 * 1000;
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !FEEDBACK_SIGNALS.includes(row.signal)) continue;
    const at = Number(row.at);
    if (Number.isFinite(at) && at < since) continue;
    const ids = Array.isArray(row.noteIds) && row.noteIds.length ? row.noteIds : row.id ? [row.id] : [];
    for (const raw of ids) {
      const id = String(raw ?? '').trim();
      if (!id) continue;
      const slot = map.get(id) ?? { useful: 0, wrong: 0, stale: 0, corrected: 0 };
      slot[row.signal] += 1;
      map.set(id, slot);
    }
  }
  return map;
}

/** 1.0 = 不动；正负权重都设上限，反馈永远只是排序微调。 */
export function feedbackWeight(slot) {
  if (!slot) return 1;
  const useful = Math.min(slot.useful ?? 0, FEEDBACK_DEFAULTS.usefulCap);
  const bad = Math.min((slot.wrong ?? 0) + (slot.stale ?? 0), FEEDBACK_DEFAULTS.badCap);
  const corrected = Math.min(slot.corrected ?? 0, FEEDBACK_DEFAULTS.correctedCap);
  return 1
    + FEEDBACK_DEFAULTS.usefulStep * useful
    - FEEDBACK_DEFAULTS.badStep * bad
    - FEEDBACK_DEFAULTS.correctedStep * corrected;
}

/** 按 id 取权重，构造排序用的 Map。未被反馈过的笔记不出现在 Map 里（默认 1）。 */
export function feedbackWeights(rows, options = {}) {
  const aggregates = aggregateFeedback(rows, options);
  const weights = new Map();
  for (const [id, slot] of aggregates) {
    const weight = feedbackWeight(slot);
    if (Math.abs(weight - 1) > 1e-9) weights.set(id, weight);
  }
  return { aggregates, weights };
}

/** 稳定排序：按 finalScore 降序，分数相同保持原相对顺序。 */
export function rankItemsByScore(items, scoreOf) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ item, index, score: scoreOf(item) }))
    .sort((a, b) => {
      const delta = (b.score ?? 0) - (a.score ?? 0);
      if (Math.abs(delta) > 1e-9) return delta;
      return a.index - b.index;
    })
    .map((row) => row.item);
}
