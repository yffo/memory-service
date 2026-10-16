/**
 * 组合级共现核对（`docs/06-architecture.md §5.5.3`）。零依赖、零出网、零模型。
 *
 * 这个文件回答一个问题：**命中的那篇笔记，到底同时提到了问题里的哪几样东西。**
 *
 * ────────────────────────── 为什么需要它（前一条机制修不了的那半） ──────────────────────────
 *
 * 覆盖率闸（`MIN_COVERAGE`）与证据性闸（`INFORMATIVE_DF_RATIO` / `INFORMATIVE_DF_FLOOR_DOCS`）
 * 都在问同一件事：「问题里的鉴别性内容，这篇笔记命中了多少」。它们**结构上**答不了
 * 下一个问题：「命中是**同一篇**里同时发生的，还是分散在社区里的不同篇」。
 *
 * M5 在 50/200/500/1000/2000 篇五档合成语料上扫了 9835 格，结论是拒答与召回在现有
 * 机制下完全反相关：`recall ≥ 0.80` 的 9807 格里拒答率**全是 0.000**。逐题诊断给出的
 * 机制是：判别词（`kpNNNNN` 这种知识点号，df = 2~4）是孤例级稀罕词，**它自己就过了闸门**，
 * 而覆盖率的分母里每个证据词只算一次、分子里单词命中可以放大 —— 于是「服务 X 有一篇讲
 * `kp00042` 的笔记」（X 别的知识点）与「X 的 `kp00042` 那一篇」拿到**逐位相同**的覆盖率
 * 1.000。两类题在覆盖率上不可分，不是阈值不够严。
 *
 * 缺的那条判据是**组合级**的：被问的「实体 × 知识点」必须在**同一篇**笔记里共现；
 * 只共现一边（服务名在这一篇、知识点号在另一篇）就该拒答。
 *
 * ────────────────────────── 机制：按「词面类」核对，而不是数词项 ──────────────────────────
 *
 * 朴素做法是「数这篇命中了几个稀有词项，够 N 个就放行」。它**修不了**病灶，而且是
 * 可证伪的：被问的组合缺的往往只有**一样**（服务名），其余几样（知识点号、属性名、
 * 领域词）都在那一篇里 —— 于是「命中 4 个锚点」的近邻照样越过「≥2」的门槛。
 * 数词项数不出「缺的是哪一样」。
 *
 * 所以核对单位是**词面类**（{@link termClass}）：把锚点按「它长什么样」分组 ——
 * 中日韩文、拉丁字母、数字。判据是：
 *
 *   一个候选能当答案，每类**必须至少命中一个**（该类在库里根本没有锚点时除外，见下）。
 *
 * 为什么是按类而不是逐词项：提问里的「实体」与「知识点号」在词面上本来就是不同的类
 * （`Lumenpath` / `kp00042` / `额度峰值`），而**切词会把一个词切成好几个词项**
 * （`acme-widget` → `acme` + `widget`；`过期时限` → `过期` + `期时` + `时限`）。
 * 逐词项要求「每个都命中」会被切词碎片误伤；按类要求「每类至少一样」正好是
 * 「这几样东西得写在**同一篇**里」的可操作形式。
 *
 * 「该类在库里没有锚点 → 不绑定」这一条是**零成本**的诚实化：用户问的词库里
 * 一个字都没写过（`acme` 不在任何笔记里），那这一样东西就不是「同一篇里缺了它」，
 * 而是「这类东西在这座库里不存在」—— 拿它拒答等于用「我的词典没有这个词」
 * 冒充「事实没写过」。要么这一类的确无处可寻（放行，让覆盖率与分数去判），
 * 要么库里有别的笔记写了它（那就**绑**：此时「本篇少写了一样」才是真信号）。
 *
 * ────────────────────────── 为什么是「宁可拒答」 ──────────────────────────
 *
 * 判据 1 的拒答线（`correct_refusal_rate`）要的就是「不确定时倾向拒答」。这条机制天生
 * 偏保守：它会把「用户用了库里没有的说法」的**真答案**一起拒掉（词面层的已知代价）。
 * 这个代价是刻意选的，而且**不许用模糊匹配去救** —— 一旦允许「差不多算共现」，
 * 它就会退化成又一个覆盖率，M5 的那 9835 格就白扫了。
 *
 * 两个旋钮：`COOC_ANCHOR_MAX_DF_RATIO`（什么样的词算锚点）与 `COOC_MIN_CLASSES`
 * （要几类同篇）。两个都在 `bench/sweep.mjs` 的网格里，取值是量出来的，不是拍的。
 */

