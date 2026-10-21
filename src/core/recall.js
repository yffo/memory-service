/**
 * 召回主流程（`06-architecture.md §5.2`、§9 的 `recall`）。
 *
 * 形状：**候选过滤 → BM25 打分 → 拒答判定 → 预算裁剪**，四步全确定性、零模型调用。
 * 这个模块**不碰文件系统**（`core` 零依赖的纪律）：输入是 `scanStore()` 的结果。
 *
 * 关于「拒答」的三个理由（§9 的 `why_not` 枚举），本实现只产出能确定性判定的那些：
 *  - `top_score_below_threshold`：最高分都没过热阈值 → 真的没有证据；
 *  - `only_external_low_trust`：命中的全是 external 低信任内容 → 有证据但不该当事实用；
 *  - `all_hits_expired`：命中的都在 as-of 视角已失效。
 *
 * **拒答时不注入任何 items**（包括核心档）。这是 `§5.2` 那句「先丢 episodic、再丢低
 * trust、最后才丢 core」的反面：裁剪序管的是**有证据时**先丢谁，不是「拒答时偷渡核心档」。
 * 拒答路径是一等公民，偷渡会让「问了 A 答了 B 的偏好」重新出现。
 */
import { createHash } from 'node:crypto';
import { expandQuery } from './tokenize.js';
import { finiteOr } from '../util/text.js';
import { buildIndex, scoreDocs, aggregateByNote, sectionsOf } from './bm25.js';
import { scoreNote, inDefaultSurface, isValidAt, isSince, lifecycleOf, asOfTime } from './score.js';
import { selectBudget, budgetOf, costOf } from './select.js';

/**
 * 默认阈值。**取值的依据**：relevance 是 BM25 饱和度 `s/(s+K)`，K=1.5；
 * 单跳事实题（查询词几乎逐字出现在标题/正文）实测落 0.35–0.6，
 * 而「只有一个常见词碰上」的噪声命中落 0.05–0.12。门槛取两者之间：
 *  - `minRelevance`（保底）：低于它 -- 不作为证据，进 `nearest` 供人放宽；
 *  - `minScore`（展示）：三因子合成后的门槛，比 relevance 宽，因为它还叠加了
 *    重要度与新鲜度——一条刚写的 core 笔记可以靠这两项过线。
 *
 * 这两个数是**配置项**（`tabellio search --min-relevance`），因为 `02-evaluation.md §6`
 * 明确禁止在跑分集上调参：要动就动配置，别动默认值。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  minRelevance: 0.15,
  minScore: 0.18,
  // 覆盖率闸：拒答的**默认启用**方式，但它只在「这 56 题 + 单域语料」这个口径上
  // 同时满足 recall@5 ≥ 0.80 与拒答 ≥ 0.75（0.6：0.861 / 1.00）。2026-10-22 用
  // 5 份模拟用户语料（151 篇、5 个领域、120 查询、80 条真模型作答）复测到它的
  // 结构性代价：
  //  - 命中率：0.6 → 53.8%，0.33 → 80.0%，0.2 → 85.0%；gold 排第 1 也会被排除
  //    （pm-product-q06 的 gold coverage 0.2435，输给了 coverage 0.378 的无关笔记）；
  //  - 端到端（插件形态，带 judge，120 题）：0.33 → 63.7%，0.2 → 76.3%；
  //  - AUC：maxCov 0.851 看着不差，但可答/不可答两组分布重叠，任何阈值都在
  //    「多拒 1 题」换「少答 5 题」。
  // 结论：这个闸是**面向问答的拒答闸**，不是通用检索的准入闸。默认值保持 0.6
  // （核心自己的验收口径依赖它）；自动注入/高召回场景由调用方显式传低值
  // （插件默认 0.2），需要「宁拒勿答」时显式抬高。别把它当成一遍就能定死的常量。
  minCoverage: 0.6,
  nearestLimit: 5,
});

/** `search` 的默认预算：与架构文档 `recall({ budget_tokens = 500 })` 一致。 */
export const DEFAULT_TOKENS = 500;

/** 语料达到这个篇数，覆盖率闸才按 `minCoverage` 全量生效（见 `coverageGate` 处注释）。 */
export const COVERAGE_FULL_CORPUS = 20;
/** 小语料（< `COVERAGE_FULL_CORPUS` 篇）时的保底覆盖率闸；不会把调用方的闸调严。 */
export const COVERAGE_SMALL_CORPUS_GATE = 0.25;

