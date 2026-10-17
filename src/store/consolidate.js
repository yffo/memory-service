/**
 * 巩固 run 的落盘与读取。
 *
 * 目录约定（都在 `<store>/runs/`，与 recall 回执同一个账本位置）：
 *   run_<ULID>.plan.json     决策（dry-run 默认不写；apply 时先写 plan 再改笔记）
 *   run_<ULID>.json          巩固回执（只含元数据 diff 与正文 hash，不含正文）
 *   run_<ULID>.undo.json     撤销记录（不修改原回执，避免把历史改掉）
 *
 * 写入一律 tmp + rename，且拒绝覆盖同 id 文件：重跑一次不能把旧账悄悄换掉。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { paths } from './vault.js';
import { consolidateReceiptProblems, receiptIntegrity } from '../core/consolidate.js';

const RUN_ID_RE = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

export function runPlanPath(storePath, runId) {
  if (!isRunId(runId)) return null;
  return join(paths(storePath).runs, `${runId}.plan.json`);
}

export function runReceiptPath(storePath, runId) {
  if (!isRunId(runId)) return null;
  return join(paths(storePath).runs, `${runId}.json`);
}

export function runUndoPath(storePath, runId) {
  if (!isRunId(runId)) return null;
  return join(paths(storePath).runs, `${runId}.undo.json`);
}

function errorOf(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function writeJsonNoOverwrite(filePath, value, code = 'E_RUN_WRITE') {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) return errorOf('E_RUN_EXISTS', '同 id 的 run 文件已存在，拒绝覆盖', { path: filePath });
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, filePath);
    return { ok: true, path: filePath, bytes: Buffer.byteLength(text) };
  } catch (err) {
    return errorOf(code, err?.message ?? String(err), { path: filePath });
  }
}

/** 写计划文件（apply 前）。 */
export function writeRunPlan(storePath, plan) {
  const id = plan?.runId;
  if (!isRunId(id)) return errorOf('E_RUN_ID_INVALID', 'runId 必须是 run_ + 26 位 Crockford Base32');
  const filePath = runPlanPath(storePath, id);
  const doc = { schema: 'tabellio.consolidate.plan/1', ...plan };
  return writeJsonNoOverwrite(filePath, doc, 'E_RUN_PLAN_WRITE');
}

/** 写巩固回执（apply 后）。 */
export function writeRunReceipt(storePath, receipt) {
  const id = receipt?.runId;
  if (!isRunId(id)) return errorOf('E_RUN_ID_INVALID', 'runId 必须是 run_ + 26 位 Crockford Base32');
  const shape = consolidateReceiptProblems(receipt);
  if (shape.length) return errorOf('E_RUN_SHAPE', shape.join('；'));
  const integrity = receiptIntegrity(receipt);
  if (!integrity.ok) return errorOf('E_RUN_HASH_MISMATCH', integrity.problems.join('；'));
  const filePath = runReceiptPath(storePath, id);
  return writeJsonNoOverwrite(filePath, receipt, 'E_RUN_RECEIPT_WRITE');
}

/** 写撤销记录（undo 成功后）。 */
export function writeUndoRecord(storePath, record) {
  const id = record?.runId;
  if (!isRunId(id)) return errorOf('E_RUN_ID_INVALID', 'runId 必须是 run_ + 26 位 Crockford Base32');
  const filePath = runUndoPath(storePath, id);
  return writeJsonNoOverwrite(filePath, record, 'E_UNDO_WRITE');
}

function readJson(ref, idResolver, codePrefix) {
  const raw = String(ref ?? '').trim();
  if (!raw) return errorOf(`${codePrefix}_ID_INVALID`, '需要 run id 或路径');
  const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.endsWith('.json');
  const filePath = looksLikePath ? resolve(raw) : idResolver(raw);
  if (!filePath) return errorOf(`${codePrefix}_ID_INVALID`, 'run id 必须是 run_ + 26 位 Crockford Base32', { ref: raw });
  if (!existsSync(filePath)) return errorOf(`${codePrefix}_NOT_FOUND`, '找不到 run 文件', { path: filePath });
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    return errorOf(`${codePrefix}_UNREADABLE`, err?.message ?? String(err), { path: filePath });
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return errorOf(`${codePrefix}_PARSE`, `不是合法 JSON：${err?.message ?? err}`, { path: filePath });
  }
  return { ok: true, doc, path: filePath };
}

/**
 * 读取巩固回执。**只校验形状**，不校验 hash —— 与 recall 的 readReceipt 同口径：
 * 调用方（undo / doctor）需要能打开一张被篡改的回执并把 tampered 报出来。
 */
export function readRunReceipt(storePath, ref) {
  const got = readJson(ref, (id) => runReceiptPath(storePath, id), 'E_RUN');
  if (!got.ok) return got;
  if (got.doc?.schema !== 'tabellio.consolidate/1') {
    return errorOf('E_RUN_SCHEMA', '不认识的 consolidate receipt schema', { path: got.path, schema: got.doc?.schema ?? null });
  }
  const shape = consolidateReceiptProblems(got.doc);
  if (shape.length) return errorOf('E_RUN_SHAPE', shape.join('；'), { path: got.path });
  return { ok: true, receipt: got.doc, path: got.path, integrity: receiptIntegrity(got.doc) };
}

/** 读取计划文件（--show 或调试用；不参与 undo）。 */
export function readRunPlan(storePath, ref) {
  const got = readJson(ref, (id) => runPlanPath(storePath, id), 'E_PLAN');
  if (!got.ok) return got;
  return { ok: true, plan: got.doc, path: got.path };
}

/** 读撤销记录（存在即说明这个 run 已撤销过）。 */
export function readUndoRecord(storePath, runId) {
  const filePath = runUndoPath(storePath, runId);
  if (!filePath) return errorOf('E_RUN_ID_INVALID', 'runId 不合法');
  if (!existsSync(filePath)) return errorOf('E_UNDO_NOT_FOUND', '这个 run 还没有撤销记录', { path: filePath });
  return readJson(filePath, () => filePath, 'E_UNDO');
}
