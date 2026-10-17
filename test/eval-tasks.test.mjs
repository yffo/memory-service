/**
 * 题集纪律测试：把「题集必须自洽、不许泄题」的规矩写成可执行的检查。
 *
 * 这一组的立场：**题集是要拿去判分的**，所以它自己先得被判。
 * 每条检查都对应 `docs/02-evaluation.md §4.2/§4.3` 里的一条纪律：
 *   - 反向构题：先有笔记，再有题 —— 所以每条 expect 必须能**逐字**追回 source 笔记正文；
 *   - 防泄漏①：prompt 不得含答案串，与笔记的 8-gram 重叠 ≤ 30%；
 *   - 防泄漏⑤：expect / forbid 不许互相包含（否则命中判定会骑墙）；
 *   - forbid 必须是**真实存在的错误候选**（能在别的笔记里找到），不是临时编的字符串；
 *   - 纠错题必须指向「当前笔记 supersedes 掉的旧笔记」，否则它测不出「知道新的」；
 *   - 一个字的私人内容都不许进语料：过一遍 denylist。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRefusalTask, normalizeText, termVariants } from '../bench/scorer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.join(HERE, '..', 'bench', 'core-30-v1');
const LIBRARY = path.join(SUITE, 'library');
const TASKS_PATH = path.join(SUITE, 'tasks.json');

/** 四类能力 + 拒答（拒答用 source:[] 表达，不新增第五种「任务」语义）。 */
const KINDS = ['fact_recall', 'preference', 'correction', 'procedure', 'refusal'];
const REQUIRED_QUOTA = { fact_recall: 8, preference: 6, correction: 6, procedure: 6, refusal: 6 };
const MIN_TASKS = 30;
const MAX_EXPECT_CHARS = 60;
const MAX_PROMPT_LEAK = 0.3;

const suite = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8'));
const tasks = suite.tasks;

