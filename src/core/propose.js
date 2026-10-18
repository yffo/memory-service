/**
 * 内容类巩固的**提案层**（merge / summarize / promote）。
 *
 * 这一层只回答「如果做，会得到什么」，不写任何文件：
 *
 *   - merge：多条同 scope、同 kind 的显式源 → 一条去重拼接稿；
 *   - summarize：一条长记录的抽取式摘要稿（只摘原句，不新增事实）；
 *   - promote：多条同 scope、跨多个时间点的事实 → 一份候选规则脚手架，
 *     目标路径是 `notes/candidates/`，永远不进默认检索面。
 *
 * 为什么先只做提案：内容类操作会新增/压缩事实，判据比 invalidate/archive
 * 复杂得多。先把「选哪些源、草稿长什么样、会省多少」摊开给人看，执行层
 * （真正写 note、归档源、写回执）留到下一步。因此返回里固定：
 *
 *   dry_run: true
 *   apply_supported: false
 *   would_write: false
 *
 * 这一层不碰 IO、不读时钟（nowMs 由调用方注入），测试与将来的 replay
 * 看到的是同一份输入、同一份提案。
 */
import { ulid, isUlid } from '../util/ulid.js';
import { isoLocal, parseTime, todayLocal } from '../util/clock.js';
import { isValidAt } from './score.js';
import { estimateTokens } from './tokenize.js';
import { charNgrams, charLength, jaccard, sha256 } from '../util/text.js';

export const CONTENT_PROPOSAL_SCHEMA = 'tabellio.consolidate.proposal/1';
export const CONTENT_MODES = Object.freeze(['merge', 'summarize', 'promote']);
export const CONTENT_HASH_LEN = 32;
export const MIN_SUMMARIZE_CHARS = 200;
export const MIN_PROMOTE_SOURCES = 3;
export const MIN_PROMOTE_DAYS = 2;
export const DEFAULT_MAX_DRAFT_CHARS = 400;

const MODE_LABEL = Object.freeze({ merge: '合并', summarize: '摘要', promote: '提升候选' });
const DRAFT_KIND = Object.freeze({ merge: 'deduped_concat', summarize: 'extractive', promote: 'scaffold' });

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function scopeKeyOf(note) {
  if (!note) return null;
  return note.scope_detail ? `project:${note.scope_detail}` : String(note.scope ?? 'user');
}

function sourceDate(note) {
  const ms = parseTime(note?.valid_from);
  return ms === null ? null : todayLocal(ms);
}

function bodyOf(entry) {
  return String(entry?.body ?? '');
}

function bodyHash(entry) {
  return sha256(bodyOf(entry), CONTENT_HASH_LEN);
}

