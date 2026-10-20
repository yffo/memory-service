/**
 * 评测门控调参的最小实现。
 *
 * 只做两件事：
 *   1. `gridPoints` 把「阈值网格」拍平成候选点；
 *   2. `chooseCandidate` 用 Pareto 约束挑一个**不退化**的候选——
 *      命中数不能少、误注入不能多，且至少一项严格更好。
 *
 * 为什么不做自动写入：参数改动会影响所有召回。这个模块只产出建议，落盘与否由人批准，
 * 回滚就是把旧值写回去（默认值仍在 `core/recall.js` 的 DEFAULT_THRESHOLDS 里）。
 */

export const DEFAULT_GRID = {
  minRelevance: [0.08, 0.1, 0.12, 0.15],
  minScore: [0.08, 0.1, 0.15, 0.18],
  minCoverage: [0, 0.25, 0.33, 0.4, 0.5],
};

const normalizeGrid = (grid) => {
  const out = [];
  for (const [key, values] of Object.entries(grid ?? {})) {
    const usable = (value) =>
      value !== null && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
    const clean = [...new Set((Array.isArray(values) ? values : []).filter(usable))]
      .map(Number)
      .sort((left, right) => left - right);
    if (clean.length) out.push([key, clean]);
  }
  return out;
};

/** 笛卡尔积：每个键取一个值，返回 `[{minRelevance:…, minScore:…, minCoverage:…}, …]`。 */
export function gridPoints(grid = DEFAULT_GRID) {
  const axes = normalizeGrid(grid);
  if (axes.length === 0) return [{}];
  let points = [{}];
  for (const [key, values] of axes) {
    const next = [];
    for (const point of points) for (const value of values) next.push({ ...point, [key]: value });
    points = next;
  }
  return points;
}

/**
 * 候选必须同时满足：
 *   - `hit` 不低于基线（宁可不少命中）；
 *   - `falseInjects` 不高于基线（不引入新的误注入）；
 *   - 至少一项严格更好（否则没有换的理由）。
 * 在合格候选里按「命中最多 → 误注入最少 → 阈值更保守」排序取第一个。
 */
export function chooseCandidate(baseline, evaluated = []) {
  const base = baseline ?? { hit: 0, falseInjects: 0 };
  const eligible = evaluated.filter((item) => {
    const hit = Number(item?.hit) || 0;
    const falseInjects = Number(item?.falseInjects) || 0;
    return (
      hit >= base.hit &&
      falseInjects <= base.falseInjects &&
      (hit > base.hit || falseInjects < base.falseInjects)
    );
  });
  if (eligible.length === 0) return null;
  eligible.sort((left, right) => {
    const hitDiff = (Number(right.hit) || 0) - (Number(left.hit) || 0);
    if (hitDiff !== 0) return hitDiff;
    const falseDiff = (Number(left.falseInjects) || 0) - (Number(right.falseInjects) || 0);
    if (falseDiff !== 0) return falseDiff;
    return (Number(right.point?.minCoverage) || 0) - (Number(left.point?.minCoverage) || 0);
  });
  return eligible[0];
}

/** 只读评分：正例看 gold 是否进 top-k，拒答题看有没有被注入内容。 */
export function scoreRun({ tasks = [], runs = [], k = 5 } = {}) {
  const byId = new Map(runs.map((run) => [run.task_id, run]));
  let positives = 0;
  let hit = 0;
  let refusals = 0;
  let falseInjects = 0;
  for (const task of tasks) {
    const run = byId.get(task.id);
    if (!run) continue;
    const ids = new Set((run.hits ?? []).slice(0, k).map((item) => String(item?.id ?? item)));
    if (Array.isArray(task.source) && task.source.length > 0) {
      positives += 1;
      const sources = task.source.map((file) => String(file).replace(/\.md$/, ''));
      if (sources.some((id) => ids.has(id))) hit += 1;
    } else {
      refusals += 1;
      if (Array.isArray(run.hits) && run.hits.length > 0) falseInjects += 1;
    }
  }
  return { hit, positives, refusals, falseInjects };
}
