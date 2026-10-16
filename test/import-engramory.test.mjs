/**
 * `src/import/engramory.js`：从旧 Engramory 库（`~/memory/engramory` 的形状）导入。
 *
 * 旧库的形状（实测）：一个 `MEMORY.md` 索引（`# Memory Index` + `## user` 之类的
 * 分区 + `- [标题](文件.md) — 摘要` 指针行），加上一堆 markdown 笔记，
 * frontmatter 是 `name / description / type(user|feedback|project|reference) /
 * scope / created / updated`。
 *
 * 这里全部用**虚构语料**（铁律 1：仓库里不许出现任何私人记忆内容）。
 * 导入的验收标准不是「搬过来了」，而是：① 幂等（跑两次不会变两份）
 * ② 有账（没收下的逐条列出）③ 过闸门（旧库里不合规的东西不许绕过新规则进来）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  planImport,
  applyImport,
  parseIndexPointers,
  listSourceNotes,
  readSourceIndex,
  TYPE_TO_KIND,
  TYPE_TO_TRUST,
} from '../src/import/engramory.js';
import { openStore, importFrom, status } from '../src/api.js';
import { parseNoteLoose } from '../src/store/note.js';
import { chunkText } from '../src/util/text.js';
import { tempDir, rm } from './helpers.mjs';

const INDEX = `# Memory Index

> 一行一个指针，内容在笔记里。上限 200 行 / 25KB。

## user

- [用户偏好与工作习惯](user-preferences.md) — 用户偏好 TypeScript、讨厌隐式 any
- [常用构建工具](user-build-tools.md) — 构建统一走 acme-bundler，产物落 dist/

## feedback

- [不要动无关代码](feedback-scope-discipline.md) — 改 bug 时不要顺手重构没坏的东西

## project

- [acme-widget 的发布流程](project-release-flow.md) — 三步：构建 → 同步 → 冒烟

## reference

- [某博客对 BM25 参数的说法](reference-bm25-blog.md) — 外部资料，b 取 0.75，未经本地实测
`;

/** 造一个旧格式的库（全部虚构）。 */
function makeLegacyStore() {
  const dir = tempDir('memory-legacy-');
  writeFileSync(join(dir, 'MEMORY.md'), INDEX, 'utf8');
  const note = (name, { type, description, body, created = '2026-08-01', updated = '2026-09-01' }) =>
    writeFileSync(
      join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\nscope: global\ncreated: ${created}\nupdated: ${updated}\n---\n\n${body}\n`,
      'utf8',
    );

  note('user-preferences', {
    type: 'user',
    description: '用户偏好 TypeScript、讨厌隐式 any',
    body: '# 用户偏好与工作习惯\n\n用户偏好 TypeScript，讨厌隐式 any；提交前要跑一遍 `pnpm run lint`。',
  });
  note('user-build-tools', {
    type: 'user',
    description: '构建统一走 acme-bundler，产物落 dist/',
    body: '# 常用构建工具\n\n构建统一走 `acme-bundler`，产物落在 `dist/`。',
  });
  note('feedback-scope-discipline', {
    type: 'feedback',
    description: '改 bug 时不要顺手重构没坏的东西',
    body: '# 不要动无关代码\n\n改 bug 时就改 bug，不要顺手重构没坏的东西。',
  });
  note('project-release-flow', {
    type: 'project',
    description: '三步：构建 → 同步 → 冒烟',
    body: '# acme-widget 的发布流程\n\n发布三步：① 构建；② 同步到 staging；③ 跑冒烟脚本。',
  });
  note('reference-bm25-blog', {
    type: 'reference',
    description: '外部资料，b 取 0.75，未经本地实测',
    body: '# 某博客对 BM25 参数的说法\n\n某博客说 BM25 的 b 参数应该取 0.75、k1 取 1.2。这是外部资料，未经本地实测。',
  });
  // 故意放一个坏文件：没有 frontmatter。导入必须**记账**而不是崩掉或假装没看见。
  writeFileSync(join(dir, 'broken-no-frontmatter.md'), '# 随手记\n\n没有 frontmatter 的一段话。\n', 'utf8');
  // 故意放一个索引里有指针、但文件不在的（反向也要能报）
  return dir;
}

test('parseIndexPointers：认出 `- [标题](文件.md) — 摘要`，坏行单独记账', () => {
  const { pointers, badLines } = parseIndexPointers(INDEX);
  assert.equal(pointers.size, 5);
  const p = pointers.get('user-preferences.md');
  assert.equal(p.title, '用户偏好与工作习惯');
  assert.equal(p.section, 'user');
  assert.ok(p.summary.includes('TypeScript'));
  assert.equal(p.line > 0, true, '指针要记住自己在第几行（重建索引时要按原序）');
  assert.deepEqual(badLines, [], '这份索引每行都是合法的');

  // `badLines` 只记**看起来想当指针但格式不对**的行（以 `- ` 开头）。
  // 正文散文（`这不是指针`）不算坏行 —— 索引里可以有说明文字，
  // 把每一行非指针都报错会让 badLines 变成一个永远非零、因而没人看的数字。
  const mixed = parseIndexPointers('# Memory Index\n\n- [好的一行](a.md) — 摘要\n这是说明文字，不算坏行\n- 破了的一行\n');
  assert.equal(mixed.pointers.size, 1);
  assert.equal(mixed.badLines.length, 1, '以 - 开头但解析不出指针的行必须记账');
  assert.equal(mixed.badLines[0].line, 5);
});

test('listSourceNotes / readSourceIndex：列全笔记、MEMORY.md 单列出来', () => {
  const dir = makeLegacyStore();
  try {
    const { files, missing } = listSourceNotes(dir);
    assert.ok(files.includes('user-preferences.md'));
    assert.ok(files.includes('broken-no-frontmatter.md'));
    assert.ok(!files.includes('MEMORY.md'), '索引不是笔记，不能当笔记导进来');
    assert.deepEqual(files, [...files].sort(), '顺序必须稳定（否则每次 plan 的 id 分配都会漂）');
    assert.equal(missing, false);

    const idx = readSourceIndex(dir);
    assert.equal(idx.exists, true);
    assert.ok(idx.text.includes('Memory Index'));

    const gone = listSourceNotes(join(dir, '不存在'));
    assert.equal(gone.missing, true);
    assert.deepEqual(gone.files, []);
  } finally {
    rm(dir);
  }
});

test('planImport：类型映射进四类 kind，坏文件进 failures 而不是被吞掉', () => {
  const dir = makeLegacyStore();
  try {
    assert.equal(TYPE_TO_KIND.user, 'semantic');
    assert.equal(TYPE_TO_KIND.feedback, 'procedural');
    assert.equal(TYPE_TO_TRUST.reference, 'external');
    assert.equal(TYPE_TO_TRUST.feedback, 'user_stated');

    const plan = planImport(dir, { now: 1_760_000_000_000 });
    const byFile = new Map(plan.entries.map((e) => [e.file, e]));
    assert.equal(byFile.get('user-preferences.md').kind, 'semantic');
    assert.equal(byFile.get('feedback-scope-discipline.md').kind, 'procedural');
    assert.equal(byFile.get('reference-bm25-blog.md').trust, 'external');
    assert.equal(byFile.get('project-release-flow.md').trust, 'system_derived');
    for (const e of plan.entries) {
      assert.equal(e.action, 'create');
      assert.ok(e.id, '每条都要先分好 id（plan 是可复现的，导入只是执行）');
      assert.equal(e.chunks.length, 1, '这些 fixture 都不超 400 字，不该被切');
      assert.ok(e.chunks[0].body && e.chunks[0].body.length > 0);
      assert.ok(e.chunks[0].rev, '正文摘要指纹：重跑时要靠它判断「变了没有」');
    }
    // 索引摘要被带进 note.legacy，导入后还能对回旧索引
    assert.equal(byFile.get('user-preferences.md').index_summary.includes('TypeScript'), true);

    assert.equal(plan.failures.length, 1, `坏文件应恰好一条：${JSON.stringify(plan.failures)}`);
    assert.equal(plan.failures[0].file, 'broken-no-frontmatter.md');
    // 没有 frontmatter 的旧文件不收：给它套默认元数据等于替用户认领一句他没说过的话
    assert.equal(plan.failures[0].code, 'E_FRONTMATTER_MISSING');
    assert.ok(!plan.entries.some((e) => e.file === 'broken-no-frontmatter.md'));
    assert.equal(plan.source.indexPointers, 5);
    assert.equal(plan.source.badLines.length, 0, '这份索引每行都合法');
  } finally {
    rm(dir);
  }
});

test('importFrom：真的写进新库、过闸门、可检索，且逐条对得上', () => {
  const src = makeLegacyStore();
  const dest = tempDir('memory-import-dest-');
  try {
    const ctx = openStore(dest);
    const r = importFrom(ctx, src, { dry: false });
    assert.equal(r.imported, 5, `应当导入 5 条：${JSON.stringify(r.results)}`);
    assert.equal(r.denied, 0);
    assert.equal(r.failures, 1, '坏文件仍然计入 failures');
    assert.deepEqual(r.not_imported.map((x) => x.file), ['broken-no-frontmatter.md']);

    const files = readdirSync(join(dest, 'notes')).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 5);

    const s = status(ctx);
    assert.equal(s.notes, 5);
    assert.equal(s.parseFailures, 0, '导进来的东西必须全部可解析（否则等于把坏数据搬了个家）');

    // 导进来的笔记要能按文件名 id 读出来，正文与旧库一致
    // 导入时**用源文件名当 id**（去掉 `.md`）：`02-evaluation.md` 的 gold_notes 写的就是文件名，
    // 换成新发 ULID 会让所有既有标注当场失配（检索没问题，是「一条记忆叫什么」被改了）。
    const read = ctx.scan().notes.find((n) => n.id === 'user-preferences');
    assert.ok(read, `找不到 user-preferences，实际有 ${ctx.scan().notes.map((n) => n.id)}`);
    assert.ok(read.body.includes('TypeScript'));
    assert.equal(read.note.kind, 'semantic');
    assert.equal(read.note.legacy.source_file, 'user-preferences.md', '要留下「从哪个文件来的」');
  } finally {
    rm(src);
    rm(dest);
  }
});

test('importFrom 幂等：第二次跑全部 skip（同一条事实不许变成两条）', () => {
  const src = makeLegacyStore();
  const dest = tempDir('memory-import-idem-');
  try {
    const ctx = openStore(dest);
    const first = importFrom(ctx, src, { dry: false });
    assert.equal(first.imported, 5);

    const second = importFrom(ctx, src, { dry: false });
    assert.equal(second.imported, 0, `第二次不该再导入：${JSON.stringify(second.results)}`);
    assert.equal(second.skipped, 5, '应当全部 skip（unchanged）');
    assert.equal(status(ctx).notes, 5, '笔记数不能变');

    // 源文件改了内容 → 同一条被 update，而不是新增
    writeFileSync(
      join(src, 'user-preferences.md'),
      '---\nname: user-preferences\ndescription: 改了\ntype: user\nscope: global\ncreated: 2026-08-01\nupdated: 2026-10-01\n---\n\n# 用户偏好\n\n用户偏好 TypeScript，也偏好 `acme-bundler`。\n',
      'utf8',
    );
    const third = importFrom(ctx, src, { dry: false });
    assert.equal(third.imported, 0);
    assert.equal(third.updated, 1, `应恰好更新一条：${JSON.stringify(third.results.filter((x) => x.action === 'update'))}`);
    assert.equal(status(ctx).notes, 5, 'update 不是新建');
  } finally {
    rm(src);
    rm(dest);
  }
});

test('importFrom --dry：只报计划、一个字都不写', () => {
  const src = makeLegacyStore();
  const dest = tempDir('memory-import-dry-');
  try {
    const ctx = openStore(dest);
    const r = importFrom(ctx, src, { dry: true });
    assert.equal(r.dry, true);
    assert.equal(r.planned, 5);
    assert.equal(r.imported, 0, '--dry 不许写');
    assert.equal(status(ctx).notes, 0);
    const notesDir = join(dest, 'notes');
    const written = existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith('.md')) : [];
    assert.deepEqual(written, [], `--dry 不许落任何笔记文件，实际写了 ${written}`);
  } finally {
    rm(src);
    rm(dest);
  }
});

test('applyImport：remember 说 deny 的不算导入成功，并且出现在 denied_files 里', () => {
  const src = makeLegacyStore();
  try {
    const plan = planImport(src, { now: 1_760_000_000_000 });
    // 把闸门换成「一律拒绝」，模拟旧库里混进了不合规内容
    const r = applyImport('/tmp/不存在的库', plan, {
      dry: true,
      remember: () => ({ verdict: 'deny', gate: 'deny', reason: 'would_promote_external_to_instruction', details: { why: '测试' } }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.imported, 0);
    assert.equal(r.denied, plan.entries.length);
    assert.equal(r.denied_files.length, plan.entries.length, '被拒的每一条都要列出来（静默丢数据是最坏的形态）');
    assert.ok(r.denied_files[0].reason);
  } finally {
    rm(src);
  }
});

test('importFrom：源目录不存在 → 明确报错，不是静默导入 0 条', () => {
  const dest = tempDir('memory-import-missing-');
  try {
    const ctx = openStore(dest);
    const r = importFrom(ctx, join(dest, '没有这个目录'), { dry: false });
    // 源目录不存在 → `ok:false` 才是诚实的：调用方据 `ok` 决定要不要报警，
    // 报 0 条导入会让「源路径打错了」看起来像「源库是空的」。
    assert.equal(r.ok, false);
    assert.equal(r.sourceMissing, true);
    assert.equal(r.planned, 0);
    assert.equal(r.imported, 0);
    assert.equal(r.skipped, 0);
    assert.equal(status(ctx).notes, 0);
  } finally {
    rm(dest);
  }
});

test('长文切分：一篇旧笔记切成多条 ≤400 字的事实，一个字都不丢', () => {
  const src = tempDir('memory-import-split-');
  const dest = tempDir('memory-import-split-dest-');
  try {
    // 三个自然段 + 一个超长单行：专挑切分器的三个分支（空行 / 行 / 标点回退）
    const para1 = '第一段讲的是 acme-widget 的构建入口。'.repeat(6);
    const para2 = '第二段讲的是发布流程与回滚办法。'.repeat(6);
    const longLine = `${'这句话很长所以要在标点处回退切分，'.repeat(30)}结束。`;
    const body = `# 一大篇\n\n${para1}\n\n${para2}\n\n${longLine}\n`;
    writeFileSync(
      join(src, 'project-big-topic.md'),
      `---\nname: project-big-topic\ndescription: 一大篇\ntype: project\nscope: global\ncreated: 2026-08-01\n---\n\n${body}`,
      'utf8',
    );

    const plan = planImport(src, { now: 1_760_000_000_000 });
    const entry = plan.entries[0];
    assert.ok(entry.chunks.length > 1, `长文必须被切开，实际 ${entry.chunks.length} 片`);
    assert.equal(entry.split.parts, entry.chunks.length);
    for (const c of entry.chunks) {
      assert.ok(c.chars <= 400, `每一片都要过闸门的上限：${c.id} = ${c.chars} 字`);
      assert.ok(c.note.legacy.part >= 1 && c.note.legacy.parts === entry.chunks.length);
      assert.deepEqual(c.note.legacy.derived_from, ['engramory:project-big-topic.md'], '切出来的兄弟片要留亲缘关系');
    }
    // id 用源文件名 + `#n`：既能一眼看出「它们本来是一篇」，又不会跟别的笔记撞。
    assert.equal(entry.chunks[0].id, 'project-big-topic#1');
    assert.equal(entry.chunks[1].id, 'project-big-topic#2');

    // 不丢字：把所有片的正文拼回去，非空白字符必须与原文一致（切分不是摘要）
    const strip = (t) => t.replace(/\s+/g, '');
    const parsedBody = parseNoteLoose(readFileSync(join(src, 'project-big-topic.md'), 'utf8')).body.trim();
    const joined = strip(entry.chunks.map((c) => c.body).join(''));
    assert.equal(joined, strip(parsedBody), '切分只许丢空行，不许丢字');

    // 真的落盘：几条事实就是几个文件
    const ctx = openStore(dest);
    const r = importFrom(ctx, src, { dry: false });
    assert.equal(r.imported, entry.chunks.length);
    assert.equal(r.denied, 0, `切完还要被拒就说明切分没起作用：${JSON.stringify(r.results)}`);
    const files = readdirSync(join(dest, 'notes')).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, entry.chunks.length);
    assert.equal(status(ctx).notes, entry.chunks.length);

    // 重跑：同一篇的每一片各自认领自己（按 id，不是按源文件名），全部 skip
    const again = importFrom(ctx, src, { dry: false });
    assert.equal(again.imported, 0, `重跑不该再写：${JSON.stringify(again.results.slice(0, 3))}`);
    assert.equal(again.skipped, entry.chunks.length);
    assert.equal(status(ctx).notes, entry.chunks.length, '重跑之后条数不能变');
  } finally {
    rm(src);
    rm(dest);
  }
});

