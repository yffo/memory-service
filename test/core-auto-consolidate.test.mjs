/**
 * 自动巩固发现层：纯函数、确定性、不写文件。
 *
 * 这里守的是「宁可漏，不可把相关当重复」：同 scope/kind/trust 才比较，
 * 只认正文高重叠，不读候选，也不生成目标正文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverConsolidationProposals,
  autoProposalId,
  AUTO_CONSOLIDATE_SCHEMA,
  AUTO_MIN_SIMILARITY,
} from '../src/core/auto-consolidate.js';

const BASE =
  '项目约定：所有构建都从仓库根目录执行，安装依赖统一用 pnpm，提交前必须跑全量测试，发布走 GitHub Actions。';

function entry(id, body, overrides = {}) {
  const note = {
    kind: 'semantic',
    trust: 'user_stated',
    scope: 'user',
    scope_detail: null,
    status: 'active',
    valid_from: null,
    valid_to: null,
    superseded_by: null,
    ...overrides.note,
  };
  return {
    id,
    title: overrides.title ?? id,
    body,
    note,
  };
}

test('发现层：只把同 scope/kind/trust 的高重叠正文成组', () => {
  const entries = [
    entry('a', BASE + ' 文档统一放 docs 目录。'),
    entry('b', BASE + ' 文档统一放 docs 目录，变更写 CHANGELOG。'),
    entry('c', BASE + ' 文档统一放 docs 目录。', { note: { scope: 'project', scope_detail: 'other' } }),
    entry('d', BASE + ' 文档统一放 docs 目录。', { note: { kind: 'procedural' } }),
    entry('e', BASE + ' 文档统一放 docs 目录。', { note: { trust: 'system_derived' } }),
  ];
  const r = discoverConsolidationProposals({ entries, nowMs: Date.parse('2026-10-18T00:00:00Z') });
  assert.equal(r.ok, true);
  assert.equal(r.schema, AUTO_CONSOLIDATE_SCHEMA);
  assert.equal(r.discovered ?? r.groups.length, 1);
  assert.equal(r.groups.length, 1);
  const group = r.groups[0];
  assert.deepEqual([...group.source_ids].sort(), ['a', 'b']);
  assert.equal(group.mode, 'merge');
  assert.ok(group.similarity >= AUTO_MIN_SIMILARITY, String(group.similarity));
  assert.equal(group.proposal_id, autoProposalId(['a', 'b']));
  assert.equal(autoProposalId(['b', 'a']), group.proposal_id, 'id 必须与源顺序无关');
});

test('发现层：archived / 已过期 / 太短的正文不参与', () => {
  const entries = [
    entry('a', BASE + ' 文档统一放 docs 目录。'),
    entry('b', BASE + ' 文档统一放 docs 目录，变更写 CHANGELOG。'),
    entry('archived', BASE + ' 文档统一放 docs 目录。', { note: { status: 'archived' } }),
    entry('expired', BASE + ' 文档统一放 docs 目录。', { note: { valid_to: '2020-01-01' } }),
    entry('superseded', BASE + ' 文档统一放 docs 目录。', { note: { superseded_by: 'x' } }),
    entry('short', '太短了，不够成组。'),
    entry('short2', '太短了，不够成组。'),
  ];
  const r = discoverConsolidationProposals({ entries, nowMs: Date.parse('2026-10-18T00:00:00Z') });
  assert.deepEqual(r.groups.map((g) => [...g.source_ids].sort()), [['a', 'b']]);
  assert.equal(r.eligible, 2);
});

test('发现层：阈值可调；maxGroup 与 maxProposals 有上限', () => {
  const entries = [];
  for (let i = 0; i < 6; i += 1) {
    entries.push(entry('id' + i, BASE + ' 第 ' + i + ' 条只有编号不同。'));
  }
  const strict = discoverConsolidationProposals({ entries, minSimilarity: 0.999 });
  assert.deepEqual(strict.groups, [], '阈值 0.999 时编号差异足以拆散');

  const grouped = discoverConsolidationProposals({ entries, maxGroup: 2, maxProposals: 2 });
  assert.equal(grouped.groups.length, 2);
  assert.equal(grouped.groups.every((g) => g.source_ids.length === 2), true);
  assert.equal(grouped.truncated, true);
  assert.ok(grouped.skipped >= 1);
  assert.deepEqual(grouped.thresholds, { min_similarity: AUTO_MIN_SIMILARITY, max_group: 2, max_proposals: 2 });
});
