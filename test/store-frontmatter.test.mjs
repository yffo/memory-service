/**
 * `src/store/frontmatter.js`：零依赖 frontmatter 解析/序列化。
 *
 * 为什么不用 YAML 库：M1 要求零运行时依赖，而我们只用到 YAML 的一个子集
 * （标量、行内数组、嵌套一层、块列表）。自己写能精确控制**坏数据怎么办** ——
 * 库的默认行为（抛异常 / 静默丢字段）两种我们都不能接受。
 *
 * 注意 `parseFrontmatter()` 吃的文本**不含 `---` 围栏**（切围栏是 `note.js`
 * 的 `splitDocument()` 的活）。测试里如果连围栏一起喂进去，就会得到
 * 「不是 key: value 形状：---」这种看起来吓人的报错——那正是它该有的行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScalar, parseFrontmatter, serializeFrontmatter, NOTE_KEY_ORDER } from '../src/store/frontmatter.js';
import { splitDocument } from '../src/store/note.js';

test('parseScalar：布尔/null/数字/引号/裸串', () => {
  assert.equal(parseScalar('true'), true);
  assert.equal(parseScalar('false'), false);
  assert.equal(parseScalar('null'), null);
  assert.equal(parseScalar('~'), null);
  assert.equal(parseScalar(''), null);
  assert.equal(parseScalar('42'), 42);
  assert.equal(parseScalar('0.9'), 0.9);
  assert.equal(parseScalar('-7'), -7);
  assert.equal(parseScalar('"带 空格"'), '带 空格');
  assert.equal(parseScalar("'单引号'"), '单引号');
  assert.equal(parseScalar('裸串 with spaces'), '裸串 with spaces');
});

test('parseScalar：时间戳样式的串**保持字符串**（不能变成数字）', () => {
  // 如果 `2026-10-17` 被当表达式解析会得到减法结果或 NaN，两者都是数据损坏
  assert.equal(parseScalar('2026-10-17'), '2026-10-17');
  assert.equal(parseScalar('2026-10-17T03:25:24+08:00'), '2026-10-17T03:25:24+08:00');
});

test('parseScalar：`[` / `{` 开头交给上层（行内集合不是标量）', () => {
  assert.equal(parseScalar('[]'), null);
  assert.equal(parseScalar('[a, b]'), null);
  assert.equal(parseScalar('{a: 1}'), null);
});

test('parseFrontmatter：行内数组、嵌套一层、块列表', () => {
  const text = [
    'schema: memory.note/1',
    'id: 01M5337R6NDTDRQJ8GQERZNDQW',
    'scope: user',
    'tags: [a, b]',
    'provenance:',
    '  written_by: cli:remember',
    '  source_ref: null',
    'supersedes:',
    '  - 01AAA',
    '  - 01BBB',
  ].join('\n');
  const { data, errors } = parseFrontmatter(text);
  assert.deepEqual(errors, []);
  assert.equal(data.schema, 'memory.note/1');
  assert.equal(data.id, '01M5337R6NDTDRQJ8GQERZNDQW');
  assert.deepEqual(data.tags, ['a', 'b']);
  assert.deepEqual(data.provenance, { written_by: 'cli:remember', source_ref: null });
  assert.deepEqual(data.supersedes, ['01AAA', '01BBB']);
});

test('parseFrontmatter：引号里的逗号不是分隔符', () => {
  const { data, errors } = parseFrontmatter('tags: ["a, b", c]');
  assert.deepEqual(errors, []);
  assert.deepEqual(data.tags, ['a, b', 'c']);
});

test('splitDocument + parseFrontmatter：带围栏的真实文件（BOM + CRLF）', () => {
  const text = '\uFEFF---\r\nkind: semantic\r\nscope: user\r\n---\r\n\r\n正文\r\n';
  const { frontmatter, body, hasFrontmatter } = splitDocument(text);
  assert.equal(hasFrontmatter, true);
  const { data, errors } = parseFrontmatter(frontmatter);
  assert.deepEqual(errors, []);
  assert.equal(data.kind, 'semantic');
  assert.equal(body.trim(), '正文');
});

test('splitDocument：没有围栏 → 整篇是正文，frontmatter 为空', () => {
  const { frontmatter, body, hasFrontmatter } = splitDocument('# 只有正文\n\n没有头部。');
  assert.equal(hasFrontmatter, false);
  assert.equal(frontmatter, '');
  assert.equal(body, '# 只有正文\n\n没有头部。');
});

test('parseFrontmatter：坏行**升级为错误并保留行号**，且 data 归 null（半份数据比没数据更危险）', () => {
  const text = ['good: 1', '这行没有冒号', 'also_good: 2'].join('\n');
  const { data, errors } = parseFrontmatter(text);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2, '行号必须精确到行：人要去文件里改它');
  assert.match(errors[0].message, /冒号|key/);
  // fail-closed：只要有 error，data 就是 null。让调用方拿到「好了的那几个字段」
  // 是最糟的设计 —— 它会高高兴兴把缺失字段当默认值，于是 note 静默降级。
  assert.equal(data, null);
});

test('parseFrontmatter：tab 缩进直接报错（YAML 子集不支持，猜错比报错更贵）', () => {
  const { errors } = parseFrontmatter('provenance:\n\twritten_by: x');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /tab/);
});

test('parseFrontmatter：孤立数组项报错（没有归属的键 = 数据丢了）', () => {
  const { errors } = parseFrontmatter(['kind: semantic', '- 孤儿项'].join('\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /数组项/);
});

test('parseFrontmatter：注释与空行被跳过', () => {
  const { data, errors } = parseFrontmatter(['# 注释', 'kind: semantic # 行尾注释', '', 'trust: user_stated'].join('\n'));
  assert.deepEqual(errors, []);
  assert.equal(data.kind, 'semantic');
  assert.equal(data.trust, 'user_stated');
});

test('serializeFrontmatter：按给定键序输出、能 round-trip（写出去要能读回来）', () => {
  const data = {
    schema: 'memory.note/1',
    id: '01M5337R6NDTDRQJ8GQERZNDQW',
    scope: 'user',
    kind: 'semantic',
    trust: 'user_stated',
    tags: ['b', 'a'],
    supersedes: ['01AAA'],
    provenance: { written_by: 'test', source_ref: null, derived_from: [] },
    confidence: 0.9,
    valid_from: '2026-10-17T03:25:24+08:00',
    valid_to: null,
    status: 'active',
  };
  const text = serializeFrontmatter(data, NOTE_KEY_ORDER);
  const keys = text
    .split('\n')
    .filter((l) => /^[a-z_]+:/.test(l))
    .map((l) => l.slice(0, l.indexOf(':')));
  assert.equal(keys[0], 'schema', 'schema 必须第一（人一眼能看出这是什么文件）');
  assert.equal(keys[1], 'id');
  const { data: back, errors } = parseFrontmatter(text);
  assert.deepEqual(errors, []);
  assert.equal(back.kind, 'semantic');
  assert.equal(back.confidence, 0.9);
  assert.deepEqual(back.tags, ['b', 'a']);
  assert.deepEqual(back.supersedes, ['01AAA']);
  assert.deepEqual(back.provenance, { written_by: 'test', source_ref: null, derived_from: [] });
  assert.equal(back.valid_to, null);
  assert.equal(back.valid_from, '2026-10-17T03:25:24+08:00');
});

test('serializeFrontmatter：需要引号的串会加引号（不然读回来就变了）', () => {
  const text = serializeFrontmatter({ title: 'a: b', note: 'true', other: 'has # hash' });
  const { data } = parseFrontmatter(text);
  assert.equal(data.title, 'a: b');
  assert.equal(data.note, 'true', '字符串 "true" 不能读回来变成布尔 true');
  assert.equal(data.other, 'has # hash');
});

test('serializeFrontmatter：空数组写成 [] 而不是省略（省略会被读成 undefined，语义不同）', () => {
  const text = serializeFrontmatter({ tags: [], supersedes: [] });
  assert.match(text, /tags: \[\]/);
  const { data } = parseFrontmatter(text);
  assert.deepEqual(data.tags, []);
  assert.deepEqual(data.supersedes, []);
});

test('serializeFrontmatter：未知键排在已知键之后但**不丢**（不然 legacy 字段会静默消失）', () => {
  const text = serializeFrontmatter({ kind: 'semantic', legacy_custom: 'keep me' }, NOTE_KEY_ORDER);
  const { data } = parseFrontmatter(text);
  assert.equal(data.legacy_custom, 'keep me');
  assert.ok(text.indexOf('kind:') < text.indexOf('legacy_custom:'));
});
