/**
 * BM25 词法索引。零依赖、零出网、零模型。
 *
 * 参数取值与理由（都来自旧项目 `bm25.js` 实测，不是拍脑袋）：
 *
 *  - `K1 = 1.2`：教科书默认值（也是 DSH-SEP 用的值），便于对照。
 *  - `B = 0.4`：**不是**教科书的 0.75。机制是长度归一按 `len/avgLen` 惩罚长文档，
 *    而我们的库里绝大多数记录都是长文，这个惩罚就变成「谁长谁吃亏」，与相关性无关。
 *    旧项目在三把尺子上扫过 0.2–0.9，0.3–0.5 是一片平台，取中间偏下的 0.4。
 *  - `TITLE_EXTRA = 3` / `TAG_EXTRA = 2`：字段加权（BM25F 的廉价近似）＝把标题/标签里的
 *    词项多计几遍。旧项目从 3 调到过 24，但那是靠「标题当查询」的对照组堆出来的，
 *    那个构造对标题权重**结构性偏袒**，不构成证据。这里取保守值 3（它自己最初的取值）。
 *    要重调请先按 `02-evaluation.md §4.3` 第 3 条把 dev/test 切开，别在跑分集上调。
 *  - `QUERY_TERM_CAP = 24`：超长查询里高频词会淹没真正特异的词，按 IDF 只留最特异的
 *    这么多个（抄 hindsight 的 bm25 词项选择 cap）。
 *  - `PHRASE_BONUS = 0`：整句子串命中奖励**实测否决**过（奖励「抄了查询的笔记」会把
 *    更该命中的那篇挤下去）。常量与实现留在代码里当证据，不是待办。
 */
import { tokenize, expandQuery } from './tokenize.js';
import {
  COOC_ANCHOR_MAX_DF_RATIO,
  anchorTermsOf,
  presentClasses,
  groupAnchorsByClass,
  cooccurringClasses,
  requiredCooccurrences,
  checkCooccurrence,
} from './cooccurrence.js';

export const K1 = 1.2;
export const B = 0.4;
export const TITLE_EXTRA = 3;
export const TAG_EXTRA = 2;
export const QUERY_TERM_CAP = 24;
export const PHRASE_BONUS = 0;

/** 索引里的版本号：口径变了就 +1，旧索引会被判指纹不匹配而重建。 */
/**
 * 词项在**多少比例的文档里出现过**就不再算证据。
 *
 * 中文按二字切之后，`的构`/`是什`/`么` 这类碎片会出现在几乎每篇笔记里：它们是
 * 分词噪声，不是证据。不设这道闸的后果是「查一个库里根本不存在的东西，也能凑出
 * 0.3 的相关性」——那是把拒答能力直接烧掉（判据 1 的 `correct_refusal_rate`）。
 *
 * 0.8 是刻意保守的：一个真在 8 成以上笔记里出现的词，本来就区分不了任何东西；
 * 而小语料（n < 5）下这个闸基本不生效（`df/n` 波动太大）。
 */
export const MAX_DF_RATIO = 0.8;
export const MIN_DF_DOCS = 5;

