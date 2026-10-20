import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  remember,
  recordFeedback,
  readFeedback,
  feedbackSummary,
  recallQuery,
} from '../src/api.js';

const DAY = 24 * 60 * 60 * 1000;

async function tempStore(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tabellio-feedback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: openStore(dir) };
}

test('feedback lands in runs/feedback.jsonl and validates its input', async (t) => {
  const { dir, store } = await tempStore(t);
  assert.equal(recordFeedback(store, { id: 'n1', signal: 'invented' }).reason, 'invalid_signal');
  assert.equal(recordFeedback(store, { signal: 'useful' }).reason, 'missing_notes');
  const saved = recordFeedback(store, { id: 'n1', signal: 'useful', query: 'x'.repeat(500) });
  assert.equal(saved.ok, true);
  assert.match(saved.path, /runs\/feedback\.jsonl$/);
  const rows = readFeedback(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query.length, 120, 'queries are clipped before they hit disk');
});

test('legacy plugin feedback files are still read and merged by time', async (t) => {
  const { dir, store } = await tempStore(t);
  const now = Date.now();
  await writeFile(path.join(dir, 'panel-feedback.jsonl'),
    JSON.stringify({ id: 'old1', signal: 'useful', at: now - 2 * DAY }) + '\n', 'utf8');
  await writeFile(path.join(dir, 'outcome.jsonl'),
    JSON.stringify({ signal: 'corrected', noteIds: ['old2'], at: now - 1 * DAY }) + '\n', 'utf8');
  const rows = readFeedback(store);
  assert.deepEqual(rows.map((row) => row.signal), ['useful', 'corrected']);
  const summary = feedbackSummary(store, { days: 7 });
  assert.equal(summary.total, 2);
  assert.equal(summary.counts.useful, 1);
  assert.equal(summary.counts.corrected, 1);
  assert.ok(summary.notes.find((note) => note.id === 'old1'));
});

test('applyFeedback reorders recalled items without dropping any', async (t) => {
  const { store } = await tempStore(t);
  const strong = remember(store, { content: '发版流程：先跑测试，再用 tag 触发 CI 发布。' }, { writtenBy: 'test' });
  const weak = remember(store, { content: '发版流程的补充说明：回滚时先看发布记录。' }, { writtenBy: 'test' });
  assert.equal(strong.ok, true);
  assert.equal(weak.ok, true);
  const base = recallQuery(store, '发版流程', { minCoverage: 0, minScore: 0, minRelevance: 0 });
  assert.equal(base.items.length, 2);
  const demoted = base.items[0].id;
  for (let i = 0; i < 6; i += 1) recordFeedback(store, { id: demoted, signal: 'wrong' });
  const ranked = recallQuery(store, '发版流程', { minCoverage: 0, minScore: 0, minRelevance: 0, applyFeedback: true });
  assert.equal(ranked.items.length, 2, 'feedback never drops items');
  assert.notEqual(ranked.items[0].id, demoted);
  const plain = recallQuery(store, '发版流程', { minCoverage: 0, minScore: 0, minRelevance: 0 });
  assert.equal(plain.items[0].id, demoted, 'default recall stays untouched');
});

test('decay demotes older notes but leaves user-stated rules alone', async (t) => {
  const { dir, store } = await tempStore(t);
  assert.equal(remember(store, { content: '旧的项目笔记：发版流程用 tag 发布。' }, { writtenBy: 'test' }).ok, true);
  assert.equal(remember(store, { content: '新的项目笔记：发版流程还要跑验收。' }, { writtenBy: 'test' }).ok, true);
  const base = recallQuery(store, '发版流程', { minCoverage: 0, minScore: 0, minRelevance: 0 });
  assert.equal(base.items.length, 2);
  const topId = base.items[0].id;
  // Age the currently-winning note by rewriting its frontmatter, then reopen the
  // store so the scan cache reflects the change.
  const { readdir } = await import('node:fs/promises');
  for (const file of await readdir(path.join(dir, 'notes'))) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(dir, 'notes', file);
    const text = await readFile(filePath, 'utf8');
    if (!text.includes(`id: ${topId}`)) continue;
    const past = new Date(Date.now() - 400 * DAY).toISOString();
    await writeFile(filePath, text.replace(/valid_from: ".*"/, `valid_from: "${past}"`), 'utf8');
    break;
  }
  const fresh = openStore(dir);
  const decayed = recallQuery(fresh, '发版流程', { minCoverage: 0, minScore: 0, minRelevance: 0, decay: { halfLifeDays: 1, floor: 0.01 } });
  assert.equal(decayed.items.length, 2);
  assert.notEqual(decayed.items[0].id, topId, 'the aged note should fall behind');
});
