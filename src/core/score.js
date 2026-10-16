/**
 * 三因子打分 + 生命周期时间判定。全部确定性、零模型成本。
 *
 * ```
 * score = w1*importance + w2*recency + w3*relevance
 * recency = exp(-Δdays / τ)          # τ 默认 30 天
 * ```
 * 形状照抄 Generative Agents（`05-agi-direction.md §4.3`）。三因子的**口径**是我们自己定的，
 * 下面每条都写清「为什么是这个形状」。
 *
 * 一个关键分工，容易搞错：
 *  - **relevance**（BM25 饱和度）决定「这条能不能进候选、够不够格回答」；
 *  - **total**（三因子加权）只决定「在预算里谁先谁后、谁先被裁掉」。
 *
 * 为什么不让 importance/recency 参与「够不够格」：身份类记忆（core）天然与查询词不重叠，
 * 若让它靠 importance 顶进答案，就会出现「问了 A 答了 B 的偏好」——拒答路径是
 * 一等公民（`06-architecture.md §5.3`），不能靠权重把它绕过去。
 */
import { parseTime, parseDateOnlyAsNoon } from '../util/clock.js';

/** 三因子权重：相关性为主，重要性和新近度为辅。 */
export const W_IMPORTANCE = 0.3;
export const W_RECENCY = 0.2;
export const W_RELEVANCE = 0.5;
/** recency 的时间常数（天）：`05-agi-direction.md §4.3` 与旧项目 freshness 半衰期同量级。 */
export const TAU_DAYS = 30;
/** BM25 饱和常数：relevance = s/(s+K)，K 取 BM25 单条记录的典型满分量级。 */
export const RELEVANCE_K = 1.5;

/** 打分的默认权重（可被配置/调用方覆盖，但默认值就是上面那三个）。 */
export const DEFAULT_SCORE_WEIGHTS = Object.freeze({
  importance: W_IMPORTANCE,
  recency: W_RECENCY,
  relevance: W_RELEVANCE,
});

const DAY_MS = 86400000;

/**
 * importance：类型（四层）+ 信任等级（来源）+ 置信度。
 *
 * 类型基数直接对应「分层而不是平铺」：core（身份/硬偏好）> procedural（过程技能）
 * > semantic（语义事实）> episodic（情节事件）。信任等级是**乘性**的，因为
 * `external` 内容即便重要也不该和用户亲口说的一样重（`06-architecture.md` 风险 5）。
 */
export const KIND_IMPORTANCE = Object.freeze({
  core: 1,
  procedural: 0.75,
  semantic: 0.6,
  episodic: 0.35,
});
export const TRUST_FACTOR = Object.freeze({
  user_stated: 1,
  system_derived: 0.8,
  external: 0.5,
});

export function importanceOf(note) {
  const base = KIND_IMPORTANCE[note.kind] ?? KIND_IMPORTANCE.semantic;
  const trust = TRUST_FACTOR[note.trust] ?? TRUST_FACTOR.external;
  const conf = Number.isFinite(note.confidence) ? Math.min(1, Math.max(0, note.confidence)) : 0.7;
  return base * trust * (0.5 + 0.5 * conf);
}

/**
 * relevance 饱和：`s / (s + K)`，值域 [0,1)、单调。
 *
 * 为什么必须饱和：BM25 是无上界的，长文档堆词项能把它堆到任意大；直接当 0–1 的
 * relevance 用，等于让「长」重新赢回 `B=0.4` 压下去的那个优势。
 */
export function saturateRelevance(score, k = RELEVANCE_K) {
  if (!(score > 0)) return 0;
  return score / (score + k);
}

/**
 * recency：距「参考时间」多少天，指数衰减；τ 默认 30 天。
 *
 * 参考时间取 `valid_from`，没有才退回 `mtime`。为什么不是 mtime：文件 mtime 会因为
 * 一次批量导入、一次 `git checkout` 全部刷新成同一时刻，把 90 天的记忆全变成「刚刚」。
 * 而 `valid_from` 是内容自己的时间（schema 必填字段）。
 *
 * **被命中时抬高 base**（MemoryBank 式恢复）不在这一步做：它是写入侧事件
 * （M2 的 `times_hit` 维护），本函数保持纯函数，避免读路径顺手改状态。
 */
export function recencyOf(note, nowMsValue, tauDays = TAU_DAYS) {
  const ref = parseTime(note.valid_from) ?? parseTime(note.mtime) ?? null;
  if (ref === null) return 0.5; // 没有时间信息：给中间值，不假装它很新
  const ageDays = Math.max(0, (nowMsValue - ref) / DAY_MS);
  return Math.exp(-ageDays / tauDays);
}

/**
 * 三因子合成。返回拆解结果（`recall` 的 `score` 字段就是它，`explain` 也吃它）。
 *
 * `why` 是给人看的短句：它必须能回答「为什么给了它」，所以由**因子本身**生成，
 * 不是事后编的词。
 */