/** 读语料库：返回 Map<文件名, {frontmatter, body, raw}>。 */
function readLibrary() {
  const docs = new Map();
  for (const name of fs.readdirSync(LIBRARY).sort()) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
    const raw = fs.readFileSync(path.join(LIBRARY, name), 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const frontmatter = {};
    if (m) {
      let current = null;
      for (const line of m[1].split(/\r?\n/)) {
        if (/^\s*#/.test(line) || line.trim() === '') continue;
        const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (kv) {
          current = kv[1];
          frontmatter[current] = kv[2].trim();
        } else if (current && /^\s+\S/.test(line)) {
          frontmatter[current] = `${frontmatter[current]} ${line.trim()}`.trim();
        }
      }
    }
    docs.set(name, { name, frontmatter, body: m ? raw.slice(m[0].length) : raw, raw });
  }
  return docs;
}

const docs = readLibrary();
const noteNames = [...docs.keys()];
const bodyOf = (name) => (docs.has(name) ? docs.get(name).body : '');

/** 逐字（原样）追一条字符串到某篇笔记正文。 */
function traceRaw(text, names = noteNames) {
  return names.filter((n) => bodyOf(n).includes(text));
}

/**
 * 笔记的**内容**：正文去掉 H1 标题行。
 *
 * 为什么把标题摘出去：H1 就是这条笔记的名字，也是索引里那一行（`- xxx.md — 说明`），
 * 任何一句「问这条笔记讲的事」的话都会跟它撞词——把标题算进重叠率，等于要求题面
 * 回避话题本身，检索反而更差。`docs/02-evaluation.md §4.3①` 要防的是「题面抄笔记内容」，
 * 内容在标题之外的正文里；含标题的数另外用一个宽松上限兜底（见下一条 test）。
 */
function contentOf(name) {
  return bodyOf(name).replace(/^#\s.*$/m, '');
}

/** 归一化 / 别名换算后再追（判分器认的等价写法，这里也要认）。 */
function traceLoose(text, names = noteNames) {
  const variants = termVariants(text).map(normalizeText).filter(Boolean);
  return names.filter((n) => {
    const haystack = normalizeText(bodyOf(n));
    return variants.some((v) => haystack.includes(v));
  });
}

/** 字符 8-gram 集合（防泄漏①的重叠率）。 */
function ngrams(text, n = 8) {
  const clean = normalizeText(text);
  const out = new Set();
  if (clean.length < n) return out;
  for (let i = 0; i + n <= clean.length; i += 1) out.add(clean.slice(i, i + n));
  return out;
}

function overlapRatio(a, b) {
  const ga = ngrams(a);
  const gb = ngrams(b);
  if (ga.size === 0) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / ga.size;
}

test('tasks.json：形状、版本、题量、四类配额', () => {
  assert.equal(suite.version, 'core-30-v1');
  assert.ok(Array.isArray(tasks), 'tasks 必须是数组');
  assert.ok(tasks.length >= MIN_TASKS, `至少要 ${MIN_TASKS} 条题，现在是 ${tasks.length}`);
  const byKind = {};
  for (const t of tasks) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
  for (const kind of KINDS) {
    assert.ok(REQUIRED_QUOTA[kind] <= (byKind[kind] ?? 0), `${kind} 至少 ${REQUIRED_QUOTA[kind]} 条，现在 ${byKind[kind] ?? 0} 条`);
  }
  for (const kind of Object.keys(byKind)) assert.ok(KINDS.includes(kind), `出现了没定义的 kind：${kind}`);
  // 拒答率阈值 0.75 的粒度：拒答题太少会让「一条题顶一格」太粗。
  assert.ok(byKind.refusal * 0.25 >= 1, '拒答题数量要够细（≥4）才配得上 0.75 的阈值');
});

test('tasks.json：id 唯一、字段齐、expect 不为空（拒答除外）、expect 限长 ≤60', () => {
  const ids = new Set();
  const required = ['expect', 'forbid', 'id', 'kind', 'prompt', 'source'];
  const allowed = [...required, 'answer_aliases'];
  for (const t of tasks) {
    for (const key of Object.keys(t)) assert.ok(allowed.includes(key), `${t.id} 有未定义字段 ${key}`);
    for (const key of required) assert.ok(Object.hasOwn(t, key), `${t.id} 缺字段 ${key}`);
    if (t.answer_aliases !== undefined) {
      assert.ok(Array.isArray(t.answer_aliases), `${t.id} 的 answer_aliases 必须是数组`);
      for (const alias of t.answer_aliases) {
        assert.ok(typeof alias === 'string' && alias.trim().length > 0, `${t.id} 的别名必须是非空字符串`);
        assert.ok(alias.length <= MAX_EXPECT_CHARS, `${t.id} 的别名超过 ${MAX_EXPECT_CHARS} 字：${alias}`);
      }
    }
    assert.match(t.id, /^[a-z]\d{2}$/, `id 形状：${t.id}`);
    assert.ok(!ids.has(t.id), `id 重复：${t.id}`);
    ids.add(t.id);
    assert.equal(typeof t.prompt, 'string');
    assert.ok(t.prompt.trim().length >= 6, `${t.id} 的 prompt 太短`);
    assert.ok(Array.isArray(t.expect) && Array.isArray(t.forbid) && Array.isArray(t.source));
    if (isRefusalTask(t)) {
      assert.equal(t.expect.length, 0, `${t.id} 是拒答题，不该有 expect`);
    } else {
      assert.ok(t.expect.length >= 1, `${t.id} 至少要有一条期望答案`);
    }
    for (const e of t.expect) {
      assert.ok(e.length <= MAX_EXPECT_CHARS, `${t.id} 的 expect 超过 ${MAX_EXPECT_CHARS} 字：${e}`);
    }
  }
  assert.equal(new Set(tasks.map((t) => t.prompt)).size, tasks.length, 'prompt 不该重复');
});

test('题集齐：每条 source 笔记都在库里，拒答题不带 source', () => {
  for (const t of tasks) {
    if (isRefusalTask(t)) {
      assert.equal(t.source.length, 0);
      continue;
    }
    assert.ok(t.source.length >= 1, `${t.id} 没有 source`);
    for (const file of t.source) {
      assert.ok(docs.has(file), `${t.id} 指向的笔记不存在：${file}`);
      assert.notEqual(file, 'MEMORY.md', '索引不是笔记，不能当 gold');
    }
  }
});

test('expect 可追：至少一条逐字出现在 source 正文里，其余走归一化/别名也追得上', () => {
  for (const t of tasks) {
    if (isRefusalTask(t)) continue;
    const rawHits = t.expect.filter((e) => traceRaw(e, t.source).length > 0);
    assert.ok(rawHits.length >= 1, `${t.id} 没有一条 expect 能逐字追回 source：${JSON.stringify(t.expect)}`);
    for (const e of t.expect) {
      const loose = traceLoose(e, t.source);
      assert.ok(loose.length >= 1, `${t.id} 的 expect「${e}」连归一化/别名都追不回 source`);
    }
  }
});

test('防泄漏①：prompt 不含 expect 关键词，与笔记内容的 8-gram 重叠 ≤30%', () => {
  for (const t of tasks) {
    const np = normalizeText(t.prompt);
    for (const e of t.expect) {
      for (const v of termVariants(e).map(normalizeText).filter(Boolean)) {
        assert.ok(!np.includes(v), `${t.id} 的 prompt 直接含答案串「${e}」`);
      }
    }
    if (isRefusalTask(t)) continue;
    for (const file of t.source) {
      const ratio = overlapRatio(t.prompt, contentOf(file));
      assert.ok(ratio <= MAX_PROMPT_LEAK, `${t.id} 与 ${file} 正文的 8-gram 重叠 ${(ratio * 100).toFixed(1)}% > 30%`);
    }
  }
});

test('防泄漏①（兜底）：题面不许就是标题（含标题重叠 >75% 视为抄标题），且题面不是索引行', () => {
  const indexLines = fs
    .readFileSync(path.join(LIBRARY, 'MEMORY.md'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().startsWith('- '));
  for (const t of tasks) {
    if (isRefusalTask(t)) continue;
    assert.ok(!indexLines.some((l) => normalizeText(l).includes(normalizeText(t.prompt))), `${t.id} 的 prompt 直接用了索引行`);
    for (const file of t.source) {
      const ratio = overlapRatio(t.prompt, bodyOf(file));
      assert.ok(ratio <= 0.75, `${t.id} 与 ${file}（含标题）重叠 ${(ratio * 100).toFixed(1)}%，题面基本等于标题了`);
    }
  }
});

test('防泄漏⑤：expect 与 forbid 不许互相包含', () => {
  for (const t of tasks) {
    for (const e of t.expect) {
      for (const f of t.forbid) {
        const ne = normalizeText(e);
        const nf = normalizeText(f);
        assert.ok(!ne.includes(nf) && !nf.includes(ne), `${t.id} 里 expect「${e}」与 forbid「${f}」互相包含`);
      }
    }
  }
});

test('forbid 是真实陷阱：不在 source 里，但能在别的笔记里找到', () => {
  for (const t of tasks) {
    for (const f of t.forbid) {
      if (!isRefusalTask(t)) {
        assert.equal(traceLoose(f, t.source).length, 0, `${t.id} 的 forbid「${f}」出现在 source 里（那就不是陷阱了）`);
      }
      const elsewhere = traceLoose(f).filter((n) => !t.source.includes(n));
      assert.ok(elsewhere.length >= 1, `${t.id} 的 forbid「${f}」在任何一篇笔记里都找不到（编的陷阱不算陷阱）`);
    }
  }
});

test('纠错题：source 笔记 supersedes 掉的旧笔记里，必须能找到这条 forbid', () => {
  const corrections = tasks.filter((t) => t.kind === 'correction');
  assert.ok(corrections.length >= REQUIRED_QUOTA.correction);
  for (const t of corrections) {
    for (const file of t.source) {
      const fm = docs.get(file).frontmatter;
      const old = String(fm.supersedes ?? '')
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => `${s}.md`);
      assert.ok(old.length >= 1, `${t.id} 的 source ${file} 没有 supersedes，纠错题测的是什么？`);
      for (const oldFile of old) {
        assert.ok(docs.has(oldFile), `${t.id} 的 supersedes 指向不存在的笔记：${oldFile}`);
        assert.equal(docs.get(oldFile).frontmatter.status, 'superseded', `${oldFile} 应该标成 superseded`);
        assert.equal(docs.get(oldFile).frontmatter.superseded_by, file.replace(/\.md$/, ''), `${oldFile} 的 superseded_by 应指回 ${file}`);
      }
      const oldBodies = old.map((n) => bodyOf(n));
      const found = t.forbid.some((f) => {
        const variants = termVariants(f).map(normalizeText).filter(Boolean);
        return oldBodies.some((b) => variants.some((v) => normalizeText(b).includes(v)));
      });
      assert.ok(found, `${t.id} 的 forbid 没有一条能在 ${old.join('/')} 里找到（旧值得是真实存在过的）`);
    }
  }
});

test('语料库 frontmatter：A 的 schema 字段齐、id 对得上文件名、取值范围合法', () => {
  assert.ok(noteNames.length >= 40, `语料库太小：${noteNames.length} 篇`);
  for (const [name, doc] of docs) {
    const fm = doc.frontmatter;
    for (const key of ['schema', 'id', 'name', 'description', 'type', 'scope', 'kind', 'trust', 'status', 'created', 'updated']) {
      assert.ok(fm[key], `${name} 缺 frontmatter 字段 ${key}`);
    }
    assert.equal(fm.schema, 'memory.note/1');
    assert.equal(fm.id, name.replace(/\.md$/, ''), `${name} 的 id 必须等于文件名`);
    assert.equal(fm.name, fm.id);
    assert.ok(['user', 'feedback', 'project', 'reference'].includes(fm.type), `${name} 的 type 越界：${fm.type}`);
    assert.ok(['core', 'semantic', 'episodic', 'procedural'].includes(fm.kind), `${name} 的 kind 越界：${fm.kind}`);
    assert.ok(['user_stated', 'system_derived', 'external'].includes(fm.trust), `${name} 的 trust 越界：${fm.trust}`);
    assert.ok(['draft', 'active', 'stale', 'superseded', 'archived'].includes(fm.status), `${name} 的 status 越界：${fm.status}`);
    assert.match(fm.scope, /^(user|project(:[\w-]+)?)$/, `${name} 的 scope 越界：${fm.scope}`);
    assert.match(String(fm.created), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(String(fm.updated), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(doc.body, /^# \S/m, `${name} 正文要有标题行`);
    // description 不许含具体取值，否则索引会泄题（索引就是 description 拼的）
    assert.ok(fm.description.length <= 60, `${name} 的 description 太长，会在索引里变相泄题`);
  }
  assert.equal(new Set([...docs.values()].map((d) => d.frontmatter.id)).size, docs.size, 'id 撞了');
});

test('语料库 frontmatter：已失效笔记要有 valid_to，当前笔记的 supersedes 指向存在', () => {
  let pairs = 0;
  for (const [name, doc] of docs) {
    const fm = doc.frontmatter;
    if (fm.supersedes) {
      const old = String(fm.supersedes).replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const o of old) {
        assert.ok(docs.has(`${o}.md`), `${name} 的 supersedes 指向不存在的 ${o}.md`);
        assert.equal(docs.get(`${o}.md`).frontmatter.superseded_by, fm.id, `${o}.md 要指回 ${name}`);
        assert.ok(docs.get(`${o}.md`).frontmatter.valid_to, `${o}.md 失效了就该有 valid_to`);
        assert.match(String(docs.get(`${o}.md`).frontmatter.valid_to), /^\d{4}-\d{2}-\d{2}$/);
        pairs += 1;
      }
    }
    if (name.startsWith('archive-')) {
      assert.equal(fm.status, 'superseded', `${name} 是归档，status 应为 superseded`);
      assert.ok(fm.valid_to, `${name} 缺 valid_to`);
    }
  }
  assert.ok(pairs >= 8, `「当前 vs 已失效」的对照组太少：${pairs}`);
});

test('MEMORY.md 索引：一篇一行、指向存在的笔记、不泄具体取值', () => {
  const index = fs.readFileSync(path.join(LIBRARY, 'MEMORY.md'), 'utf8');
  const lines = index.split('\n').filter((l) => l.trim().startsWith('- '));
  const referenced = lines.map((l) => {
    const m = l.match(/^- `?([^\s`]+\.md)`?\s*—\s*(.+)$/);
    assert.ok(m, `索引行格式不对：${l}`);
    const [, name, desc] = m;
    assert.equal(desc.trim(), docs.get(name)?.frontmatter.description, `${name} 的索引描述与 frontmatter 不一致`);
    return name;
  });
  assert.equal(referenced.length, noteNames.length, `索引 ${referenced.length} 行 ≠ 笔记 ${noteNames.length} 篇`);
  assert.equal(new Set(referenced).size, referenced.length, '索引里有重复行');
  for (const name of referenced) assert.ok(docs.has(name), `索引指向不存在的笔记：${name}`);
  // 索引用的是 description；再确认一遍它没把取值带出去
  for (const [, doc] of docs) {
    const desc = doc.frontmatter.description;
    assert.ok(!index.includes(desc) || !/\d{3,}/.test(desc), `索引里的 description 带了具体取值：${desc}`);
  }
});

test('私人内容 denylist：语料库与题集里不许出现真实世界痕迹', () => {
  const BANNED = [
    '/Users/',
    'yffto',
    'memory-service',
    'dsh-engramory',
    'OpenClaw',
    'Minke',
    'Hysteria',
    'MacBook',
    '杨',
    '过儿',
    '~/memory/engramory',
    '.engramory-recall',
    'KSL_HOME=',
  ];
  const files = [
    ...noteNames.map((n) => [n, docs.get(n).raw]),
    ['MEMORY.md', fs.readFileSync(path.join(LIBRARY, 'MEMORY.md'), 'utf8')],
    ['tasks.json', fs.readFileSync(TASKS_PATH, 'utf8')],
  ];
  for (const [name, text] of files) {
    for (const word of BANNED) {
      assert.ok(!text.includes(word), `${name} 里出现了不该有的字眼：${word}`);
    }
  }
});