/**
 * 锚点门槛：`df/n` 不超过它的词项才算「在这座库里够稀有」，值得当核对点。
 *
 * 为什么判据是**比例**而不是绝对词频：这条机制要问的是「这个词在库里挑不挑得出笔记」，
 * 而那是相对规模的性质 —— `df = 40` 在 50 篇的库里是 80%（挑不出东西），在 2000 篇的
 * 库里是 2%（很能挑）。M4 的 `INFORMATIVE_DF_FLOOR_DOCS` 之所以用绝对词频，是因为
 * 它管的是**证据性**（「同一句话被抄进上百篇笔记」本身就是结构信号）；两者判的不是
 * 同一件事，所以这里的口径必须与它不同 —— 混用会让小语料上「任何词都是锚点」
 * 或者大库上「几乎没词是锚点」，两头都错。
 *
 * 0.5 的读法：出现在一半以上笔记里的词，靠它自己挑不出两篇里的一篇，当核对点没有
 * 鉴别力。这个值刻意宽松（宁可多留锚点，也别把真答案的核对点丢了 —— 锚点少一类，
 * 就更容易掉进「共现不足」的拒绝里）。实测曲线见 `docs/06-architecture.md §5.5.3`。
 */
export const COOC_ANCHOR_MAX_DF_RATIO = 0.5;

/**
 * 判定要几**类**同篇共现的**上限**。`null` = 用公式 `min(2, 库里锚点类数)`：
 *  - 库里锚点 ≥ 2 类 → 要 **2** 类（「至少两样被问的东西写在同一篇里」）；
 *  - 库里锚点 = 1 类 → 要 **1** 类（只有一样可核，就核它在不在）。
 *
 * 为什么不写死 2：只命中一类锚点的查询（一个实体名 + 全是常见词的属性）在真实提问里
 * 很常见，硬要 2 会变成「这条机制一律拒答」。公式化之后，机制在**能核的地方**核，
 * 在只有一样可核的地方退化成「那一样必须在场」—— 比直接放行严，比一律拒答松。
 */
export const COOC_MIN_CLASSES = null;

/**
 * 判「缺了一类」的**证据下限**：候选在**绑定的**类上一共命中了几个锚点，低于这个数
 * 就不把「缺一类」算成拒答理由。
 *
 * 为什么需要它（M6 在真库上量出来的硬约束）：合成语料里判别词（服务名）**每篇都写**，
 * 而真库的笔记是**按主题**归档的 —— `project-kestrel-retry-count.md` 的正文是
 * 「# 同步失败的重试次数 / 同步失败后重试 5 次…」，`Kestrel` 只出现在 frontmatter 的
 * `scope`/`id` 里（那不是被索引的正文）。于是「问 Kestrel 的重试次数」这句话里，
 * 服务名这一**类**在答案那一篇里**真的没写**，而答案是对的。
 *
 * 逐题量出来的分界（M6 实测，见 `docs/06-architecture.md §5.5.3`）：
 *  - 真库的三条误拒（`f03`/`c02`/`k04`）：被挡的那篇在另一类上命中 **7 / 8 / 11** 个锚点
 *    —— 它是「整段都在回答这个问题、只是没复述实体名」；
 *  - 合成语料的近邻（`Lumenpath` 篇只写了 `kp00042`）：另一类上只命中 **1** 个锚点
 *    —— 它是「这个知识点号在这篇里出现过」这种薄证据。
 * 所以下限设 2：**证据薄的时候不拿「缺一类」拒答**（那种查询由分数与覆盖率判），
 * 证据厚的时候「缺的那一类」才是真信号。
 *
 * 这个值不是拍的：调高它 = 共现核对在真库上失效（回到 M5 的反相关）；调低到 1
 * = 真库 `recall@5` 从 0.844 掉到 0.750（丢掉 3 条真答案），两边的读数都在
 * `docs/06-architecture.md §5.5.3` 的表里。
 */
export const COOC_MIN_EVIDENCE = 2;