/**
 * 索引 memo：`buildIndex` 是纯函数（同样的 docs → 同样的索引），但每召回一次要
 * 重新分词 1423 段（本机实测 92ms，占一次召回 161ms 的一半以上）。
 * 这里按 **docs 内容本身** 的 sha1 复用结果：
 *  - 键是内容而不是路径/时间戳 —— 笔记改了内容，键就变，不可能读到旧索引；
 *  - 上限 `INDEX_MEMO_MAX` 份，LRU 淘汰（一份 1423 段索引序列化后约 1.9MB）；
 *  - 哈希 2MB 正文实测 3.2ms，比 92ms 的分词便宜一个数量级。
 *
 * 为什么不拿 `(id, mtime, size)` 当键：同一毫秒内两次写会让 mtime 相同，
 * 改字不改长会让 size 相同 —— 两种都会变成「内容变了但键没变」。
 */
const INDEX_MEMO_MAX = 3;
const indexMemo = new Map();

function fingerprintDocs(docs) {
  const hash = createHash('sha1');
  for (const doc of docs) {
    // 桶字段全进指纹：`id/section/title/body/tags/kind/trust/aliases` 里有任何一个
    // 参与打分的字段变了，索引就必须重建（`identityTerms` 读 title/tags/aliases）。
    hash.update(String(doc.id ?? ''));
    hash.update('\u0000');
    hash.update(String(doc.section ?? 0));
    hash.update('\u0000');
    hash.update(String(doc.title ?? ''));
    hash.update('\u0000');
    hash.update(String(doc.body ?? ''));
    hash.update('\u0000');
    hash.update((doc.tags ?? []).join(','));
    hash.update('\u0000');
    hash.update((doc.aliases ?? []).join(','));
    hash.update('\u0000');
    hash.update(String(doc.kind ?? ''));
    hash.update('\u0000');
    hash.update(String(doc.trust ?? ''));
    hash.update('\u0001');
  }
  return hash.digest('hex');
}

function memoIndex(docs) {
  const key = fingerprintDocs(docs);
  const hit = indexMemo.get(key);
  if (hit) {
    // LRU 触碰：先删后插，淘汰时丢掉的是最久没被用过的那份。
    indexMemo.delete(key);
    indexMemo.set(key, hit);
    return hit;
  }
  const index = buildIndex(docs);
  indexMemo.set(key, index);
  while (indexMemo.size > INDEX_MEMO_MAX) {
    indexMemo.delete(indexMemo.keys().next().value);
  }
  return index;
}

/** 清空索引 memo（只用在上限/内存相关的手工诊断里；正常召回不需要调用）。 */
export function clearIndexMemo() {
  indexMemo.clear();
}

function normalizeList(value) {
  if (value === undefined || value === null) return null;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = arr.map((v) => String(v).trim()).filter((v) => v !== '');
  return cleaned.length ? cleaned : null;
}

/**
 * 过滤候选：**先把「不可能出现在答案里」的笔记剔掉，再打分**。
 *
 * 为什么过滤要在打分之前：BM25 的 `avgLen`/`df` 是按语料算的，把不该出现的文档
 * 也算进语料会污染归一化（as-of 查询尤其明显：历史快照的语料不等于今天的语料）。
 */
