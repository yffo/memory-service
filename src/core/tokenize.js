/**
 * 分词与查询扩展。零依赖、零出网、零模型。
 *
 * 三件事：
 *  1. **归一化**：大小写、全角/半角、Unicode 破折号与空格混用——中文语料里
 *     `记忆服务` / `記憶服務` 这类混排是常态，不归一化就会出现「明明有却搜不到」。
 *  2. **切词**：拉丁按词，CJK 按**相邻二字组（bigram）+ 单字**。为什么同时给 bigram 和单字：
 *     只用单字 → 「服务」和「服」同权，噪声大；只用 bigram → 单字查询（「图」）彻底搜不到。
 *     两者都给，但**单字降权**（`SINGLE_CHAR_WEIGHT`），让精确的词组命中赢。
 *     **CJK 串在结构助词处先断开**（`CJK_BOUNDARY_CHARS`）：二字组只能来自**开口词内部**，
 *     不能横跨一个结构助词——见 `CJK_BOUNDARY_CHARS` 处为什么（跨词碎片假命中）。
 *  3. **同义扩展**：一张**极小**的双语桥接表（中↔英技术词），只做「同一概念的不同写法」，
 *     不做语义推理。它在评测里是可开关的（`bridge: false`），因为
 *     `02-evaluation.md §4.3` 要求「查询改写对指标有正贡献」才算数——没贡献就该关掉。
 */

import { estimateTokens as estimateTokensImpl, charLength, normalizeCjkDigits, toHalfWidth } from '../util/text.js';

/** CJK 统一表意文字 + 日文假名 + 韩文音节。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
/** 拉丁/数字/下划线一个「词」的字符集。 */
const LATIN = /[0-9a-z_]/;

/** 单字（CJK bigram 拆出来的一元）权重：低于二元，避免「服」与「服务」同权。 */
export const SINGLE_CHAR_WEIGHT = 0.5;
/** 桥接表（同义扩展）的权重：低于原词，只在原词命中不足时起作用。 */
export const BRIDGE_WEIGHT = 0.6;

/**
 * 常见中英技术词桥接表。**故意保持极小**：每加一条都要有「不加就搜不到」的实例，
 * 否则它会变成一部悄悄改写用户查询的同义词词典（那是最坏的失败模式：
 * 用户搜 A，系统答 B，而且从输出上看不出被改写了）。
 */
export const BRIDGE_PAIRS = Object.freeze([
  ['记忆', 'memory'],
  ['检索', 'retrieval'],
  ['召回', 'recall'],
  ['预算', 'budget'],
  ['闸门', 'gate'],
  ['索引', 'index'],
  ['笔记', 'note'],
  ['评测', 'evaluation'],
  ['降级', 'degrade'],
  ['作用域', 'scope'],
  ['偏好', 'preference'],
  ['约定', 'convention'],
  ['测试', 'test'],
  ['部署', 'deploy'],
  ['配置', 'config'],
  ['密钥', 'secret'],
]);

/** 构建双向桥接表：中→英、英→中。 */
function buildBridge() {
  const map = new Map();
  for (const [zh, en] of BRIDGE_PAIRS) {
    if (!map.has(zh)) map.set(zh, new Set());
    if (!map.has(en)) map.set(en, new Set());
    map.get(zh).add(en);
    map.get(en).add(zh);
  }
  return map;
}
const BRIDGE = buildBridge();

export function bridgeTerms(term) {
  const set = BRIDGE.get(term);
  return set ? [...set] : [];
}

/**
 * 归一化：NFKC（全角→半角）+ 小写 + 破折号统一。
 * NFKC 是 Node 内置的，不用装库。
 */
export function normalizeForSearch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u3000/g, ' ');
}

/**
 * 别名，名字说清楚它是**检索侧**的归一化：不处理 BOM/CRLF、不转中文数字。
 *
 * 存储侧（写盘、指纹、字数口径）请用 `util/text.js` 的 `normalizeText()`。
 * 两个函数都留着是刻意的——检索归一化改动会移动分数，存储归一化改动会移动指纹，
 * 把它们合成一个函数，改一个就会同时动两个口径。**但名字不能骗人**：
 * 这里原来把它也导成 `normalizeText`，于是 `normalizeText('BOM\uFEFF')` 在
 * util 与 core 下给出不同结果，谁 import 错了都看不出来。
 */
export const normalizeForIndex = normalizeForSearch;

/**
 * 切词。返回**词项数组（含重复）**——重复是有意义的：BM25 的记录内词频靠它算。
 *
 * 规则：
 *  - 拉丁/数字/下划线连续串各算一个词（下划线**不**拆：`tabellio_store` 是一个词，
    与 `bm25.js` 的实测结论一致——拆开会让 `tabellio_store` 这个标识符再也搜不到）；
 *  - CJK 连续串 → 相邻二字组；长度 1 的串 → 该单字；
 *  - 其它字符（标点、emoji）是分隔符。
 */