/**
 * 词面类：锚点「长什么样」。`\p{Script=Han}` 之外的字母（拉丁、西里尔……）一律算
 * `latin` 一类 —— 这条机制不负责猜语言，只负责区分「提问里那几样在词面上本来就是
 * 不同的东西」。
 *
 * 为什么单字与桥接词不算锚点（见 {@link anchorTermsOf}），却仍然分得出类：
 * 类只用在**锚点**上，锚点已经过滤过一遍了。
 *
 * @param {string} term
 * @returns {'digit'|'han'|'latin'|'other'}
 */
export function termClass(term) {
  const s = String(term ?? '');
  if (/[0-9]/.test(s)) return 'digit';
  if (/[\p{Script=Han}]/u.test(s)) return 'han';
  if (/\p{Letter}/u.test(s)) return 'latin';
  return 'other';
}

/**
 * 一个词项在这座库里够不够稀有，能不能当锚点。
 *
 * @param {number} df 词项在语料里的文档频次；`0`（库里没有这个词项）**不算锚点** ——
 *   锚点必须是被核对的**在场**的东西，库里没有的词项本来就命中不了任何笔记。
 * @param {number} n  语料篇数
 * @param {number} [maxDfRatio]
 */
export function isAnchorTerm(df, n, maxDfRatio = COOC_ANCHOR_MAX_DF_RATIO) {
  if (!Number.isFinite(df) || df <= 0) return false;
  if (!Number.isFinite(n) || n <= 0) return false;
  if (!Number.isFinite(maxDfRatio) || maxDfRatio <= 0) return maxDfRatio === Infinity;
  return df / n <= maxDfRatio;
}

/**
 * 这条查询的锚点词项集合。
 *
 * 只认**字面词项**（`source === 'term'`，且长度 ≥ 2）：桥接词（`部署` → `deploy`）
 * 与单字是切词的产物，不是用户问的东西，拿它们做核对会把「用户没写的词」偷偷
 * 升级成必要条件。
 *
 * @param {Array<{term:string, weight:number, source:string}>} expansions `expandQuery()` 的结果
 * @param {{postings: Map<string, Array>, n: number}} index 建好的索引（只用 `postings` 数 df）
 * @param {{maxAnchorDfRatio?: number}} [options]
 * @returns {string[]} 锚点词项（保序、去重）
 */
export function anchorTermsOf(expansions, index, options = {}) {
  const maxDfRatio = options.maxAnchorDfRatio ?? COOC_ANCHOR_MAX_DF_RATIO;
  const out = [];
  const seen = new Set();
  for (const e of expansions ?? []) {
    if (e?.source !== 'term') continue;
    const term = String(e.term ?? '');
    if (term.length < 2) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    const df = index?.postings?.get(term)?.length ?? 0;
    if (isAnchorTerm(df, index?.n ?? 0, maxDfRatio)) out.push(term);
  }
  return out;
}

/**
 * 把锚点词项按类归并。
 *
 * @param {string[]} anchors {@link anchorTermsOf} 的结果
 * @returns {Map<string, string[]>} 类 → 该类锚点（保序）
 */
export function groupAnchorsByClass(anchors) {
  const groups = new Map();
  for (const term of anchors ?? []) {
    const cls = termClass(term);
    const list = groups.get(cls);
    if (list) list.push(term);
    else groups.set(cls, [term]);
  }
  return groups;
}

