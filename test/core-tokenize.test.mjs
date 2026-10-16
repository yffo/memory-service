/**
 * `src/core/tokenize.js`：词项化与查询扩展。
 *
 * 这个文件里的每条断言都对应一次**真实的召回失败**或一个刻意的取舍：
 *  - 中文按相邻二字切（`代理节点` → `代理/理节/节点`）：单字永远匹配不上四字串；
 *  - 拉丁词再按 `-` `/` `.` 切：`html-ppt` 整词入库时，查 `ppt` 永远搜不到；
 *  - 桥表（中↔英）把跨语言问法接上，但**降权**（0.6）而不是等价替换；
 *  - 单字查询降权（0.5），因为单字命中几乎等于没命中。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tokenizeModule from '../src/core/tokenize.js';
import {
  tokenize,
  expandQuery,
  bridgeTerms,
  BRIDGE_PAIRS,
  SINGLE_CHAR_WEIGHT,
  BRIDGE_WEIGHT,
  normalizeForSearch,
  estimateTokens,
  countChars,
  CJK_BOUNDARY_CHARS,
  isBoundaryRun,
  splitCjkSegments,
} from '../src/core/tokenize.js';

test('tokenize：中文切相邻二字（单字当词项是最容易漏召回的错法）', () => {
  assert.deepEqual(tokenize('代理节点'), ['代理', '理节', '节点']);
  assert.deepEqual(tokenize('记忆'), ['记忆']);
  assert.deepEqual(tokenize('一'), ['一'], '单字仍然入库，只是查询时降权');
});

test('tokenize：混排文本里中英各自成词项', () => {
  const terms = tokenize('用 html-ppt 做幻灯片');
  assert.ok(terms.includes('html'), `缺 html：${terms}`);
  assert.ok(terms.includes('ppt'), '连字符必须切开，否则查 ppt 永远搜不到 html-ppt');
  assert.ok(terms.includes('幻灯'));
  assert.ok(!terms.includes('html-ppt'), '整词不该同时保留（保留会让 8-gram 去重与 IDF 都失真）');
});

test('tokenize：`/` 与 `.` 也要切（路径与域名在语料里是常态）', () => {
  assert.deepEqual(tokenize('a/b'), ['a', 'b']);
  assert.ok(tokenize('example.com').includes('com'));
  assert.ok(tokenize('v2.5').includes('5'));
});

test('tokenize：短于 1 个字符的碎片被丢掉（标点不能成为词项）', () => {
  assert.deepEqual(tokenize('。，、！'), []);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('normalizeForSearch：大小写/全角/破折号/全角空格在这一层归一', () => {
  assert.equal(normalizeForSearch('ABC'), 'abc');
  assert.equal(normalizeForSearch('ＡＢＣ'), 'abc');
  assert.equal(normalizeForSearch('a—b'), 'a-b', '各种破折号统一成 ASCII 连字符，否则切词切不开');
  assert.equal(normalizeForSearch('a\u3000b'), 'a b', '全角空格是空格');
});

test('检索归一化 ≠ 存储归一化：**故意不合并**，但名字必须说清楚', () => {
  // 检索侧不碰 BOM/CRLF（那是存储侧 normalizeText 的活）。这里断言的是
  // 「两者行为确实不同」这件事实本身——合并它们会让改检索分数顺带移动内容指纹。
  assert.notEqual(normalizeForSearch('x\uFEFF'), normalizeForSearch('x'));
  assert.ok(!('normalizeText' in tokenizeModule), 'core 里不能再有叫 normalizeText 的导出（名字会骗人）');
  assert.equal(typeof tokenizeModule.normalizeForIndex, 'function');
});

test('expandQuery：原文词项权重为 1，单字降权，桥接词更低', () => {
  const ex = expandQuery('记忆');
  const byTerm = Object.fromEntries(ex.map((e) => [e.term, e]));
  assert.equal(byTerm['记忆'].weight, 1);
  assert.equal(byTerm['记忆'].source, 'term');
  assert.equal(byTerm['memory'].weight, BRIDGE_WEIGHT);
  assert.equal(byTerm['memory'].source, 'bridge');

  const single = expandQuery('一');
  assert.equal(single[0].weight, SINGLE_CHAR_WEIGHT);
  assert.equal(single[0].source, 'single');
});

test('expandQuery：去重（同一个词项不能出现两次，否则等于偷偷加权）', () => {
  const ex = expandQuery('test 测试');
  const terms = ex.map((e) => e.term);
  assert.equal(new Set(terms).size, terms.length, `有重复：${terms}`);
  // 「测试」与「test」互为桥接词，两边都要在，但各自只出现一次
  assert.ok(terms.includes('测试'));
  assert.ok(terms.includes('test'));
});

test('expandQuery：关掉桥接就不出桥接词（评测要能单独量桥表的贡献）', () => {
  const ex = expandQuery('记忆', { bridge: false });
  assert.deepEqual(ex.map((e) => e.term), ['记忆']);
});

test('bridgeTerms：桥表是双向的、且只返回不在原文里的那些', () => {
  assert.deepEqual(bridgeTerms('记忆'), ['memory']);
  assert.deepEqual(bridgeTerms('memory'), ['记忆']);
  // 已经是目标语言就不该再返回自己
  assert.ok(!bridgeTerms('记忆').includes('记忆'));
  assert.deepEqual(bridgeTerms('不存在的词'), []);
});

test('BRIDGE_PAIRS：每条都是 [中文, 英文] 且不重复（重复会让权重算两次）', () => {
  const zh = new Set();
  for (const pair of BRIDGE_PAIRS) {
    assert.equal(pair.length, 2);
    assert.match(pair[0], /[\u4e00-\u9fff]/, `${pair[0]} 应该是中文`);
    assert.match(pair[1], /^[a-z]+$/, `${pair[1]} 应该是小写英文`);
    assert.ok(!zh.has(pair[0]), `中文侧重复：${pair[0]}`);
    zh.add(pair[0]);
  }
});

test('estimateTokens / countChars：从 util 转发，只有一份实现', () => {
  assert.equal(estimateTokens('中'.repeat(400)), 200);
  assert.equal(countChars('中'.repeat(400)), 400);
  // 这两个名字是从这里导出给 core 用的；值必须与 util/text.js 完全一致
  assert.equal(estimateTokens(''), 0);
});

// ── CJK 边界字符：跨词碎片假命中（M2） ──────────────────────────────────────
//
// 这一组用例对应一次**实测的假命中**，不是理论洁癖：
// 相邻二字切会把「闸门 + 的 + 默认」切成 `闸门/门的/的默/默认/…`，
// `门的` 就此成了一个词项。真实库（1321 篇）上「量子色动力学里的胶子禁闭」
// 只剩 `里的` 一个词项，**92 篇无关笔记的覆盖率被顶到 1.0** —— 问库里
// 根本没有的东西，它一本正经地答了 92 条。

test('tokenize：二字组不跨结构助词（`门的` 这种碎片根本不该被生成）', () => {
  const terms = tokenize('闸门的默认值');
  assert.ok(!terms.includes('门的'), `跨词碎片 门的 又出现了：${terms}`);
  assert.ok(!terms.includes('的默'), `跨词碎片 的默 又出现了：${terms}`);
  assert.deepEqual(terms, ['闸门', '默认', '认值']);
});

test('tokenize：边界字符自己不成词项（`的` 单独问过一次就该空手而归）', () => {
  assert.deepEqual(tokenize('的'), []);
  assert.deepEqual(tokenize('的了的了'), []);
  // 混在实词里也一样：只剩实词
  assert.deepEqual(tokenize('图的'), ['图']);
  assert.deepEqual(tokenize('图的和了'), ['图']);
});

test('tokenize：没有边界字符的中文串切法一个字都没变（回归护栏）', () => {
  // 这两条是 M1 的既有行为，边界改造**不许**动它们 —— 动了就是召回面的静默缩水。
  assert.deepEqual(tokenize('代理节点'), ['代理', '理节', '节点']);
  assert.deepEqual(tokenize('数据库连接池'), ['数据', '据库', '库连', '连接', '接池']);
});

test('tokenize：助词处的断开是**就地**的，不是把整串一起丢掉', () => {
  // 断成 `闸门` / `默认`（各自内部继续二字切），而不是 `闸门默认`（那会造出
  // 一个语料里不存在的跨词词项）也不是什么都不要（那会漏掉真答案）。
  assert.deepEqual(tokenize('闸门默认'), ['闸门', '门默', '默认']);
  assert.deepEqual(splitCjkSegments('闸门的默认'), ['闸门', '默认']);
});

test('tokenize：`里的` / `的封` 这类跨词碎片在真实查询上确实不再出现', () => {
  const t1 = tokenize('量子色动力学里的胶子禁闭');
  assert.ok(!t1.includes('里的'), `里的 仍在：${t1}`);
  assert.ok(t1.includes('量子') && t1.includes('力学') && t1.includes('胶子'));
  const t2 = tokenize('中世纪欧洲的封建采邑制度');
  assert.ok(!t2.includes('的封'), `的封 仍在：${t2}`);
  assert.ok(t2.includes('欧洲') && t2.includes('封建') && t2.includes('制度'));
});

test('CJK_BOUNDARY_CHARS：集合刻意保持最小，加字必须有假命中实例', () => {
  // 这条断言的作用是**挡住无意识的扩张**：每加一个字都要在报告里附一个
  // 「不加就出假命中」的例子。集合变大等于召回面变窄，必须有人签字。
  assert.deepEqual([...CJK_BOUNDARY_CHARS].sort(), ['与', '了', '和', '在', '是', '的']);
  for (const ch of CJK_BOUNDARY_CHARS) {
    assert.match(ch, /^[\u4e00-\u9fff]$/, `${ch} 应该是一个汉字`);
  }
});

test('isBoundaryRun：整段都是结构性助词时才算「没有内容」', () => {
  assert.equal(isBoundaryRun('的是'), true);
  assert.equal(isBoundaryRun('的'), true);
  assert.equal(isBoundaryRun('图的'), false, '含实词就不是空段');
  assert.equal(isBoundaryRun(''), false, '空串另有语义，别混进来');
});

test('tokenize：混排时边界断词不影响拉丁侧（`Kestrel 的默认端口`）', () => {
  const terms = tokenize('Kestrel 的默认端口');
  assert.ok(terms.includes('kestrel'), `缺 kestrel：${terms}`);
  assert.ok(!terms.includes('的默'), `跨词碎片 的默 仍在：${terms}`);
  assert.ok(terms.includes('端口'));
});
