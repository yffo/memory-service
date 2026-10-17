/**
 * 巩固（consolidate）的**纯决策层**：只读扫描结果，产出可审阅的 operations。
 *
 * 目前只做两种操作：`invalidate` 与 `archive`，两者都只动元数据、正文一字不改。
 *
 * `invalidate`：当 B 的 frontmatter 显式写了 `supersedes: [A]`，而 A 仍然是
 * active、没有 `valid_to`、也没有 `superseded_by` 时，A 就是一条「已经被人明确
 * 宣布作废、但文件里还没关掉」的记录。把它关掉只需要写两个元数据字段：
 *
 *   valid_to: <now>          # 让默认检索面按 isValidAt() 把它排除
 *   superseded_by: <B.id>    # 留下是谁替代了它的证据
 *
 * `archive`：人显式点名要归档一条仍 active、时间上有效的笔记。它不依赖
 * `supersedes`，只把 `status` 改成 `archived`，让默认检索面不再出现；undo
 * 只恢复 status。
 *
 * **正文一个字都不改。** merge / summarize / promote 都会新增或压缩事实，
 * 需要更复杂的判据和人工确认，不在当前实现里假装能自动做。
 *
 * 决策与执行分离：本模块不碰 IO，不读时钟（nowMs 由调用方注入）。这样
 * dry-run、apply、测试和重放看到的是同一份 operations。
 */
import { ulid } from '../util/ulid.js';
import { isoLocal } from '../util/clock.js';
import { isValidAt } from './score.js';
import { sha256 } from '../util/text.js';
import { canonicalJson } from './receipt.js';

export const CONSOLIDATE_SCHEMA = 'tabellio.consolidate/1';
export const CONSOLIDATE_KIND = 'consolidate';
export const CONSOLIDATE_UNDO_SCHEMA = 'tabellio.undo/1';
export const CONSOLIDATE_HASH_LEN = 32;
export const DEFAULT_MAX_CHANGE_RATIO = 0.05;
export const CONSOLIDATE_OPERATIONS = Object.freeze(['invalidate', 'archive']);

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function bodyHash(entry) {
  return sha256(String(entry?.body ?? ''), 16);
}

function fieldsOf(note) {
  return {
    status: note?.status ?? 'active',
    valid_to: note?.valid_to ?? null,
    superseded_by: note?.superseded_by ?? null,
  };
}

/** 字段级相等（只比较巩固会改的三项，不把整个 note 拖进比较）。 */
export function sameFields(a, b) {
  return (
    String(a?.status ?? '') === String(b?.status ?? '') &&
    String(a?.valid_to ?? '') === String(b?.valid_to ?? '') &&
    String(a?.superseded_by ?? '') === String(b?.superseded_by ?? '')
  );
}

