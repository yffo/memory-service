/**
 * frontmatter 读写。零依赖，**不用 YAML 库**（`00-brief.md §6` 原则 7）：
 * 我们自己限定一个 YAML 子集，能表达 `06-architecture.md §3.1` 那份 schema 就够。
 *
 * 支持的子集（全都有用例）：
 *  - `key: value` 标量；`null` / `~` / 空值 → null；`true`/`false` 布尔；
 *    `123` / `0.9` 数字；`2026-10-17` 与 ISO 时间**保持字符串**（日期不做隐式转换，
 *    时区混用是 `05-agi-direction.md §5.2` 点名的会咬人的边界之一）；
 *  - 行内数组 `[a, b]` 与块数组（`- a`）；空数组写 `[]`；
 *  - **两层嵌套 map**（`provenance:` 下面缩进两格），这是 schema 里唯一用到的嵌套；
 *  - `#` 注释、单双引号字符串（双引号支持 `\n \t \\ \"`）。
 *
 * 不支持的语法（嵌套数组、多行标量、锚点、`|` 块）**报错而不是猜**：
 * 猜着解析正是 `§3.4` 明令禁止的事（"遇到更高版本拒绝解释、原样透出"）。
 * 解析失败 = fail-closed：该文件不参与检索，且必须出现在 `status` 的账上。
 */