/**
 * 锚点类里，**在库里真的与别的类同篇出现过**的那些类 —— 也就是「参与了某个
 * 复合键」的类。只有它们被绑定（{@link checkCooccurrence} 的 `bindableClasses`）。
 *
 * 为什么绑定条件不是「这个类库里有没有」而是「它有没有和别的类写在同一篇里」：
 * 前者会把「用户问的那样东西库里写在别处、只是这一篇没写」也判成缺失，于是
 * 「`acme` 有构建命令那篇、部署步骤那篇没写产品名」这种**部分匹配**被一并拒掉。
 * 后者问的是更准的一件事：**这一样东西在这座库里到底参不参与组合**。
 *
 *  - 服务名 `Lumenpath` 与知识点号 `kp00042` 在库里同篇出现过（有笔记写
 *    「Lumenpath 这边 kp00042 的…」）→ 这一对是复合键 → 服务名这一类**绑定**，
 *    于是「某篇只有 kp00042、没有 Lumenpath」确实缺了一样，该拒答。
 *  - `acme` / `widget` 在库里从来没和别的锚点类同篇过（它们只出现在讲构建命令
 *    的那一篇）→ 这个类在这座库里不参与组合 → **不绑定**，于是「部署步骤那篇
 *    没写产品名」不算缺样，交给覆盖率与分数去判。
 *
 * 口径是「库级」的（看全库），不是「题级」的（不看这道题答没答得出来）——
 * 用一个类**在这座库里的用法**决定它是否可核，是可以在语料上验证的客观事实；
 * 而按题目逐个决定绑定，等于拿答案去调判据。
 *
 * 复杂度：O(全库词项数) 一次，按索引缓存（`WeakMap`）—— 同一次 `scoreDocs` 里
 * 每条候选都要问同一件事，不缓存会变成 O(n²)。
 *
 * @param {Map<string, string[]>} groups {@link groupAnchorsByClass} 的结果
 * @param {{postings: Map<string, Array>}} index
 * @returns {string[]} 参与复合键、因而被绑定的类（保序）
 */
/**
 * 库里有这个词项的锚点类（`df > 0`）—— **不问它是不是好锚点**。
 *
 * 与 {@link cooccurringClasses} 的分工是 M6 定下来的，两者意义完全不同：
 *  - 本函数回答「这个词项在这座库里存在吗」→ 存在就说明它**可被问到**，
 *    于是「候选篇里没有它」就是真的没写（`checkCooccurrence` 的 `tracked` 用它）；
 *  - `cooccurringClasses` 回答「它够不够稀罕、能不能当核对点」→ 只用来算
 *    稀有度相关的读数，**不再**决定要不要核这一类。
 * 把两者混成一个（M6 第一版）会让「实体名太常见」被读成「这类不用核」，
 * 于是「另一个服务持有同一个知识点号」的近邻全部被放行。
 */
export function presentClasses(groups, index) {
  const out = [];
  for (const [cls, terms] of groups ?? []) {
    if (terms.some((t) => (index?.postings?.get(t)?.length ?? 0) > 0)) out.push(cls);
  }
  return out;
}

export function cooccurringClasses(groups, index, options = {}) {
  const maxDfRatio = options.maxAnchorDfRatio ?? COOC_ANCHOR_MAX_DF_RATIO;
  const terms = [];
  for (const list of groups.values()) for (const t of list) terms.push(t);
  if (terms.length === 0) return [];
  const cls = new Map(terms.map((t) => [t, termClass(t)]));
  const df = new Map(terms.map((t) => [t, index?.postings?.get(t)?.length ?? 0]));
  // 不参与组合的类：库里没有这个词项（df = 0），或它太常见、当不了核对点。
  const bindable = new Set(
    terms.filter((t) => isAnchorTerm(df.get(t), index?.n ?? 0, maxDfRatio)).map((t) => cls.get(t)),
  );
  if (bindable.size < 2) return [];
  const cached = cooccurMemo.get(index);
  const pairs = cached === undefined ? collectCooccurringPairs(index, new Set(terms), cls) : cached;
  const out = [];
  for (const c of groups.keys()) {
    if (bindable.has(c) && pairs.has(c)) out.push(c);
  }
  return out;
}

/** 索引 → 参与复合键的类集合（`cooccurringClasses` 的缓存槽）。 */
const cooccurMemo = new WeakMap();

/**
 * 扫一遍全库：哪些锚点类与**别的**锚点类在至少一篇笔记里同现过。
 *
 * 为什么不用 `postings` 直接两两求交：那要按词项对做集合运算，锚点多时是 O(m²·n)。
 * 这里反过来从**笔记**走：把 postings 归拢成「每篇笔记的词项集合」，一篇一篇看
 * 它同时含哪些类 —— O(全库词项数) 一遍过完，而且读得懂。
 */
function collectCooccurringPairs(index, anchors, cls) {
  const perNote = new Map();
  for (const term of anchors) {
    for (const [docIndex] of index?.postings?.get(term) ?? []) {
      let set = perNote.get(docIndex);
      if (!set) {
        set = new Set();
        perNote.set(docIndex, set);
      }
      set.add(cls.get(term));
    }
  }
  const pairs = new Set();
  for (const set of perNote.values()) {
    if (set.size < 2) continue;
    for (const c of set) pairs.add(c);
  }
  cooccurMemo.set(index, pairs);
  return pairs;
}