export function scoreNote({ note, bm25 = 0, coverage = null, nowMs: nowMsValue, weights = DEFAULT_SCORE_WEIGHTS, tauDays = TAU_DAYS }) {
  const importance = importanceOf(note);
  const recency = recencyOf(note, nowMsValue, tauDays);
  const relevance = saturateRelevance(bm25);
  const total = weights.importance * importance + weights.recency * recency + weights.relevance * relevance;
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return {
    importance: round(importance),
    recency: round(recency),
    relevance: round(relevance),
    // coverage（查询的信息量里有几分之几被这篇覆盖）单独报，**不并进 relevance**：
    // 两者回答的是不同问题 —— 「够不够格当证据」看 coverage，「命中得多猛」看 relevance。
    // 混成一个数会让阈值调不动：冲淡哪个都说不清。
    coverage: coverage === null || !Number.isFinite(coverage) ? null : round(coverage),
    total: round(total),
    bm25: round(bm25),
    why: whyString({ note, relevance, bm25 }),
  };
}

function whyString({ note, relevance, bm25 }) {
  if (note.kind === 'core') return 'core 档：身份/硬偏好';
  if (relevance <= 0) return '未被词法命中（由核心档或晋升路径带入）';
  return `词法命中 ${Math.round(bm25 * 100) / 100}（relevance ${Math.round(relevance * 100) / 100}）`;
}

/**
 * as-of 语义：`valid_from <= at < valid_to`。
 *
 * 三条边界口径（`05-agi-direction.md §5.2` 点名会咬人，这里钉死）：
 *  1. `valid_to = null` 表示「仍然有效」，不是「未知」，所以不设上界；
 *  2. **date-only 的 as-of 解析到当天正午**，不是午夜 —— 解析到 00:00 会把当天
 *     写成的事判成「还没发生」；
 *  3. `valid_from` 缺失视为「一直有效」（不能因为缺一个字段就把记忆判成不存在，
 *     那不是 fail-closed 而是静默漏召回）。
 */
export function asOfTime(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return parseDateOnlyAsNoon(value);
  }
  return parseTime(value);
}

export function isValidAt(note, atMs) {
  if (atMs === null || atMs === undefined) return true;
  const from = parseTime(note.valid_from);
  const to = parseTime(note.valid_to);
  if (from !== null && from > atMs) return false;
  if (to !== null && to <= atMs) return false;
  return true;
}

/** `since`：只要「这条时间之后写过/生效」的记录（增量同步用）。 */
export function isSince(note, sinceMs) {
  if (sinceMs === null || sinceMs === undefined) return true;
  const ref = parseTime(note.valid_from) ?? parseTime(note.mtime);
  if (ref === null) return true;
  return ref >= sinceMs;
}

/**
 * 生命周期状态（§3.2 `draft → active → stale → superseded → archived`）。
 *
 * 本函数只做**从字段能推出来的**那部分：`superseded` 看 `superseded_by` / `valid_to`，
 * `archived` 看状态字段。`stale` 需要「连续 K 轮 recency 低于阈值且从未被注入」这种
 * 跨轮次证据，属于 M2 的巩固决策，这里不猜（返回 active）。
 *
 * 优先级（**显式字段永远赢过推导**，`archived` 又永远赢过一切）：
 *   archived（显式） > superseded_by（显式） > draft（显式） > valid_to 已过（推导） > active。
 *
 * 为什么 `archived` 排第一：它是「人明确说了别再用了」，任何推导都不该把它翻回来。
 * 为什么 `valid_to` 已过推出的是 **superseded 而不是 stale**：`05-agi-direction.md §5.2`
 * 把 stale 定义成需要跨轮次证据的状态；「有效期已经结束」是**当下就能确定**的事实，
 * 属于被取代，不属于「可能已经过时」。把 expired 记成 stale 会让 staleness 指标虚高。
 */
export function lifecycleOf(note, nowMsValue) {
  if (note.status === 'archived') return 'archived';
  if (note.superseded_by) return 'superseded';
  // 显式 status 原样透传（draft / stale / superseded …）。原来只认 archived 与 draft，
  // 于是手写 `status: superseded` 的笔记被读成 active —— 一个**只有人写的文件才会触发**
  // 的静默错误（自动写入路径永远写 active）。
  if (note.status && note.status !== 'active') return note.status;
  const to = parseTime(note.valid_to);
  if (to !== null && to <= nowMsValue) return 'superseded';
  return 'active';
}

/**
 * 默认检索面：**只看显式 status**，`draft` 与 `archived` 不出现。
 *
 * 为什么**不**用 `lifecycleOf()` 的结果来判断（这是踩过的坑）：
 * `lifecycleOf()` 会把「valid_to 已过」推成 `superseded`，于是窗口已经关闭的笔记
 * 在默认面上被排除 —— 但 as-of 过滤（`isValidAt`）做的事**完全一样**，
 * 两个地方各排一次就出事：历史视图（as-of 在过去）里那些**当时正有效**的笔记
 * 也会被这个函数排掉，症状是「查历史永远查不到东西」。
 * 现在有效性只由 `isValidAt(note, atMs)` 一处负责，默认 atMs = 现在。
 *
 * `superseded` 因此仍然进面（§3.2 明确要求它可被读到）：它可能正是要回答
 * 「以前是怎么做的」的那条，只是排在后面、并带 `stale`/`superseded` 状态。
 */
export function inDefaultSurface(note, _nowMsValue) {
  return note?.status !== 'archived' && note?.status !== 'draft';
}