function listOf(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((x) => String(x)).filter(Boolean);
  return String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqueIdsOf(value) {
  const input = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const seen = new Set();
  const out = [];
  for (const item of input) {
    for (const part of String(item).split(',')) {
      const id = part.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function inScope(entry, options) {
  const note = entry?.note;
  // 解析失败的条目也必须留在扫描面里：否则 successor 指向一条坏笔记时，
  // 我们会误报 missing_target，而不是把它作为 target_unparsed 报出来。
  if (!note) return true;
  if (options.scope && note.scope !== options.scope) return false;
  const kinds = listOf(options.kinds);
  if (kinds && !kinds.includes(note.kind)) return false;
  return true;
}

/**
 * 从扫描结果算出巩固计划。
 *
 * @param {string[]|string} [archiveIds] 显式要求归档的 note id（可逗号分隔）。
 * @returns {object} planned / aborted；aborted 时仍然带 operations，方便 dry-run
 *   告诉人「本来想改哪几条、为什么被 5% 保险丝拦下」。
 */
export function planConsolidation({ entries = [], nowMs = Date.now(), maxChangeRatio = DEFAULT_MAX_CHANGE_RATIO, scope = null, kinds = null, runId = null, archiveIds = null } = {}) {
  const ratio = Number(maxChangeRatio);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    return {
      ok: false,
      status: 'aborted',
      reason: 'invalid_max_change_ratio',
      runId: runId ?? `run_${ulid(nowMs)}`,
      createdAt: isoLocal(nowMs),
      operations: [],
      skipped: [],
      stats: { scanned: 0, planned: 0, allowed: 0, change_ratio: 0, est_tokens: 0, invalidate: 0, archive: 0 },
    };
  }

  const id = runId ?? `run_${ulid(nowMs)}`;
  const createdAt = isoLocal(nowMs);
  const visible = entries.filter((e) => inScope(e, { scope, kinds }));
  const byId = new Map();
  for (const entry of visible) byId.set(String(entry.id), entry);
  const allIds = new Set(entries.map((entry) => String(entry.id)));

  // 先收集「谁声明替代了谁」。同一个 A 被多个 B 声明时必须跳过：
  // 选任意一个都会在没有证据的情况下替人做决定，而不选只是少做一次清理。
  const claims = new Map();
  const claimProblems = [];
  for (const successor of visible) {
    const note = successor.note;
    if (!note || note.status !== 'active' || !isValidAt(note, nowMs)) continue;
    for (const raw of Array.isArray(note.supersedes) ? note.supersedes : []) {
      const targetId = String(raw ?? '').trim();
      if (!targetId) continue;
      if (targetId === String(successor.id)) {
        claimProblems.push({ id: targetId, reason: 'self_supersede' });
        continue;
      }
      if (!claims.has(targetId)) claims.set(targetId, new Map());
      claims.get(targetId).set(String(successor.id), successor);
    }
  }

  const operations = [];
  const skipped = [...claimProblems];
  for (const targetId of [...claims.keys()].sort()) {
    const successors = [...claims.get(targetId).values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (successors.length > 1) {
      skipped.push({ id: targetId, reason: 'ambiguous_supersedes', successors: successors.map((s) => String(s.id)) });
      continue;
    }
    const successor = successors[0];
    const target = byId.get(targetId);
    if (!target) {
      skipped.push({ id: targetId, reason: 'missing_target', successor: String(successor.id) });
      continue;
    }
    if (!target.note) {
      skipped.push({ id: targetId, reason: 'target_unparsed', successor: String(successor.id) });
      continue;
    }
    if (target.note.status !== 'active') {
      skipped.push({ id: targetId, reason: 'target_not_active', successor: String(successor.id) });
      continue;
    }
    if (target.note.superseded_by) {
      skipped.push({ id: targetId, reason: 'target_already_superseded', successor: String(successor.id) });
      continue;
    }
    if (target.note.valid_to !== null && target.note.valid_to !== undefined) {
      skipped.push({ id: targetId, reason: 'target_has_valid_to', successor: String(successor.id) });
      continue;
    }
    if (!isValidAt(target.note, nowMs)) {
      skipped.push({ id: targetId, reason: 'target_not_valid_at_now', successor: String(successor.id) });
      continue;
    }
    const before = { ...fieldsOf(target.note), body_sha256: bodyHash(target) };
    const after = { ...before, valid_to: isoLocal(nowMs), superseded_by: String(successor.id) };
    operations.push({
      op: 'invalidate',
      id: targetId,
      superseded_by: String(successor.id),
      valid_to: after.valid_to,
      rationale: `${successor.id} 的 supersedes 显式指向 ${targetId}，${targetId} 仍 active 且未关闭`,
      before,
      after,
      est_tokens: 0,
    });
  }

  // 显式归档。与 invalidate 共用同一份扫描面、同一道 5% 保险丝和同一张回执；
  // 与 invalidate 撞车时 invalidate 优先，避免同一轮既关闭又归档。
  const plannedIds = new Set(operations.map((op) => op.id));
  for (const targetId of uniqueIdsOf(archiveIds)) {
    if (plannedIds.has(targetId)) {
      skipped.push({ id: targetId, reason: 'already_planned' });
      continue;
    }
    const target = byId.get(targetId);
    if (!target) {
      skipped.push({ id: targetId, reason: allIds.has(targetId) ? 'target_out_of_scope' : 'missing_target' });
      continue;
    }
    if (!target.note) {
      skipped.push({ id: targetId, reason: 'target_unparsed' });
      continue;
    }
    if (target.note.status !== 'active') {
      skipped.push({ id: targetId, reason: 'target_not_active' });
      continue;
    }
    if (target.note.superseded_by) {
      skipped.push({ id: targetId, reason: 'target_already_superseded' });
      continue;
    }
    if (target.note.valid_to !== null && target.note.valid_to !== undefined) {
      skipped.push({ id: targetId, reason: 'target_has_valid_to' });
      continue;
    }
    if (!isValidAt(target.note, nowMs)) {
      skipped.push({ id: targetId, reason: 'target_not_valid_at_now' });
      continue;
    }
    const before = { ...fieldsOf(target.note), body_sha256: bodyHash(target) };
    const after = { ...before, status: 'archived' };
    operations.push({
      op: 'archive',
      id: targetId,
      superseded_by: null,
      valid_to: null,
      rationale: `显式请求归档 ${targetId}；它仍 active、时间上有效且没有关闭字段`,
      before,
      after,
      est_tokens: 0,
    });
    plannedIds.add(targetId);
  }

  const scanned = visible.filter((e) => e.note).length;
  // 5% 保险丝是给大库用的；小库上 `floor(10 * 0.05) = 0` 会让任何一次清理都
  // 被拦下，功能等于不存在。所以至少允许 1 条——仍然远小于「一次改半个库」。
  const allowed = Math.max(1, Math.floor(scanned * ratio));
  const archiveCount = operations.filter((op) => op.op === 'archive').length;
  const stats = {
    scanned,
    planned: operations.length,
    allowed,
    change_ratio: scanned > 0 ? round(operations.length / scanned) : 0,
    est_tokens: 0,
    invalidate: operations.length - archiveCount,
    archive: archiveCount,
  };

  const base = {
    runId: id,
    createdAt,
    operations,
    skipped: skipped.sort((a, b) => String(a.id).localeCompare(String(b.id)) || String(a.reason).localeCompare(String(b.reason))),
    stats,
    options: { max_change_ratio: ratio, scope: scope ?? null, kinds: listOf(kinds), archive: uniqueIdsOf(archiveIds) },
  };
  if (operations.length > allowed) {
    return {
      ok: false,
      status: 'aborted',
      reason: 'change_ratio_exceeded',
      ...base,
      message: `计划改 ${operations.length} 条，超过本次允许的 ${allowed} 条（${Math.round(ratio * 100)}% 保险丝）`,
    };
  }
  return { ok: true, status: 'planned', ...base };
}

/**
 * 巩固回执：把「实际改了什么」固化成可核验 JSON。
 *
 * 不存正文，只存正文 hash 与三个元数据字段的前后值。撤销只需要根据 before
 * 恢复元数据；正文没动过，就不需要把记忆内容复制进回执。
 */
export function buildConsolidateReceipt({ plan, store, applied = [], skipped = [], nowMs = Date.now() } = {}) {
  const unsigned = {
    schema: CONSOLIDATE_SCHEMA,
    kind: CONSOLIDATE_KIND,
    runId: plan?.runId,
    createdAt: isoLocal(nowMs),
    store: store ?? null,
    plan_created_at: plan?.createdAt ?? null,
    options: plan?.options ?? null,
    stats: {
      ...(plan?.stats ?? {}),
      applied: applied.length,
      skipped: skipped.length,
      failed: skipped.filter((s) => s?.reason && !String(s.reason).startsWith('target_')).length,
      invalidate: applied.filter((op) => op.op === 'invalidate').length,
      archive: applied.filter((op) => op.op === 'archive').length,
    },
    operations: applied.map((op) => ({
      op: op.op,
      id: op.id,
      superseded_by: op.superseded_by ?? null,
      valid_to: op.valid_to ?? null,
      rationale: op.rationale,
      before: op.before,
      after: op.after,
      before_text_sha256: op.before_text_sha256 ?? null,
      after_text_sha256: op.after_text_sha256 ?? null,
    })),
    skipped,
    reversible: true,
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned), CONSOLIDATE_HASH_LEN) };
}

export function consolidateReceiptProblems(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['回执必须是 JSON 对象'];
  const problems = [];
  if (receipt.schema !== CONSOLIDATE_SCHEMA) problems.push(`schema 必须是 ${CONSOLIDATE_SCHEMA}`);
  if (receipt.kind !== CONSOLIDATE_KIND) problems.push(`kind 必须是 ${CONSOLIDATE_KIND}`);
  if (typeof receipt.runId !== 'string' || !receipt.runId.startsWith('run_')) problems.push('runId 缺失或非法');
  if (typeof receipt.hash !== 'string' || receipt.hash.length !== CONSOLIDATE_HASH_LEN) problems.push('hash 缺失或长度不对');
  if (!Array.isArray(receipt.operations)) problems.push('operations 必须是数组');
  if (receipt.reversible !== true) problems.push('reversible 必须是 true');
  for (const op of receipt.operations ?? []) {
    if (!op || typeof op !== 'object') {
      problems.push('operation 必须是对象');
      continue;
    }
    if (!CONSOLIDATE_OPERATIONS.includes(op.op)) problems.push(`不认识的 operation：${op.op}`);
    if (typeof op.id !== 'string' || op.id === '') problems.push('operation.id 缺失');
    if (!op.before || typeof op.before !== 'object') problems.push(`${op.id} 缺 before`);
    if (!op.after || typeof op.after !== 'object') problems.push(`${op.id} 缺 after`);
  }
  return problems;
}

/** 回执自身 hash（不包含 hash 字段）。 */
export function consolidateReceiptHash(receipt) {
  const { hash: _ignored, ...unsigned } = receipt ?? {};
  return sha256(canonicalJson(unsigned), CONSOLIDATE_HASH_LEN);
}

export function receiptIntegrity(receipt) {
  const shape = consolidateReceiptProblems(receipt);
  if (shape.length) return { ok: false, problems: shape };
  if (consolidateReceiptHash(receipt) !== receipt.hash) {
    return { ok: false, problems: ['hash 与内容不一致'] };
  }
  return { ok: true, problems: [] };
}