const BARE_SCALAR = /^[^\s:[\]{}#'"]|^$/;

/** 双引号字符串的转义。 */
function unescapeDouble(s) {
  return s.replace(/\\(n|t|r|"|\\)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' })[c]);
}

/** 解析一个标量 token（已经去掉了两侧空白）。 */
export function parseScalar(raw) {
  const s = String(raw).trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return unescapeDouble(s.slice(1, -1));
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') || s.startsWith('{')) return null; // 交给调用方（数组行内语法）
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

/** 行内数组 `[a, b, c]`；不是这个形状返回 null。 */
function parseInlineArray(raw) {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  return splitInline(inner).map((part) => parseScalar(part));
}

/** 按逗号切，但引号里的逗号不算分隔符。 */
function splitInline(inner) {
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      if (ch === quote && inner[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** 去掉行尾注释：只在 `#` 前有空白、且不在引号里时才当注释。 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * 解析 frontmatter 文本（**不含** `---` 围栏）。
 *
 * @returns {{data: object|null, errors: Array<{line:number, message:string}>}}
 *   只要有 error，`data` 就是 null —— 调用方必须按解析失败处理，不许用半份数据。
 */
export function parseFrontmatter(text) {
  const data = {};
  const errors = [];
  const lines = String(text ?? '').split('\n');
  /** 正在填的两层 map（`parentKey` 下的缩进键都进这里）。 */
  let pending = null;
  /** 正在填的块数组（缩进 `- x` 都进这里）。 */
  let list = null;
  let listIndent = -1;

  const flush = () => {
    if (pending) data[pending.parentKey] = pending.obj;
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    if (rawLine.trim() === '' || rawLine.trim().startsWith('#')) continue;
    if (rawLine.includes('\t')) {
      errors.push({ line: lineNo, message: 'frontmatter 不允许 tab 缩进（YAML 子集）' });
      continue;
    }
    const line = stripComment(rawLine);
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();

    // 块数组项：归属最近一个「空值键」
    if (body === '-' || body.startsWith('- ')) {
      // **开启块数组**：`key:` 下一行缩进写 `- x`，这是 YAML 里最常见的写法。
      // 这里曾经只在「缩进的空键」(`key:\n  :`) 上开 list，于是
      //   supersedes:
      //     - 01AAA
      // 每一项都报「数组项没有归属的键」。注意 `supersedes: []`（行内语法）
      // 一直是好的——所以这个 bug 只在人手写文件时出现，自动写入路径根本碰不到，
      // 也正因如此它才活到了测试阶段。
      if ((!list || indent <= listIndent) && pending && indent > 0) {
        list = [];
        listIndent = indent - 2 >= 0 ? indent - 2 : indent;
        data[pending.parentKey] = list;
        // 父键**已经定成数组**了，把它从「待定 map」里摘掉。不摘的话循环末尾的
        // flush() 会拿 pending.obj（一个空对象）把刚建好的数组覆盖掉——
        // 症状是 `supersedes:` 读回来变成 `{}` 而不是 `[]`，静默丢数据。
        pending = null;
      }
      if (!list || indent <= listIndent) {
        errors.push({ line: lineNo, message: '数组项没有归属的键' });
        continue;
      }
      const v = parseScalar(body === '-' ? '' : body.slice(2));
      if (v !== null) list.push(v);
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) {
      errors.push({ line: lineNo, message: `不是 key: value 形状：${body.slice(0, 40)}` });
      continue;
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (key === '' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      errors.push({ line: lineNo, message: `键名不合法：${JSON.stringify(key)}` });
      continue;
    }

    if (indent === 0) {
      flush();
      list = null;
      listIndent = -1;
      if (rest === '') {
        // 可能是嵌套 map（后面缩进的键）、块数组，或真的空标量：
        // 先按 null 记下，等到看见缩进行再决定它是什么。
        data[key] = null;
        pending = { parentKey: key, obj: {} };
        continue;
      }
      const arr = parseInlineArray(rest);
      if (arr) {
        data[key] = arr;
        continue;
      }
      if (rest.startsWith('[') || rest.startsWith('{')) {
        errors.push({ line: lineNo, message: `数组/对象语法不完整：${rest.slice(0, 40)}` });
        continue;
      }
      data[key] = parseScalar(rest);
      continue;
    }

    // 缩进行：只能是某空值键之下的 map 或块数组
    if (indent !== 2) {
      errors.push({ line: lineNo, message: `只支持两层缩进（这里是 ${indent} 空格）` });
      continue;
    }
    if (!pending) {
      errors.push({ line: lineNo, message: `缩进键 ${key} 没有父键` });
      continue;
    }
    if (rest === '') {
      // `- ` 列表：父键已经按 null 记着了，这里把 list 挂成目标
      list = [];
      listIndent = indent;
      data[pending.parentKey] = list;
      continue;
    }
    if (list) {
      errors.push({ line: lineNo, message: `父键 ${pending.parentKey} 已经是数组，不能再放键` });
      continue;
    }
    const arr = parseInlineArray(rest);
    pending.obj[key] = arr ?? parseScalar(rest);
    data[pending.parentKey] = pending.obj;
  }
  flush();

  if (errors.length) return { data: null, errors };
  return { data, errors: [] };
}

/** 需要加引号的标量。 */
function quoteIfNeeded(value) {
  const s = String(value);
  if (s === '') return '""';
  if (/^[\s]|[\s]$/.test(s)) return JSON.stringify(s);
  if (/[:#\[\]{}'"]/.test(s) || s.startsWith('- ') || s === '~') return JSON.stringify(s);
  if (['true', 'false', 'null', '~'].includes(s)) return JSON.stringify(s);
  if (/^-?\d+(\.\d+)?$/.test(s)) return JSON.stringify(s);
  return s;
}

function scalarOut(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => quoteIfNeeded(v)).join(', ')}]`;
  return quoteIfNeeded(value);
}

/**
 * 序列化 frontmatter（**不写** `---` 围栏）——确定性输出：键按给定顺序，
 * 同输入永远同字节。审计要的就是这个（diff 干净，幂等重建可比 hash）。
 */
export function serializeFrontmatter(data, keyOrder) {
  const keys = keyOrder ? keyOrder.filter((k) => k in data) : Object.keys(data);
  for (const k of Object.keys(data)) if (!keys.includes(k)) keys.push(k);
  const lines = [];
  for (const key of keys) {
    const value = data[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const sub of Object.keys(value)) lines.push(`  ${sub}: ${scalarOut(value[sub])}`);
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      lines.push(`${key}: []`);
      continue;
    }
    if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) {
      lines.push(`${key}: ${scalarOut(value)}`);
      continue;
    }
    lines.push(`${key}: ${scalarOut(value)}`);
  }
  return lines.join('\n');
}

/**
 * 官方键序（`06-architecture.md §3.1` 的示例顺序）。
 * 写文件时用它，读文件时**不**依赖它——人手写的顺序可能不同，那是合法的。
 */
export const NOTE_KEY_ORDER = Object.freeze([
  'schema',
  'id',
  'scope',
  'kind',
  'trust',
  'provenance',
  'valid_from',
  'valid_to',
  'supersedes',
  'superseded_by',
  'confidence',
  'verify_after',
  'tags',
  'aliases',
  'subject',
  'predicate',
  'legacy',
]);
