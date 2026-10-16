/**
 * 文本归一化、n-gram 指纹与 token 估算 —— 全部确定性、零依赖。
 *
 * 这些口径必须在**写入**与**检索**两侧完全一致，否则会出现「写进去的词查不出来」
 * 这类只在真库上才暴露的漂移（旧项目为此吃过两次亏，见 `store.js` 的 BOM/CRLF 注释）。
 * 所以归一化只在本文件实现一次。
 */
import { createHash } from 'node:crypto';

/**
 * 全角 → 半角。
 *
 * 为什么必须做：中文输入法打出来的数字与英文常常是全角（`５００`、`ＥＮＯＴＦＯＵＮＤ`），
 * 而查询侧往往是半角。不归一，两串字符在词项层面完全不同。
 * 范围口径：U+FF01–U+FF5E → U+0021–U+007E；U+3000（全角空格）→ 普通空格。
 */
export function toHalfWidth(text) {
  return String(text ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 常用中文数字 → 阿拉伯数字（只做 0–99 的直读，不做「一百二十三」这种复合解析）。 */
const CJK_DIGITS = {
  〇: '0', 零: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4',
  五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10',
};

/**
 * 中文数字归一。
 *
 * **只转真正的数字短语，绝不逐字替换。** 这里曾经是
 * `.replace(/[〇零一二两三四五六七八九]/g, ...)` —— 逐字替换，后果是
 * 「一起」→「1起」、「一共」→「1共」、「一鸣惊人」→「1鸣惊人」，
 * 而且这个函数是从 `normalizeText()` 里调的，`normalizeText()` 又是写入路径
 * （指纹/去重）与索引路径的入口：
 *
 *  ① 搜「一起做」永远搜不到原文写着「一起做」的笔记（词项两边不一样）；
 *  ② 「一起」与「1起」的 `content_sha256` 相同，去重会把两条不同的记忆判成同一条。
 *
 * 判据：汉字数字**只有在后面跟着量词/单位、且前面不是汉字**时才算数字。
 *   「三十条」→「30条」✓   「十五」→「15」✓   「十五个」→「15个」✓
 *   「一起」→「一起」✓（后面是「起」，不是量词）
 *   「一鸣惊人」→「一鸣惊人」✓
 *   「统一」「第一」→ 不动（前面是汉字；「第一」真要归一也该归成序号，不是数字 1）
 *
 * 仍然会误伤一小撮（「三只小猪」里的「三只」、「一个人」里的「一个」本来就该转），
 * 所以这里只做**多字数字串**的安全转换，单字不动 —— 单字信息量太低，
 * 转了只会增加误命中（搜「一」命中所有含「1」的笔记）。
 */
export function normalizeCjkDigits(text) {
  const s = String(text ?? '');
  const CN = '〇零一二两三四五六七八九';
  const UNIT = '个条次天年月日号份台张页步层版秒分时周趟遍点倍组项款件只把位名些';
  // 数字串 = 数字/量级词 的连续串。**必须吃进量级词**，否则「两千零一」会被切碎：
  // 「千」不是数字，`[CN]{2,}` 只能匹配到「零一」→「两千01」。
  const NUM = `[${CN}十百千]`;
  // 前面是数字或量词就不算数字（「第**三十**」的「三十」前面是「第」= 汉字，不是数字，照转）
  const re = new RegExp(`(?<![${CN}十百千${UNIT}])${NUM}{1,}(?=[${UNIT}]|[^${CN}十百千]|$)`, 'g');
  return s.replace(re, (m) => {
    const n = readNumberWords(m);
    // 单字且没有量词跟着读不出来（`一`、`三` 这种）：不转。转了只会
    // 让「搜『一』」命中所有含「1」的笔记，是净损失。
    if (n === null) return m;
    if (m.length === 1 && !/[十百千]/.test(m)) return m;
    return String(n);
  });
}

/**
 * 读一串汉字数字。返回 null 表示「读不出来 / 不该转」。
 *
 * 支持 〇零一二两三四五六七八九 + 十百千，够日常语料；
 * 遇到不认识的组合返回 null（**宁可不转，不要转错**）。
 */
function readNumberWords(run) {
  if (run.length === 1 && !'十百千'.includes(run)) return Number(CJK_DIGITS[run]);
  const units = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  let seen = false;
  for (const ch of run) {
    if (ch in units) {
      // 「十五」= 十(1)五 → 10 + 5；「三十」= 三(3)十 → 30
      total += (current || 1) * units[ch];
      current = 0;
      seen = true;
      continue;
    }
    const d = CJK_DIGITS[ch];
    if (d === undefined || d.length > 1) return null;
    if (current !== 0) {
      // 「一二三」这种连写的位序列：先收着，最后当位串读
      current = current * 10 + Number(d);
    } else {
      current = Number(d);
    }
    seen = true;
  }
  if (!seen) return null;
  return total + current;
}


/**
 * 统一的归一化入口：去 BOM → CRLF 归一 → 全角转半角 → 中文数字转写 → 小写。
 *
 * 返回的是**检索用**的形态；原文一律原样保存。`nfkc` 用 String.normalize，
 * 它顺手把上标、连字、异体字拉到同一个码位（Node 内置，零依赖）。
 */
export function normalizeText(text) {
  let s = String(text ?? '');
  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/\r\n?/g, '\n');
  s = toHalfWidth(s);
  s = normalizeCjkDigits(s);
  if (typeof s.normalize === 'function') s = s.normalize('NFKC');
  return s.toLowerCase();
}

/**
 * 字符 n-gram 集合（默认 8-gram，与 `02-evaluation.md §4.3` 的防泄漏口径同参）。
 *
 * 用途有两处，都用同一个口径：① 防泄漏自检（题面与 gold 正文的重叠率）；
 * ② 写入闸门的去重（同 scope 下两条笔记的 8-gram Jaccard 重叠）。
 * 空白先折叠，否则「换个换行」就能把重叠率刷下去。
 */
export function charNgrams(text, n = 8) {
  // **空白全部删掉**（不只是折叠成单空格）：这个函数判的是「内容有没有抄」和
  // 「两条笔记是不是同一件事」，而中文语料里换行与空格是排版噪声 ——
  // 折叠成单空格仍然让「一二三\n四五六」与「一二三四五六」判为不重叠。
  const s = normalizeText(text).replace(/\s+/g, '');
  const out = new Set();
  if (s.length < n) {
    if (s.length) out.add(s);
    return out;
  }
  for (let i = 0; i + n <= s.length; i += 1) out.add(s.slice(i, i + n));
  return out;
}

/** Jaccard 重叠：|A∩B| / |A∪B|。两边都空时返回 0（不是 1，空内容不算重复）。 */
export function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * token 估算：**不引分词器**，用「字符数 / 每 token 字符数」的比值。
 *
 * 口径（`04-cost-model.md` 的省钱清单第 13 条要求单条 ≤200 token / ≤400 字）：
 * **分别数**CJK 与 ASCII，CJK 每 2 字 1 token、其余每 4 字 1 token，相加后向上取整。
 * 不是「两种算法的较小值」——中英混排的正文里两种字符同时存在，取较小值会低估。
 * 这是**下界估计**（宁可高估 token 用量、早一点触发裁剪），因为预算闸门是硬约束：
 * 估高只是少给一点，估低会让注入超预算。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  const ascii = s.length - cjk;
  return Math.ceil(cjk / 2 + ascii / 4);
}

