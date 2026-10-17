/**
 * 分层索引（`src/store/index-tree.js`）的用例。
 *
 * 这一层要守的是 Task 1 的**验收判据**：导入 1321 篇之后，「读索引」这条路
 * 不能再是九成瞎的。所以用例的重点不是渲染好不好看，而是三个数必须对得上：
 *  - `notes/` 里的条数；
 *  - 清单层真正列出来的条数；
 *  - 从 `MEMORY.md` 出发顺着链接**真能走到**的条数（读磁盘、不信任内存里的计划）。
 *
 * 语料全部虚构（`alpha-thing` / `beta-thing` 这种并不存在的主题），
 * 形状照真实库的样子造：一个大主题几百条、一堆单条小组、组名长短不一。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

import {
  groupKeyOf,
  buildIndexTree,
  leafGroupsOf,
  listRelPath,
  pointerLine,
  renderRoute,
  renderList,
  buildIndexPlan,
  fitRoute,
  readIndexTree,
  verifyRoutes,
  countPointerLines,
  idFromPointerLine,
  escapeLinkText,
  LIST_FILE_MAX_LINES,
  ROUTE_BUDGET,
} from '../src/store/index-tree.js';
import { tempDir, rm } from './helpers.mjs';

const CAPS = { maxLines: 200, maxBytes: 25 * 1024 };

/** 造一批「笔记条目」：真实的 scan 条目只要有 `id`。 */
function entries(ids) {
  return ids.map((id) => ({ id, title: `标题 ${id}`, note: { kind: 'semantic', trust: 'user_stated', tags: ['t'] } }));
}

/** `prefix` 主题下的 `n` 条（组名形状与真实库一致：`#N` 分片）。 */
function group(prefix, n) {
  return Array.from({ length: n }, (_, i) => (n === 1 ? prefix : `${prefix}#${i + 1}`));
}

// ── 组名 ──────────────────────────────────────────────────────────────────

test('分层索引：组名从 id 的 `#` 前缀推，没有 `#` 就整条当组名', () => {
  assert.equal(groupKeyOf('reference-thing#137'), 'reference-thing');
  assert.equal(groupKeyOf('topic-beta'), 'topic-beta');
  assert.equal(groupKeyOf('a#1#2'), 'a', '只认第一个 `#`：id 里不该有第二个，但不能因此错组');
});

// ── 容量：这是整个 Task 1 的要害 ────────────────────────────────────────────

test('分层索引：1321 条 72 组 → 路由层装得下、每条都有路（旧平铺索引只列得下 127 条）', () => {
  // 形状照真实库的量级：7 个大组 + 一堆小组，总数 1321（组名是虚构的）。
  const ids = [
    ...group('topic-a', 200),
    ...group('topic-b', 195),
    ...group('topic-c', 188),
    ...group('topic-d', 121),
    ...group('topic-e', 99),
    ...group('topic-f', 94),
    ...group('topic-g', 87),
    ...group('topic-h', 24),
    ...Array.from({ length: 313 }, (_, i) => `reference-single-${i + 1}`),
  ];
  assert.equal(ids.length, 1321, '夹具条数必须是 1321（与真实库同量级，这是判据的分母）');
  const plan = buildIndexPlan({ notes: entries(ids) }, { caps: CAPS });

  assert.equal(plan.total, 1321);
  assert.equal(plan.hidden, 0, '路由化之后不该再有列不下的笔记');
  assert.equal(plan.listed, 1321);
  assert.ok(plan.tree.groups.length <= ROUTE_BUDGET, `路由层 ${plan.tree.groups.length} 行超过预算`);
  // 旧路径的对照：平铺 200 行上限下只能列 190 多条（真实库实测 127 条）。
  assert.ok(plan.listed > 190 * 6, '分层索引的容量必须远大于平铺的一屏');
});

test('分层索引：清单文件超过单文件上限时**分页而不是截断**（截断等于重新造出盲区）', () => {
  const ids = group('project-big', LIST_FILE_MAX_LINES * 2 + 7);
  const plan = buildIndexPlan({ notes: entries(ids) }, { caps: CAPS });
  const f = plan.listFiles[0];
  assert.equal(f.count, LIST_FILE_MAX_LINES * 2 + 7, '文件里必须真的有这么多指针行');
  assert.equal(countPointerLines(f.text), f.count);
  assert.match(f.text, /…（续，第 2 段）/, '超长要分页，让人知道下面还有');
  assert.equal(plan.hidden, 0);
});

