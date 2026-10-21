// P2 批次不变：同一个笔记的 RRF 分数只该由「全库第几」决定，不该由「这一批
// 里还有谁」决定。否则同一个问题、同一个库，只因为预算松紧不同（maxNotes 从
// 6 调到 10）就可能换出不同答案 —— 这既不能解释，也不可复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSemanticItems } from '../src/core/semantic.js';

const note = (id, body) => ({ ok: true, id, title: 'T-' + id, body });
const readNote = (id) => note(id, 'body of ' + id);

const hits = [
  { id: 'B', similarity: 0.9 },
  { id: 'Y', similarity: 0.85 },
];
// 全库名次：A 第 1、B 第 2、Y 第 5（B/Y 都可能被预算裁掉，名次不变）。
const lexRanks = new Map([
  ['A', 1],
  ['B', 2],
  ['Y', 5],
]);

const ids = (result) => result.items.map((item) => item.id);

test('merging is independent of how much the budget already trimmed', () => {
  const full = mergeSemanticItems(
    { items: [{ id: 'A', title: 'T-A', content: 'body of A', lexRank: 1 }, { id: 'B', title: 'T-B', content: 'body of B', lexRank: 2 }] },
    { hits, readNote, lexRanks, maxNotes: 6 },
  );
  // 同样的库、同样的语义命中，只是 B 被预算提前裁掉了。
  const trimmed = mergeSemanticItems(
    { items: [{ id: 'A', title: 'T-A', content: 'body of A', lexRank: 1 }] },
    { hits, readNote, lexRanks, maxNotes: 6 },
  );
  assert.deepEqual(ids(trimmed), ids(full), 'same query + same corpus must pick the same order');

  // 不传全库名次就会退化成「批次内名次」——这里正是修复前的行为，钉住它，
  // 免得以后有人觉得这个参数多余。
  const batchOnly = mergeSemanticItems(
    { items: [{ id: 'A', title: 'T-A', content: 'body of A' }] },
    { hits, readNote, maxNotes: 6 },
  );
  assert.notDeepEqual(ids(batchOnly), ids(full), 'without stable ranks the batch leaks into the order');
});

test('a note keeps its fraction even when the incoming batch is a different size', () => {
  // 单条 A 在两种批次里都应拿到同样的名次（第 1），而不是「最小批次里第 1」。
  const one = mergeSemanticItems(
    { items: [{ id: 'A', title: 'T-A', content: 'body of A' }] },
    { hits: [], readNote, maxNotes: 6 },
  );
  assert.deepEqual(ids(one), ['A']);

  // 条目自带的 lexRank 优先于批次位置。
  const ranked = mergeSemanticItems(
    { items: [{ id: 'A', title: 'T-A', content: 'body of A', lexRank: 7 }] },
    { hits: [{ id: 'Y', similarity: 0.7 }], readNote, maxNotes: 6 },
  );
  // A 名次 7（1/67），Y 语义第 1（1/61）→ Y 在前。若按批次位置（A=1）顺序会反过来。
  assert.deepEqual(ids(ranked), ['Y', 'A']);
});
