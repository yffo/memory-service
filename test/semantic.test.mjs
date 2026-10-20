import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cosine, indexableEntry, mergeSemanticItems, planSemanticIndex, rankSemantic } from '../src/core/semantic.js';
import { loadSemanticIndex, saveSemanticIndex, semanticIndexPath } from '../src/store/semantic-index.js';
import { indexSemantic, openStore, remember, semanticRecall } from '../src/api.js';

const entry = (id, body, note = {}) => ({ id, body, note: { status: 'active', trust: 'user_stated', ...note } });

/** Deterministic toy embedder: the test only needs stable, separable vectors. */
function fakeEmbed(text) {
  const value = String(text ?? '');
  if (value.includes('alpha')) return [1, 0];
  if (value.includes('beta')) return [0, 1];
  return [0.5, 0.5];
}

async function tempStore(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tabellio-semantic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: openStore(dir) };
}

test('planSemanticIndex keeps unchanged notes, embeds new ones and drops the invisible', () => {
  const previous = new Map([
    ['a', { hash: 'hash-a', vector: [1, 1] }],
    ['gone', { hash: 'hash-gone', vector: [1, 0] }],
    ['arch', { hash: 'hash-arch', vector: [0, 1] }],
  ]);
  const entries = [
    { id: 'a', body: 'unchanged body', note: { status: 'active' } },
    { id: 'b', body: 'fresh body', note: { status: 'active' } },
    { id: 'arch', body: 'archived body', note: { status: 'archived' } },
    { id: 'draft', body: 'draft body', note: { status: 'draft' } },
    { id: 'old', body: 'superseded body', note: { status: 'active', superseded_by: 'x' } },
  ];
  // `hash-a` must be the real hash of the unchanged body for it to be kept.
  const realHash = planSemanticIndex([{ id: 'a', body: 'unchanged body', note: { status: 'active' } }], new Map());
  previous.set('a', { hash: realHash.changed[0].hash, vector: [1, 1] });

  const plan = planSemanticIndex(entries, previous);
  assert.deepEqual([...plan.kept.keys()], ['a']);
  assert.deepEqual(plan.changed.map((item) => item.id), ['b']);
  assert.deepEqual(plan.removed.sort(), ['arch', 'gone']);
  assert.equal(indexableEntry({ note: { status: 'active', valid_to: '2026-01-01' } }), false);
  assert.equal(indexableEntry({ note: { status: 'active', superseded_by: 'null' } }), true);
});

test('rankSemantic sorts by cosine and honours the threshold', () => {
  const index = new Map([
    ['alpha', { hash: 'h1', vector: [1, 0] }],
    ['beta', { hash: 'h2', vector: [0, 1] }],
    ['mixed', { hash: 'h3', vector: [0.8, 0.6] }],
  ]);
  const hits = rankSemantic(index, [1, 0], { top: 2, minSimilarity: 0.5 });
  assert.deepEqual(hits.map((hit) => hit.id), ['alpha', 'mixed']);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0]), 1);
});

test('mergeSemanticItems appends unseen hits and re-checks lifecycle and trust', () => {
  const result = { items: [{ id: 'a', title: 'A', content: 'lexical' }], refused: true, reason: 'below_min_coverage', tokens: 3 };
  const notes = {
    b: { ok: true, title: 'B', body: 'semantic body', note: { status: 'active', trust: 'user_stated' } },
    arch: { ok: true, title: 'Archived', body: 'old', note: { status: 'archived', trust: 'user_stated' } },
    ext: { ok: true, title: 'External', body: 'doc', note: { status: 'active', trust: 'external' } },
  };
  const merged = mergeSemanticItems(result, {
    hits: [{ id: 'a', similarity: 0.9 }, { id: 'arch', similarity: 0.8 }, { id: 'ext', similarity: 0.7 }, { id: 'b', similarity: 0.6 }],
    readNote: (id) => notes[id] ?? { ok: false },
    maxNotes: 6,
    allowedTrusts: ['user_stated', 'system_derived'],
  });
  assert.deepEqual(merged.items.map((item) => item.id), ['a', 'b']);
  assert.equal(merged.items[1].semantic, true);
  assert.equal(merged.refused, false);
  assert.equal(merged.reason, null);
  assert.ok(merged.tokens > 0);
  // No new hits → the original object comes back untouched.
  assert.equal(mergeSemanticItems(result, { hits: [], readNote: () => null }), result);
});

test('rrf fusion lets a strong semantic hit displace a weak lexical one', () => {
  const result = {
    items: [
      { id: 'lex1', title: 'Lex 1', content: 'strong lexical' },
      { id: 'lex2', title: 'Lex 2', content: 'medium lexical' },
      { id: 'lex3', title: 'Lex 3', content: 'weak lexical' },
    ],
    refused: false,
    reason: null,
    tokens: 12,
  };
  const notes = {
    sem1: { ok: true, title: 'Sem 1', body: 'semantic top', note: { status: 'active', trust: 'user_stated' } },
  };
  const merged = mergeSemanticItems(result, {
    hits: [{ id: 'sem1', similarity: 0.9 }],
    readNote: (id) => notes[id] ?? { ok: false },
    maxNotes: 3,
  });
  assert.deepEqual(merged.items.map((item) => item.id), ['lex1', 'sem1', 'lex2']);
  // append 模式保留旧行为，不置换。
  const appended = mergeSemanticItems(result, {
    hits: [{ id: 'sem1', similarity: 0.9 }],
    readNote: (id) => notes[id] ?? { ok: false },
    maxNotes: 3,
    fusion: 'append',
  });
  assert.deepEqual(appended.items.map((item) => item.id), ['lex1', 'lex2', 'lex3']);
});

test('semantic index round-trips through the store and only embeds changed notes', async (t) => {
  const { dir, store } = await tempStore(t);
  const first = remember(store, { content: 'alpha 项目的发版流程走 tag 和 CI，不走手工上传。', title: '发版流程' });
  assert.equal(first.ok, true);
  const second = remember(store, { content: 'beta 项目的测试一律先跑全量再合并。', title: '测试纪律' });
  assert.equal(second.ok, true);

  let calls = 0;
  const embed = async (texts) => {
    calls += texts.length;
    return texts.map(fakeEmbed);
  };

  const built = await indexSemantic(store, { embed, model: 'fake-embed' });
  assert.equal(built.ok, true);
  assert.equal(built.size, 2, 'one note per record');
  assert.equal(calls, 2);
  assert.ok(loadSemanticIndex(dir, 'fake-embed').size === 2);
  assert.equal(loadSemanticIndex(dir, 'another-model').size, 0, 'index is per model');

  const again = await indexSemantic(store, { embed, model: 'fake-embed' });
  assert.equal(again.changed, 0);
  assert.equal(calls, 2, 'unchanged notes are not re-embedded');

  const hits = await semanticRecall(store, 'alpha 怎么发版', { embed, model: 'fake-embed', top: 3, minSimilarity: 0.5 });
  assert.equal(hits.ok, true);
  assert.equal(hits.size, 2);
  assert.equal(hits.hits[0].id, first.id);

  // The index file is a derived artifact: corrupt it and the loader degrades to empty.
  await writeFile(semanticIndexPath(dir), '{not json', 'utf8');
  assert.equal(loadSemanticIndex(dir, 'fake-embed').size, 0);

  const saved = saveSemanticIndex(dir, 'fake-embed', new Map([['x', { hash: 'h', vector: [1, 2] }]]));
  assert.equal(saved, true);
  assert.equal(loadSemanticIndex(dir, 'fake-embed').size, 1);
});