test('分层索引：组数超过路由预算时打包成中间层，打包之后仍然装得下', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `reference-single-${i + 1}`);
  const tree = buildIndexTree(entries(ids), { budget: 190 });
  assert.ok(tree.groups.length <= 190, '打包后路由行数必须落回预算内');
  assert.equal(tree.levels, 2, '打包 = 多一层');
  assert.equal(tree.groupCount, 500, '打包不改变真实组数（账要分开记）');
  assert.equal(tree.routeHidden, 0);
  // 打包出来的 digest 必须报得出子组的**真名**，否则人从标题里看不出里面有谁。
  const packed = tree.groups.find((g) => g.packed);
  assert.ok(packed && packed.children.length > 1);
  assert.ok(packed.count === packed.ids.length);
});

test('分层索引：组多到离谱时打包到预算内，真实组数照报（打包不许吞掉账）', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `g-${i}`);
  const tree = buildIndexTree(entries(ids), { budget: 2 });
  assert.ok(tree.groups.length <= 2, '打包之后路由行数必须落回预算内');
  assert.equal(tree.groupCount, 500, '真实组数不能被打包吞掉');
  assert.equal(tree.routeHidden, 0, '打包成功了就没有「装不下」');
  // 一行路由代表 250 个组时，它报的条数必须是这 250 组的**总和**，不是其中一组的。
  assert.equal(
    tree.groups.reduce((a, g) => a + g.count, 0),
    500,
    '路由层报的条数之和必须等于库里的条数',
  );
});

// ── 渲染 ──────────────────────────────────────────────────────────────────

test('分层索引：路由层每行都是能点进去的链接，清单层每行都能走回笔记', () => {
  const plan = buildIndexPlan({ notes: entries([...group('project-a', 3), ...group('project-b', 1)]) }, { caps: CAPS });
  const route = plan.routeText;
  assert.match(route, /^- \[project-a\]\(groups\/\d+-project-a\.md\) — 3 条$/m);
  assert.equal(countPointerLines(route), 0, '路由层不是清单层：一行笔记指针都不该有');
  for (const f of plan.listFiles) {
    for (const line of f.text.split('\n')) {
      if (!line.startsWith('- ')) continue;
      assert.ok(idFromPointerLine(line), `清单行没走到笔记：${line}`);
    }
  }
});

test('分层索引：标题里的 `]` `[` `(` 必须转义，否则那几条笔记点不进去', () => {
  // 真实库里旧文档切出来的片段标题就是正文第一句，方括号很常见。
  const nasty = '**两步走**：先升内核（`2799949`），见 [docs/x.md]（含 `]` 和括号）';
  const line = pointerLine({ id: 'project-a#1', title: nasty, note: { kind: 'semantic', trust: 'user_stated' } });
  assert.equal(idFromPointerLine(line), 'project-a#1', '标题再脏也必须解析出 id');
  const head = line.slice(0, line.indexOf('](notes/'));
  assert.ok(!head.slice(1).includes(']'), '标题部分不能有裸 `]`（会截断链接文本）');
  assert.equal(escapeLinkText('a[b]c'), 'a&#91;b&#93;c');
  // 解析器要有第二重保险（真实库里有标题**以 `](` 结尾**的笔记，转义救不了它）：
  // 取离行尾最近的那个目标。
  assert.equal(idFromPointerLine('- [x](notes/a.md) — 又被 [y](notes/b.md) 引用'), 'b');
  const reallyNasty = pointerLine({ id: 'project-a#2', title: '标题以 [链接]（', note: {} });
  assert.equal(idFromPointerLine(reallyNasty), 'project-a#2');
  // 真的没有笔记链接时返回 null，不能瞎猜一个 id 出来。
  assert.equal(idFromPointerLine('- … 还有 3 条未列入索引'), null);
  assert.equal(idFromPointerLine('普通一行'), null);
});