function normalizeIds(ids) {
  const raw = Array.isArray(ids) ? ids : String(ids ?? '').split(',');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = String(item ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function bodyWithoutTitle(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i < lines.length && /^#\s+/.test(lines[i].trim())) lines.splice(i, 1);
  return lines.join('\n').trim();
}

function blocksOf(body) {
  const out = [];
  let current = [];
  for (const line of bodyWithoutTitle(body).split('\n')) {
    if (line.trim() === '') {
      if (current.length) {
        out.push(current.join('\n').trim());
        current = [];
      }
      continue;
    }
    current.push(line.replace(/\s+$/, ''));
  }
  if (current.length) out.push(current.join('\n').trim());
  return out.filter(Boolean);
}

function firstSentence(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cut = s.search(/[。！？!?]|\.\s/);
  let out = cut >= 0 ? s.slice(0, cut + 1).trim() : s;
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out;
}

function uniqueTitle(sources) {
  const titles = [...new Set(sources.map((s) => String(s.title ?? '').trim()).filter(Boolean))];
  return titles.join(' + ') || '未命名';
}

function mergeDraft(sources, ids) {
  const seen = new Set();
  const blocks = [];
  for (const source of sources) {
    for (const block of blocksOf(bodyOf(source))) {
      const key = block.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      blocks.push(block);
    }
  }
  if (blocks.length === 0) return null;
  const heading = `# 合并提案：${uniqueTitle(sources)}`.slice(0, 120);
  const footer = `<!-- 合并自：${ids.join('、')}；提案草稿，未写入库。 -->`;
  return `${heading}\n\n${blocks.join('\n\n')}\n\n${footer}\n`;
}

function summarizeDraft(source, id) {
  const picked = blocksOf(bodyOf(source))
    .map((block) => firstSentence(block, 160))
    .filter(Boolean);
  if (picked.length === 0) return null;
  const heading = `# 摘要提案：${String(source.title ?? id).trim() || id}`.slice(0, 120);
  const footer = `<!-- 摘要自：${id}；提案草稿，未写入库。 -->`;
  return `${heading}\n\n${picked.join('\n\n')}\n\n${footer}\n`;
}

function promoteDraft(sources, ids) {
  const observations = sources.map((source) => {
    const date = sourceDate(source.note) ?? '日期未知';
    const sentence = firstSentence(bodyOf(source), 120) || String(source.title ?? source.id);
    return `- [${date}] ${String(source.title ?? source.id)}：${sentence}`;
  });
  return [
    '# 候选规则提案（待人工确认）',
    '',
    `<!-- 来源：${sources.length} 条，覆盖 ${new Set(sources.map((s) => sourceDate(s.note))).size} 个日期；这是脚手架，不是规则，未写入库。 -->`,
    '',
    '## 观察',
    '',
    ...observations,
    '',
    '## 待人工归纳',
    '',
    '- 请根据上面的观察写出一条可执行规则，并注明适用范围与失效条件。',
    '',
    `<!-- 来源 id：${ids.join('、')} -->`,
    '',
  ].join('\n');
}

/**
 * 把「提案稿」换成「执行稿」：去掉提案口吻的标题/尾注，避免一条已入库的笔记
 * 在正文里自称「提案草稿，未写入库」。只做确定的文字替换，不新增事实。
 */
export function materializeContentDraft(mode, draft) {
  const text = String(draft ?? '');
  if (mode === 'promote') {
    return text.replace('这是脚手架，不是规则，未写入库。', '这是候选脚手架，尚未批准入库。');
  }
  return text
    .replace(/^# 合并提案：/m, '# 合并：')
    .replace(/^# 摘要提案：/m, '# 摘要：')
    .replace('；提案草稿，未写入库。 -->', '；已由内容类巩固写入。 -->');
}

function sourceView(entry) {
  const note = entry.note ?? {};
  return {
    id: entry.id,
    title: entry.title ?? '',
    path: entry.path ?? null,
    kind: note.kind ?? null,
    scope: scopeKeyOf(note),
    trust: note.trust ?? null,
    status: note.status ?? null,
    valid_from: note.valid_from ?? null,
    chars: charLength(bodyOf(entry)),
    tokens: estimateTokens(bodyOf(entry)),
    body_sha256: bodyHash(entry),
  };
}

function baseStats(entries) {
  return {
    scanned: Array.isArray(entries) ? entries.length : 0,
    sources: 0,
    source_chars: 0,
    source_tokens: 0,
    target_chars: 0,
    target_tokens: 0,
    saved_chars: 0,
    saved_tokens: 0,
    saved_ratio: 0,
    estimated_write_ops: 0,
    estimated_change_ratio: 0,
  };
}

function reject(reason, extra = {}) {
  return {
    ok: false,
    status: 'rejected',
    reason,
    dry_run: true,
    apply_supported: false,
    would_write: false,
    ...extra,
  };
}

/**
 * 生成一份内容类巩固提案。
 *
 * @param {object} options
 * @param {Array} options.entries 扫描到的笔记（只应传主库 notes，不含 candidates）
 * @param {'merge'|'summarize'|'promote'} options.mode
 * @param {string[]|string} options.ids 显式源 id
 * @param {number} [options.nowMs]
 * @param {string} [options.targetId] 测试/调用方指定目标 id（必须是合法 ULID）
 * @param {string} [options.proposalId]
 */
export function planContentConsolidation({
  entries = [],
  mode,
  ids = [],
  nowMs = Date.now(),
  targetId = null,
  proposalId = null,
  minSummarizeChars = MIN_SUMMARIZE_CHARS,
  minPromoteSources = MIN_PROMOTE_SOURCES,
  minPromoteDays = MIN_PROMOTE_DAYS,
  maxDraftChars = DEFAULT_MAX_DRAFT_CHARS,
} = {}) {
  const stats = baseStats(entries);
  if (!CONTENT_MODES.includes(mode)) {
    return reject('invalid_mode', { mode: mode ?? null, stats });
  }
  const sourceIds = normalizeIds(ids);
  if (sourceIds.length === 0) return reject('missing_sources', { mode, stats });

  if (mode === 'merge' && sourceIds.length < 2) {
    return reject('not_enough_sources', { mode, stats, source_count: sourceIds.length, min_sources: 2 });
  }
  if (mode === 'summarize' && sourceIds.length !== 1) {
    return reject('summarize_needs_one_source', { mode, stats, source_count: sourceIds.length });
  }
  if (mode === 'promote' && sourceIds.length < minPromoteSources) {
    return reject('not_enough_sources', { mode, stats, source_count: sourceIds.length, min_sources: minPromoteSources });
  }

  const byId = new Map();
  for (const entry of entries) {
    if (entry?.id) byId.set(String(entry.id), entry);
  }
  const skipped = [];
  const sources = [];
  for (const id of sourceIds) {
    const entry = byId.get(id);
    if (!entry) {
      skipped.push({ id, reason: 'missing_source' });
      continue;
    }
    if (!entry.note) {
      skipped.push({ id, reason: 'source_unparsed' });
      continue;
    }
    const note = entry.note;
    if (note.status !== 'active') {
      skipped.push({ id, reason: 'source_not_active' });
      continue;
    }
    if (note.superseded_by) {
      skipped.push({ id, reason: 'source_superseded' });
      continue;
    }
    if (note.valid_to !== null && note.valid_to !== undefined) {
      skipped.push({ id, reason: 'source_has_valid_to' });
      continue;
    }
    if (!isValidAt(note, nowMs)) {
      skipped.push({ id, reason: 'source_not_valid_at_now' });
      continue;
    }
    if (mode === 'promote' && sourceDate(note) === null) {
      skipped.push({ id, reason: 'source_missing_valid_from' });
      continue;
    }
    sources.push(entry);
  }
  if (skipped.length > 0) {
    return reject('source_invalid', {
      mode,
      stats: { ...stats, sources: sources.length },
      source_ids: sourceIds,
      skipped,
    });
  }

  const warnings = [];
  const scopes = new Set(sources.map((s) => scopeKeyOf(s.note)));
  if (scopes.size > 1) {
    return reject('scope_mismatch', { mode, stats, source_ids: sourceIds, scopes: [...scopes] });
  }
  const kinds = new Set(sources.map((s) => s.note.kind));
  if (mode === 'merge' && kinds.size > 1) {
    return reject('kind_mismatch', { mode, stats, source_ids: sourceIds, kinds: [...kinds] });
  }
  if (mode === 'promote' && kinds.size > 1) {
    warnings.push({ code: 'promote_mixed_kinds', message: `源覆盖多种 kind：${[...kinds].join(', ')}；候选规则需人工判断是否成立。` });
  }

  const sourceChars = sources.reduce((n, s) => n + charLength(bodyOf(s)), 0);
  const sourceTokens = sources.reduce((n, s) => n + estimateTokens(bodyOf(s)), 0);
  if (mode === 'summarize' && sourceChars < minSummarizeChars) {
    return reject('source_too_short', {
      mode,
      stats: { ...stats, sources: 1, source_chars: sourceChars, source_tokens: sourceTokens },
      source_ids: sourceIds,
      source_chars: sourceChars,
      min_chars: minSummarizeChars,
    });
  }

  let distinctDays = 0;
  if (mode === 'promote') {
    const days = new Set(sources.map((s) => sourceDate(s.note)));
    distinctDays = days.size;
    if (distinctDays < minPromoteDays) {
      return reject('not_enough_time_points', {
        mode,
        stats: { ...stats, sources: sources.length, source_chars: sourceChars, source_tokens: sourceTokens },
        source_ids: sourceIds,
        distinct_days: distinctDays,
        min_days: minPromoteDays,
      });
    }
  }

  if (mode === 'merge' && sources.length > 1) {
    let maxOverlap = 0;
    const grams = sources.map((s) => charNgrams(bodyOf(s), 8));
    for (let i = 0; i < grams.length; i += 1) {
      for (let j = i + 1; j < grams.length; j += 1) {
        maxOverlap = Math.max(maxOverlap, jaccard(grams[i], grams[j]));
      }
    }
    if (maxOverlap < 0.15) {
      warnings.push({ code: 'sources_low_overlap', message: `源之间最大 8-gram 重叠只有 ${maxOverlap.toFixed(3)}，合并后可能只是拼接而非合并；请人工确认。` });
    }
  }

  const draft =
    mode === 'merge'
      ? mergeDraft(sources, sourceIds)
      : mode === 'summarize'
        ? summarizeDraft(sources[0], sourceIds[0])
        : promoteDraft(sources, sourceIds);
  if (draft === null) {
    return reject('empty_draft', { mode, stats, source_ids: sourceIds });
  }

  const targetChars = charLength(draft);
  const targetTokens = estimateTokens(draft);
  if (targetChars > maxDraftChars) {
    warnings.push({ code: 'draft_over_note_chars', message: `目标草稿 ${targetChars} 字，超过核心档 ${maxDraftChars} 字的建议上限；执行层需要拆分或人工压缩。` });
  }
  const savedChars = sourceChars - targetChars;
  const savedTokens = sourceTokens - targetTokens;
  if (mode !== 'promote' && savedChars <= 0) {
    warnings.push({ code: 'draft_not_shorter', message: `目标草稿没有比源更短（源 ${sourceChars} 字，草稿 ${targetChars} 字），摘要/合并不会节省注入。` });
  }

  const estimatedWriteOps = mode === 'merge' ? sourceIds.length + 1 : mode === 'summarize' ? 2 : 1;
  // 5% 保险丝算的是「动到多少条**现有**笔记」，不是写文件次数：merge 新建一条目标是
  // 新增，不是改动；真正关闭的是源。promote 不关闭任何源，改动率就是 0。
  const touchedSources = mode === 'promote' ? 0 : sourceIds.length;
  const changeRatio = stats.scanned > 0 ? round(touchedSources / stats.scanned) : 0;
  if (changeRatio > 0.05) {
    warnings.push({ code: 'would_exceed_change_ratio', message: `预计关闭/改动 ${touchedSources} 条现有笔记（扫描 ${stats.scanned} 条，改动率 ${(changeRatio * 100).toFixed(1)}%）超过 5% 保险丝；执行层默认会拒绝整单。` });
  }

  let target = targetId;
  if (target !== null) {
    target = String(target).trim();
    if (!isUlid(target)) return reject('invalid_target_id', { mode, stats, target_id: target });
    if (sourceIds.includes(target)) return reject('target_id_collides', { mode, stats, target_id: target });
    if (entries.some((entry) => String(entry?.id ?? '') === target)) {
      return reject('target_id_exists', { mode, stats, target_id: target });
    }
  } else {
    target = ulid(nowMs);
    if (entries.some((entry) => String(entry?.id ?? '') === target)) target = ulid(nowMs);
  }

  const proposal = proposalId === null ? `prop_${ulid(nowMs)}` : String(proposalId);
  const scopeKey = scopeKeyOf(sources[0].note);
  const scopeDetail = sources[0].note.scope_detail ?? null;
  const kind = mode === 'promote' ? 'procedural' : sources[0].note.kind;
  const trust =
    mode === 'promote'
      ? 'system_derived'
      : sources.every((s) => s.note.trust === 'user_stated')
        ? 'user_stated'
        : sources.some((s) => s.note.trust === 'external')
          ? 'external'
          : 'system_derived';

  const targetNote = {
    id: target,
    path: mode === 'promote' ? `notes/candidates/${target}.md` : `notes/${target}.md`,
    scope: scopeKey,
    scope_detail: scopeDetail,
    kind,
    trust,
    status: 'draft',
    valid_from: isoLocal(nowMs),
    valid_to: null,
    supersedes: mode === 'promote' ? [] : [...sourceIds],
    superseded_by: null,
    provenance: {
      written_by: `consolidator:${mode}:proposal`,
      source_ref: mode === 'summarize' ? sourceIds[0] : null,
      derived_from: [...sourceIds],
    },
    tags: [],
    subject: null,
    predicate: null,
    body: draft,
    body_sha256: sha256(draft, CONTENT_HASH_LEN),
    chars: targetChars,
    tokens: targetTokens,
    draft_kind: DRAFT_KIND[mode],
    requires_review: true,
    apply_supported: false,
  };

  return {
    ok: true,
    status: 'proposed',
    schema: CONTENT_PROPOSAL_SCHEMA,
    proposal_id: proposal,
    mode,
    mode_label: MODE_LABEL[mode],
    created_at: isoLocal(nowMs),
    dry_run: true,
    apply_supported: true,
    would_write: false,
    target_id: target,
    source_ids: sourceIds,
    sources: sources.map(sourceView),
    skipped,
    target: targetNote,
    warnings,
    stats: {
      ...stats,
      sources: sources.length,
      source_chars: sourceChars,
      source_tokens: sourceTokens,
      target_chars: targetChars,
      target_tokens: targetTokens,
      saved_chars: savedChars,
      saved_tokens: savedTokens,
      saved_ratio: sourceChars > 0 ? round(savedChars / sourceChars) : 0,
      estimated_write_ops: estimatedWriteOps,
      touched_sources: touchedSources,
      estimated_change_ratio: changeRatio,
      distinct_days: distinctDays,
      max_draft_chars: maxDraftChars,
      min_summarize_chars: minSummarizeChars,
      min_promote_sources: minPromoteSources,
      min_promote_days: minPromoteDays,
    },
    next_action: '人工审阅后加 --apply 执行；执行会写目标笔记，merge/summarize 还会关闭源。',
  };
}