export function filterNotes(entries, options = {}) {
  // 别名一律接住：`trust` / `trusts`、`kind` / `kinds`、`scope` / `scopes`、`asOf` / `asOfMs`。
  // 这里曾经只认复数拼写，于是调用方传单数名时**过滤条件被静默忽略** ——
  // 症状是「我明明只问了 user_stated，它把 external 也返回给我了」，
  // 正是 03-hosts 里点名会咬人的「tag filter silently ignored」那一类。
  const kinds = normalizeList(options.kinds ?? options.kind);
  const trusts = normalizeList(options.trusts ?? options.trust);
  const scopes = normalizeList(options.scopes ?? options.scope);
  const nowMsValue = options.nowMs ?? Date.now();
  // 默认的「有效时点」= 现在。这不是可选的额外过滤，而是**语义纠正**：
  // 没有 as-of 时「这条现在还算数吗」的答案就是「现在」。
  // 这里原来是 null（= 不过滤），后果是**过期笔记在默认视图里照样返回**，
  // 于是 `all_hits_expired` 这条拒答理由永远不可能出现 —— 一个写在 §5.3 里的
  // 一等公民在代码里是死代码。要历史视图就显式传 as-of（见下），
  // 或者传 `includeExpired: true`（`explain` / 审计要用）。
  // `asOf` 是给人用的写法（字符串/日期），`asOfMs` 是内部口径；两个都要认。
  // 原来只认 `asOfMs`，而调用方（含 `recall` 自己）传的是 `asOf`：
  // 于是 as-of 被**静默忽略**、一律按「现在」判，历史视图永远查不到东西。
  const explicitAsOf = options.asOfMs ?? asOfTime(options.asOf);
  const atMs = explicitAsOf ?? (options.includeExpired ? null : nowMsValue);
  const sinceMs = options.sinceMs ?? null;
  // `new Set(null)` 是**空 Set**，而空 Set 是真值 —— `if (wanted && ...)` 会
  // 把每一条都当「不在白名单里」丢掉且不记账。这类「看着像有过滤其实全丢」的写法
  // 在这里被禁掉：只在真的有白名单时才用 Set。
  const wantedList = normalizeList(options.ids);
  const wanted = wantedList ? new Set(wantedList) : null;

  const kept = [];
  const skipped = { kind_mismatch: 0, trust_mismatch: 0, scope_mismatch: 0, expired_at_as_of: 0, malformed: 0, not_since: 0, archived_draft: 0 };
  for (const entry of entries) {
    const note = entry.note;
    if (!note) {
      skipped.malformed += 1;
      continue;
    }
    if (wanted && !wanted.has(entry.id)) continue;
    if (kinds && !kinds.includes(note.kind)) {
      skipped.kind_mismatch += 1;
      continue;
    }
    if (trusts && !trusts.includes(note.trust)) {
      skipped.trust_mismatch += 1;
      continue;
    }
    if (scopes && !scopes.includes(note.scope)) {
      skipped.scope_mismatch += 1;
      continue;
    }
    // **只按显式 status 排除 draft/archived**，不用 `inDefaultSurface()`：
    // 后者内部走 `lifecycleOf()`，会把「valid_to 已过」也推成 superseded 一并排掉，
    // 于是历史视图（as-of 在过去）里那些**当时正有效**的笔记也会被排除 ——
    // 症状是「查历史永远查不到东西」。有效性问题由下面的 `isValidAt(note, atMs)`
    // 统一负责：默认 atMs = 现在，历史视图给 as-of。
    if (note.status === 'draft' || note.status === 'archived') {
      skipped.archived_draft += 1;
      continue;
    }
    if (!isValidAt(note, atMs)) {
      skipped.expired_at_as_of += 1;
      continue;
    }
    if (!isSince(note, sinceMs)) {
      skipped.not_since += 1;
      continue;
    }
    kept.push(entry);
  }
  return { kept, skipped };
}

/** 把笔记展开成可检索记录（切桶交给 `bm25.js` 的 `sectionsOf`，口径只有一处）。 */
function toDocs(entries) {
  const docs = [];
  for (const entry of entries) {
    const note = entry.note;
    const sections = sectionsOf({ id: String(entry.id), title: entry.title ?? '', body: entry.body ?? '' });
    for (const s of sections) {
      docs.push({
        // `id` 必须是**笔记 id**（不带 `#section`）：索引的 `meta.id` 一路传到
        // `aggregateByNote()` 的返回值，调用方拿它去查 `entryById`。
        // 这里曾经写成 `${s.id}#${s.section}`，导致每条命中都查不到 entry、
        // 被静默丢弃 —— 症状是「写入成功但永远搜不到」，且 `candidates:0` 看不出原因。
        id: s.id,
        section: s.section,
        title: s.title,
        body: s.body,
        tags: note.tags ?? [],
        // aliases 是作者显式给的同义说法；不传进来，身份核对（共现）就看不到它。
        // 它只进 identityTerms，不进 postings、不参与打分，也不改 entry 的对外形状。
        aliases: note.aliases ?? [],
        kind: note.kind,
        trust: note.trust,
      });
    }
  }
  return docs;
}

/**
 * 召回。
 *
 * @param {object} input
 * @param {Array} input.entries `scanStore().notes`
 * @param {string} input.query
 * @param {object} [input.options] `{budget, kinds, trusts, scope, asOf, since, nowMs,
 *                                  minRelevance, minScore, minCoverage, explain, includeCore}`
 * @returns {object} `06-architecture.md §9` 的 `recall` 形状 + 评测器需要的字段
 */
