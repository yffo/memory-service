/**
 * `tabellio consolidate` / `--undo` 的端到端用例。
 *
 * 这里必须真起进程：默认 dry-run、--json 形状、退出码都只有真实 CLI 才能测到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function runsFiles(dir) {
  try {
    return readdirSync(join(dir, 'runs')).sort();
  } catch {
    return [];
  }
}

function seedPair(prefix = 'memory-cli-consolidate-') {
  const dir = tempDir(prefix);
  const aFile = join(dir, 'a.md');
  writeFileSync(aFile, '---\nkind: semantic\ntrust: user_stated\n---\n\n# 构建命令\n\n旧构建命令是 pnpm run build。\n', 'utf8');
  const a = cli(['remember', '--file', aFile, '--json'], { store: dir });
  assert.equal(a.code, 0, a.stderr);
  const bFile = join(dir, 'b.md');
  writeFileSync(bFile, `---\nkind: semantic\ntrust: user_stated\nsupersedes: [${a.json.id}]\n---\n\n# 构建命令 v2\n\n新的构建命令是 npm run build。\n`, 'utf8');
  const b = cli(['remember', '--file', bFile, '--json'], { store: dir });
  assert.equal(b.code, 0, b.stderr);
  return { dir, a: a.json.id, b: b.json.id };
}

function getNote(dir, id) {
  const r = cli(['read', '--id', id, '--json'], { store: dir });
  assert.equal(r.code, 0, r.stderr);
  return r.json;
}

test('CLI consolidate 默认 dry-run：只出计划，不改笔记，不写 runs/', () => {
  const { dir, a } = seedPair('memory-cli-consolidate-dry-');
  try {
    const before = getNote(dir, a);
    const r = cli(['consolidate', '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, 'planned');
    assert.equal(r.json.dry_run, true);
    assert.match(r.json.run_id, /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(r.json.operations.length, 1);
    assert.equal(getNote(dir, a).note.valid_to, null);
    assert.equal(getNote(dir, a).body, before.body);
    assert.deepEqual(runsFiles(dir), []);
  } finally {
    rm(dir);
  }
});

test('CLI consolidate --apply：改元数据、正文不变、回执可读', () => {
  const { dir, a, b } = seedPair('memory-cli-consolidate-apply-');
  try {
    const before = getNote(dir, a);
    const r = cli(['consolidate', '--apply', '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, 'applied');
    assert.equal(r.json.dry_run, false);
    assert.equal(r.json.applied, 1);
    assert.ok(existsSync(r.json.plan_path));
    assert.ok(existsSync(r.json.receipt_path));
    const receipt = JSON.parse(readFileSync(r.json.receipt_path, 'utf8'));
    assert.equal(receipt.kind, 'consolidate');
    assert.equal(receipt.operations[0].id, a);
    assert.ok(!JSON.stringify(receipt).includes('旧构建命令'));

    const after = getNote(dir, a);
    assert.equal(after.note.valid_to !== null, true);
    assert.equal(after.note.superseded_by, b);
    assert.equal(after.body, before.body);
  } finally {
    rm(dir);
  }
});

test('CLI consolidate --undo：恢复、二次撤销、退出码为 0', () => {
  const { dir, a } = seedPair('memory-cli-consolidate-undo-');
  try {
    const apply = cli(['consolidate', '--apply', '--json'], { store: dir });
    assert.equal(apply.code, 0, apply.stderr);
    const undo = cli(['consolidate', '--undo', apply.json.run_id, '--json'], { store: dir });
    assert.equal(undo.code, 0, undo.stderr);
    assert.equal(undo.json.status, 'undone');
    assert.equal(undo.json.restored, 1);
    assert.equal(getNote(dir, a).note.valid_to, null);
    assert.equal(getNote(dir, a).note.superseded_by, null);

    const again = cli(['consolidate', '--undo', apply.json.run_id, '--json'], { store: dir });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.status, 'already_undone');
  } finally {
    rm(dir);
  }
});

test('CLI consolidate --undo：正文被改过时退 1，整单 conflict', () => {
  const { dir, a } = seedPair('memory-cli-consolidate-conflict-');
  try {
    const apply = cli(['consolidate', '--apply', '--json'], { store: dir });
    assert.equal(apply.code, 0, apply.stderr);
    const path = getNote(dir, a).path;
    writeFileSync(path, readFileSync(path, 'utf8') + '\n外部补充。\n', 'utf8');
    const undo = cli(['consolidate', '--undo', apply.json.run_id, '--json'], { store: dir });
    assert.equal(undo.code, 1, undo.stdout + undo.stderr);
    assert.equal(undo.json.status, 'conflict');
    assert.equal(undo.json.conflicts[0].reason, 'body_changed');
    assert.equal(getNote(dir, a).note.valid_to !== null, true, '冲突时不许部分撤销');
  } finally {
    rm(dir);
  }
});

test('CLI consolidate --undo：回执被篡改时退 1，并报 tampered', () => {
  const { dir, a } = seedPair('memory-cli-consolidate-tampered-');
  try {
    const apply = cli(['consolidate', '--apply', '--json'], { store: dir });
    assert.equal(apply.code, 0, apply.stderr);
    const doc = JSON.parse(readFileSync(apply.json.receipt_path, 'utf8'));
    doc.store = '/tmp/another-store';
    writeFileSync(apply.json.receipt_path, JSON.stringify(doc, null, 2), 'utf8');
    const undo = cli(['consolidate', '--undo', apply.json.run_id, '--json'], { store: dir });
    assert.equal(undo.code, 1, undo.stdout + undo.stderr);
    assert.equal(undo.json.status, 'tampered');
    assert.equal(getNote(dir, a).note.valid_to !== null, true);
  } finally {
    rm(dir);
  }
});

test('CLI consolidate：参数错误一律退 2', () => {
  const dir = tempDir('memory-cli-consolidate-usage-');
  try {
    const both = cli(['consolidate', '--apply', '--dry-run'], { store: dir });
    assert.equal(both.code, 2);
    const undoMissing = cli(['consolidate', '--undo'], { store: dir });
    assert.equal(undoMissing.code, 2);
    const badRatio = cli(['consolidate', '--max-change-ratio', '2'], { store: dir });
    assert.equal(badRatio.code, 2);
    const undoWithApply = cli(['consolidate', '--undo', 'run_x', '--apply'], { store: dir });
    assert.equal(undoWithApply.code, 2);
  } finally {
    rm(dir);
  }
});
