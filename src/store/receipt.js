/**
 * 回执的落盘与读取（`<store>/runs/<receipt-id>.json`）。
 *
 * 放在 `runs/` 而不是另开目录，是为了和 `06-architecture.md §2.2` 的
 * 「runs/<run-id>.json → receipt」保持同一个账本位置；巩固回执以后也落这里。
 *
 * 写入用 tmp + rename，保证读者永远看不到半截 JSON；已存在的 id 拒绝覆盖，
 * 避免「重跑一次把旧回执悄悄换掉」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { paths } from './vault.js';
import { receiptHash, receiptShapeProblems } from '../core/receipt.js';

const RECEIPT_ID_RE = /^rcp_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isReceiptId(value) {
  return typeof value === 'string' && RECEIPT_ID_RE.test(value);
}

/** 合法 id 返回绝对路径，非法返回 null（调用方负责报错）。 */
export function receiptFilePath(storePath, receiptId) {
  if (!isReceiptId(receiptId)) return null;
  return join(paths(storePath).runs, `${receiptId}.json`);
}

function errorOf(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

/** 保存回执；不覆盖同 id 文件。 */
export function writeReceipt(storePath, receipt) {
  const id = receipt?.receiptId;
  if (!isReceiptId(id)) return errorOf('E_RECEIPT_ID_INVALID', '回执 id 必须是 rcp_ + 26 位 Crockford Base32');
  const shape = receiptShapeProblems(receipt);
  if (shape.length) return errorOf('E_RECEIPT_SHAPE', shape.join('；'));
  const computed = receiptHash(receipt);
  if (computed !== receipt.hash) return errorOf('E_RECEIPT_HASH_MISMATCH', '回执 hash 与内容不一致，拒绝落盘');
  const filePath = receiptFilePath(storePath, id);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) return errorOf('E_RECEIPT_EXISTS', '同 id 回执已存在，拒绝覆盖', { path: filePath });
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, filePath);
    return { ok: true, path: filePath, bytes: Buffer.byteLength(text), receiptId: id };
  } catch (err) {
    return errorOf('E_RECEIPT_WRITE', err?.message ?? String(err), { path: filePath });
  }
}

/**
 * 读取回执：`ref` 可以是回执 id，也可以是显式文件路径。
 *
 * 这里**不校验 hash**（只校验形状）：explain 需要能打开一张被篡改的回执并
 * 把 tampered 状态展示出来；如果这里先拒绝，就无法解释「它为什么不可信」。
 */
export function readReceipt(storePath, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return errorOf('E_RECEIPT_ID_INVALID', '需要回执 id 或路径');
  const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.endsWith('.json');
  const filePath = looksLikePath ? resolve(raw) : receiptFilePath(storePath, raw);
  if (!filePath) return errorOf('E_RECEIPT_ID_INVALID', '回执 id 必须是 rcp_ + 26 位 Crockford Base32', { ref: raw });
  if (!existsSync(filePath)) return errorOf('E_RECEIPT_NOT_FOUND', '找不到回执文件', { path: filePath });
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    return errorOf('E_RECEIPT_UNREADABLE', err?.message ?? String(err), { path: filePath });
  }
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch (err) {
    return errorOf('E_RECEIPT_PARSE', `回执不是合法 JSON：${err?.message ?? err}`, { path: filePath });
  }
  if (receipt?.schema !== 'tabellio.receipt/1') {
    return errorOf('E_RECEIPT_SCHEMA', '不认识的 receipt schema', { path: filePath, schema: receipt?.schema ?? null });
  }
  const shape = receiptShapeProblems(receipt);
  if (shape.length) return errorOf('E_RECEIPT_SHAPE', shape.join('；'), { path: filePath });
  return { ok: true, receipt, path: filePath };
}