test('分层索引：清单文件路径只含安全字符，同名组不会互相覆盖', () => {
  const a = listRelPath({ name: 'project/a b' }, 1);
  const b = listRelPath({ name: '项目：中文组名' }, 2);
  assert.match(a, /^groups\/001-project-a-b\.md$/);
  assert.match(b, /^groups\/002-group\.md$/, '整串都不安全时要退化成占位名，不能变成空文件名');
  assert.notEqual(a, b);
});

// ── 账：三个数必须对得上 ───────────────────────────────────────────────────

test('分层索引：plan 的账自洽（listed + hidden === total）', () => {
  const plan = buildIndexPlan({ notes: entries([...group('a', 5), ...group('b', 2)]) }, { caps: CAPS });
  assert.equal(plan.listed + plan.hidden, plan.total);
  assert.equal(plan.listFileCount, plan.listFiles.length);
});

test('分层索引：路由层字节超限时逐条丢**最小**的组，丢了多少如实报', () => {
  // 组名故意造得很长：行数够、字节超 —— 这是「行数够了就以为没事」的经典坑。
  const long = Array.from({ length: 40 }, (_, i) => `reference-${'x'.repeat(60)}-${i}`);
  const ids = [...group('project-big', 30), ...long.flatMap((p) => group(p, 1))];
  const plan = buildIndexPlan({ notes: entries(ids) }, { caps: CAPS });
  const fitted = fitRoute({ plan, caps: { maxLines: 200, maxBytes: 3000 }, scan: { notes: entries(ids) } });
  assert.ok(fitted.routeBytes <= 3000, `削完还是超：${fitted.routeBytes}`);
  assert.ok(fitted.routeDropped.length > 0, '削了就必须报出来');
  assert.ok(fitted.total > fitted.listed, '削掉的条目要落在 hidden 里，不能凭空消失');
  assert.equal(fitted.listed + fitted.hidden, fitted.total);
  // 丢的是最小的组：30 条的大组必须还在。
  assert.ok(fitted.tree.groups.some((g) => g.name === 'project-big'), '大组不能被丢掉');
  // 丢掉的组不能还留在路由里（否则链接指向不存在的文件）。
  for (const d of fitted.routeDropped) {
    assert.ok(!fitted.tree.groups.some((g) => g.name === d), `被丢的组还在路由层里：${d}`);
  }
});

test('分层索引：路由层过不了字节闸门时由**生成器**先削（闸门拒写会让库从索引不全退化成没有索引）', () => {
  const ids = [...group('project-big', 50), ...Array.from({ length: 80 }, (_, i) => `reference-long-name-${'y'.repeat(40)}-${i}`)];
  const plan = buildIndexPlan({ notes: entries(ids) }, { caps: CAPS });
  const scan = { notes: entries(ids) };
  const fitted = fitRoute({ plan, caps: { maxLines: 200, maxBytes: 2500 }, scan });
  assert.ok(fitted.routeBytes <= 2500);
  assert.ok(fitted.listFileCount >= 1, '路由层削了也要留下能走的组');
});

// ── 幂等（§6.3 的 CI 判据）─────────────────────────────────────────────────

test('分层索引：同一份真相源渲染两次，字节完全一致（幂等性判据的生成器一侧）', () => {
  const ids = [...group('project-a', 7), ...group('project-b', 3), 'reference-solo'];
  const one = buildIndexPlan({ notes: entries(ids) }, { caps: CAPS });
  const two = buildIndexPlan({ notes: entries(ids) }, { caps: CAPS });
  assert.equal(one.routeText, two.routeText);
  assert.deepEqual(
    one.listFiles.map((f) => [f.rel, f.text]),
    two.listFiles.map((f) => [f.rel, f.text]),
  );
});

// ── 真文件系统：写出去、读回来、走一遍 ─────────────────────────────────────

