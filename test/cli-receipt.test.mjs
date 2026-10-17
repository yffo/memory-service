/**
 * `bin/memory` 的回执 / explain / verify 端到端用例。
 *
 * 这层必须真起进程：回执的写入位置、`--json` 形状、退出码（verified=0，
 * drifted/tampered=1，用法错误=2）都只有在真实 CLI 上才测得到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'memory');

function cli(args, { store } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MEMORY_STORE: store },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function seeded(prefix = 'memory-receipt-') {
  const dir = tempDir(prefix);
  const md = join(dir, 'inbox-note.md');
  writeFileSync(md, '# acme-widget 构建\n\nacme-widget 的构建命令是 `pnpm run build`，产物落在 `dist/` 目录。\n', 'utf8');
  const w = cli(['remember', '--file', md, '--json', '--kind', 'semantic', '--trust', 'user_stated'], { store: dir });
  assert.equal(w.code, 0, w.stderr);
  return { dir, id: w.json.id };
}

function runsFiles(dir) {
  try {
    return readdirSync(join(dir, 'runs')).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

test('CLI recall --receipt：附带回执但不落盘，且回执不含正文', () => {
  const { dir, id } = seeded('memory-receipt-flag-');
  try {
    const before = runsFiles(dir);
    const r = cli(['recall', '--query', 'acme-widget 构建命令', '--receipt', '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.receipt.schema, 'tabellio.receipt/1');
    assert.equal(r.json.receipt.decision.refused, false);
    const item = r.json.receipt.items.find((x) => x.id === id);
    assert.ok(item, '回执里必须有命中的笔记');
    assert.ok(item.noteSha256);
    assert.ok(!('content' in item), '回执不许复制正文');
    assert.equal(r.json.receiptPath, undefined);
    assert.deepEqual(runsFiles(dir), before, '--receipt 不许落盘');
  } finally {
    rm(dir);
  }
});

test('CLI recall --save-receipt：回执落盘失败退 1，并带 receiptError', () => {
  const { dir } = seeded('memory-receipt-writefail-');
  try {
    // 把 runs/ 换成同名普通文件，制造一次真实的落盘失败。
    rmSync(join(dir, 'runs'), { recursive: true, force: true });
    writeFileSync(join(dir, 'runs'), 'not a directory', 'utf8');
    const r = cli(['recall', '--query', 'acme-widget 构建命令', '--save-receipt', '--json'], { store: dir });
    assert.equal(r.code, 1, r.stderr);
    assert.ok(r.json.receipt, '回执行本身仍应返回，方便调用方排查');
    assert.equal(r.json.receiptError.code, 'E_RECEIPT_WRITE');
    assert.equal(r.json.receiptPath, undefined);
  } finally {
    rm(dir);
  }
});

test('CLI recall 默认：不生成回执，也不写 runs/', () => {
  const { dir } = seeded('memory-receipt-default-');
  try {
    const before = runsFiles(dir);
    const r = cli(['recall', '--query', 'acme-widget 构建命令', '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.receipt, undefined);
    assert.deepEqual(runsFiles(dir), before);
  } finally {
    rm(dir);
  }
});

test('CLI recall --save-receipt + verify：落盘、核验通过、改正文后 drifted', () => {
  const { dir, id } = seeded('memory-receipt-save-');
  try {
    const saved = cli(['recall', '--query', 'acme-widget 构建命令', '--save-receipt', '--json'], { store: dir });
    assert.equal(saved.code, 0, saved.stderr);
    assert.ok(saved.json.receiptPath.endsWith('.json'));
    const onDisk = JSON.parse(readFileSync(saved.json.receiptPath, 'utf8'));
    assert.equal(onDisk.receiptId, saved.json.receipt.receiptId);
    assert.equal(onDisk.hash, saved.json.receipt.hash);

    const ok = cli(['verify', '--receipt', saved.json.receipt.receiptId, '--json'], { store: dir });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.status, 'verified');
    assert.ok(ok.json.itemsChecked >= 1);

    const notePath = join(dir, 'notes', `${id}.md`);
    writeFileSync(notePath, `${readFileSync(notePath, 'utf8')}\n补一句。\n`, 'utf8');
    const drifted = cli(['verify', '--receipt', saved.json.receiptPath, '--json'], { store: dir });
    assert.equal(drifted.code, 1, drifted.stdout + drifted.stderr);
    assert.equal(drifted.json.status, 'drifted');
    assert.equal(drifted.json.changed[0].id, id);
    assert.ok(drifted.json.changed[0].fields.includes('noteSha256'));
  } finally {
    rm(dir);
  }
});

test('CLI verify：回执被改（hash 对不上）报 tampered，退出码 1', () => {
  const { dir } = seeded('memory-receipt-tamper-');
  try {
    const saved = cli(['recall', '--query', 'acme-widget 构建命令', '--save-receipt', '--json'], { store: dir });
    assert.equal(saved.code, 0, saved.stderr);
    const receipt = JSON.parse(readFileSync(saved.json.receiptPath, 'utf8'));
    receipt.query = '被改过的查询';
    writeFileSync(saved.json.receiptPath, JSON.stringify(receipt), 'utf8');

    const r = cli(['verify', '--receipt', saved.json.receipt.receiptId, '--json'], { store: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(r.json.status, 'tampered');
    assert.equal(r.json.problems[0].code, 'E_RECEIPT_HASH_MISMATCH');
  } finally {
    rm(dir);
  }
});

test('CLI explain --query：只读解释，不落盘', () => {
  const { dir } = seeded('memory-receipt-explain-');
  try {
    const before = runsFiles(dir);
    const r = cli(['explain', '--query', 'acme-widget 构建命令', '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.mode, 'query');
    assert.equal(r.json.receiptPath, null);
    assert.ok(r.json.explanation.summary.recalled >= 1);
    assert.equal(r.json.verification.status, 'verified');
    assert.deepEqual(runsFiles(dir), before, 'explain 不许写文件');
  } finally {
    rm(dir);
  }
});

test('CLI explain --receipt：按已落盘回执解释，不重跑检索', () => {
  const { dir, id } = seeded('memory-receipt-explain-id-');
  try {
    const saved = cli(['recall', '--query', 'acme-widget 构建命令', '--save-receipt', '--json'], { store: dir });
    assert.equal(saved.code, 0, saved.stderr);
    const r = cli(['explain', '--receipt', saved.json.receipt.receiptId, '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.mode, 'receipt');
    assert.equal(r.json.receiptId, saved.json.receipt.receiptId);
    assert.ok(r.json.explanation.recalled.some((x) => x.id === id));
  } finally {
    rm(dir);
  }
});

test('CLI 拒答也能留回执：退出码 1，但回执可核验、可解释', () => {
  const { dir } = seeded('memory-receipt-refusal-');
  try {
    const r = cli(['recall', '--query', '量子色动力学里的胶子禁闭', '--save-receipt', '--json'], { store: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(r.json.receipt.decision.refused, true);
    assert.ok(r.json.receiptPath);

    const v = cli(['verify', '--receipt', r.json.receipt.receiptId, '--json'], { store: dir });
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.equal(v.json.status, 'verified');

    const e = cli(['explain', '--receipt', r.json.receipt.receiptId, '--json'], { store: dir });
    assert.equal(e.code, 0, e.stderr);
    assert.equal(e.json.decision.refused, true);
    assert.equal(e.json.explanation.summary.recalled, 0);
  } finally {
    rm(dir);
  }
});

test('CLI explain / verify 用法错误：退出码 2，不吐 JSON', () => {
  const { dir } = seeded('memory-receipt-usage-');
  try {
    const noTarget = cli(['explain', '--json'], { store: dir });
    assert.equal(noTarget.code, 2);
    assert.equal(noTarget.json, null);
    const both = cli(['explain', '--query', 'x', '--receipt', 'rcp_01J9Z000000000000000000000', '--json'], { store: dir });
    assert.equal(both.code, 2);
    assert.equal(both.json, null);
    const noRef = cli(['verify', '--json'], { store: dir });
    assert.equal(noRef.code, 2);
    assert.equal(noRef.json, null);
  } finally {
    rm(dir);
  }
});
