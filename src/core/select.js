/**
 * 预算感知选片（`06-architecture.md §5.2` 的「硬预算 + 分层热度」）。
 *
 * 这个文件回答一个问题：**给定的 token 预算里，到底放哪些笔记、超了先丢谁。**
 *
 * 四条规则，按优先级：
 *
 *  1. **pull 先于 push**：与查询相关的（检索命中的）先占额度。push（核心档）虽然
 *     是基线注入，但预算不够时它是**先被挤掉**的——否则会出现「问了 A，答案里
 *     全是身份设定」。这是旧项目 `Push 是错的默认` 的直接落地。
 *  2. **裁剪顺序照架构文档写死**：先丢 `episodic`、再丢低 `trust`、最后才丢 `core`
 *     （`06-architecture.md §5.2`）。`dropRank` 就是这个序：越小越先掉。
 *  3. **超预算的候选被逐出，且逐出必须留账**：`dropped / droppedCount / truncated`
 *     是返回值的一等字段，不是日志。旧项目用血换来的那条铁律：
 *     「任何静默截断都要有账」。
 *  4. **核心档兜底**：pull 为 0 时，核心档按分数占位（供 /memory 面板与首轮注入用）；
 *     调用方给 `includeCore: false` 就不要它。
 *
 * `maxTokens` 的语义是**上界**：宁少勿多。超一点点也比爆掉用户的上下文预算好，
 * 所以每一片都先算 token 再决定放不放（不做「先放再截」）。
 */
import { estimateTokens } from './tokenize.js';

/** 每片的固定开销：id + 标题 + frontmatter 骨架（不含正文的 token）。 */
export const ENTRY_OVERHEAD_TOKENS = 12;

/** 架构文档给的默认硬预算就是 500 token（`06-architecture.md §9` 的 `recall` 签名）。 */
export const DEFAULT_BUDGET = Object.freeze({
  maxNotes: 8,
  maxTokens: 500,
  maxChars: 0, // 0 = 不限
  includeCore: true,
});

/** 裁剪序（§5.2）：episodic 最先丢，core 最后丢。 */
export const DROP_RANK = Object.freeze({ episodic: 0, low_trust: 1, other: 2, core: 3 });

export function dropRankOf({ note, trust } = {}) {
  const kind = note?.kind ?? 'semantic';
  const noteTrust = trust ?? note?.trust ?? 'external';
  if (kind === 'core') return DROP_RANK.core;
  if (kind === 'episodic') return DROP_RANK.episodic;
  if (noteTrust === 'external' || noteTrust === 'system_derived') return DROP_RANK.low_trust;
  return DROP_RANK.other;
}

function dropReasonOf(cand) {
  const rank = dropRankOf(cand);
  if (rank === DROP_RANK.episodic) return 'episodic_low_trust';
  if (rank === DROP_RANK.low_trust) return 'low_trust';
  return 'budget_exhausted';
}

export function budgetOf(options = {}) {
  const b = options.budget ?? {};
  return {
    maxNotes: positive(b.maxNotes, DEFAULT_BUDGET.maxNotes),
    maxTokens: positive(b.maxTokens, DEFAULT_BUDGET.maxTokens),
    maxChars: nonNegative(b.maxChars, DEFAULT_BUDGET.maxChars),
    includeCore: b.includeCore === undefined ? DEFAULT_BUDGET.includeCore : Boolean(b.includeCore),
  };
}

