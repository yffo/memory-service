/**
 * `src/store/receipt.js`：回执落盘、读取与拒绝覆盖。
 *
 * 这里钉住四条性质：
 *  1. 合法回执能原子落到 `runs/`，同 id 第二次写入拒绝覆盖；
 *  2. `readReceipt` 接受 id 与显式路径，非法 id 直接报错；
 *  3. 坏 JSON / 不认识的 schema 分别报 `E_RECEIPT_PARSE` / `E_RECEIPT_SCHEMA`；
 *  4. 读取端**不校验 hash**，否则被篡改的回执就无法被 explain 展示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRecallReceipt, receiptHash } from '../src/core/receipt.js';
import { recall } from '../src/core/recall.js';
import { parseTime } from '../src/util/clock.js';
import { isReceiptId, readReceipt, receiptFilePath, writeReceipt } from '../src/store/receipt.js';

const NOW = parseTime('2026-10-17T12:00:00+08:00');
const ENTRY = {
  id: 'alpha',
  title: 'Alpha',
  body: '# Alpha\n\nAcme 的构建命令是 pnpm run build。',
  note: {
    kind: 'semantic',
    trust: 'user_stated',
    scope: 'user',
    status: 'active',
    confidence: 0.9,
    valid_from: '2026-10-10T12:00:00+08:00',
    valid_to: null,
  },
};

function receiptOf() {
  const entries = [ENTRY];
  const result = recall({ entries, query: 'Acme 的构建命令是什么', options: { nowMs: NOW } });
  return buildRecallReceipt({
    result,
    entries,
    store: '/tmp/tabellio-store-receipt-test',
    query: 'Acme 的构建命令是什么',
    options: { nowMs: NOW },
    nowMs: NOW,
    receiptId: 'rcp_01J9Z000000000000000000001',
  });
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tabellio-receipt-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeReceipt：原子落 runs/，同 id 拒绝覆盖', () => withStore((dir) => {
  const receipt = receiptOf();
  const saved = writeReceipt(dir, receipt);
  assert.equal(saved.ok, true);
  assert.equal(saved.path, receiptFilePath(dir, receipt.receiptId));
  assert.equal(saved.receiptId, receipt.receiptId);
  assert.ok(existsSync(saved.path));
  assert.deepEqual(JSON.parse(readFileSync(saved.path, 'utf8')), receipt);

  const again = writeReceipt(dir, receipt);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'E_RECEIPT_EXISTS');
}));

test('readReceipt：按 id 与显式路径都能读，非法 id 报 E_RECEIPT_ID_INVALID', () => withStore((dir) => {
  const receipt = receiptOf();
  const saved = writeReceipt(dir, receipt);
  const byId = readReceipt(dir, receipt.receiptId);
  assert.equal(byId.ok, true);
  assert.equal(byId.receipt.receiptId, receipt.receiptId);
  assert.equal(byId.path, saved.path);

  const byPath = readReceipt(dir, saved.path);
  assert.equal(byPath.ok, true);
  assert.equal(byPath.receipt.receiptId, receipt.receiptId);

  const bad = readReceipt(dir, 'rcp_not-a-real-id');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'E_RECEIPT_ID_INVALID');
  assert.equal(isReceiptId('rcp_01J9Z000000000000000000001'), true);
  assert.equal(isReceiptId('../escape'), false);
}));

test('readReceipt：坏 JSON 与不认识的 schema 分开报错', () => withStore((dir) => {
  const receipt = receiptOf();
  const saved = writeReceipt(dir, receipt);

  writeFileSync(saved.path, '{not json', 'utf8');
  const broken = readReceipt(dir, receipt.receiptId);
  assert.equal(broken.ok, false);
  assert.equal(broken.error.code, 'E_RECEIPT_PARSE');

  writeFileSync(saved.path, JSON.stringify({ schema: 'tabellio.receipt/999' }), 'utf8');
  const wrongSchema = readReceipt(dir, receipt.receiptId);
  assert.equal(wrongSchema.ok, false);
  assert.equal(wrongSchema.error.code, 'E_RECEIPT_SCHEMA');
}));

test('readReceipt：不校验 hash，篡改过的回执照样能打开（交给 verify 判 tampered）', () => withStore((dir) => {
  const receipt = receiptOf();
  const saved = writeReceipt(dir, receipt);
  const tampered = { ...receipt, query: '被改过的查询' };
  writeFileSync(saved.path, JSON.stringify(tampered), 'utf8');

  const got = readReceipt(dir, receipt.receiptId);
  assert.equal(got.ok, true);
  assert.equal(got.receipt.query, '被改过的查询');
  assert.equal(got.receipt.hash, receipt.hash, 'hash 字段还是旧的');
  assert.notEqual(receiptHash(got.receipt), got.receipt.hash, '按内容重算的 hash 必须对不上，verify 才能判 tampered');
}));
