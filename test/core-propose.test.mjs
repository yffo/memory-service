/**
 * 内容类巩固提案层的纯决策用例。
 *
 * 这一层不写文件，所以测试只回答三件事：哪些源能进提案、草稿是否真的来自源、
 * 拒绝时是否一条都不放过。IO 与命令行的验证分别放在 api-propose / cli-propose。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planContentConsolidation,
  CONTENT_PROPOSAL_SCHEMA,
  MIN_SUMMARIZE_CHARS,
} from '../src/core/propose.js';

const NOW = Date.parse('2026-10-17T12:00:00+08:00');
const TARGET = '01M554B3JYZ1NH8QZCQ73Q6CSX';

function entry(id, body, note = {}) {
  return {
    id,
    path: `notes/${id}.md`,
    title: note.title ?? `笔记 ${id}`,
    body,
    note: {
      id,
      status: 'active',
      kind: 'semantic',
      scope: 'user',
      scope_detail: null,
      trust: 'user_stated',
      valid_from: '2026-10-01T09:00:00+08:00',
      valid_to: null,
      superseded_by: null,
      supersedes: [],
      ...note,
    },
  };
}

function summaryEntry(id = 'LONG') {
  return entry(id, [
    '# 长记录',
    '',
    '第一段说的是构建命令必须从仓库根目录执行，并且先安装依赖，否则会在编译阶段报找不到模块。',
    '',
    '第二段记录发布流程：先跑全量测试，再打标签，最后把构建产物上传到发布服务器，任何一步失败都停止。',
    '',
    '第三段是排障经验：如果缓存命中了旧版本，先清缓存再重试，不要直接改依赖版本，否则会把问题藏起来。',
    '',
    '第四段补充：任何发布脚本都必须先检查当前分支，避免把未合并的改动带上线，也避免把别人的提交一起发布。',
  ].join('\n'), { title: '长记录' });
}

test('planContentConsolidation merge：去重拼接、带源 id，目标只是 draft', () => {
  const a = entry('A', '# 构建命令\n\n共同事实。\n\n只有 A 的细节。', { title: '构建命令' });
  const b = entry('B', '# 构建命令 v2\n\n共同事实。\n\n只有 B 的细节。', { title: '构建命令 v2' });
  const plan = planContentConsolidation({ entries: [a, b], mode: 'merge', ids: ['A', 'B'], nowMs: NOW, targetId: TARGET, proposalId: 'prop_test' });

  assert.equal(plan.ok, true);
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.schema, CONTENT_PROPOSAL_SCHEMA);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.apply_supported, true);
  assert.equal(plan.would_write, false);
  assert.equal(plan.target_id, TARGET);
  assert.equal(plan.target.path, `notes/${TARGET}.md`);
  assert.equal(plan.target.status, 'draft');
  assert.equal(plan.target.draft_kind, 'deduped_concat');
  assert.equal(plan.target.requires_review, true);
  assert.deepEqual(plan.target.supersedes, ['A', 'B']);
  assert.deepEqual(plan.target.provenance.derived_from, ['A', 'B']);
  assert.equal(plan.stats.sources, 2);
  assert.equal(plan.stats.estimated_write_ops, 3);
  const body = plan.target.body;
  assert.match(body, /^# 合并提案：构建命令 \+ 构建命令 v2/);
  assert.equal((body.match(/共同事实。/g) ?? []).length, 1, '重复段落只保留一次');
  assert.match(body, /只有 A 的细节/);
  assert.match(body, /只有 B 的细节/);
  assert.match(body, /<!-- 合并自：A、B；提案草稿，未写入库。 -->/);
  assert.equal(plan.sources[0].body_sha256.length, 32);
});

test('planContentConsolidation merge：scope / kind 不一致直接拒绝', () => {
  const a = entry('A', '# A\n\n正文 A。');
  const b = entry('B', '# B\n\n正文 B。', { scope: 'project', scope_detail: 'tabellio' });
  const scope = planContentConsolidation({ entries: [a, b], mode: 'merge', ids: ['A', 'B'], nowMs: NOW });
  assert.equal(scope.ok, false);
  assert.equal(scope.reason, 'scope_mismatch');
  assert.equal(scope.would_write, false);

  const kind = planContentConsolidation({ entries: [a, entry('C', '# C\n\n正文 C。', { kind: 'episodic' })], mode: 'merge', ids: ['A', 'C'], nowMs: NOW });
  assert.equal(kind.ok, false);
  assert.equal(kind.reason, 'kind_mismatch');
});

test('planContentConsolidation：任一源缺失或失效就整单拒绝，不静默丢源', () => {
  const good = entry('A', '# A\n\n正文 A。');
  const cases = [
    [entry('B', '# B\n\n正文 B。', { status: 'archived' }), 'source_not_active'],
    [entry('C', '# C\n\n正文 C。', { valid_to: '2026-10-10T00:00:00+08:00' }), 'source_has_valid_to'],
    [entry('D', '# D\n\n正文 D。', { superseded_by: 'Z' }), 'source_superseded'],
    [entry('E', '# E\n\n正文 E。', { valid_from: '2027-01-01T00:00:00+08:00' }), 'source_not_valid_at_now'],
    [{ id: 'F', path: 'notes/F.md', title: 'F', body: '# F', note: null }, 'source_unparsed'],
  ];
  for (const [bad, reason] of cases) {
    const plan = planContentConsolidation({ entries: [good, bad], mode: 'merge', ids: ['A', bad.id], nowMs: NOW });
    assert.equal(plan.ok, false, reason);
    assert.equal(plan.reason, 'source_invalid');
    assert.equal(plan.skipped[0].id, bad.id);
    assert.equal(plan.skipped[0].reason, reason);
    assert.equal(plan.target, undefined, '拒绝时不给目标，避免被误当成可写');
  }
  const missing = planContentConsolidation({ entries: [good], mode: 'merge', ids: ['A', 'ghost'], nowMs: NOW });
  assert.equal(missing.reason, 'source_invalid');
  assert.equal(missing.skipped[0].reason, 'missing_source');
});

test('planContentConsolidation summarize：只接受一条够长的源，草稿只摘原句', () => {
  const short = entry('SHORT', '# 短\n\n太短了。');
  const tooShort = planContentConsolidation({ entries: [short], mode: 'summarize', ids: ['SHORT'], nowMs: NOW });
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.reason, 'source_too_short');
  assert.ok(tooShort.stats.source_chars < MIN_SUMMARIZE_CHARS);

  const many = planContentConsolidation({ entries: [summaryEntry('A'), summaryEntry('B')], mode: 'summarize', ids: ['A', 'B'], nowMs: NOW });
  assert.equal(many.ok, false);
  assert.equal(many.reason, 'summarize_needs_one_source');

  const one = summaryEntry('LONG');
  const plan = planContentConsolidation({ entries: [one], mode: 'summarize', ids: ['LONG'], nowMs: NOW, targetId: TARGET });
  assert.equal(plan.ok, true);
  assert.equal(plan.target.draft_kind, 'extractive');
  assert.equal(plan.target.supersedes.length, 1);
  assert.match(plan.target.body, /^# 摘要提案：长记录/);
  assert.match(plan.target.body, /第一段说的是构建命令必须从仓库根目录执行/);
  assert.ok(!plan.target.body.includes('## 待人工归纳'));
  assert.ok(plan.warnings.some((w) => w.code === 'draft_not_shorter'), '单句段落摘不出更短的稿时必须明说');
});

test('planContentConsolidation promote：至少三条、跨两个日期，目标进 candidates', () => {
  const few = planContentConsolidation({
    entries: [entry('A', '# A\n\n正文 A。'), entry('B', '# B\n\n正文 B。')],
    mode: 'promote', ids: ['A', 'B'], nowMs: NOW,
  });
  assert.equal(few.reason, 'not_enough_sources');

  const sameDay = planContentConsolidation({
    entries: [entry('A', '# A\n\n正文 A。'), entry('B', '# B\n\n正文 B。'), entry('C', '# C\n\n正文 C。')],
    mode: 'promote', ids: ['A', 'B', 'C'], nowMs: NOW,
  });
  assert.equal(sameDay.reason, 'not_enough_time_points');
  assert.equal(sameDay.distinct_days, 1);

  const sources = [
    entry('A', '# 第一次观察\n\n周五发布后缓存命中旧版本。', { valid_from: '2026-10-02T09:00:00+08:00', kind: 'episodic' }),
    entry('B', '# 第二次观察\n\n又遇到缓存旧版本，清缓存后恢复。', { valid_from: '2026-10-09T09:00:00+08:00', kind: 'episodic' }),
    entry('C', '# 第三次观察\n\n发布前预热缓存可以避免这个问题。', { valid_from: '2026-10-12T09:00:00+08:00', kind: 'episodic' }),
  ];
  const plan = planContentConsolidation({ entries: sources, mode: 'promote', ids: ['A', 'B', 'C'], nowMs: NOW, targetId: TARGET });
  assert.equal(plan.ok, true);
  assert.equal(plan.target.path, `notes/candidates/${TARGET}.md`);
  assert.equal(plan.target.kind, 'procedural');
  assert.equal(plan.target.trust, 'system_derived');
  assert.equal(plan.target.draft_kind, 'scaffold');
  assert.equal(plan.target.supersedes.length, 0);
  assert.equal(plan.stats.distinct_days, 3);
  assert.match(plan.target.body, /^# 候选规则提案（待人工确认）/);
  assert.match(plan.target.body, /## 观察/);
  assert.match(plan.target.body, /## 待人工归纳/);
  assert.match(plan.target.body, /<!-- 来源 id：A、B、C -->/);
});

test('planContentConsolidation：合法 targetId 撞源或撞库都拒绝，非法 id 也拒绝', () => {
  const a = entry('A', '# A\n\n正文 A。');
  const b = entry('B', '# B\n\n正文 B。');
  const invalid = planContentConsolidation({ entries: [a, b], mode: 'merge', ids: ['A', 'B'], nowMs: NOW, targetId: 'not-a-ulid' });
  assert.equal(invalid.reason, 'invalid_target_id');
  const targetEntry = entry(TARGET, '# X\n\n正文 X。');
  const collision = planContentConsolidation({ entries: [a, targetEntry], mode: 'merge', ids: ['A', TARGET], nowMs: NOW, targetId: TARGET });
  assert.equal(collision.reason, 'target_id_collides');
  const exists = planContentConsolidation({ entries: [a, b, entry(TARGET, '# X\n\n正文 X。')], mode: 'merge', ids: ['A', 'B'], nowMs: NOW, targetId: TARGET });
  assert.equal(exists.reason, 'target_id_exists');
});

test('planContentConsolidation：同一输入得到同一份提案', () => {
  const a = entry('A', '# A\n\n正文 A。');
  const b = entry('B', '# B\n\n正文 B。');
  const input = { entries: [a, b], mode: 'merge', ids: ['B', 'A', 'A'], nowMs: NOW, targetId: TARGET, proposalId: 'prop_fixed' };
  const one = planContentConsolidation(input);
  const two = planContentConsolidation(input);
  assert.deepEqual(one, two);
  assert.deepEqual(one.source_ids, ['B', 'A'], '重复 id 去重且保留首次顺序');
});