/**
 * **查询必须至少有一个「有信息量的词项」，否则整条查询不算证据。**
 *
 * 「有信息量」= 在参考语料里出现的文档比例不超过 `INFORMATIVE_DF_RATIO`。
 * 这是 `CJK_BOUNDARY_CHARS` 之后的**第二道网**，防的是同一类失败的另一半：
 * 切词边界能干掉 `门的`/`里的` 这种横跨助词的碎片，但**干不掉那些本身就是词、
 * 却在库里几乎无处不在**的词项（`什么` df 115/1321、`默认` df 110/1321）。
 *
 * 机制（为什么这一条能治病）：覆盖率 = 命中词项的信息量 / 查询的信息量总量。
 * 当查询里**只有**一个词项在库里存在时（无论它多常见），覆盖率恒等于 1.0 ——
 * 这不是「覆盖得很全」，而是分母退化了。实测未修前：「量子色动力学里的胶子禁闭」
 * 只剩 `里的`（df 96）一个词项，**92 篇无关笔记覆盖率全是 1.0**，全部越过
 * `minCoverage=0.6` 的拒答闸；「中世纪欧洲的封建采邑制度」只剩 `的封`（df 1）
 * 一个词项，也照样答。加了这道网之后这三条查询都正确拒答（见 M2 报告）。
 *
 * 为什么**不**是「给常见词按 idf 打折」：M1 试过，它把真答案一起压掉了
 * （计分集 recall@5 0.844 → 0.563，见 `scoreDocs` 里那段注释）。打折动的是**分数**，
 * 而这里的病灶是**分母退化**；把退化这件事直接判成「没有证据」才是对症的。
 *
 * 为什么阈值是 5%：它等同于「这个词项在 20 篇里出现不超过 1 篇」。低于它就区分不出
 * 任何东西（出现在 5% 以上文档里的词，靠它自己挑不出 20 篇里的一篇）。
 * 0.05 与已有的 `MAX_DF_RATIO = 0.8` 是两个不同用途的闸，**不要合并**：
 *  - `MAX_DF_RATIO`：**逐词**过滤（这个词还能不能算一个证据）；
 *  - `INFORMATIVE_DF_RATIO`：**整条查询**过滤（这条查询整体还值不值得答）。
 * 为什么判据是**双阈值**（`MIN_DOCS` **或** `RATIO`）而不是单看比例：只看比例时，
 * 判据的分母是语料规模，于是同一条闸在小语料上会**反过来**咬人。M3 的
 * `bench/sweep.mjs` 扫出：200 篇档上判别词 `df=12` 只占 6% > 5%，被整条判成
 * 「没有信息量的词」→ `no_informative_term` 误触 → 120 道可答题全被拒
 * （recall@5 0.0%、拒答率 87.5%）。500 篇档同病，2000 篇档才回到 80.0% / 62.5%。
 * 也就是说：**n 越小，这道闸越像「什么都拒」**，而它本该只在大库上拦分母退化。
 *
 * 修法是把「常见词」的判据改成与语料规模无关的那一半先说：
 * `df <= INFORMATIVE_DF_FLOOR_DOCS`（绝对词频）**或** `df/n <= INFORMATIVE_DF_RATIO`
 * （比例）就算证据。绝对词频这一支有统计意义、**不需要**语料够大：
 *  - 50 篇语料里出现在 ≥ 10 篇的词就是常见词（那是全部笔记的 20%），这跟语料有 50 篇
 *    还是 5000 篇无关；「同一句话被抄进上百篇笔记」本身就是结构性的信号。
 *  - 小语料恰恰是最容易被 n 放大误判的地方：n=50 时服务名只落在 10 篇笔记里，
 *    按比例算是 20% 常见词，可那 10 篇是 10 篇**不同**的笔记——闸门不该据此
 *    把「服务名 + 判别词」的正常提问整条拒掉。绝对词频 `10 ≤ 64` 就不会这么判。
 * 所以这条闸**在任何语料规模上都成立**，不再有 `n < 200 时整条闸失效` 的空档
 * （那正是缺陷的温床：闸要么全关要么全拒，中间没有过渡）。
 *
 * 两个阈值的分工：`FLOOR` 管小语料（n < 1280 时它更宽松，是先"放行"的那一支），
 * `RATIO` 管大库（n ≥ 1280 时它更宽松）。真库 1321 篇的行为因此**不变**：
 * 那个规模上仍然是 `df/n ≤ 0.05` 说了算，`df ≥ 67` 的词照旧不算证据。
 *
 * **M6 修的残余空档**：地板是**绝对**词频，`df ≤ 64` 对任何 `df > 0` 都成立 ——
 * 于是 `n ≤ 64` 的语料上这条闸**恒真**，一个词项都不会被删（`dropped` 永远是 false，
 * `informativeGateEnabled` 永远是 false）。50 篇档因此等于没开闸，这正是 M5 说的
 * 「小语料第二重失效」。修法是把地板按语料规模**封顶**：`df ≤ min(FLOOR, n)`。
 *  - `n ≤ 64` 时地板 = n，而 `df ≤ n` 恒成立 —— **行为逐字不变**（那正是要保留的
 *    「小语料上不误杀判别词」这一支；这条闸的职责不是在小库上咬人）；
 *  - `n = 1321` 时地板仍是 64 —— `isInformativeTerm(66,1321) === true` 与
 *    `(67,1321) === false` 这类既有断言**原样通过**，真库行为逐字不变。
 * 也就是说：这个改动本身**不**让 50 篇档的闸门变严（变严的活儿交给共现核对，
 * 见 `cooccurrence.js`）——它只是把「地板永远比语料大」这个退化写明白，
 * 让 `min(FLOOR, n)` 成为两个规模上一致的口径。
 */
export const INFORMATIVE_DF_RATIO = 0.05;
export const INFORMATIVE_DF_FLOOR_DOCS = 64;
/** @deprecated 不再参与判定（闸门现在在所有语料规模上生效）；保留导出只为兼容既有引用与文档。 */
export const INFORMATIVE_MIN_DOCS = 200;

