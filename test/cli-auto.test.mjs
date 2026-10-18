/**
 * tabellio consolidate --auto / inbox 的 CLI 端到端用例。
 *
 * 盯三件事：默认 dry-run 不写；--write 只写提案不改笔记；inbox 两类 id
 * 分流正确，提案批准后能 undo。
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

const COMMON =
  '项目约定：所有构建都从仓库根目录执行，安装依赖统一用 pnpm，提交前必须跑全量测试，发布走 GitHub Actions。';

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

function writeNote(dir, name, title, body) {
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '---\nkind: semantic\ntrust: user_stated\n---\n\n# ' + title + '\n\n' + body + '\n', 'utf8');
  return file;
}

function seedPair(dir) {
  const a = writeNote(dir, 'a.md', '构建约定 A', COMMON + ' 文档统一放 docs 目录。');
  const b = writeNote(dir, 'b.md', '构建约定 B', COMMON + ' 文档统一放 docs 目录，变更写 CHANGELOG。');
  for (const file of [a, b]) {
    const r = cli(['remember', '--file', file, '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
  }
}

test('CLI consolidate --auto：默认 dry-run 不落盘，--write 才写提案', () => {
  const dir = tempDir('memory-cli-auto-write-');
  try {
    seedPair(dir);
    const dry = cli(['consolidate', '--auto', '--json'], { store: dir });
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json.dry_run, true);
    assert.equal(dry.json.created_count, 0);
    assert.equal(dry.json.discovered, 1);
    assert.equal(existsSync(join(dir, 'runs', 'proposals')), false, 'dry-run 不建 proposals 目录');

    const written = cli(['consolidate', '--auto', '--write', '--json'], { store: dir });
    assert.equal(written.code, 0, written.stderr);
    assert.equal(written.json.created_count, 1);
    const id = written.json.created[0].id;
    assert.match(id, /^prop_[a-z0-9]{20}$/);
    assert.equal(existsSync(join(dir, 'runs', 'proposals', id + '.json')), true);

    const status = cli(['status', '--json'], { store: dir });
    assert.equal(status.json.notes, 2, '自动发现不改笔记');
    assert.equal(status.json.proposals, 1);
    assert.ok(status.json.warnings.some((w) => w.includes('自动巩固提案')), status.json.warnings.join('\n'));

    const again = cli(['consolidate', '--auto', '--write', '--json'], { store: dir });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.created_count, 0);
    assert.equal(again.json.existing_count, 1);
  } finally {
    rm(dir);
  }
});

test('CLI inbox：列出提案、--accept 合并后可 undo，提案 id 与候选 id 分流', () => {
  const dir = tempDir('memory-cli-auto-accept-');
  try {
    seedPair(dir);
    const swept = cli(['consolidate', '--auto', '--write', '--json'], { store: dir });
    const pid = swept.json.created[0].id;

    const listed = cli(['inbox', '--json'], { store: dir });
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.json.count, 0);
    assert.equal(listed.json.proposal_count, 1);
    assert.equal(listed.json.proposals[0].id, pid);

    const human = cli(['inbox'], { store: dir });
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /自动巩固提案 1 条/);
    assert.match(human.stdout, new RegExp(pid));

    const accepted = cli(['inbox', '--accept', pid, '--json'], { store: dir });
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(accepted.json.accepted_count, 1);
    assert.equal(accepted.json.accepted[0].status, 'applied');
    const runId = accepted.json.accepted[0].run_id;
    const targetId = accepted.json.accepted[0].target_id;
    assert.ok(runId);
    assert.equal(existsSync(join(dir, 'notes', targetId + '.md')), true);
    assert.equal(existsSync(join(dir, 'runs', 'proposals', 'accepted', pid + '.json')), true);

    const after = cli(['status', '--json'], { store: dir });
    assert.equal(after.json.notes, 3);
    assert.equal(after.json.proposals, 0);

    const undo = cli(['consolidate', '--undo', runId, '--json'], { store: dir });
    assert.equal(undo.code, 0, undo.stderr);
    assert.equal(undo.json.status, 'undone');
    const restored = cli(['status', '--json'], { store: dir });
    assert.equal(restored.json.notes, 2);
  } finally {
    rm(dir);
  }
});

test('CLI inbox：--reject 只归档提案；--dry 不移动', () => {
  const dir = tempDir('memory-cli-auto-reject-');
  try {
    seedPair(dir);
    const swept = cli(['consolidate', '--auto', '--write', '--json'], { store: dir });
    const pid = swept.json.created[0].id;

    const dry = cli(['inbox', '--reject', pid, '--dry', '--json'], { store: dir });
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json.rejected_count, 1);
    assert.equal(dry.json.rejected[0].status, 'planned');

    const rejected = cli(['inbox', '--reject', pid, '--json'], { store: dir });
    assert.equal(rejected.code, 0, rejected.stderr);
    assert.equal(rejected.json.rejected_count, 1);
    assert.equal(existsSync(join(dir, 'runs', 'proposals', 'rejected', pid + '.json')), true);

    const status = cli(['status', '--json'], { store: dir });
    assert.equal(status.json.notes, 2);
    assert.equal(status.json.proposals, 0);
  } finally {
    rm(dir);
  }
});

test('CLI consolidate --auto：互斥参数和越界值退 2', () => {
  const dir = tempDir('memory-cli-auto-bad-');
  try {
    seedPair(dir);
    assert.equal(cli(['consolidate', '--auto', '--apply', '--json'], { store: dir }).code, 2);
    assert.equal(cli(['consolidate', '--auto', '--merge', 'x', '--json'], { store: dir }).code, 2);
    assert.equal(cli(['consolidate', '--auto', '--min-similarity', '2', '--json'], { store: dir }).code, 2);
    assert.equal(cli(['consolidate', '--auto', '--max-proposals', '0', '--json'], { store: dir }).code, 2);
  } finally {
    rm(dir);
  }
});
