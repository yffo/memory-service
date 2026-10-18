/**
 * 自动巩固的**发现层**：只找「值得让人看一眼」的近似重复组，不写任何文件。
 *
 * 自动巩固最容易走歪的地方是「自己决定合并」：两条笔记看起来像，但一条是旧结论、
 * 一条是新例外，机器合并会把例外抹掉。所以这一层只做三件事：
 *
 *   1. 只在**同 scope + 同 kind + 同 trust** 的 active 笔记里找；
 *   2. 只在正文 8-gram 重叠足够高时成组（默认 0.62，宁可漏，不可把「相关」当「重复」）；
 *   3. 输出可以交给 `consolidate --merge` 的源 id 组，不生成目标、不读时钟以外的状态。
 *
 * 真正的目标草稿、回执、撤销仍由显式执行层负责；提案只是「待人工确认的清单」。
 */
import { charNgrams, jaccard, sha256 } from '../util/text.js';
import { isValidAt } from './score.js';

export const AUTO_CONSOLIDATE_SCHEMA = 'tabellio.consolidate.auto/1';
export const AUTO_MIN_SIMILARITY = 0.62;
export const AUTO_MAX_GROUP = 4;
export const AUTO_MAX_PROPOSALS = 20;
export const AUTO_MIN_BODY_CHARS = 40;

function scopeKeyOf(note) {
  if (!note) return null;
  return note.scope_detail ? 'project:' + note.scope_detail : String(note.scope ?? 'user');
}

function compareBody(entry) {
  return String(entry?.body ?? '')
    .replace(/^#\s+.*$/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupKeyOf(entry) {
  const note = entry?.note ?? {};
  return [scopeKeyOf(note), note.kind ?? 'semantic', note.trust ?? 'system_derived'].join('|');
}

function eligible(entry, nowMs) {
  const note = entry?.note;
  if (!note || !entry.id) return false;
  if (note.status !== 'active') return false;
  if (note.superseded_by) return false;
  if (note.valid_to !== null && note.valid_to !== undefined) return false;
  if (!isValidAt(note, nowMs)) return false;
  return compareBody(entry).length >= AUTO_MIN_BODY_CHARS;
}

function proposalIdOf(ids) {
  return 'prop_' + sha256([...ids].sort().join('|'), 20);
}

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/**
 * @param {object} options
 * @param {Array} options.entries 主库笔记（不应含 candidates）
 * @param {number} [options.nowMs]
 * @param {number} [options.minSimilarity]
 * @param {number} [options.maxGroup]
 * @param {number} [options.maxProposals]
 */
export function discoverConsolidationProposals({
  entries = [],
  nowMs = Date.now(),
  minSimilarity = AUTO_MIN_SIMILARITY,
  maxGroup = AUTO_MAX_GROUP,
  maxProposals = AUTO_MAX_PROPOSALS,
} = {}) {
  const threshold = Number(minSimilarity);
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(maxProposals) || AUTO_MAX_PROPOSALS)));
  const groupSize = Math.max(2, Math.min(8, Math.trunc(Number(maxGroup) || AUTO_MAX_GROUP)));
  const buckets = new Map();
  for (const entry of entries) {
    if (!eligible(entry, nowMs)) continue;
    const key = groupKeyOf(entry);
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }

  const groups = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const prepared = bucket
      .map((entry) => ({ entry, grams: charNgrams(compareBody(entry), 8) }))
      .sort((a, b) => (String(a.entry.id) < String(b.entry.id) ? -1 : 1));
    const used = new Set();
    for (let i = 0; i < prepared.length; i += 1) {
      if (used.has(i)) continue;
      const picked = [i];
      let minPair = 1;
      for (let j = i + 1; j < prepared.length && picked.length < groupSize; j += 1) {
        if (used.has(j)) continue;
        let ok = true;
        let pairMin = 1;
        for (const k of picked) {
          const sim = jaccard(prepared[k].grams, prepared[j].grams);
          if (sim < threshold) {
            ok = false;
            break;
          }
          pairMin = Math.min(pairMin, sim);
        }
        if (!ok) continue;
        picked.push(j);
        minPair = Math.min(minPair, pairMin);
      }
      if (picked.length < 2) continue;
      for (const index of picked) used.add(index);
      const chosen = picked.map((index) => prepared[index].entry);
      const ids = chosen.map((entry) => String(entry.id));
      groups.push({
        proposal_id: proposalIdOf(ids),
        mode: 'merge',
        source_ids: ids,
        source_titles: chosen.map((entry) => String(entry.title ?? entry.id)),
        similarity: round(minPair),
        source_chars: chosen.reduce((n, entry) => n + String(entry.body ?? '').length, 0),
      });
    }
  }

  groups.sort((a, b) => {
    if (a.similarity !== b.similarity) return b.similarity - a.similarity;
    return a.proposal_id < b.proposal_id ? -1 : 1;
  });
  const truncated = groups.length > limit;
  return {
    ok: true,
    schema: AUTO_CONSOLIDATE_SCHEMA,
    scanned: entries.length,
    eligible: [...buckets.values()].reduce((n, bucket) => n + bucket.length, 0),
    groups: groups.slice(0, limit),
    truncated,
    skipped: truncated ? groups.length - limit : 0,
    thresholds: { min_similarity: threshold, max_group: groupSize, max_proposals: limit },
  };
}

export { proposalIdOf as autoProposalId };
