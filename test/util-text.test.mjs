/**
 * `src/util/text.js`：归一化、n-gram、字数/token 口径。
 *
 * 这个文件的每一条都对应一个**真实踩过的坑**（写在断言旁）：
 * BOM、CRLF、全角、中文数字、代理对、字节 vs 字符。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHalfWidth, normalizeCjkDigits, normalizeText, charNgrams, jaccard, estimateTokens, sha256, charLength, collapse, countLines, finiteOr } from '../src/util/text.js';

test('归一化：BOM 不参与内容（留着会让整段 frontmatter 被当正文索引）', () => {
  assert.equal(normalizeText('\uFEFF记忆'), '记忆');
  assert.equal(normalizeText('\uFEFF'), '');
});

test('归一化：CRLF → LF（否则 `\\r` 会漏进词项）', () => {
  assert.equal(normalizeText('a\r\nb'), 'a\nb');
  assert.equal(normalizeText('a\rb'), 'a\nb');
});

test('归一化：全角 → 半角，中文数字 → 阿拉伯数字', () => {
  assert.equal(toHalfWidth('ＡＢＣ１２３'), 'ABC123');
  assert.equal(normalizeText('ＡＢＣ'), 'abc');
  assert.equal(normalizeCjkDigits('一共有三十条笔记'), '一共有30条笔记');
  assert.equal(normalizeCjkDigits('十五'), '15');
  assert.equal(normalizeCjkDigits('两千零一'), '2001');
  // 不是数字的汉字不能被吃掉
  assert.equal(normalizeCjkDigits('一鸣惊人'), '一鸣惊人');
});

test('归一化：大小写折叠 + NFKC（中文语料里混排是常态，不归一化就搜不到）', () => {
  assert.equal(normalizeText('TypeScript'), 'typescript');
  assert.equal(normalizeText('①②'), '①②'.normalize('NFKC'));
});

test('charNgrams：空白（含换行）全部删掉后再切 —— 换个换行不能把重叠率刷下去', () => {
  const a = charNgrams('abcdefghij', 4);
  const b = charNgrams('abcd\nef ghij', 4);
  assert.ok(a.size > 0);
  assert.deepEqual([...a].sort(), [...b].sort(), '只差排版的两段文本必须切出同一组 n-gram');
  assert.equal(charNgrams('短').size, 1, '比 n 短时整段算一个 gram（不是 0：太短的文本还是要有指纹）');
  assert.equal(charNgrams('').size, 0);
  // 全角/大小写差异也必须消失（否则「换个写法」就能绕过防泄漏自检）
  assert.deepEqual([...charNgrams('ABCDEFGH', 4)].sort(), [...charNgrams('ａｂｃｄｅｆｇｈ', 4)].sort());
});

test('jaccard：空集合的并集是 0/0，返回 0 而不是 NaN', () => {
  assert.equal(jaccard(new Set(), new Set()), 0);
  assert.equal(jaccard(new Set(['a']), new Set()), 0);
  assert.equal(jaccard(new Set(['a']), new Set(['a'])), 1);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
});

test('token 估算：中文按 2 字 1 token、ASCII 按 4 字 1 token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('中'.repeat(400)), 200);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  // 400 字上限 = 200 token 上限，这个换算关系是 04-cost-model 的核心档
  assert.equal(estimateTokens('中'.repeat(400)), 200);
});

test('token 估算：代理对（emoji）不算成两个 ASCII', () => {
  const one = estimateTokens('😀');
  assert.ok(one <= 1, `单个 emoji 不该超过 1 token，实际 ${one}`);
});

test('字数口径是**字符**不是字节（用字节会冤枉中文：400 字 = 1200 字节）', () => {
  assert.equal(charLength('中'.repeat(400)), 400);
  assert.equal(Buffer.byteLength('中'.repeat(400)), 1200);
  assert.equal(charLength(''), 0);
  assert.equal(charLength(null), 0);
});

test('sha256：稳定、可截断、区分大小写差异', () => {
  const a = sha256('abc');
  assert.equal(a.length, 16);
  assert.equal(a, sha256('abc'));
  assert.notEqual(a, sha256('ABC'));
  assert.equal(sha256('abc', 8).length, 8);
  assert.match(sha256('abc'), /^[0-9a-f]{16}$/);
});

test('collapse：永远单行、超长截断加省略号', () => {
  assert.equal(collapse('a\n\nb   c'), 'a b c');
  assert.equal(collapse('x'.repeat(10), 5).length, 5);
  assert.ok(collapse('x'.repeat(10), 5).endsWith('…'));
  assert.equal(collapse('   '), '');
});

test('countLines：与末尾换行无关（索引行数口径靠它）', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('\n\n\n'), 3);
});

// ── finiteOr：把「可能没给」的入参收敛成有限数 ─────────────────────────────
//
// 这组用例的由来是一个真 bug：原实现用 `Number(value)` 判有限，
// 而 `Number(null) === 0` —— 于是 `--min-coverage`（漏了值）会被当成 0，
// 阈值闸**静默关闭**，返回全部结果。人以为自己设了阈值，其实一个闸都没了。
test('finiteOr：null / 空串 / 布尔都退回默认值（不能当成 0）', () => {
  assert.equal(finiteOr(null, 7), 7, 'null 必须退回默认值：Number(null) === 0 是个陷阱');
  assert.equal(finiteOr('', 7), 7, '空串同理：Number("") === 0');
  assert.equal(finiteOr(undefined, 7), 7);
  assert.equal(finiteOr(true, 7), 7, '布尔不是数字');
  assert.equal(finiteOr(false, 7), 7, 'false 更不是 0');
  assert.equal(finiteOr({}, 7), 7);
  assert.equal(finiteOr([], 7), 7, '空数组 Number([]) === 0，同样得挡住');
  assert.equal(finiteOr('abc', 7), 7);
  assert.equal(finiteOr(NaN, 7), 7);
  assert.equal(finiteOr(Infinity, 7), 7);
});

test('finiteOr：真数字（含数字字符串、0、负数）原样通过', () => {
  assert.equal(finiteOr(0.5, 7), 0.5);
  assert.equal(finiteOr(0, 7), 0, '0 是合法值，必须能表达「把闸门放到 0」');
  assert.equal(finiteOr(-1, 7), -1);
  assert.equal(finiteOr('0.6', 7), 0.6, '命令行传进来的都是字符串');
  assert.equal(finiteOr(' 12 ', 7), 12);
});