export function recall({ entries = [], query = '', options = {} } = {}) {
  const nowMsValue = options.nowMs ?? Date.now();
  const thresholds = {
    minRelevance: finiteOr(options.minRelevance, DEFAULT_THRESHOLDS.minRelevance),
    minScore: finiteOr(options.minScore, DEFAULT_THRESHOLDS.minScore),
    minCoverage: finiteOr(options.minCoverage, DEFAULT_THRESHOLDS.minCoverage),
    nearestLimit: finiteOr(options.nearestLimit, DEFAULT_THRESHOLDS.nearestLimit),
  };
  // **两种口径**（0.1.13）：
  //  - `refuse !== false`（QA 口径，默认）：覆盖率闸参与准入，没够格的证据就拒答；
  //  - `refuse === false`（检索口径）：覆盖率不参与准入，只有「一个信息词都没有」
  //    （`no_informative_term`）这种**硬拒答**才拒。宿主自己负责判断要不要答
  //    （插件用 judge + intent gate 做这件事）。
  // 分开的理由是实测的：同一个库上覆盖率闸从 0.6 放到 0.2，56 题 recall@5
  // 0.861 → 1.000，但零模型 correct_refusal_rate 0.75 → 0.15 —— 一个常量
  // 不可能同时服务「问答要敢拒」和「检索要敢给」两个目标。
  const refuseOnMiss = options.refuse !== false;
  const budgetInput = { ...(options.budget ?? {}) };
  if (budgetInput.maxTokens === undefined && options.budgetTokens !== undefined) {
    budgetInput.maxTokens = options.budgetTokens;
  }
  const budget = budgetOf({ budget: budgetInput });

  const { kept, skipped } = filterNotes(entries, { ...options, nowMs: nowMsValue });
  // **两份索引**，用途不同：
  //  - `index` 只装「够格出现在结果里」的笔记（分数、桶都在它上面算）；
  //  - `refIndex` 装全库，**只用来算覆盖率的 idf 分母**。
  // 合成一份会出事：过滤掉一批过期笔记后 idf 变了，同一句查询的覆盖率跟着变，
  // 于是「昨天答得出来、今天同一句拒答」。检索结果可以随生命周期变，
  // 但「这句话库里到底有没有讲到」不该随之漂移。
  const index = memoIndex(toDocs(kept));
  const filtered = kept.length !== entries.length;
  const refIndex = filtered ? memoIndex(toDocs(entries)) : index;
  const expansions = expandQuery(query);
  // **组合级共现核对**（`cooccurrence.js`）：`scoreDocs` 会把每条候选命中了几个
  // 「稀有锚点」标在桶上，这里按笔记聚合后当**准入条件**用。参数从 `options` 透传
  // （`cooccurrence: false` 可关掉；装置要拿它当扫描轴）。
  const scoredDocs = scoreDocs(index, expansions, {
    referenceIndex: refIndex,
    cooccurrence: options.cooccurrence,
    maxAnchorDfRatio: options.maxAnchorDfRatio,
    minClasses: options.minClasses,
  });
  // 查询侧的口径（哪些词项算证据、分母塌没塌）。挂在数组的不可枚举属性上，
  // 形状仍是数组（见 `bm25.js` 的 `attachQueryInfo`）。
  const queryInfo = scoredDocs.queryInfo ?? {
    informativeTerms: [],
    informativeRatio: null,
    informativeGateEnabled: false,
    queryTerms: 0,
    queryMass: 0,
  };
  const informativityGateOn = queryInfo.informativeGateEnabled !== false && (queryInfo.informativeRatio ?? 0) > 0;
  const byNote = aggregateByNote(scoredDocs, index);

  const entryById = new Map(kept.map((e) => [String(e.id), e]));

  // 「最接近的几条」用**不过停用词闸**的原始匹配单独算一遍。
  //
  // 为什么不能直接复用 `scored`：闸门生效时（查询里全是 `的/是/什` 这类碎片）
  // `scored` 是空的，`nearest` 也就是空的 —— 于是拒答变成「我也不知道库里有什么」，
  // 人没法据此改词或补记忆。这两件事必须分开算：
  // **够不够格当证据**走闸门，**谁离得最近**走原始分数。
  const nearestHits = aggregateByNote(
    scoreDocs(index, expansions, { keepCommon: true, referenceIndex: refIndex }),
    index,
  );
  const nearest = nearestHits
    .slice(0, thresholds.nearestLimit)
    .map((hit) => {
        const bd = scoreNote({ note: entryById.get(hit.id)?.note ?? {}, bm25: hit.score, coverage: hit.coverage ?? null, nowMs: nowMsValue });
      return { id: hit.id, score: round(bd.total), relevance: round(bd.relevance), why: bd.why };
    });

  const scored = [];
  // 组合级共现核对的结果（`{id, cooc}` 列表）。这两个集合只用于**理由归因**，
  // 不参与打分（分数口径不变是硬要求：改分数就会连带动到既有 1321 篇库的
  // `recall@5 = 0.844` 基线）。
  const coocFailed = [];
  let coocChecked = 0;
  // 诊断用的共现读数（**一处**格式化，两条返回路径共用）。
  const coocReport = (c) => ({
    required: c.required,
    requiredRaw: c.requiredRaw,
    count: c.count,
    evidence: c.evidence,
    minEvidence: c.minEvidence,
    ok: c.ok,
    missing: c.missing,
    absent: c.absent,
    forgiven: c.forgiven,
    matched: c.matched,
    classes: c.classes,
  });
  for (const hit of byNote) {
    const entry = entryById.get(hit.id);
    if (!entry) continue;
    const breakdown = scoreNote({ note: entry.note, bm25: hit.score, coverage: hit.coverage ?? null, nowMs: nowMsValue });
    // **组合级共现闸**（`cooccurrence.js`）：`required > 0` 才代表这次查询里
    // 存在「可被问的组合」，也才核得动；`required === 0`（查询里一个库里可核的
    // 稀有类都没有）时 `cooc` 恒为 null（放行）—— 那种查询这条机制不构成证据。
    // 判定的**唯一副本**在 `cooccurrence.js`（`aggregateByNote` 只搬运每桶的读数）。
    // 这里只挑「这篇笔记命中的最多类的那个桶」的判定，别在这里重算一遍 ——
    // 重算就会与 `minEvidence`/`requiredNow` 那几处口径漂开（M6 踩过一次）。
    const cooc = hit.coocVerdict ?? null;
    if (cooc) {
      coocChecked += 1;
      if (!cooc.ok) coocFailed.push({ id: hit.id, cooc });
    }
    scored.push({
      id: hit.id,
      entry,
      note: entry.note,
      title: entry.title,
      body: entry.body,
      sections: hit.sections.map((di) => index.metas[di]?.section ?? 0),
      score: breakdown.total,
      relevance: breakdown.relevance,
      coverage: hit.coverage ?? null,
      breakdown,
      why: breakdown.why,
      cooc,
    });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  // 拒答判定。
  //
  // **有没有证据**只看 `relevance`（词法命中饱和度），**排序**才用三因子 `score`。
  // 这条界线是必须的：`score` 里 30% 是 importance、20% 是 recency，于是一条
  // `kind: semantic, trust: user_stated` 的「重要」笔记哪怕**一个词都没命中**，
  // 也能拿到 0.48 的总分、轻松越过 minScore=0.18 —— 症状就是「问一个库里完全
  // 不存在的东西，它一本正经地给你一条最像的」，而这恰恰是 02-evaluation.md
  // 判据 1 里的 `correct_refusal_rate` 要抓的东西。所以必须额外要求「确实被命中」。
  const top = scored[0] ?? null;
  // 覆盖率的守卫写成「有限数才能当阈值」，理由和 minScore 一样：
  // 传 null 的人本意是「用默认」，不是「把这个闸关掉」。
  const coverGateFull = Number.isFinite(thresholds.minCoverage) ? thresholds.minCoverage : 0;
  // 传 `null` 表示「用默认」，不是「把这个闸关掉」—— 与 `minScore` 那条注释同一个理由。
  // `null` 在 `finiteOr` 里会落回默认值，所以这里拿不到 `null`；真正要关闸请传 0。
  // 语料小到什么程度算「小」：20 篇。低于它时 idf 本身就没什么统计意义，
  // 覆盖率的分母会被「库里恰好只有 5 篇」放大成噪声，所以改用保底闸。
  // 小语料切换点本身也是可配的：否则「全量闸」这条路径在小语料上永远测不到，
  // 只能靠一个专门为测试编出来的 20 篇语料去撞。
  const fullCorpusAt = finiteOr(options.coverageFullCorpus, COVERAGE_FULL_CORPUS);
  // 小语料用保底闸，但不能比调用方给的闸更严：`minCoverage: 0` 是「关掉」，
  // 不该在 15 篇的库上被 0.25 重新打开。
  const coverGate = kept.length >= fullCorpusAt
    ? coverGateFull
    : Math.min(COVERAGE_SMALL_CORPUS_GATE, coverGateFull);
  const eligible = scored.filter(
    (s) =>
      s.relevance > 0 &&
      s.relevance >= thresholds.minRelevance &&
      s.score >= thresholds.minScore &&
      // **覆盖率闸**：查询的信息量（按 idf×词权重算）里，这篇至少得覆盖 `minCoverage`。
      //
      // 0.6 的取值来自 50 篇合成语料（8 条拒答题 0.34–0.64、32 条可答题 0.48–1.00）。
      // 2026-10-22 的复测（151 篇、5 领域）证明它是**问答口径的拒答闸**：
      // 覆盖率高的笔记未必答得上；gold 排第 1 也可能 coverage 只有 0.24 而被排除。
      // 换场景（自动注入、CLI 高召回）就显式传低值，别指望一个常量同时服务两种口径。
      // 覆盖率对**笔记**取各段的最大值（一篇长笔记有一段正面回答了就算数）。
      (!refuseOnMiss || !Number.isFinite(s.coverage) || s.coverage >= coverGate) &&
      // **组合级共现闸**（`cooccurrence.js`）：光「覆盖率够」还不够 ——
      // 覆盖率的分母里每个证据词只算一次，所以「提问的实体」和「被问的知识点号」
      // 分别出现在**两篇不同的笔记**里时，两篇的覆盖率都能顶到 1.000，
      // 而它们谁也没回答这个问题。这一条要求这些词在**同一篇**里共现。
      //
      // 为什么放在覆盖率之后而不是最前：`cooc` 只在 `required > 0` 时不为 null，
      // 而 `required > 0` 已经蕴含「查询里有稀有词」，和覆盖率的判别范围重叠；
      // 放在这里让拒绝理由的分支顺序保持「分数 → 覆盖率 → 共现」，
      // 归因时先报更基本的那条。
      (!s.cooc || s.cooc.ok),
  );
  const ignored = scored.filter((s) => !eligible.includes(s));
  // 「只有外部低信任命中」也走拒答（§5.3 的四类理由之一）。
  //
  // 这条规则是**默认开**的，因为不实现它 `only_external_low_trust` 就是死代码，
  // 而 external 内容的语义恰恰是「不确定来源、不能当事实用」。注意它只作用于
  // **pull（检索命中）**：caller 用 `kinds` 显式点名的检索也照此办理，
  // 而 push 路径（核心档）本来就不在这一段里。
  const onlyExternal =
    eligible.length > 0 && eligible.every((s) => s.note.trust === 'external');
  // **分母退化也要拒答，理由单独报**（`bm25.js` 的 `INFORMATIVE_DF_RATIO`）。
  //
  // 这种情形下 `eligible` 本来就是空的（每篇覆盖率都是 0），所以**判定结果**与
  // 「分数不够」一致，但**理由**完全不同，必须分开报：
  //  - `top_score_below_threshold` → 库里有相关的，是分数没够，换词/放宽阈值可能有救；
  //  - `no_informative_term`      → 这句话里的词在这座库里区分不出任何东西
  //    （只剩下 `什么`/`默认`/`里的` 这种满库皆是的词项）。换阈值、补记忆都没用，
  //    得换一种问法。实测：「量子色动力学里的胶子禁闭」在真实库上只剩 `里的`（df 96）
  //    一个词项，92 篇无关笔记覆盖率 1.0 —— 报成「分数不够」会让人一直去调阈值。
  const noInformativeTerm = informativityGateOn && queryInfo.informativeTerms.length === 0;
  // 检索口径下只剩硬拒答：库里一个信息词都认不出来。`only_external_low_trust`
  // 是「有证据但不可信」，交给宿主判断（它可能就是要原文链接）。
  const mustRefuse = refuseOnMiss
    ? eligible.length === 0 || onlyExternal || noInformativeTerm
    : noInformativeTerm;
  if (mustRefuse) {
    // **共现失败单独报**：有候选过了覆盖率闸，却因为「被问的那几样东西不在**同一篇**里
    // 共现」全被挡下 —— 这和「分数不够」是完全不同的诊断出口。前者是「库里有相关笔记
    // 但没回答这个组合」，换阈值没用、补一篇对的笔记才有用。
    //
    // 只在**真凭实据**时才报这条：候选里存在一篇「被问的每一样都写到了」的（`co` 非空），
    // 而其余候选都各缺一样 —— 那才叫「组合缺一篇」。反过来，如果**每一篇候选都在缺同一类**
    // （比如问的东西库里根本没写过），那这是「查的词不在这座库里」，不是「组合没共现」；
    // 报成共现失败会把「我不认识这个词」伪装成「事实没写过」（M6 的铁律：不许伪造成绩）。
    const coocBlocked = !noInformativeTerm && !onlyExternal && eligible.length === 0
      && coocFailed.length > 0
      && coocFailed.some((s) => s.cooc.required > 0 && s.cooc.missing.length === 0);
    const reason = noInformativeTerm
      ? 'no_informative_term'
      : onlyExternal
        ? 'only_external_low_trust'
        : coocBlocked
          ? 'cooccurrence_required_pair_missing'
          : refuseReason({ scored: eligible.length ? eligible : ignored, thresholds, skipped, kept, allScored: scored });
    return {
      ok: true,
      status: 'insufficient_evidence',
      refused: true,
      reason,
      why_not: reason,
      query,
      items: [],
      // `nearest` 只在拒答时给：它不是「额外的补位结果」，而是
      // 「如果你想放宽阈值，就该看这几条」的提示。正常命中时给 nearest 会让
      // 调用方以为还有别的可选答案。
      nearest,
      tokens: 0,
      split: { pull: 0, push: 0 },
      truncated: false,
      dropped: [],
      droppedCount: 0,
      truncatedNotes: [],
      skipped,
      candidates: scored.length,
      thresholds,
      policy: refuseOnMiss ? 'qa' : 'search',
      // 覆盖率闸的实际门限：小语料走 `COVERAGE_SMALL_CORPUS_GATE`，且不会比调用方的闸更严。
      // 回执要能解释「为什么这条被挡」，就必须把这次真正生效的门限记下来，
      // 而不是让读回执的人拿默认阈值去猜。
      coverageGate: coverGate,
      scores: scored.map((s) => ({ id: s.id, score: round(s.score), relevance: round(s.relevance), coverage: round(s.coverage ?? 0) })),
      diagnostics: {
        thresholds,
        coverageGate: coverGate,
        skipped,
        candidates: scored.length,
        eligible: 0,
        ignored: ignored.map((s) => ({
          id: s.id,
          score: round(s.score),
          relevance: round(s.relevance),
          coverage: round(s.coverage ?? 0),
          // 被共现闸挡下来的条目把判据原样附上：审计要能回答
          // 「是覆盖率不够还是组合没共现」，不能只给一个布尔。
          cooccurrence: s.cooc ? coocReport(s.cooc) : null,
        })),
        pulled: 0,
        core: 0,
        dropped: [],
        store: null,
        queryInfo,
        cooccurrence: {
          checked: coocChecked,
          blocked: coocFailed.length,
          blockedIds: coocFailed.slice(0, 20).map((x) => x.id),
        },
      },
    };
  }

  // 预算裁剪：pull 优先，push（核心档）兜底且最后被挤。
  //
  // 曾实现过 `excerptSections`（长笔记只带命中节进预算），2026-10-22 在真实库
  // （1412 篇，p99 = 400 字）和 151 篇模拟用户库上都量不到差异：库里没有长笔记，
  // 而匹配本来就按 400 字分节。结论是这项改动在当前语料上没有可测收益，
  // 代码撤掉；将来接长文档来源（PDF/网页导入）时再评估。
  const pulled = eligible.map((s) => ({
    id: s.id,
    title: s.title,
    body: s.body,
    note: s.note,
    score: s.score,
    relevance: s.relevance,
    breakdown: s.breakdown,
    why: s.why,
  }));

  const coreCandidates = kept
    .filter((e) => e.note.kind === 'core')
    .map((e) => {
      const breakdown = scoreNote({ note: e.note, bm25: 0, nowMs: nowMsValue });
      return {
        id: String(e.id),
        title: e.title,
        body: e.body,
        note: e.note,
        score: breakdown.total,
        relevance: 0,
        breakdown,
        why: breakdown.why,
      };
    })
    .sort((a, b) => b.score - a.score);

  const selected = selectBudget({
    pulled,
    core: options.includeCore === false ? [] : coreCandidates,
    budget: { ...budget, includeCore: options.includeCore !== false },
  });

  // 全库候选名次（与预算无关）：融合排序要用它，才能保证同一问题不因
  // maxNotes/budget 变化而换答案。`scores` 已经是稳定降序。
  const lexRankOf = new Map(scored.map((entry, index) => [String(entry.id), index + 1]));
  const items = selected.items.map((item) => ({
    id: item.id,
    lexRank: lexRankOf.get(String(item.id)) ?? null,
    title: item.title,
    content: item.body,
    kind: item.note?.kind ?? null,
    trust: item.note?.trust ?? null,
    confidence: item.note?.confidence ?? null,
    scope: item.note?.scope ?? null,
    valid_from: item.note?.valid_from ?? null,
    valid_to: item.note?.valid_to ?? null,
    supersedes: item.note?.supersedes ?? [],
    superseded_by: item.note?.superseded_by ?? null,
    source: item.note?.provenance
      ? { written_by: item.note.provenance.written_by, source_ref: item.note.provenance.source_ref }
      : null,
    via: item.source, // pull | push
    cost: item.cost,
    // 分数**不重算**：直接用打分阶段的拆解，保证 `search` 报的数字与 `recall` 一致。
    score: item.score_breakdown ?? scoreNote({ note: item.note, bm25: 0, nowMs: nowMsValue }),
    relevance: item.relevance ?? 0,
    why: item.why,
  }));

  const pullCount = items.filter((i) => i.via === 'pull').length;
  return {
    ok: true,
    status: 'ok',
    refused: false,
    reason: null,
    query,
    items,
    // 正常命中时**不给 nearest**：它是拒答专用的提示（见拒答分支的注释）。
    nearest: null,
    tokens: selected.tokens,
    chars: selected.chars,
    budget: {
      requested: budget.maxTokens,
      used: selected.tokens,
      maxNotes: budget.maxNotes,
      dropped: selected.dropped,
    },
    split: { pull: pullCount, push: items.length - pullCount },
    truncated: selected.truncated,
    dropped: selected.dropped,
    droppedCount: selected.droppedCount,
    truncatedNotes: [],
    skipped,
    candidates: scored.length,
    thresholds,
    policy: refuseOnMiss ? 'qa' : 'search',
    coverageGate: coverGate,
    scores: scored.map((s) => ({
      id: s.id,
      score: round(s.score),
      relevance: round(s.relevance),
      // 覆盖率必须和拒答分支同形：少一个字段，调用方就得写两套读法。
      coverage: round(s.coverage ?? 0),
    })),
    // 与拒答分支同形的诊断块：`tabellio status` / `explain` 都吃它，
    // 两个分支形状不一致的话调用方得写两套读法（而它一定会漏掉一套）。
    diagnostics: {
      thresholds,
      coverageGate: coverGate,
      skipped,
      candidates: scored.length,
      eligible: eligible.length,
      ignored: ignored.map((s) => ({
        id: s.id,
        // 解释层要区分「相关性不够」和「分数不够」，缺 score 就只能报 unknown。
        score: round(s.score),
        relevance: round(s.relevance),
        coverage: round(s.coverage ?? 0),
        cooccurrence: s.cooc ? coocReport(s.cooc) : null,
      })),
      pulled: pulled.length,
      core: coreCandidates.length,
      dropped: selected.dropped,
      store: null,
      queryInfo,
      cooccurrence: { checked: coocChecked, blocked: coocFailed.length, blockedIds: coocFailed.slice(0, 20) },
    },
  };
}

/**
 * 拒答理由（`§9` 的 `why_not` 枚举）。
 *
 * 这里只处理**分数面/时间面/信任面**的三条，判据互斥且可解释：
 *  - 一条笔记都没进候选，而且有笔记是被 as-of/since 剔掉的 → `all_hits_expired`
 *    （调用方该放宽时间，而不是换词）；
 *  - 有候选但全是 external → `only_external_low_trust`（有料但不可当事实）；
 *  - 其余 → `top_score_below_threshold`。
 *
 * 另外两条理由不在这里判：`no_informative_term`（分母退化，由查询侧决定）
 * 和 `cooccurrence_required_pair_missing`（组合没在同一篇共现，由共现闸决定）——
 * 它们都在 `recall()` 里就地短路，因为判据来自查询侧与共现闸，不是这里的候选集。
 */
function refuseReason({ scored, thresholds, skipped, kept, allScored }) {
  if (scored.length === 0) {
    // 时间面：所有候选都被时间条件筛掉了
    const timeFiltered = skipped.expired_at_as_of + skipped.not_since;
    if (kept.length === 0 && timeFiltered > 0) return 'all_hits_expired';
    return 'top_score_below_threshold';
  }
  // 只命中外部低信任：**要求全部**命中都是 external（有一条 user_stated 就不算）
  if (scored.every((s) => s.note.trust === 'external')) return 'only_external_low_trust';
  return 'top_score_below_threshold';
}

function round(x) {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * 冻结接口的 `search`：`{hits:[{id,title,score}], tokens, refused, reason}`。
 *
 * **它就是 `recall` 的投影**，不是第二套检索：投影在同一函数里做，
 * 保证 CLI 报的数字与 MCP 报的数字来自同一次计算（`§6.1` 的口径一致要求）。
 */
export function searchHits({ entries, query, options = {} } = {}) {
  const result = recall({ entries, query, options });
  const hits = (result.items ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    score: round(item.score?.total ?? 0),
  }));
  return {
    hits,
    tokens: result.tokens,
    refused: result.refused,
    reason: result.reason,
    result,
  };
}

export { costOf, lifecycleOf };