export const INDEX_VERSION = 1;
export const INDEX_BUILDER = 'bm25-lexical-1';

/**
 * 单条记录的字数上限：超过就切桶。
 *
 * 为什么切桶而不是截断：旧项目真库里出现过一篇 267KB 的追加式日志，占全库七成体积，
 * 在 30 条查询里霸榜 17 条。截断能压住霸榜，但后面那 259KB 就永远检索不到了；
 * 切桶既不丢内容，又只让「真正含查询词的那一节」得分。
 */
const SECTION_CHARS = 400;
const MAX_SECTIONS = 40;

/** 一条笔记（已归一化字段）→ 若干可检索记录。 */
export function sectionsOf(note) {
  const id = String(note.id);
  const body = String(note.body ?? '');
  const title = String(note.title ?? '');
  if (body.length <= SECTION_CHARS) {
    return [{ id, section: 0, title, body, weightLabel: '' }];
  }
  const parts = [];
  for (let i = 0; i < body.length && parts.length < MAX_SECTIONS; i += SECTION_CHARS) {
    parts.push(body.slice(i, i + SECTION_CHARS));
  }
  return parts.map((part, i) => ({
    id,
    section: i,
    // 标题只喂给首桶：否则同一个标题被计入几十次，把长笔记的分数抬虚。
    title: i === 0 ? title : '',
    body: part,
    weightLabel: i === 0 ? '' : `§${i + 1}`,
  }));
}

/** 一条记录的加权词项表：标题 ×3、标签 ×2、正文 ×1。 */
export function tokenizeRecord(rec) {
  const tf = new Map();
  const add = (term, n) => {
    if (!term) return;
    tf.set(term, (tf.get(term) ?? 0) + n);
  };
  for (const t of tokenize(rec.body)) add(t, 1);
  for (const t of tokenize(rec.title)) add(t, TITLE_EXTRA);
  for (const t of tokenize((rec.tags ?? []).join(' '))) add(t, TAG_EXTRA);
  let len = 0;
  for (const n of tf.values()) len += n;
  return { tf, len };
}

/**
 * 建索引：`docs = [{ id, section, title, body, tags, kind, trust, times }]`。
 *
 * 返回的结构**可 JSON 序列化**（真相源是文件，索引只是可重建的派生物，
 * 所以索引必须能被写进 `index/` 再读回来，见架构文档风险 7）。
 */
export function buildIndex(docs) {
  const postings = new Map();
  const docLen = [];
  const metas = [];
  let totalLen = 0;
  docs.forEach((doc, i) => {
    const { tf, len } = tokenizeRecord(doc);
    docLen.push(len);
    totalLen += len;
    metas.push({
      id: String(doc.id),
      section: doc.section ?? 0,
      title: doc.title ?? '',
      kind: doc.kind ?? 'semantic',
      trust: doc.trust ?? 'user_stated',
      tags: doc.tags ?? [],
      chars: String(doc.body ?? '').length,
      // **笔记身份**的词项（`id` / `title` / `tags` / `aliases`，只用于 `cooccurrence.js`
      // 的核对，不进 `postings`、不参与打分）。理由见 `cooccurrence.js` 的 `identity` 参数。
      identityTerms: identityTermsOf(doc),
    });
    for (const [term, n] of tf) {
      let plist = postings.get(term);
      if (!plist) {
        plist = [];
        postings.set(term, plist);
      }
      plist.push([i, n]);
    }
  });
  return {
    version: INDEX_VERSION,
    builder: INDEX_BUILDER,
    n: docs.length,
    k1: K1,
    b: B,
    avgLen: docs.length ? totalLen / docs.length : 0,
    docLen,
    metas,
    postings,
  };
}

/** 序列化：Map → 数组（JSON 不认 Map）。 */
export function serializeIndex(index) {
  return {
    version: index.version,
    builder: index.builder,
    n: index.n,
    k1: index.k1,
    b: index.b,
    avgLen: index.avgLen,
    docLen: index.docLen,
    metas: index.metas,
    postings: [...index.postings.entries()],
  };
}