function positive(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
function nonNegative(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/** 单片预算成本：标题 + 正文 + 固定开销。 */
export function costOf(cand) {
  return (
    estimateTokens(String(cand.title ?? '')) +
    estimateTokens(String(cand.body ?? '')) +
    ENTRY_OVERHEAD_TOKENS
  );
}

/**
 * 选片。
 *
 * @param {object} input
 * @param {Array} [input.pulled] 检索命中（调用方已按优先级排好序）
 * @param {Array} [input.core]   核心档（已按分数降序）
 * @param {object} [input.budget]
 * @returns {{items:Array, tokens:number, chars:number, truncated:boolean,
 *            dropped:Array<{id,reason}>, droppedCount:number, omittedReason:string|null}}
 */
export function selectBudget({ pulled = [], core = [], budget = {} } = {}) {
  const cap = budgetOf({ budget });
  const items = [];
  const dropped = [];
  const deferred = [];
  let tokens = 0;
  let chars = 0;
  const seen = new Set();

  /**
   * 放一片；放不下就进 `deferred`（不是直接判死）。
   * 为什么要两段式：先来的一篇长笔记可能吃满预算，把后面一条更该给的
   * **高 dropRank** 短笔记挤掉。所以逐出要在收集完之后按裁剪序统一做账。
   */
  const tryAdd = (cand, source) => {
    const id = String(cand.id);
    if (seen.has(id)) return; // 同一篇既被 pull 又被 push 时只算一次
    const body = String(cand.body ?? '');
    const cost = costOf(cand);
    if (items.length >= cap.maxNotes) {
      deferred.push({ cand, source, reason: 'maxNotes' });
      return;
    }
    if (tokens + cost > cap.maxTokens) {
      deferred.push({ cand, source, reason: 'maxTokens' });
      return;
    }
    if (cap.maxChars > 0 && chars + body.length > cap.maxChars) {
      deferred.push({ cand, source, reason: 'maxChars' });
      return;
    }
    seen.add(id);
    tokens += cost;
    chars += body.length;
    items.push({
      id,
      title: cand.title ?? '',
      body,
      note: cand.note ?? null,
      source,
      score: cand.score ?? 0,
      relevance: cand.relevance ?? 0,
      score_breakdown: cand.breakdown ?? null,
      why: cand.why ?? '',
    });
  };

  for (const cand of pulled) tryAdd(cand, 'pull');
  if (cap.includeCore) for (const cand of core) tryAdd(cand, 'push');

  // 逐出账本：deferred 里的每条都要有一个 reason，而且必须分清是哪一类原因。
  //
  // 两类原因的读法完全不同：
  //  - `maxNotes` / `maxChars`：**硬闸门**。调用方除了放弃没有别的办法，理由必须照实说；
  //  - `maxTokens`：**软预算**。这里报的是 dropRank（episodic/low_trust/core），
  //    它表达的是「预算不够时该先砍谁」——这是可以被更好的检索结果改变的一条判断。
  //
  // 原来这两类被合在一起：`maxTokens` 也被翻成 dropRank，于是「因为预算不够」这件事
  // 在账里彻底看不见了，`status` 报出来的是一串 dropRank。硬闸门的理由不许被改写。
  for (const d of deferred) {
    if (d.reason === 'maxNotes' || d.reason === 'maxChars') {
      dropped.push({ id: String(d.cand.id), reason: d.reason, source: d.source, hard: true });
      continue;
    }
    dropped.push({
      id: String(d.cand.id),
      reason: dropReasonOf(d.cand),
      limitReason: 'maxTokens',
      source: d.source,
      hard: false,
    });
  }

  return {
    items,
    tokens,
    chars,
    truncated: dropped.length > 0,
    dropped,
    droppedCount: dropped.length,
    omittedReason: dropped.length ? summarizeReasons(dropped) : null,
  };
}

function summarizeReasons(dropped) {
  const counts = new Map();
  for (const d of dropped) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts.entries()].map(([r, c]) => `${r}×${c}`).join(', ');
}

/**
 * 笔记级正文截断（**不是**检索切桶，别混）：把一条已选中笔记的正文压到 `maxChars`。
 *
 * 只要发生截断就返回 `truncatedNote: true` 和原始长度，调用方**必须**把它记进账
 * （`search`/`recall` 的 `truncatedNotes`、`status` 的计数）。这里绝不做「悄悄切一刀」。
 */
export function clipNote(note, maxChars) {
  const body = String(note.body ?? '');
  const limit = nonNegative(maxChars, 0);
  if (limit <= 0 || body.length <= limit) {
    return { body, truncatedNote: false, originalChars: body.length, truncatedReason: null };
  }
  // `truncatedReason` 必须**永远**和 `truncatedNote: true` 一起出现：只给一个布尔，
  // 调用方迟早会写 `if (truncated) log()` 而不带数量，账就断了。
  return {
    body: body.slice(0, limit),
    truncatedNote: true,
    originalChars: body.length,
    droppedChars: body.length - limit,
    truncatedReason: 'maxChars',
  };
}
