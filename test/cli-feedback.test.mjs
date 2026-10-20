/**
 * `tabellio feedback` 的 CLI 端到端用例：记录、列出、汇总三条路径，
 * 盯 JSON 契约与退出码，不碰真实库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, rm } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'memory');

function cli(args, { store } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
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

test('feedback record / list / summary round-trip through runs/feedback.jsonl', (t) => {
  const store = tempDir('memory-cli-feedback-');
  t.after(() => rm(store));

  const empty = cli(['feedback', 'summary', '--json'], { store });
  assert.equal(empty.code, 0);
  assert.equal(empty.json.total, 0);

  const missing = cli(['feedback', 'record', '--json'], { store });
  assert.equal(missing.code, 2, 'record without an id is a usage error');

  const recorded = cli(['feedback', 'record', '--id', 'n1', '--signal', 'wrong', '--query', '发版流程', '--json'], { store });
  assert.equal(recorded.code, 0);
  assert.equal(recorded.json.ok, true);
  assert.match(recorded.json.path, /runs\/feedback\.jsonl$/);

  const bad = cli(['feedback', 'record', '--id', 'n1', '--signal', 'invented', '--json'], { store });
  assert.equal(bad.code, 1);
  assert.equal(bad.json.ok, false);

  const file = join(store, 'runs', 'feedback.jsonl');
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);

  const listed = cli(['feedback', 'list', '--json'], { store });
  assert.equal(listed.code, 0);
  assert.equal(listed.json.length, 1);
  assert.deepEqual(listed.json[0].noteIds, ['n1']);

  const summary = cli(['feedback', 'summary', '--days', '7', '--json'], { store });
  assert.equal(summary.code, 0);
  assert.equal(summary.json.counts.wrong, 1);
  assert.equal(summary.json.total, 1);
});