/** 反序列化；形状不对返回 null（调用方负责重建，绝不猜着解析）。 */
export function deserializeIndex(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== INDEX_VERSION || raw.builder !== INDEX_BUILDER) return null;
  if (!Array.isArray(raw.postings) || !Array.isArray(raw.metas)) return null;
  if (raw.n !== raw.metas.length || raw.docLen?.length !== raw.n) return null;
  const postings = new Map();
  for (const entry of raw.postings) {
    if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) return null;
    postings.set(String(entry[0]), entry[1]);
  }
  return {
    version: raw.version,
    builder: raw.builder,
    n: raw.n,
    k1: raw.k1,
    b: raw.b,
    avgLen: raw.avgLen,
    docLen: raw.docLen,
    metas: raw.metas,
    postings,
  };
}

/**
 * 一篇笔记**身份**的词项集：文件名（`id`）+ 标题 + 标签 + 别名，用同一把切词器切。
 *
 * 这份词项只给 `cooccurrence.js` 的核对用（「问题里的实体是不是写在这一篇里」），
 * **不进 `postings`、不参与 BM25 打分** —— 身份字段进打分是另一件事（会改排序，
 * 需要单独量），M6 不顺手做。
 *
 * 返回排序后的数组（不是 `Set`）：`metas` 要能过 `JSON.stringify` 往返
 * （`serializeIndex`/`deserializeIndex`），`Set` 会被序列化成 `{}`。
 */
function identityTermsOf(doc) {
  const text = [doc.id, doc.title, ...(doc.tags ?? []), ...(doc.aliases ?? [])]
    .filter((v) => v !== null && v !== undefined && v !== '')
    .join(' ');
  if (!text) return [];
  return [...tokenizeRecord({ body: text }).tf.keys()].sort();
}

function idf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/**
 * 一个词项是否**算得上证据**：绝对词频 `df <= INFORMATIVE_DF_FLOOR_DOCS`
 * **或** 文档比例 `df/n <= INFORMATIVE_DF_RATIO`。
 *
 * 两支里取更宽松的一支（或），判据因此**不随语料规模退化**：
 *  - 小语料（n < 1280）：`df <= 64` 生效 —— 50 篇档里 `df=12` 的判别词不再被
 *    5% 的比例误杀，可答题不会被整条拒掉；
 *  - 大库：`df/n <= 0.05` 生效 —— 真库（1321 篇）上仍是 `df ≥ 67` 才算常见词，
 *    与改动前的行为逐字一致；
 *  - 两边都不满足才判「没有信息量」（n=200 档的 `df=120`、n=1321 档的 `df ≥ 67`）。
 *
 * `df` 为 0（语料里根本没有这个词）时**不算常见词**，返回 true：这个词压根不在库里，
 * 「常见 / 稀罕」对它无从谈起。真正要判「有没有证据」的是**在库里存在**的词项，
 * 调用方（`scoreDocs`）与装置（`bench/sweep.mjs` 的 `judgeQuery`）都各自做了这件事
 * —— 两边都是 `df > 0 && isInformativeTerm(df, n)`。把这层判断压在 `df=0` 上会把
 * 「库里没有」与「库里太常见」混成同一个结论，它们该给的拒答理由并不相同。
 * 边界：n 非有限数或 ≤ 0 时按「不能判断」处理 —— 一律算证据（宁可答错，不可整条拒掉）。
 */
export function isInformativeTerm(df, n) {
  if (!Number.isFinite(n) || n <= 0) return true;
  if (!Number.isFinite(df) || df <= 0) return true;
  // 地板按语料规模封顶：`n ≤ 64` 时地板 = n，`df ≤ n` 恒成立 → 这条闸在小语料上
  // **结构上**不会误杀（判据随规模退化的那半边被显式钉住了，见上面那段注释）。
  return df <= Math.min(INFORMATIVE_DF_FLOOR_DOCS, n) || df / n <= INFORMATIVE_DF_RATIO;
}

/**
 * 查询侧词项选择：按 IDF 降序只留 `QUERY_TERM_CAP` 个。
 *
 * 只对**出现在索引里**的词项排序：不在索引里的词项 IDF 取最大值，
 * 若把它们排进来会挤掉真正有用的词（它们本来也贡献 0 分）。
 */
export function selectTerms(index, expansions, cap = QUERY_TERM_CAP) {
  const present = expansions.filter((e) => index.postings.has(e.term)).filter((e) => {
    // 语料内停用词闸：只在语料够大时生效。n 很小时 df/n 本身没有统计意义。
    if (index.n < MIN_DF_DOCS) return true;
    const df = index.postings.get(e.term).length;
    return df / index.n <= MAX_DF_RATIO;
  });
  // idf/df 一律带上，**不能只在超 cap 时才算**：调用方要拿它算「这个词有多稀罕」，
  // 少了字段会算出 NaN，而 NaN 的比较全是 false —— 静默失效，最难查的那种。
  const scored = present.map((e) => {
    const df = index.postings.get(e.term).length;
    return { ...e, df, idf: idf(df, index.n) };
  });
  if (scored.length <= cap) return scored;
  scored.sort((a, b) => b.idf - a.idf || b.weight - a.weight || (a.term < b.term ? -1 : 1));
  return scored.slice(0, cap);
}

