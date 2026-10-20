/**
 * 语义召回的核心部分：**哪些笔记该进索引、怎么算相似、怎么并回词面结果**。
 *
 * 这一层不联网、不知道 embedding 服务长什么样——调用方注入 `embed(texts)`。
 * 这样 DSH 插件、CLI、MCP 可以共用同一套索引与合并规则，provider 各自适配。
 *
 * 铁律：
 *   1. 语义只**追加**词面没命中的条目，不改变已有顺序；
 *   2. 只对「自动召回可见」的笔记建索引（archived/draft/被取代/过期一律不进）；
 *   3. 任何一步失败都不该让词面结果变差（调用方负责 catch）。
 */
import { createHash } from 'node:crypto';

export const DEFAULT_SEMANTIC_CHARS = 900;

export const sha1Hex = (text) => createHash('sha1').update(text).digest('hex');

const dot = (left, right) => {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
  return sum;
};
const norm = (vector) => Math.sqrt(dot(vector, vector));

export function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) return 0;
  const denom = norm(left) * norm(right);
  return denom ? dot(left, right) / denom : 0;
}

/** 索引里放正文（截断），不放 frontmatter：标题/元数据由词面检索负责。 */
export function semanticText(entry, { maxChars = DEFAULT_SEMANTIC_CHARS } = {}) {
  return String(entry?.body ?? '').trim().slice(0, Math.max(1, maxChars));
}

export function indexableEntry(entry) {
  const note = entry?.note;
  if (!note) return false;
  if (note.status === 'archived' || note.status === 'draft') return false;
  if (note.superseded_by && note.superseded_by !== 'null') return false;
  if (note.valid_to && note.valid_to !== 'null') return false;
  return true;
}

/**
 * 对比扫描结果和旧索引，得到这次要做什么：
 *   - `kept`：正文没变，直接复用旧向量；
 *   - `changed`：新增或正文变了，需要重新 embedding；
 *   - `removed`：已不存在或不可召回，从索引里删掉。
 */
export function planSemanticIndex(entries = [], previous = new Map(), { maxChars } = {}) {
  const alive = new Set();
  const kept = new Map();
  const changed = [];
  for (const entry of entries) {
    if (!indexableEntry(entry)) continue;
    const text = semanticText(entry, { maxChars });
    if (!text) continue;
    const id = String(entry.id);
    const hash = sha1Hex(text);
    alive.add(id);
    const prior = previous.get(id);
    if (prior && prior.hash === hash) kept.set(id, prior);
    else changed.push({ id, text, hash });
  }
  const removed = [...previous.keys()].filter((id) => !alive.has(id));
  return { alive, kept, changed, removed };
}

/** 余弦 top-k；阈值由调用方按模型给（qwen3-embedding 在本库约 0.55 起）。 */
export function rankSemantic(index, queryVector, { top = 8, minSimilarity = 0 } = {}) {
  const hits = [];
  for (const [id, entry] of index) {
    const similarity = cosine(queryVector, entry.vector);
    if (Number.isFinite(similarity) && similarity >= minSimilarity) hits.push({ id, similarity });
  }
  hits.sort((left, right) => right.similarity - left.similarity);
  return hits.slice(0, Math.max(1, Math.floor(top) || 8));
}

/**
 * 把语义命中并进 `recall()` 的结果。
 *
 * 两种融合方式：
 * - `rrf`（默认）：按 reciprocal rank fusion 合并词面与语义两路排序
 *   （`1/(rrfK+lexRank) + 1/(rrfK+semRank)`），同分时词面优先。语义排得足够高的
 *   条目可以挤掉词面靠后的弱命中——只追加的话，词面一旦填满预算，语义就永远进不来。
 * - `append`：保留旧行为，词面顺序不动、只追加没出现过的条目。
 *
 * 无论哪种方式，合并前都会再验一遍生命周期/信任（索引可能比库里状态旧）。
 * `readNote(id)` 由调用方给；`rrfK` 默认 60（与常见 RRF 实现一致）。
 */
export function mergeSemanticItems(result, { hits = [], readNote, maxNotes = 6, allowedTrusts = null, fusion = 'rrf', rrfK = 60 } = {}) {
  const items = Array.isArray(result?.items) ? result.items : [];
  if (!Array.isArray(hits) || hits.length === 0 || typeof readNote !== 'function') return result;
  const known = new Set(items.map((item) => item.id));
  const added = [];
  const cap = Math.max(1, Math.floor(maxNotes) || 6);
  for (const hit of hits) {
    if (!hit || known.has(hit.id)) continue;
    let note;
    try {
      note = readNote(hit.id);
    } catch {
      continue;
    }
    if (!note || note.ok === false) continue;
    const meta = note.note && typeof note.note === 'object' ? note.note : {};
    if (meta.status === 'archived' || meta.status === 'draft') continue;
    if (meta.superseded_by && meta.superseded_by !== 'null') continue;
    if (meta.valid_to && meta.valid_to !== 'null') continue;
    if (Array.isArray(allowedTrusts) && allowedTrusts.length && meta.trust && !allowedTrusts.includes(meta.trust)) continue;
    known.add(hit.id);
    added.push({
      id: hit.id,
      title: note.title ?? hit.id,
      content: String(note.body ?? '').trim(),
      relevance: Number(Number(hit.similarity).toFixed(4)),
      score: Number(hit.similarity),
      semantic: true,
    });
    if (added.length >= cap) break;
  }
  if (added.length === 0) return result;

  let merged = items;
  if (fusion === 'append') {
    merged = [...items, ...added].slice(0, cap);
  } else {
    const k = Math.max(1, Math.floor(rrfK) || 60);
    const slots = new Map();
    items.forEach((item, index) => {
      slots.set(item.id, { item, lex: index + 1, sem: null });
    });
    // 语义命中按原始顺序给名次（rankSemantic 已按相似度降序）。
    hits.forEach((hit, index) => {
      const slot = slots.get(hit.id);
      if (slot) slot.sem = index + 1;
    });
    added.forEach((item) => {
      const index = hits.findIndex((hit) => hit.id === item.id);
      const slot = slots.get(item.id) ?? { item, lex: null, sem: null };
      slot.sem = index >= 0 ? index + 1 : Number.MAX_SAFE_INTEGER;
      slots.set(item.id, slot);
    });
    merged = [...slots.values()]
      .map((slot) => ({
        slot,
        score: (slot.lex ? 1 / (k + slot.lex) : 0) + (slot.sem ? 1 / (k + slot.sem) : 0),
      }))
      .sort((left, right) => right.score - left.score || (left.slot.lex ?? Infinity) - (right.slot.lex ?? Infinity))
      .slice(0, cap)
      .map((entry) => entry.slot.item);
  }
  const chars = merged.reduce((sum, item) => sum + String(item.title ?? '').length + String(item.content ?? '').length, 0);
  return { ...result, refused: false, reason: null, items: merged, tokens: Math.round(chars / 4) };
}