test('分层索引：写到磁盘后 verifyRoutes 走得通每一条（读真文件，不信内存里的计划）', () => {
  const dir = tempDir('memory-idxtree-');
  try {
    const ids = [...group('project-a', 4), ...group('project-b', 2), 'reference-solo'];
    const plan = buildIndexPlan({ notes: entries(ids) }, { caps: CAPS });
    mkdirSync(join(dir, 'index', 'groups'), { recursive: true });
    writeFileSync(join(dir, 'index', 'MEMORY.md'), plan.routeText, 'utf8');
    for (const f of plan.listFiles) writeFileSync(join(dir, 'index', f.rel), f.text, 'utf8');

    const v = verifyRoutes(dir);
    assert.equal(v.ok, true);
    assert.equal(v.missingFiles.length, 0);
    assert.equal(v.reachable, ids.length, '每条笔记都必须能走到');
    for (const id of ids) assert.ok(v.ids.has(id), `${id} 走不到`);

    const tree = readIndexTree(dir, { caps: CAPS });
    assert.equal(tree.route.exists, true);
    assert.equal(tree.route.groups, plan.tree.groups.length);
    assert.equal(tree.listed, ids.length);
    assert.equal(tree.files, plan.listFiles.length);
  } finally {
    rm(dir);
  }
});

test('分层索引：路由层缺文件时 verifyRoutes 报 missingFiles，不假装成功', () => {
  const dir = tempDir('memory-idxtree-missing-');
  try {
    const ids = group('project-a', 3);
    const plan = buildIndexPlan({ notes: entries(ids) }, { caps: CAPS });
    mkdirSync(join(dir, 'index'), { recursive: true });
    writeFileSync(join(dir, 'index', 'MEMORY.md'), plan.routeText, 'utf8');
    // 故意不写清单文件
    const v = verifyRoutes(dir);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'list_file_missing');
    assert.ok(v.missingFiles.length > 0);
    assert.equal(v.reachable, 0);
  } finally {
    rm(dir);
  }
});

test('分层索引：没有索引时 readIndexTree/verifyRoutes 返回空账而不是抛异常', () => {
  const dir = tempDir('memory-idxtree-none-');
  try {
    const tree = readIndexTree(dir, { caps: CAPS });
    assert.equal(tree.route.exists, false);
    assert.equal(tree.listed, 0);
    assert.equal(tree.files, 0);
    const v = verifyRoutes(dir);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'route_missing');
  } finally {
    rm(dir);
  }
});

test('分层索引：路由行与指针行是两种行，谁都不会被算进对方的账', () => {
  const plan = buildIndexPlan({ notes: entries(group('a', 3)) }, { caps: CAPS });
  assert.equal(plan.routeText.includes('- … 路由层还有'), false, '装得下就不该出现削行说明');
  assert.match(plan.routeText, /^- \[a\]\(groups\/001-a\.md\) — 3 条$/m);
  assert.equal(countPointerLines(plan.routeText), 0, '路由行不是笔记指针（它指到清单文件）');

  // 削行说明行长得像指针但不是：它没有 `](notes/…)`，所以天然进不了账。
  const withHint = ['# MEMORY', '- [a](groups/001-a.md) — 3 条', '- … 路由层还有 2 组未列出（上限 200 行）'].join('\n');
  assert.equal(countPointerLines(withHint), 0);
  assert.equal(idFromPointerLine('- … 路由层还有 2 组未列出（上限 200 行）'), null);
});

// ── 平铺列表的兼容：小组的读法没变 ─────────────────────────────────────────

test('分层索引：小组的清单就是一行一条指针（人读索引的习惯不变）', () => {
  const node = {
    name: 'project-a',
    count: 2,
    ids: entries(['project-a#1', 'project-a#2']),
  };
  const text = renderList({ node, caps: CAPS });
  assert.match(text, /^# project-a$/m);
  assert.equal(countPointerLines(text), 2);
  for (const line of text.split('\n').filter((l) => l.startsWith('- '))) {
    assert.match(line, /^\d+\.|^- \[/, '保持 markdown 列表形状');
  }
});


// ── 空库：根节点没有 ids，不能当叶子 ──────────────────────────────────────

test('分层索引：空库也能生成路由层，不把根节点当叶子', () => {
  const plan = buildIndexPlan({ notes: [] }, { caps: CAPS, generatedAt: '2026-01-01T00:00:00Z' });
  assert.equal(plan.listFiles.length, 0);
  assert.equal(plan.listed, 0);
  assert.match(plan.routeText, /全库 0 条 \/ 0 组/);
  assert.equal(countPointerLines(plan.routeText), 0);
});