/**
 * 打分：返回 `[{ docIndex, score, terms: [...] }]`，只含得分 > 0 的记录。
 *
 * 纯函数：同一份索引 + 同一份查询，结果永远一致（可回放是审计性的地基）。
 */
export function scoreDocs(index, query, options = {}) {
  const cap = options.termCap ?? QUERY_TERM_CAP;
  const expansions = Array.isArray(query)
    ? query
    : expandQuery(query, { bridge: options.bridge });
  // `keepCommon: true` 时跳过停用词闸（诊断/调试用：这里要看的是原始匹配，
  // 不是「够不够格当证据」）。
  const terms = options.keepCommon
    ? expansions
        .filter((e) => index.postings.has(e.term))
        .map((e) => {
          const df = index.postings.get(e.term).length;
          return { ...e, df, idf: idf(df, index.n) };
        })
    : selectTerms(index, expansions, cap);
  // 查询的「信息量总量」：每个词按 idf × 词权重计一次（同一个词只计一次 ——
  // 同一个 term 可能同时来自字面与桥接两种 source，计两次会让分母虚高）。
  //
  // **分母用参考语料的 idf，样本用本次检索的 idf**（两者默认是同一个索引）。
  // 为什么要有这个区分：`recall()` 会先把「过期/被替换/超范围」的笔记滤掉再建索引，
  // 于是同一句查询在有 50 篇和有 41 篇时算出的覆盖率**不是同一个数** ——
  // 表现就是「昨天问它答，今天同一句它说没证据」，而库里一个字都没改。
  // 参考语料取「整个库」，覆盖率就不再随过滤结果漂移。
  const refIndex = options.referenceIndex ?? index;
  const massOf = new Map();
  for (const t of terms) {
    if (massOf.has(t.term)) continue;
    const refDf = refIndex.postings.get(t.term)?.length ?? 0;
    const refIdf = refDf > 0 ? idf(refDf, refIndex.n) : t.idf;
    massOf.set(t.term, refIdf * t.weight);
  }
  // **分母退化保护**：查询里有没有一个「算得上证据」的词项（见 `INFORMATIVE_DF_RATIO`）。
  //
  // 一条查询只命中了库里的常见词（或只剩一个碎片词项）时，覆盖率的分母塌成一个数，
  // 于是任何含这个词项的笔记都拿到 coverage = 1.0。那不是「覆盖得很全」，
  // 是**问题本身没有信息量**：这时正确动作是「不算证据」而不是「答它」。
  //
  // **`df = 0`（库里根本没有这个词项）不算证据** —— 这一条很容易写反：
  // 桥表扩展出来的英文词（`闸门` → `gate`）在库里往往一次都没出现过，
  // 把它也算成「稀有证据」的话，分母就被一个**没人命中得了**的词项撑大了，
  // 于是只命中常见词的那些笔记又拿到一个不大不小的覆盖率，这道闸就白设了。
  // 「有信息量」= **存在** 且 **不常见**，两个条件缺一不可。
  // 注意 `keepCommon`（诊断/nearest 路径）不走这条：那条路要看的正是原始匹配。
  const informative = options.keepCommon
    ? { terms: [], set: new Set(), count: 0, ratio: INFORMATIVE_DF_RATIO, enabled: false }
    : (() => {
        let dropped = false; // 闸门这次有没有**改变判定**（删掉过词项）
        const kept = terms.filter((t) => {
          const df = refIndex.postings.get(t.term)?.length ?? 0;
          if (df <= 0) return false; // 库里没有这个词项：不是证据，但也不算「被闸门删掉」
          if (isInformativeTerm(df, refIndex.n)) return true;
          dropped = true;
          return false;
        });
        return {
          terms: kept.map((t) => t.term),
          // 判定用 Set，公开的 `terms` 用数组（JSON 友好）：查询词项可达上限几十个，
          // 但分母那一层是逐词项查的，别用 `includes` 写成 O(n²)。
          set: new Set(kept.map((t) => t.term)),
          count: kept.length,
          ratio: INFORMATIVE_DF_RATIO,
          // `enabled` 的语义是「**这道闸这次有没有改变判定**」，不是「闸门开没开」。
          // 两处会报 false：① 全部候选词项都在库里不存在（`df = 0`，选择层的事）；
          // ② 存在的词项全都过闸（小语料上 `df <= 地板` 一一放行）。
          // 这两种情况下「有没有证据词」这个结论与「不设闸」逐字相同，报 true 只会把
          // 成因不同的拒答（选择层空手 vs 真的只有常见词）混成同一个 `no_informative_term`。
          // M4 之前这里是 `refIndex.n >= INFORMATIVE_MIN_DOCS` —— 那个按语料规模开关的
          // 判据造成的空档正是 200 篇档全拒的成因（见 §5.5.1）。
          enabled: dropped,
        };
      })();
  // **分母只算「有信息量」的词项**（`INFORMATIVE_DF_RATIO`）。
  //
  // 为什么不是「所有词项都进分母」：像 `什么`（df 115/1321）这种满库皆是的词项，
  // 在分母里占的份额会让一篇**只命中它**的笔记拿到一个不大不小的覆盖率，
  // 而那个数没有任何鉴别力可言 —— 分母里混进多少噪声，覆盖率就有多少水分。
  // 把分母收窄到「能区分出东西的词项」，覆盖率才真的是「这篇解释了问题里
  // 有鉴别力的那部分没有」。
  //
  // 一条查询**一个**有信息量的词项都没有时，分母塌成 0，所有笔记覆盖率都是 0：
  // 这不是「覆盖率算不出来」，而是「这条查询在库里构不成证据」，调用方据此拒答
  // （`recall.js` 报 `no_informative_term`）。
  const totalMass = informative.count === 0
    ? 0
    : terms.reduce((sum, t) => (massOf.has(t.term) && informative.set.has(t.term) ? sum + massOf.get(t.term) : sum), 0);
  // ⚠️ 试过但**没采用**：把常用词的贡献按稀有度打折（`idf/idf(1)`，一次方或平方）。
  // 动机是真实的旧库上有假命中 —— 「量子色动力学里的胶子禁闭」里唯一在库里出现过的
  // 词项可能只是 `里的`（df 96/1332），于是无关笔记的覆盖率被顶到 1.0。
  // 折扣确实把这个数压到了 0.39，但它**同时**压掉了真答案：计分集上
  // recall@5 从 0.844 掉到 0.563（平方折扣更差），
  // 而且需要的闸门值从 0.6 挪到 0.5（余量没了）。
  // 结论：问题不在「分母没按稀有度加权」，而在「切词器会把 `闸门` + 的 切成 `门的`」
  // 这类跨词碎片上 —— 那该在 M2 的切词层解决（需要词表），不是拿覆盖率闸去顶。
  // **M2 已按这个结论落地**：`tokenize.js` 的 `CJK_BOUNDARY_CHARS` 消掉跨词碎片，
  // 上面那段 `informative` 处理分母退化。两条都是**判定**，不是打分折扣 ——
  // 这正是它与「打折」的关键区别：真答案的分数一个字都没动。
  // 覆盖率**逐桶算**（`covered / totalMass`），笔记层取各桶最大值。
  //
  // 为什么不是「把一篇笔记各桶命中的词取并集再算」——那样覆盖率会虚高，
  // 而且方向恰好是错的那种虚高：一篇讲了好几个相近主题的笔记
  // （「Kestrel 配置路径」里顺带提到了「默认」），会因为**不同段落各命中一个词**
  // 而拿到 0.63 的覆盖率，于是「换个说法问同一个东西」被当成有证据。
  // 实测：并集口径下 8 条拒答题有 3 条被放过（正确拒答率 0.875 → 0.625）。
  // 逐桶口径下，一个桶必须**自己**覆盖住问题才算数，这才是「有人正面回答了它」。
  const acc = new Map();
  // 分母收窄到「有信息量」的词项之后，**分子也必须用同一把尺**——
  // 否则只命中常见词（本来不参与分母）的笔记仍会往分子里加质量，
  // 分子分母口径不一致就是这个函数最容易出的错（`density` 那段注释讲的是同一件事）。
  const massEligible = (term) => options.keepCommon || informative.set.has(term);
  for (const { term, weight, source, df } of terms) {
    const plist = index.postings.get(term);
    if (!plist) continue;
    const termIdf = idf(df, index.n);
    const qWeight = weight * termIdf;
    const termMass = massOf.get(term) ?? qWeight;
    for (const [docIndex, tf] of plist) {
      const len = index.docLen[docIndex] || 0;
      const norm = 1 - B + (B * len) / (index.avgLen || 1);
      const contribution = (qWeight * (tf * (K1 + 1))) / (tf + K1 * norm);
      let entry = acc.get(docIndex);
      if (!entry) {
        entry = { docIndex, score: 0, mass: 0, terms: [] };
        acc.set(docIndex, entry);
      }
      entry.score += contribution;
      // 分子与分母用同一个打折口径（见上面 `density` 处的注释）
      if (massEligible(term)) entry.mass += termMass;
      entry.terms.push({ term, source, weight: Math.round(contribution * 1e6) / 1e6 });
    }
  }
  for (const entry of acc.values()) {
    entry.coverage = totalMass > 0 ? Math.min(1, entry.mass / totalMass) : 0;
    entry.queryMass = totalMass;
    entry.queryTerms = massOf.size;
  }
  const result = [...acc.values()].sort(
    (a, b) => b.score - a.score || (a.docIndex < b.docIndex ? -1 : 1),
  );
  // **组合级共现核对**（`cooccurrence.js`）：命中之后要核「被问的那几样东西
  // 是不是写在**同一篇**里」。只共现一边的候选被剔出去 —— 这是 M5 扫出
  // 「召回与拒答完全反相关」时点名缺的那条机制，覆盖率闸结构上做不了这件事。
  //
  // 为什么放在这里（候选筛选之后、聚合之前）：核对的粒度是**桶**，而判定要的是
  // **笔记级**共现 —— 一篇长笔记被切成多个桶，A 写在第一桶、B 写在第三桶，
  // 它们确实是同一篇里共现的。所以这里标在桶上，`aggregateByNote()` 再把
  // 「这篇笔记共现了几样」按 id 聚合（取最大值），判定在 `recall.js` 做。
  const cooc = annotateCooccurrence(result, index, expansions, options);
  attachQueryInfo(result, {
    // 「查询里算得上证据的词项」。空数组 = 这条查询整体不构成证据（分母退化），
    // 调用方必须据此拒答，而不是「挑个最高分答了」。
    informativeTerms: informative.terms,
    informativeRatio: informative.ratio,
    informativeGateEnabled: informative.enabled,
    queryTerms: massOf.size,
    queryMass: totalMass,
    // 共现口径（锚点集 + 每篇命中了几样）。**公开出来**是为了让装置与 `explain`
    // 读得到同一次计算的结论，而不是各自再算一遍（两套口径迟早会不一致）。
    cooccurrence: cooc,
  });
  return result;
}