export function tokenize(text) {
  const s = normalizeForSearch(text);
  const out = [];
  let buf = '';
  let isLatin = false;
  const flush = () => {
    if (buf === '') return;
    if (isLatin) out.push(buf);
    else pushCjk(buf, out);
    buf = '';
  };
  for (const ch of s) {
    if (LATIN.test(ch)) {
      if (buf !== '' && !isLatin) flush();
      isLatin = true;
      buf += ch;
      continue;
    }
    if (CJK.test(ch)) {
      if (buf !== '' && isLatin) flush();
      isLatin = false;
      buf += ch;
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/**
 * CJK run → 词项。
 *
 * 先在 `CJK_BOUNDARY_CHARS` 处把 run 切成若干**段**（边界字符自己既不保留下标也不成词项），
 * 段内才做相邻二字切。这样 `代理节点` 仍然是 `代理/理节/节点`（没有边界字符，行为不变），
 * 而 `闸门的默认值` 变成 `闸门/默认/认值`——`门的`、`的默` 这两个**跨词碎片**不再存在。
 *
 * 单字段仍然保留（`图` 要搜得到），只是查询侧会降权（`SINGLE_CHAR_WEIGHT`）。
 */
function pushCjk(run, out) {
  for (const seg of splitCjkSegments(run)) pushSegment(seg, out);
}

/** 按边界字符切段；**丢弃**由边界字符组成的段（它们没有内容）。 */
export function splitCjkSegments(run) {
  const segs = [];
  let buf = '';
  for (const ch of run) {
    if (CJK_BOUNDARY_CHARS.has(ch)) {
      if (buf !== '') segs.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf !== '') segs.push(buf);
  return segs;
}

function pushSegment(seg, out) {
  if (seg.length === 1) {
    out.push(seg);
    return;
  }
  for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
}

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * CJK 切分**边界字符**：结构助词与判断/介词。遇到它们就地断开，且**自身不成词项**。
 *
 * 为什么必须有这一条（M2 实测的失败，不是理论洁癖）：
 * 相邻二字切会把「**闸门**+的+**默认值**」切成 `闸门/门的/的默/默认/认值/…`，
 * 于是 `门的` 这个**横跨两个词的碎片**成了词项。真实库（1321 篇）上实测：
 * 查询「量子色动力学里的胶子禁闭」在库里只出现过 `里的`（df 96）这一个词项碎片，
 * 于是 **92 篇无关笔记的覆盖率被顶到 1.0**（`coverage = mass/totalMass = 1/1`），
 * 全部越过了 `minCoverage=0.6` 的拒答闸（本文件承担不了这个，见 `bm25.js`
 * 的 `INFORMATIVE_DF_RATIO`）。这是「问一个库里没有的东西，它一本正经地给你 92 条」。
 *
 * 为什么是「断开 + 丢弃」而不是「降权」：`的 / 了 / 是` 这类字在中文里出现频率
 * 与「是不是证据」无关，它们**从不**是内容词。降权只是把假命中压小，仍然让它占着
 * 查询信息量的分母；丢弃才是把「跨词碎片根本不成立」这件事说清楚。
 * 这也是 M1 试过 idf 打折却把真答案一起压掉（recall@5 0.844→0.563）之后留下的教训：
 * 该修的是切词边界，不是覆盖率闸。
 *
 * 为什么**不**把实词也切碎（「数据库」→「数据/据库」）：那是另一件事，会动摇
 * 已经跑通的召回；这里只处理「跨结构助词的碎片」这一种已确诊的病灶。
 *
 * 集合刻意保持**最小**：每加一个字都要有「不加就出假命中」的实例。
 */
export const CJK_BOUNDARY_CHARS = Object.freeze(new Set(['的', '了', '是', '在', '和', '与']));

/** 一个 run 是否**全部**由边界字符组成（那种 run 没有内容，整段丢掉）。 */
export function isBoundaryRun(run) {
  if (run === '') return false;
  for (const ch of run) if (!CJK_BOUNDARY_CHARS.has(ch)) return false;
  return true;
}

/**
 * 查询 → 加权词项表 `[{term, weight, source}]`。
 *
 * `source` 记录词项从哪来（`term` 原词 / `single` 单字 / `bridge` 桥接），
 * 这样 `explain` 能回答「为什么这个词项被算进去了」——可审计性不是事后加的字段。
 */
export function expandQuery(query, { bridge = true } = {}) {
  const terms = new Map(); // term → {weight, source}
  const bump = (term, weight, source) => {
    const prev = terms.get(term);
    if (!prev || weight > prev.weight) terms.set(term, { term, weight, source: prev && prev.source === 'term' ? 'term' : source });
  };
  for (const t of tokenize(query)) {
    const single = t.length === 1 && CJK_CHAR.test(t);
    bump(t, single ? SINGLE_CHAR_WEIGHT : 1, single ? 'single' : 'term');
    if (bridge) {
      for (const alt of bridgeTerms(t)) bump(alt, BRIDGE_WEIGHT, 'bridge');
    }
  }
  return [...terms.values()];
}

/**
 * token 估算。
 *
 * **不是**精确计数，也不需要是：它只用于预算裁剪，口径必须**稳定且宁多勿少**
 * （低估预算比高估代价大：低估会让服务偷偷多塞内容）。
 * 口径：CJK 与其它非 ASCII ≈ 1 token/字；ASCII ≈ 1 token/4 字符；再乘 1.1 的余量。
 * 与旧插件 `store.js` 的估算同源，便于两条线的数字可比。
 */
/**
 * token 估算（**委托给 `util/text.js`，全项目只有一套口径**）。
 *
 * 这里曾经自己算：`ceil((wide + narrow/4) * 1.1)`，`wide` 按「码元 > 0x7f」数。
 * 三个后果，实测 400 个汉字：这里 441、`util/text.js` 200、真实约 200——
 * ① 中文被高估 2 倍，400 字笔记会被误判成「超过 200 token 上限」；
 * ② 代理对（emoji、生僻字）的第二个码元也被当成 `narrow`，而 `s.length` 是码元数，
 *    两边口径不一致；
 * ③ 同一个库里的「笔记超限判定」和「预算选片」用两把尺子，账没法对。
 * 所以口径必须只有一处：`util/text.js` 的 `estimateTokens`。
 */
export const estimateTokens = estimateTokensImpl;

/** 字符数（同样只用一套口径）。 */
export const countChars = charLength;