/**
 * 只问「库里有没有这个词项」的旧口径。**保留**是因为它读起来更直白，也用在
 * 「这个词到底算不算锚点」的自检里；判定一律走 {@link cooccurringClasses}。
 *
 * @param {Map<string, string[]>} groups
 * @param {Array<{term:string, source:string}>} expansions
 * @param {{postings: Map<string, Array>}} index
 */
export function bindableClasses(groups, expansions, index, options = {}) {
  const maxDfRatio = options.maxAnchorDfRatio ?? COOC_ANCHOR_MAX_DF_RATIO;
  const out = [];
  for (const [cls, terms] of groups ?? []) {
    if (terms.some((t) => isAnchorTerm(index?.postings?.get(t)?.length ?? 0, index?.n ?? 0, maxDfRatio))) {
      out.push(cls);
    }
  }
  return out;
}

/**
 * 这条查询要核几**类**同篇共现。
 *
 * - `anchorClassCount === 0` → 0 = **不构成证据**，一律放行。拿「没有锚点」去拒答
 *   会把「库里没有稀有词项」和「事实没写过」混成一个结论（那是
 *   `no_informative_term` 那条闸的事）。
 * - 否则 = **可核的类数**，也就是「每一类都要在这一篇里命中」。
 *
 * **缺省是「每一类都要命中」，不是「凑够 min(2, 类数)」**（M6 的第二次修正）。
 * 为什么「凑够两类」不够：绑定是对称的，而被问的两半**不对称**。
 *
 * 实证（50 篇档，`Quartzwell 的温升步幅 kp00002 是多少？`）：
 * - `温升/升步/步幅`（df=4）、`kp00002`（df=2）都算锚点，`quartzwell`（df=17/50=0.34）
 *   按 `maxAnchorDfRatio` 也算锚点；
 * - 但这座库里**没有任何一篇**把 `quartzwell` 和别的锚点类写在一起（kp00002 属于
 *   Lumenpath/Tidalmark 两家）—— 于是 `cooccurringClasses` 只钉住 `han`+`digit`；
 * - `min(2, 2) = 2` 的口径下，`lumenpath-kp00002`「命中 han+digit 两类」就过了，
 *   而那篇一个字都没提 Quartzwell（问的是另一个服务）。
 *
 * 关键在那一步 `Math.min(required, boundCount)`：它把「有一类没钉住」悄悄
 * 换成了「少核一类也行」。**可核的类必须按「库里认不认识这个词项」数，不能按
 * 「它是不是好锚点」数** —— 一个词项在库里存在（`df > 0`）就说明它可被问到，
 * 它没出现在候选里就是「这一篇没写它」，这正是要拒答的情形。
 *
 * 反过来要求「每一类都命中」时，真答案不会受伤：答案篇里两半都在，
 * 而实体名往往写在**文件名**里（`project-kestrel-retry-count.md` 的正文是
 * 「同步失败后重试 5 次」，`Kestrel` 只在 id 里）—— 这正是 `bm25.js` 的
 * `identityTerms` 要参与核对的原因，也是真库 `recall@5` 能守住 0.844 的原因。
 *
 * `minClasses` 保留成**更严**的方向（要核的类数不少于它）：放宽它等于把上面
 * 那条不对称漏洞重新打开。
 */
export function requiredCooccurrences(anchorClassCount, minClasses = COOC_MIN_CLASSES) {
  if (!Number.isFinite(anchorClassCount) || anchorClassCount <= 0) return 0;
  if (Number.isFinite(minClasses) && minClasses > 0) {
    return Math.max(Math.floor(minClasses), anchorClassCount);
  }
  return anchorClassCount;
}

/**
 * 对一条候选做共现核对。
 *
 * @param {Array<{term:string, ...}>} hitTerms 这条候选**命中的词项**（`scoreDocs` 的 `entry.terms`；
 *   同一词项可能因为字面/桥接两条来源各出现一次，这里按词项去重）
 * @param {Map<string, string[]>|string[]} anchors 查询的锚点（{@link groupAnchorsByClass} 的结果，
 *   或裸词项数组 —— 后者会就地分组）
 * @param {number} required 需要几类同篇共现（{@link requiredCooccurrences}）
 * @param {{bindableClasses?: string[]}} [options] 不绑定的类（库里一处都没写过的那种）
 * @returns {{ok:boolean, count:number, required:number, missing:string[], classes:Object, matched:string[]}}
 *   `missing` 是**绑定了却没命中**的类；`classes` 是逐类读数（审计用）。
 */
