/**
 * `tabellio consolidate --merge/--summarize/--promote` 的端到端用例。
 *
 * 这里必须真起进程：提案的 JSON 形状、默认不落盘、--apply 的明确拒绝，
 * 都只有真实 CLI 才能测到。内容类提案与 archive/undo 是互斥入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
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

function seedPair(prefix = 'memory-cli-propose-') {
  const dir = tempDir(prefix);
  const files = [
    ['a.md', '---\nkind: semantic\ntrust: user_stated\n---\n\n# 构建命令\n\n共同事实：构建从仓库根目录执行。\n\n只有 A 的细节：先安装依赖。\n'],
    ['b.md', '---\nkind: semantic\ntrust: user_stated\n---\n\n# 构建命令 v2\n\n共同事实：构建从仓库根目录执行。\n\n只有 B 的细节：发布前跑全量测试。\n'],
  ];
  const ids = [];
  for (const [name, text] of files) {
    const file = join(dir, name);
    writeFileSync(file, text, 'utf8');
    const r = cli(['remember', '--file', file, '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    ids.push(r.json.id);
  }
  return { dir, a: ids[0], b: ids[1] };
}

function getNote(dir, id) {
  const r = cli(['read', '--id', id, '--json'], { store: dir });
  assert.equal(r.code, 0, r.stderr);
  return r.json;
}

test('CLI consolidate --merge：只出提案，笔记与 runs/ 都不变', () => {
  const { dir, a, b } = seedPair();
  try {
    const before = getNote(dir, a);
    const r = cli(['consolidate', '--merge', `${a},${b}`, '--json'], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.status, 'proposed');
    assert.equal(r.json.mode, 'merge');
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.apply_supported, false);
    assert.equal(r.json.would_write, false);
    assert.match(r.json.target.path, /^notes\/[0-9A-HJKMNP-TV-Z]{26}\.md$/);
    assert.equal(r.json.target.status, 'draft');
    assert.deepEqual(r.json.target.supersedes, [a, b]);
    assert.match(r.json.target.body, /共同事实/);
    assert.deepEqual(runsFiles(dir), []);
    const after = getNote(dir, a);
    assert.equal(after.body, before.body);
    assert.equal(after.note.valid_to, null);
  } finally {
    rm(dir);
  }
});

test('CLI consolidate --merge：人读输出有提案、目标、草稿预览', () => {
  const { dir, a, b } = seedPair('memory-cli-propose-human-');
  try {
    const r = cli(['consolidate', '--merge', `${a},${b}`], { store: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[提案\] 合并：2 条源/);
    assert.match(r.stdout, /目标：notes\//);
    assert.match(r.stdout, /--- 草稿预览 ---/);
    assert.match(r.stdout, /下一步：人工审阅提案/);
  } finally {
    rm(dir);
  }
});

test('CLI consolidate 内容类提案：--apply 明确拒绝并退 2', () => {
  const { dir, a, b } = seedPair('memory-cli-propose-apply-');
  try {
    const before = getNote(dir, a);
    const r = cli(['consolidate', '--merge', `${a},${b}`, '--apply', '--json'], { store: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /只出提案，--apply 尚未实现/);
    assert.equal(getNote(dir, a).body, before.body);
    assert.deepEqual(runsFiles(dir), []);
  } finally {
    rm(dir);
  }
});

test('CLI consolidate 内容类提案：模式互斥、缺源、与 archive 混用都退 2', () => {
  const { dir, a, b } = seedPair('memory-cli-propose-args-');
  try {
    const both = cli(['consolidate', '--merge', `${a},${b}`, '--summarize', a, '--json'], { store: dir });
    assert.equal(both.code, 2);
    assert.match(both.stderr, /一次只能选一个/);

    const missing = cli(['consolidate', '--merge', '--json'], { store: dir });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /需要源 id/);

    const withArchive = cli(['consolidate', '--merge', `${a},${b}`, '--archive', a, '--json'], { store: dir });
    assert.equal(withArchive.code, 2);
    assert.match(withArchive.stderr, /不能和 --archive/);

    const withRatio = cli(['consolidate', '--merge', `${a},${b}`, '--max-change-ratio', '0.1', '--json'], { store: dir });
    assert.equal(withRatio.code, 2);
    assert.match(withRatio.stderr, /不接受/);
  } finally {
    rm(dir);
  }
});

test('CLI consolidate --summarize：源太短时退 1，而不是伪造一份摘要', () => {
  const dir = tempDir('memory-cli-propose-short-');
  try {
    const file = join(dir, 'short.md');
    writeFileSync(file, '---\nkind: semantic\ntrust: user_stated\n---\n\n# 短笔记\n\n太短了。\n', 'utf8');
    const made = cli(['remember', '--file', file, '--json'], { store: dir });
    assert.equal(made.code, 0, made.stderr);
    const r = cli(['consolidate', '--summarize', made.json.id, '--json'], { store: dir });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, 'source_too_short');
    assert.equal(r.json.would_write, false);
    assert.deepEqual(runsFiles(dir), []);
  } finally {
    rm(dir);
  }
});
