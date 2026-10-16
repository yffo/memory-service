/**
 * `src/core/select.js`：预算感知选片（**每一片被丢掉都要有账**）。
 *
 * 这个文件是整个项目的良心所在：旧项目用血换来的规矩是
 * 「任何静默截断都要有账」。所以这里的用例几乎每条都在验**账本**，
 * 而不是验「选出了什么」。
 *
 * 两条关键取舍：
 *  - pull（检索命中）先占额，push（核心档）最后；
 *  - 硬闸门（`maxNotes`/`maxChars`）与软预算（`maxTokens`）的理由**分开报**：
 *    前者是「除了放弃没别的办法」，后者是「预算不够，先砍谁」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_OVERHEAD_TOKENS,
  DEFAULT_BUDGET,
  DROP_RANK,
  dropRankOf,
  budgetOf,
  costOf,
  selectBudget,
  clipNote,
} from '../src/core/select.js';
import { estimateTokens } from '../src/util/text.js';

const cand = (id, body, extra = {}) => ({ id, title: `标题${id}`, body, score: 1, ...extra });

test('常数：条目固定开销 12 token，默认预算 8 条 / 500 token', () => {
  assert.equal(ENTRY_OVERHEAD_TOKENS, 12);
  assert.equal(DEFAULT_BUDGET.maxNotes, 8);
  assert.equal(DEFAULT_BUDGET.maxTokens, 500);
  assert.equal(DEFAULT_BUDGET.includeCore, true);
});

test('budgetOf：非法预算回退到默认值（`maxNotes: 0` 不能变成「一条都不给」）', () => {
  const b = budgetOf({ budget: { maxNotes: 0, maxTokens: -5, maxChars: 'x' } });
  assert.equal(b.maxNotes, DEFAULT_BUDGET.maxNotes);
  assert.equal(b.maxTokens, DEFAULT_BUDGET.maxTokens);
  assert.equal(b.maxChars, DEFAULT_BUDGET.maxChars);
  // 合法值当然要生效
  const c = budgetOf({ budget: { maxNotes: 3, maxTokens: 100, includeCore: false } });
  assert.equal(c.maxNotes, 3);
  assert.equal(c.maxTokens, 100);
  assert.equal(c.includeCore, false);
});

test('costOf：标题 + 正文 + 固定开销（漏掉任一项都会算漏预算）', () => {
  const c = cand('a', '正文内容');
  assert.equal(costOf(c), estimateTokens('标题a') + estimateTokens('正文内容') + ENTRY_OVERHEAD_TOKENS);
});

test('dropRankOf：裁剪序 —— episodic 最先，core 最后', () => {
  assert.equal(DROP_RANK.episodic, 0);
  assert.ok(DROP_RANK.episodic < DROP_RANK.low_trust);
  assert.ok(DROP_RANK.low_trust < DROP_RANK.other);
  assert.ok(DROP_RANK.other < DROP_RANK.core);
  // external 低信任与 episodic 同级偏后
  assert.equal(dropRankOf({ note: { kind: 'episodic', trust: 'user_stated' } }), DROP_RANK.episodic);
  assert.equal(dropRankOf({ note: { kind: 'core', trust: 'user_stated' } }), DROP_RANK.core);
  assert.ok(dropRankOf({ note: { kind: 'semantic', trust: 'external' } }) < dropRankOf({ note: { kind: 'semantic', trust: 'user_stated' } }));
});

test('空输入：返回空数组而不是 undefined（接口面不许有 null 数组）', () => {
  for (const input of [undefined, {}, { pulled: [] }, { pulled: [], core: [] }]) {
    const r = selectBudget(input);
    assert.deepEqual(r.items, []);
    assert.equal(r.tokens, 0);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.dropped, []);
    assert.equal(r.omittedReason, null);
  }
});

test('选片：装得下就全装，账为空', () => {
  const r = selectBudget({ pulled: [cand('a', '短正文'), cand('b', '短正文')], budget: { maxTokens: 5000 } });
  assert.deepEqual(r.items.map((i) => i.id), ['a', 'b']);
  assert.equal(r.truncated, false);
  assert.equal(r.items[0].source, 'pull');
});

test('maxNotes 是硬闸门：超出的进 dropped 且理由是 maxNotes（不是 dropRank）', () => {
  const r = selectBudget({
    pulled: [cand('a', 'x'), cand('b', 'x'), cand('c', 'x')],
    budget: { maxNotes: 2, maxTokens: 9999 },
  });
  assert.equal(r.items.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].id, 'c');
  assert.equal(r.dropped[0].reason, 'maxNotes', '硬闸门的理由不许被改写成 dropRank');
  assert.equal(r.dropped[0].hard, true);
  assert.equal(r.truncated, true);
});

test('maxTokens 是软预算：理由报 dropRank，并**额外**记下真正的限制是预算', () => {
  const big = '正文'.repeat(500); // 远超 500 token
  const r = selectBudget({
    pulled: [
      { id: 'epi', title: 't', body: big, score: 1, note: { kind: 'episodic', trust: 'external' } },
      { id: 'core', title: 't', body: big, score: 1, note: { kind: 'core', trust: 'user_stated' } },
    ],
    budget: { maxTokens: 100 },
  });
  assert.equal(r.items.length, 0, '两片都装不下');
  assert.equal(r.dropped.length, 2);
  const epi = r.dropped.find((d) => d.id === 'epi');
  const core = r.dropped.find((d) => d.id === 'core');
  assert.equal(epi.limitReason, 'maxTokens', '「因为预算不够」必须能在账里看见');
  assert.equal(epi.hard, false);
  // 预算不够时该先砍 episodic：这里比对的是裁剪优先级（DROP_RANK），不是字符串
  assert.ok(
    dropRankOf({ note: { kind: 'episodic', trust: 'external' } }) <
      dropRankOf({ note: { kind: 'core', trust: 'user_stated' } }),
    '原因标签必须反映裁剪序',
  );
  assert.equal(core.reason, 'budget_exhausted', 'core 是最后才砍的，它的理由只能是「预算用尽」');
  assert.match(epi.reason, /episodic|low_trust/, `episodic 要报得出自己的类别，实际 ${epi.reason}`);
});

test('pull 优先于 push：核心档不能把检索命中挤掉', () => {
  const r = selectBudget({
    pulled: [cand('hit', '正文'.repeat(100), { score: 2 })],
    core: [cand('core', '另一段正文'.repeat(100), { score: 0.5 })],
    budget: { maxTokens: 120, maxNotes: 8 },
  });
  assert.deepEqual(r.items.map((i) => i.id), ['hit']);
  assert.equal(r.items[0].source, 'pull');
  assert.equal(r.dropped.find((d) => d.id === 'core').source, 'push');
});

test('同一篇既被 pull 又被 push 时只算一次（不能双份占预算）', () => {
  const r = selectBudget({
    pulled: [cand('same', '正文')],
    core: [cand('same', '正文')],
    budget: { maxTokens: 500 },
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].source, 'pull');
  assert.deepEqual(r.dropped, []);
});

test('includeCore:false 时核心档根本不参与（不是「被挤掉」，是「没请求」）', () => {
  const r = selectBudget({
    pulled: [cand('a', '正文')],
    core: [cand('b', '正文')],
    budget: { includeCore: false },
  });
  assert.deepEqual(r.items.map((i) => i.id), ['a']);
  // 关键区别：没请求的东西不该出现在 dropped 里 —— 那会把账本污染成噪声
  assert.deepEqual(r.dropped, []);
  assert.equal(r.truncated, false);
});

test('maxChars：按正文字符数卡（0 表示不限）', () => {
  const r = selectBudget({
    pulled: [cand('a', '一二三四五'), cand('b', '六七八九十')],
    budget: { maxChars: 6, maxTokens: 9999 },
  });
  assert.deepEqual(r.items.map((i) => i.id), ['a']);
  assert.equal(r.dropped[0].reason, 'maxChars');
  assert.equal(r.dropped[0].hard, true);

  const unlimited = selectBudget({
    pulled: [cand('a', '一二三四五'), cand('b', '六七八九十')],
    budget: { maxChars: 0, maxTokens: 9999 },
  });
  assert.equal(unlimited.items.length, 2);
});

test('账本自洽：droppedCount 等于 dropped 长度，truncated 等价于「有账」', () => {
  const r = selectBudget({
    pulled: [cand('a', '长正文'.repeat(50)), cand('b', '长正文'.repeat(50)), cand('c', '短')],
    budget: { maxNotes: 2, maxTokens: 9999 },
  });
  assert.equal(r.droppedCount, r.dropped.length);
  assert.equal(r.truncated, r.dropped.length > 0);
  assert.ok(r.omittedReason, 'truncated 时必须给一句人话总结');
  assert.match(r.omittedReason, /maxNotes/);
});

test('选片结果带出 why 与 score_breakdown（用户问「为什么给我这条」时要答得出来）', () => {
  const r = selectBudget({
    pulled: [{ id: 'a', title: 't', body: 'b', score: 0.7, breakdown: { relevance: 0.5 }, why: '词法命中' }],
    budget: { maxTokens: 500 },
  });
  assert.equal(r.items[0].why, '词法命中');
  assert.deepEqual(r.items[0].score_breakdown, { relevance: 0.5 });
});

test('tokens 是实际占用（不是预算值）—— 预算没花完不能虚报', () => {
  const c = cand('a', '短');
  const r = selectBudget({ pulled: [c], budget: { maxTokens: 500 } });
  assert.equal(r.tokens, costOf(c));
  assert.ok(r.tokens < 500);
});

test('clipNote：不超限原样返回且不标 truncated', () => {
  const n = { id: 'a', body: '短正文' };
  const r = clipNote(n, 100);
  assert.equal(r.body, '短正文');
  assert.equal(r.truncatedNote, false);
  assert.equal(r.originalChars, 3);
  assert.equal(r.truncatedReason, null, '没截断就不该有截断理由（有理由就意味着账在说谎）');
});

test('clipNote：超限必须**同时**给出截断标记与原始长度（静默截断是禁止的）', () => {
  const n = { id: 'a', body: '一二三四五六七八九十' };
  const r = clipNote(n, 4);
  assert.equal(r.body.length, 4);
  assert.equal(r.truncatedNote, true);
  assert.equal(r.originalChars, 10);
  assert.equal(r.droppedChars, 6);
  assert.equal(r.truncatedReason, 'maxChars');
});

test('clipNote：maxChars 为 0/undefined 表示不截断', () => {
  const n = { id: 'a', body: '一二三四五六七八九十' };
  assert.equal(clipNote(n, 0).truncatedNote, false);
  assert.equal(clipNote(n, undefined).truncatedNote, false);
});
