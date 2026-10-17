/**
 * tabellio capture / tabellio inbox 的 CLI 端到端用例。
 *
 * 候选箱是「捕获不等于入库」这条产品承诺的入口；这里真起进程，盯的是
 * 文件、stdout JSON 契约和退出码，而不是内部函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'bin', 'memory');

function cli(args, { store, input } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...(store ? { MEMORY_STORE: store } : {}) },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function fresh(prefix) {
  const dir = tempDir(prefix);
  return dir;
}

function captureFile(dir, text) {
  const file = join(dir, 'candidate.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return file;
}

test('CLI capture：文件与 stdin 都能收候选，且不进检索面', () => {
  const dir = fresh('memory-cli-capture-');
  try {
    const file = captureFile(dir, '# 项目代号\n\n内部代号是青鸟。\n');
    const fromFile = cli(['capture', '--file', file, '--source', 'session:1', '--json'], { store: dir });
    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.equal(fromFile.json.ok, true);
    assert.equal(fromFile.json.title, '项目代号');
    assert.equal(fromFile.json.source, 'session:1');
    assert.ok(fromFile.json.id);

    const fromStdin = cli(['capture', '--file', '-', '--json'], {
      store: dir,
      input: '# 另一个代号\n\n外部代号是白鹭。\n',
    });
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
    assert.equal(fromStdin.json.ok, true);
    assert.equal(fromStdin.json.title, '另一个代号');

    const status = cli(['status', '--json'], { store: dir });
    assert.equal(status.json.notes, 0);
    assert.equal(status.json.candidates, 2);

    const search = cli(['search', '--query', '青鸟', '--json'], { store: dir });
    assert.equal(search.json.refused, true);
    assert.deepEqual(search.json.hits, []);
  } finally {
    rm(dir);
  }
});

test('CLI capture：缺文件/空文本/重复内容/坏 id 的退出码', () => {
  const dir = fresh('memory-cli-capture-bad-');
  try {
    const missing = cli(['capture', '--file', join(dir, 'nope.md'), '--json'], { store: dir });
    assert.equal(missing.code, 2);

    const empty = cli(['capture', '--file', '-', '--json'], { store: dir, input: '   \n' });
    assert.equal(empty.code, 1);
    assert.equal(empty.json.reason, 'empty');

    const file = captureFile(dir, '内部代号是青鸟，只在周会里说。');
    const first = cli(['capture', '--file', file, '--json'], { store: dir });
    assert.equal(first.code, 0, first.stderr);
    const again = cli(['capture', '--file', file, '--json'], { store: dir });
    assert.equal(again.code, 1);
    assert.equal(again.json.reason, 'duplicate');

    const badId = cli(['capture', '--file', file, '--id', '../escape', '--force', '--json'], { store: dir });
    assert.equal(badId.code, 1);
    assert.equal(badId.json.reason, 'invalid_id');
  } finally {
    rm(dir);
  }
});

test('CLI inbox：列表、accept、reject 与 status 计数', () => {
  const dir = fresh('memory-cli-inbox-');
  try {
    const file = captureFile(dir, '# 项目代号\n\n内部代号是青鸟。\n');
    const captured = cli(['capture', '--file', file, '--json'], { store: dir });
    assert.equal(captured.code, 0, captured.stderr);
    const id = captured.json.id;

    const listed = cli(['inbox', '--json'], { store: dir });
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.json.count, 1);
    assert.equal(listed.json.candidates[0].id, id);
    assert.equal(listed.json.candidates[0].chars, captured.json.chars);

    const human = cli(['inbox'], { store: dir });
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, new RegExp(id));
    assert.match(human.stdout, /候选 1 条/);

    const accepted = cli(['inbox', '--accept', id, '--json'], { store: dir });
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(accepted.json.accepted_count, 1);
    assert.equal(accepted.json.failed_count, 0);

    const status = cli(['status', '--json'], { store: dir });
    assert.equal(status.json.notes, 1);
    assert.equal(status.json.candidates, 0);
    assert.equal(existsSync(join(dir, 'notes', 'candidates', 'decided', id + '.md')), true);

    const search = cli(['search', '--query', '青鸟', '--json'], { store: dir });
    assert.equal(search.json.refused, false);
    assert.deepEqual(search.json.hits.map((h) => h.id), [id]);
  } finally {
    rm(dir);
  }
});

test('CLI inbox：reject 归档且不入库；dry-run 不移动', () => {
  const dir = fresh('memory-cli-inbox-reject-');
  try {
    const file = captureFile(dir, '# 传闻\n\n外部传闻说下周放假，未核实。\n');
    const captured = cli(['capture', '--file', file, '--json'], { store: dir });
    const id = captured.json.id;

    const dry = cli(['inbox', '--reject', id, '--dry', '--json'], { store: dir });
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json.dry_run, true);
    assert.equal(dry.json.rejected_count, 1);
    assert.equal(existsSync(join(dir, 'notes', 'candidates', id + '.md')), true);

    const rejected = cli(['inbox', '--reject', id, '--json'], { store: dir });
    assert.equal(rejected.code, 0, rejected.stderr);
    assert.equal(rejected.json.rejected_count, 1);
    assert.equal(existsSync(join(dir, 'notes', 'candidates', id + '.md')), false);
    assert.equal(existsSync(join(dir, 'notes', 'candidates', 'rejected', id + '.md')), true);
    const status = cli(['status', '--json'], { store: dir });
    assert.equal(status.json.notes, 0);
    assert.equal(status.json.candidates, 0);
  } finally {
    rm(dir);
  }
});

test('CLI inbox：缺 id、accept/reject 重叠、候选不存在都正确失败', () => {
  const dir = fresh('memory-cli-inbox-errors-');
  try {
    const missingValue = cli(['inbox', '--accept'], { store: dir });
    assert.equal(missingValue.code, 2);

    const file = captureFile(dir, '# 项目代号\n\n内部代号是青鸟。\n');
    const captured = cli(['capture', '--file', file, '--json'], { store: dir });
    const id = captured.json.id;

    const overlap = cli(['inbox', '--accept', id, '--reject', id, '--json'], { store: dir });
    assert.equal(overlap.code, 1);
    assert.equal(overlap.json.reason, 'accept_reject_overlap');
    assert.equal(existsSync(join(dir, 'notes', 'candidates', id + '.md')), true);

    const notFound = cli(['inbox', '--accept', '01M554B3JYZ1NH8QZCQ73Q6CSX', '--json'], { store: dir });
    assert.equal(notFound.code, 1);
    assert.equal(notFound.json.failed[0].reason, 'candidate_not_found');
  } finally {
    rm(dir);
  }
});