/**
 * 给每条候选标上「它命中了哪几**类**锚点、够不够」。
 *
 * 返回的 `info` 挂进 `queryInfo.cooccurrence`；每条 `entry` 上挂不可枚举的
 * `cooccurrence` 字段（形状仍然是原来的数组元素，`deepEqual` 类的断言不受影响）。
 *
 * `required` 在锚点集为空时是 0 —— 那种查询这条机制**不构成证据**，一律放行：
 * 拿「没有锚点」去拒答会把「库里没有稀有词项」和「事实没写过」混成一个结论。
 */
function annotateCooccurrence(entries, index, expansions, options) {
  const enabled = options.cooccurrence !== false;
  const maxAnchorDfRatio = options.maxAnchorDfRatio ?? COOC_ANCHOR_MAX_DF_RATIO;
  const anchors = enabled ? anchorTermsOf(expansions, index, { maxAnchorDfRatio }) : [];
  const groups = groupAnchorsByClass(anchors);
  // 只绑定「在这座库里真的参与复合键」的类（`cooccurrence.js`：一个类要和别的
  // 锚点类同篇出现过才绑定）。库里没写过、或从没和别类同篇的类不绑定 ——
  // 拿「我的词典/语料没有这一样」冒充「事实没写过」是伪造成绩。
  const bindable = enabled ? cooccurringClasses(groups, index, { maxAnchorDfRatio }) : [];
  // 可核的类数按 `presentClasses` 数（库里有这个词项就够），**不是** `bindable.length`：
  // 一个词项到处都是当不了核对点，但它**存在**，所以它没出现在候选里就是真没写。
  // 混用这两者会让「实体名太常见」被读成「这类不用核」（见 `cooccurrence.js`）。
  const known = enabled ? presentClasses(groups, index) : [];
  const required = enabled ? requiredCooccurrences(known.length, options.minClasses) : 0;
  const info = {
    enabled,
    maxAnchorDfRatio,
    anchorTerms: anchors,
    anchorClasses: Object.fromEntries([...groups].map(([cls, terms]) => [cls, terms])),
    // `required` 按**库里存在的类数**算（`known`），不按查询切出来的类数 ——
    // 查询里那些库里根本没有的词项不构成「可核的组合」（否则每一句带新词的话
    // 都会被拒）；而库里存在、只是太常见的类**照样算**（见上面 `known` 处注释）。
    required,
    knownClasses: known,
    // `ok` 是逐桶的读数（人看审计用）；判定在调用方按笔记聚合。
    pass: 0,
    fail: 0,
  };
  for (const entry of entries) {
    const verdict = checkCooccurrence(entry.terms, groups, required, {
      bindableClasses: bindable,
      knownClasses: known,
      identityTerms: index.metas[entry.docIndex]?.identityTerms,
    });
    Object.defineProperty(entry, 'cooccurrence', { value: Object.freeze(verdict), enumerable: false });
    if (required === 0) continue;
    if (verdict.ok) info.pass += 1;
    else info.fail += 1;
  }
  return Object.freeze(info);
}