export function checkCooccurrence(hitTerms, anchors, required, options = {}) {
  const groups = anchors instanceof Map ? anchors : groupAnchorsByClass(anchors ?? []);
  if (groups.size === 0 || required <= 0) {
    return { ok: true, count: 0, required: 0, bound: 0, evidence: 0, missing: [], absent: [], forgiven: [], classes: {}, matched: [] };
  }
  const bind = options.bindableClasses ? new Set(options.bindableClasses) : null;
  // `known` = 库里有这个词项的类（`df > 0`）。**没写的类 vs 太常见的类**必须分开：
  //  - 不在 `known` 里：库里一次都没提过 → 不算「这一篇漏了它」，跳过不计数
  //    （否则每一句带新词的话都会被拒）；
  //  - 在 `known` 里、却不在 `bind` 里：这个词项到处都是、当不了核对点，
  //    但它**确实存在**，所以它在这篇里没出现就是真没写 —— 照样计数、照样算
  //    「缺这一类」（`requiredCooccurrences` 的注释里那半个组合就是这种情形）。
  const known = options.knownClasses ? new Set(options.knownClasses) : bind;
  const minEvidence = Number.isFinite(options.minEvidence) ? options.minEvidence : COOC_MIN_EVIDENCE;
  const present = new Set();
  for (const t of hitTerms ?? []) present.add(String(t?.term ?? ''));
  // **笔记身份**（文件名 / 标题 / 标签 / 别名）也算「这一篇写了它」。
  //
  // 为什么身份要算：这条核对问的是「问题里的实体写没写在**这一篇**里」，
  // 而笔记的身份字段本身就是「这篇在写谁」。真库的笔记按主题归档，正文常常
  // 不复述实体名（`project-kestrel-retry-count.md` 的正文是「同步失败后重试 5 次」，
  // `Kestrel` 只在文件名里）—— 只核正文会把**正确的答案**判成「没写实体」。
  // M6 实测：只核正文时真库 `recall@5` 0.844 → 0.750（丢 3 条真答案），
  // 而正确拒答率一点没涨；身份参与之后两边同时成立。
  for (const t of options.identityTerms ?? []) present.add(String(t));
  const classes = {};
  const absent = [];
  const missing = [];
  const matched = [];
  let count = 0;
  let boundCount = 0;
  let evidence = 0;
  for (const [cls, terms] of groups) {
    const hit = terms.filter((t) => present.has(t));
    // 只有**绑定**的类才参与判定：库里一处都没写过、或从没和别类同篇过的那一类
    // 不构成「同一篇里少写了一样」（理由见文件头与 `cooccurringClasses`）。
    const bound = bind ? bind.has(cls) : true;
    const tracked = known ? known.has(cls) : bound;
    classes[cls] = { hit: hit.length, total: terms.length, bound, tracked };
    if (!tracked) continue;
    boundCount += 1;
    evidence += hit.length;
    if (hit.length === 0) {
      absent.push(cls);
      continue;
    }
    count += 1;
    matched.push(...hit);
  }
  // 证据下限：命中的锚点太少时，「缺一类」是薄证据，不拿来拒答（见 `COOC_MIN_EVIDENCE`）。
  // `forgiven` 与 `missing` 互斥：同一件事不能既「放过」又「算缺」，否则
  // `count >= required` 会把刚放过的类又收回去，下限等于没生效（M6 踩过一次）。
  const forgiven = evidence >= minEvidence ? [] : [...absent];
  if (evidence >= minEvidence) missing.push(...absent);
  // 判定只要求**没被放过**的那些类：放过一类，要求就少一类。
  const requiredNow = Math.max(1, Math.min(required, boundCount - forgiven.length));
  return {
    ok: missing.length === 0 && count >= requiredNow,
    count,
    required: requiredNow,
    requiredRaw: required,
    bound: boundCount,
    evidence,
    minEvidence,
    missing,
    absent,
    forgiven,
    classes,
    matched,
  };
}
