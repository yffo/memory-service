/**
 * status 的「新装 / 刚捕获」状态：空库不该报「索引还没生成」。
 *
 * 索引是 notes/ 的纯函数；没有笔记时索引不存在是**正常**的，不是故障。
 * 面板和 CLI 都会把 warnings 直接摊给用户看，所以这条必须区分开。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir } from './helpers.mjs';
import { openStore, addCandidate, status } from '../src/api.js';

test('空库：没有笔记时不报「索引还没生成」', () => {
  const dir = tempDir('memory-status-empty-');
  const ctx = openStore(dir);
  const st = status(ctx);
  assert.equal(st.notes, 0);
  assert.equal(st.indexExists, false);
  assert.ok(!st.warnings.some((w) => w.includes('索引还没生成')), st.warnings.join('\n'));
});

test('只有候选：仍然不报索引缺失，只报候选待处理', () => {
  const dir = tempDir('memory-status-candidate-');
  const ctx = openStore(dir);
  addCandidate(ctx, { text: '# 代号\n\n内部代号是青鸟。', source: 'test' });
  const st = status(ctx);
  assert.equal(st.notes, 0);
  assert.equal(st.candidates, 1);
  assert.ok(st.warnings.some((w) => w.includes('候选待处理')), st.warnings.join('\n'));
  assert.ok(!st.warnings.some((w) => w.includes('索引还没生成')), st.warnings.join('\n'));
});

test('有笔记但没建索引：必须报，否则用户不知道索引是空的', () => {
  const dir = tempDir('memory-status-note-');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(
    join(dir, 'notes', 'alpha.md'),
    '---\nschema: memory.note/1\nkind: semantic\ntrust: user_stated\n---\n\n# alpha\n\n构建命令是 `pnpm run build`。\n',
    'utf8',
  );
  const st = status(openStore(dir));
  assert.equal(st.notes, 1);
  assert.ok(st.warnings.some((w) => w.includes('索引还没生成')), st.warnings.join('\n'));
});