/**
 * 把查询侧的口径挂在返回值上（**不可枚举**）。
 *
 * 为什么用不可枚举属性：`scoreDocs` 的返回类型必须继续是「一个数组」——
 * 已有调用方与用例对着它 `deepEqual([])`、`map`、`slice`。多挂几个可枚举字段
 * 会**静默**改变那些断言的语义（数组属性参与 `deepEqual`），而这是最容易埋下的
 * 「测试还绿，行为已经变了」。挂不可枚举属性则两头都成立：形状不变，口径可查。
 */
function attachQueryInfo(arr, info) {
  Object.defineProperty(arr, 'queryInfo', { value: Object.freeze(info), enumerable: false });
  return arr;
}

/**
 * 把「桶级」命中聚合成「笔记级」命中：同一 id 只留分最高的那一桶。
 *
 * 对调用方而言「一篇笔记仍然只是一条命中」——切桶是实现细节，不能漏到接口上
 * （旧项目 `store.js` 的注释就是这么定的，这里沿用）。
 */
export function aggregateByNote(scored, index) {
  const byId = new Map();
  for (const hit of scored) {
    const meta = index.metas[hit.docIndex];
    if (!meta) continue;
    const prev = byId.get(meta.id);
    if (!prev) {
      byId.set(meta.id, {
        id: meta.id,
        score: hit.score,
        coverage: hit.coverage ?? 0,
        queryTerms: hit.queryTerms ?? 0,
        best: hit,
        sections: [meta.section ?? 0],
        buckets: [hit.docIndex],
        // 共现是按**桶**标的（`scoreDocs` 的 `annotateCooccurrence`），这里按笔记聚合：
        // 取各桶最大值。为什么是 max 而不是「任意桶通过」：两者在判据
        // `missing.length === 0 && count >= required` 下等价，但 max 让
        // 「这篇一共命中了哪几类锚点」这个读数在审计时可解释 —— 「同篇共现」的语义是
        // **笔记级**的（分段只是打分用的实现细节）。
        // 判定对象整个搬过去（`cooccurrence.js` 的 `checkCooccurrence` 返回值）。
        // 只在**桶间**选「命中类最多的那个桶」，判定本身不在这一层重算。
        coocVerdict: hit.cooccurrence ?? null,
      });
      continue;
    }
    // `sections` 是**桶号**（人看得懂的 §2），`buckets` 是文档下标（程序要用的）。
    // 原来只存文档下标却叫 sections，诊断时会读出一串与正文对不上的数。
    if (!prev.sections.includes(meta.section ?? 0)) prev.sections.push(meta.section ?? 0);
    prev.buckets.push(hit.docIndex);
    // 笔记的覆盖率取**各桶最大值**：一篇长笔记只要有一段正面回答了问题，
    // 这篇就算覆盖到了。取平均会让长笔记因为大量无关段落被判成「不够格」，
    // 而长笔记恰恰是这个库里的常态。
    if ((hit.coverage ?? 0) > prev.coverage) prev.coverage = hit.coverage ?? 0;
    // 同一篇笔记的多个桶：取「命中类更多」的那个判定（`coocVerdict` 已含全部读数）。
    if ((hit.cooccurrence?.count ?? 0) > (prev.coocVerdict?.count ?? 0)) {
      prev.coocVerdict = hit.cooccurrence ?? null;
    }
    if (hit.score > prev.best.score) {
      prev.best = hit;
      prev.score = hit.score;
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
