/**
 * 遗忘衰减（纯函数）：越久没被用过的笔记，排序权重越低，但永远不消失。
 *
 * 只看笔记自己的时间信息（`valid_from` / `created`），不读文件、不写使用记录；
 * 显式标记 `evergreen` 或 `trust: user_stated` 的笔记不衰减——用户亲口定下的
 * 偏好和规则不该因为「三周没用」被压下去。
 */

export const DECAY_DEFAULTS = Object.freeze({
  halfLifeDays: 180,
  floor: 0.6,
});

export function normalizeDecay(value) {
  if (!value || value === true) return null;
  const source = typeof value === 'object' ? value : {};
  const halfLifeDays = Number(source.halfLifeDays ?? source.days ?? DECAY_DEFAULTS.halfLifeDays);
  const floor = Number(source.floor ?? DECAY_DEFAULTS.floor);
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return null;
  return {
    halfLifeDays,
    floor: Number.isFinite(floor) ? Math.min(1, Math.max(0, floor)) : DECAY_DEFAULTS.floor,
  };
}

function isEvergreen(item) {
  if (!item) return true;
  if (item.evergreen === true) return true;
  if (item.trust === 'user_stated') return true;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  return tags.includes('evergreen');
}

export function decayWeight(item, { now = Date.now(), halfLifeDays = DECAY_DEFAULTS.halfLifeDays, floor = DECAY_DEFAULTS.floor } = {}) {
  if (isEvergreen(item)) return 1;
  const raw = item?.valid_from ?? item?.created ?? null;
  const at = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
  if (!Number.isFinite(at)) return 1;
  const ageDays = Math.max(0, (now - at) / (24 * 60 * 60 * 1000));
  const weight = 0.5 ** (ageDays / halfLifeDays);
  return Math.min(1, Math.max(floor, weight));
}

/** 把反馈权重与衰减权重合成一个乘数；两者都缺省时为 1。 */
export function mergeWeights(feedback, decay) {
  const ids = new Set([...(feedback?.keys?.() ?? []), ...(decay?.keys?.() ?? [])]);
  const merged = new Map();
  for (const id of ids) {
    merged.set(id, (feedback?.get(id) ?? 1) * (decay?.get(id) ?? 1));
  }
  return merged;
}