/** sha256 十六进制（正文 hash 用于 receipt 与索引指纹，短截断到 16 位足够）。 */
export function sha256(text, len = 16) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, len);
}

/**
 * 字符数（**而不是字节数**）。
 *
 * 400 字的核心档上限是字符口径（`04-cost-model.md`），与预算里的 `maxChars` 一致。
 * 用字节会冤枉中文（一个汉字 3 字节，400 字 = 1200 字节），把合规的笔记判超限。
 */
export function charLength(text) {
  return String(text ?? '').length;
}

/** 折叠空白并截断到 n 个字符（用于 reason / 摘要，输出永远单行）。 */
export function collapse(text, n = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 行数（末尾换行不敏感：`"a\n"` 是 1 行；口径与旧项目 index-guard 一致）。 */
/**
 * 把「可能是数字、也可能没给」的入参收敛成一个有限数，给不出就用默认值。
 *
 * ⚠️ 不能用 `Number(value)` 直接判：`Number(null) === 0`、`Number('') === 0`，
 * 于是「显式传了个空值」会被当成 0，而 0 在阈值场景里恰恰是**把闸门关掉**。
 * 症状：`memory search --query x --min-coverage`（命令行漏了值）静默返回全部结果，
 * 而人以为自己设了阈值。所以 null / '' / 布尔 一律走默认值。
 */
export function finiteOr(value, fallback) {
  // 只认「数字」和「数字串」两种形状，别的一律默认值。
  // 不用 `Number(value) > -Infinity` 之类的宽松判断：`Number([]) === 0`、
  // `Number([5]) === 5`，数组会悄悄变成阈值。
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function countLines(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  return s.replace(/\n$/, '').split('\n').length;
}

/**
 * 把长文切成若干 ≤ maxChars 的片段，尽量在语义边界上切。
 *
 * 为什么必须有这个函数：`06-architecture.md` 规定「单条事实 ≤ 200 token / ≤ 400 字，
 * 超长内容写入时切分为多条」。旧库里的笔记是按「一个主题一大篇」写的，
 * 实测 72 篇里有 50 篇超过 400 字（最长 58902 字）。导入如果拿 400 字上限去卡它们，
 * 结果是**大部分旧知识进不来** —— 而迁移的意义恰恰是别丢东西。
 *
 * 切法（从强到弱）：
 *   ① 先按空行切成块（段落 / 列表项 / 代码块 / 表格，块内不切）；
 *   ② 单块仍超限 → 按行拆，行累加到接近上限为止；
 *   ③ 单行仍超限 → 在句末标点、代码围栏、空格处回退切；
 *   ④ 实在没有回退点（一坨连续的中文 / 一个超长 base64）→ 硬切。
 *
 * 两条不变量（测试盯着）：
 *   - 每一片的 `charLength <= maxChars`（否则闸门会拒，等于没切）；
 *   - `join(parts)` 与按 `\n` 归一化后的原文**字符集完全一致**（只允许丢空行，
 *     一个字都不许丢 —— 切分不是摘要）。
 *
 * 返回值 `parts[i].reason` 说明这一片为什么在这儿断（`blank`/`line`/`sentence`/
 * `space`/`hard`/`end`），便于出问题时定位是哪条规则切坏了。
 */
export function chunkText(text, maxChars = 400, options = {}) {
  const limit = Math.max(1, Math.floor(Number(maxChars) || 1));
  const maxParts = Math.max(1, Math.floor(Number(options.maxParts) || 10000));
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (src.length <= limit) {
    const one = src.trim() === '' ? [] : [{ text: src, reason: 'end' }];
    return { parts: one, truncated: false, dropped: [] };
  }

  const hardCut = (str) => {
    const out = [];
    for (let i = 0; i < str.length; i += limit) out.push({ text: str.slice(i, i + limit), reason: 'hard' });
    return out;
  };

  const splitLine = (line) => {
    if (line.length <= limit) return [{ text: line, reason: 'line' }];
    const out = [];
    let rest = line;
    while (rest.length > limit) {
      let cut = -1;
      // 句末标点优先（含中英），其次空格 / 制表符，最后硬切。
      //
      // 关键细节：回退点必须 **`<= limit`**。标点后面可能还跟着收尾引号
      // （`…结果。」`），如果直接取 `m.index + m[0].length`，切点会落到 limit 之后，
      // 于是「切出来的片子」比上限还长 —— 而闸门下一站就会把它拒掉。
      // 这个 off-by-one 很难看出来：切片函数看起来完全正确，只有 8 片（1309 片里）
      // 恰好标点后跟引号时才越界，症状是「导入时莫名其妙丢了几条」。
      for (const re of [/[。！？；!?;][”"’'）)】\]]*/g, /\s+/g]) {
        re.lastIndex = 0;
        let m;
        let last = -1;
        while ((m = re.exec(rest)) !== null) {
          const end = m.index + m[0].length;
          if (end > limit) break;
          last = end;
        }
        if (last >= limit * 0.5) {
          cut = last;
          break;
        }
      }
      if (cut <= 0) cut = limit;
      out.push({ text: rest.slice(0, cut), reason: cut === limit ? 'hard' : 'sentence' });
      rest = rest.slice(cut);
    }
    if (rest !== '') out.push({ text: rest, reason: 'end' });
    return out;
  };

  const parts = [];
  let buf = null;
  const flush = (reason) => {
    if (buf === null) return;
    if (buf.trim() !== '') parts.push({ text: buf, reason });
    buf = null;
  };
  const push = (text, reason) => {
    if (buf !== null && buf.length + text.length > limit) flush('blank');
    if (text.length > limit) {
      flush('blank');
      for (const p of splitLine(text)) parts.push(p);
      return;
    }
    buf = buf === null ? text : `${buf}\n${text}`;
    if (reason === 'blank') {
      // 空行是天然边界：能在这里收就收，避免把两个主题塞进同一条事实。
      if (buf.length >= limit * 0.6) flush('blank');
    }
  };

  for (const block of src.split(/\n{2,}/)) {
    if (block.length > limit) {
      // 逐行 push 时**去掉行尾空白**：markdown 里行尾空格没有意义（除了硬换行），
      // 但它是实打实的字符数。留着的直接后果是「闸门量 401、切分器认为刚好 400」——
      // 差一个空格，去查的人会从检索一路查到存储。行内缩进保留（代码块要）。
      for (const line of block.split('\n')) push(line.replace(/[ \t]+$/, ''), 'line');
    } else {
      push(block, 'blank');
    }
  }
  flush('end');

  // 后置条件守卫：规则一旦有洞（标点回退、行尾空白、将来新加的边界），
  // 这里保证**交付出去的每一片**都 ≤ limit。切分器与闸门量的是同一件事，
  // 「切完还是超限」必须是结构性不可能，而不是靠调用方再挡一次。
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].text.length > limit) {
      const pieces = hardCut(parts[i].text);
      parts.splice(i, 1, ...pieces);
      i += pieces.length - 1;
    }
  }

  // 兜底：上面的规则保证每片 ≤ limit；这里只是不让调用方拿到空数组。
  if (parts.length === 0) return { parts: [{ text: src.slice(0, limit), reason: 'hard' }], truncated: false, dropped: [] };
  if (parts.length > maxParts) {
    const kept = parts.slice(0, maxParts);
    const dropped = parts.slice(maxParts);
    return {
      parts: kept,
      truncated: true,
      dropped: [{ count: dropped.length, chars: dropped.reduce((n, p) => n + p.text.length, 0), reason: 'maxParts' }],
    };
  }
  return { parts, truncated: false, dropped: [] };
}