test('长文切分：整篇都是碎片时明确报 E_ONLY_FRAGMENTS，并把碎片数记账', () => {
  const src = tempDir('memory-import-frag-');
  try {
    // 全是短碎片：切分器会把它们合成一片，但仍短于闸门下限 —— 这时**不送闸门**，
    // 而是给出一个说得清的失败原因。送进闸门的结果是 `denied: too_short`，
    // 那个数字看起来像「闸门拦下了坏数据」，实际只是「这篇本来就没内容」。
    writeFileSync(
      join(src, 'project-frag.md'),
      // 整篇只有 7 个字符：切分器产出一片，仍短于闸门下限 8 字
      '---\nname: project-frag\ntype: project\nscope: global\ncreated: 2026-08-01\n---\n\n- a\n- b\n',
      'utf8',
    );
    const plan = planImport(src, { now: 1_760_000_000_000 });
    assert.equal(plan.entries.length, 0, '没有可入档的事实');
    assert.equal(plan.failures.length, 1);
    assert.equal(plan.failures[0].code, 'E_ONLY_FRAGMENTS');
    assert.ok(plan.failures[0].message.includes('碎片'));

    // 有正常内容时，夹在中间的短行（`- x` / 单字符标题）被丢掉，但**丢了多少要报**：
    // 一个 500 字的段落会把前后的短行挤成独立的片，它们不够 8 字就进不了闸门。
    writeFileSync(
      join(src, 'project-mixed.md'),
      `---\nname: project-mixed\ntype: project\nscope: global\ncreated: 2026-08-01\n---\n\n# 主题\n\n${'这是一条正常的事实描述，长度足够入档。'.repeat(25)}\n\n- x\n\n${'另一条足够长的事实描述，用来把前后两片分开。'.repeat(25)}\n\n完\n`,
      'utf8',
    );
    const mixed = planImport(src, { now: 1_760_000_000_000 });
    const entry = mixed.entries.find((e) => e.file === 'project-mixed.md');
    assert.ok(entry, `project-mixed.md 应当有可入档内容：${JSON.stringify(mixed.failures)}`);
    assert.ok(
      entry.fragments_dropped >= 1,
      `短碎片必须记账（否则就是静默丢数据）：${JSON.stringify(entry.chunks.map((c) => [c.id, c.chars]))}`,
    );
    assert.ok(entry.fragments_chars > 0, '丢了多少字也要有数');
    for (const c of entry.chunks) assert.ok(c.chars >= 8, '进计划的每一片都得够长');
  } finally {
    rm(src);
  }
});
