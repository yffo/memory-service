/**
 * 内容类巩固的回执（merge / summarize / promote 的执行层）。
 *
 * 与元数据巩固回执分开一个 schema，因为撤销语义不同：
 *
 *   - 元数据巩固只改已有笔记的三个字段，撤销 = 把字段写回 before；
 *   - 内容类巩固会**新建一条目标笔记**，撤销 = 删除目标 + 把源字段写回 before。
 *
 * 回执不存正文，只存目标正文 hash、目标文件 hash、源正文 hash 与源字段前后值。
 * 这样回执可以安全地留在 `runs/` 里，也足够 undo 做「整单预检」。
 */
import { sha256 } from '../util/text.js';
import { canonicalJson } from './receipt.js';
import { isoLocal } from '../util/clock.js';
import { CONSOLIDATE_HASH_LEN } from './consolidate.js';

export const CONTENT_RECEIPT_SCHEMA = 'tabellio.consolidate.content/1';
export const CONTENT_RECEIPT_KIND = 'consolidate_content';
export const CONTENT_RECEIPT_OPERATIONS = Object.freeze(['create_target', 'invalidate_source']);

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function sourceEntry(op) {
  return {
    id: op.id,
    before: op.before,
    after: op.after,
    body_sha256: op.body_sha256 ?? op.after?.body_sha256 ?? null,
    before_text_sha256: op.before_text_sha256 ?? null,
    after_text_sha256: op.after_text_sha256 ?? null,
  };
}

/** 生成内容类巩固回执（hash 覆盖除 hash 自身以外的全部字段）。 */
export function buildContentReceipt({ plan, store, target, sources = [], nowMs = Date.now() } = {}) {
  const mode = plan?.mode ?? null;
  const unsigned = {
    schema: CONTENT_RECEIPT_SCHEMA,
    kind: CONTENT_RECEIPT_KIND,
    runId: plan?.runId,
    proposal_id: plan?.proposal_id ?? plan?.proposalId ?? null,
    createdAt: isoLocal(nowMs),
    store: store ?? null,
    mode,
    options: {
      max_change_ratio: plan?.options?.max_change_ratio ?? plan?.maxChangeRatio ?? null,
    },
    stats: {
      ...(plan?.stats ?? {}),
      applied: 1 + sources.length,
      sources: sources.length,
      target_chars: target?.chars ?? 0,
      target_tokens: target?.tokens ?? 0,
      saved_chars: plan?.stats?.saved_chars ?? 0,
      saved_tokens: plan?.stats?.saved_tokens ?? 0,
      saved_ratio: plan?.stats?.saved_ratio ?? 0,
      change_ratio: plan?.stats?.estimated_change_ratio ?? 0,
    },
    target: {
      id: target?.id,
      path: target?.path,
      bucket: target?.bucket ?? (mode === 'promote' ? 'candidates' : 'notes'),
      status: target?.status,
      chars: target?.chars ?? 0,
      tokens: target?.tokens ?? 0,
      body_sha256: target?.body_sha256,
      text_sha256: target?.text_sha256,
    },
    operations: [
      {
        op: 'create_target',
        id: target?.id,
        path: target?.path,
        bucket: target?.bucket ?? (mode === 'promote' ? 'candidates' : 'notes'),
        body_sha256: target?.body_sha256,
        text_sha256: target?.text_sha256,
      },
      ...sources.map((op) => ({ op: 'invalidate_source', ...sourceEntry(op) })),
    ],
    reversible: true,
  };
  return { ...unsigned, hash: sha256(canonicalJson(unsigned), CONSOLIDATE_HASH_LEN) };
}

export function contentReceiptProblems(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['回执必须是 JSON 对象'];
  const problems = [];
  if (receipt.schema !== CONTENT_RECEIPT_SCHEMA) problems.push(`schema 必须是 ${CONTENT_RECEIPT_SCHEMA}`);
  if (receipt.kind !== CONTENT_RECEIPT_KIND) problems.push(`kind 必须是 ${CONTENT_RECEIPT_KIND}`);
  if (typeof receipt.runId !== 'string' || !receipt.runId.startsWith('run_')) problems.push('runId 缺失或非法');
  if (typeof receipt.hash !== 'string' || receipt.hash.length !== CONSOLIDATE_HASH_LEN) problems.push('hash 缺失或长度不对');
  if (!Array.isArray(receipt.operations)) problems.push('operations 必须是数组');
  if (receipt.reversible !== true) problems.push('reversible 必须是 true');
  const target = receipt.target;
  if (!target || typeof target !== 'object') problems.push('target 缺失');
  else {
    if (typeof target.id !== 'string' || target.id === '') problems.push('target.id 缺失');
    if (typeof target.path !== 'string' || target.path === '') problems.push('target.path 缺失');
    if (typeof target.body_sha256 !== 'string' || target.body_sha256.length === 0) problems.push('target.body_sha256 缺失');
    if (typeof target.text_sha256 !== 'string' || target.text_sha256.length === 0) problems.push('target.text_sha256 缺失');
  }
  for (const op of receipt.operations ?? []) {
    if (!op || typeof op !== 'object') {
      problems.push('operation 必须是对象');
      continue;
    }
    if (!CONTENT_RECEIPT_OPERATIONS.includes(op.op)) problems.push(`不认识的 operation：${op.op}`);
    if (typeof op.id !== 'string' || op.id === '') problems.push('operation.id 缺失');
    if (op.op === 'invalidate_source') {
      if (!op.before || typeof op.before !== 'object') problems.push(`${op.id} 缺 before`);
      if (!op.after || typeof op.after !== 'object') problems.push(`${op.id} 缺 after`);
    }
  }
  return problems;
}

/** 回执自身 hash（不包含 hash 字段）。 */
export function contentReceiptHash(receipt) {
  const { hash: _ignored, ...unsigned } = receipt ?? {};
  return sha256(canonicalJson(unsigned), CONSOLIDATE_HASH_LEN);
}

export function contentReceiptIntegrity(receipt) {
  const shape = contentReceiptProblems(receipt);
  if (shape.length) return { ok: false, problems: shape };
  if (contentReceiptHash(receipt) !== receipt.hash) {
    return { ok: false, problems: ['hash 与内容不一致'] };
  }
  return { ok: true, problems: [] };
}

