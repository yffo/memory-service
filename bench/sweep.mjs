// 判据 2/3 的**常量扫描**装置：`score.coverage` 的 `MIN_COVERAGE`，以及
// `no_informative_term` 的 `INFORMATIVE_DF_RATIO` / `INFORMATIVE_DF_FLOOR_DOCS`
// （外加 M4 之前那版「按语料规模开关闸门」的 `INFORMATIVE_MIN_DOCS` 历史轴）。
//
// 为什么要有它：这三个常量目前只在**两个点**上验过 ——
//   · 1321 篇的真实库（`~/memory/engramory`，df/n 有统计意义）
//   · 51 篇的评测语料（`bench/core-30-v1/library`，df/n 没有统计意义，闸门整段关闭）
// 中间量级（几百到两千篇，也就是一个人真用几个月之后的库）**一次都没测过**。
// 「在 51 篇上关掉、在 1321 篇上打开」并不能推出「在 300 篇上打开是对的」。
//
// 本装置造 50 / 200 / 500 / 1000 / 2000 篇的合成语料（取值与事实分布受控），
// 在每档上把「可答题的 recall@5」与「不可答题的拒答率」一起扫出来。
//
// **零依赖、纯词法、不起子进程**：直接调 `src/core/bm25.js` 的 `buildIndex` /
// `scoreDocs`，再用与 `src/core/recall.js` 同一套闸门口径判定。被扫的常量以参数
// 形式传进去（不改生产代码），所以同一次运行能把整条曲线放在一张表里。
//
// 用法：
//   node bench/sweep.mjs                 # 曲线 + 建议值（Markdown）
//   node bench/sweep.mjs --json          # 同样的内容，JSON（stdout 是纯 JSON）
//   node bench/sweep.mjs --json --out x.json
//   node bench/sweep.mjs --detail        # 逐档逐题的表
//   node bench/sweep.mjs --fixed         # 恒定语料（题目数量不随语料增长），看纯 df 效应
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INFORMATIVE_DF_FLOOR_DOCS,
  INFORMATIVE_DF_RATIO,
  INFORMATIVE_MIN_DOCS,
  buildIndex,
  scoreDocs,
} from '../src/core/bm25.js';
import { expandQuery } from '../src/core/tokenize.js';
import { saturateRelevance } from '../src/core/score.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');

/** 本装置自己的默认值（不改生产常量，只决定扫哪些点）。 */
export const SWEEP_DEFAULTS = Object.freeze({
  /** 语料规模梯度。50 与 2000 贴着已知的两个点（51 / 1321）。 */
  docs: Object.freeze([50, 200, 500, 1000, 2000]),
  /** `--fixed` 时不管语料多大，都只出这么多题，让 df 是唯一变量。 */
  fixedTasks: 48,
  k: 5,
  /** 与 `src/core/recall.js` 的 `DEFAULT_THRESHOLDS` 对齐（闸门之外的门槛）。 */
  minRelevance: 0.15,
  minScore: 0.18,
  /** 覆盖率闸门的扫描点；null = 关掉覆盖率闸门。 */
  coveragePoints: Object.freeze([null, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
  /** 有信息量闸门的 df/n 扫描点；null = 关掉这条闸门。 */
  /**
   * `df/n` 的扫描点。上限 0.5 是必需的：本语料里判别词每个服务一篇，
   * `df ≈ 12`，在 50 篇档上 `df/n = 0.24` —— 扫描点如果停在 0.2，
   * 「可答题在 50 篇档上就已经被误拒」这件事根本不会出现在表里（n=50 那行会全是 0）。
   * 生产值 0.05 也在表里，好直接看出它落在曲线的哪一段。
   */
  dfRatioPoints: Object.freeze([null, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5]),
  /** `INFORMATIVE_MIN_DOCS` 的历史扫描点（闸门「按语料规模开关」那一版的轴）。 */
  minDocsPoints: Object.freeze([0, 50, 100, 200, 400]),
  /**
   * `INFORMATIVE_DF_FLOOR_DOCS`（绝对词频地板）的扫描点。
   *
   * 这一支是修 M3 扫出的缺陷时加的：`df/n ≤ 0.05` 在小语料上把判别词（n=200 时
   * `df=12`，占 6%）判成「没有信息量」，整条闸退化成「什么都拒」。
   * 扫描点从 0（=旧的纯比例口径）一路到 3200（=比任何一档语料都大，等价于把闸关掉），
   * 好让「地板多大才够」是量出来的，而不是拍的。
   */
  dfFloorPoints: Object.freeze([0, 8, 16, 32, 64, 200, 800, 3200]),
});

/**
 * 生产口径（`src/core/recall.js` 的 `DEFAULT_THRESHOLDS` + `score.js` 的
 * `MIN_COVERAGE` + `bm25.js` 的两个证据性常量）。**唯一副本**在这里：
 * 渲染、CLI 的 JSON、比对脚本都读它，免得「文档里写的生产值」和「装置读的生产值」
 * 各写一份、改一处忘一处。
 */
export const PROD_PARAMS = Object.freeze({
  k: SWEEP_DEFAULTS.k,
  minRelevance: SWEEP_DEFAULTS.minRelevance,
  minScore: SWEEP_DEFAULTS.minScore,
  minCoverage: 0.6,
  dfRatio: INFORMATIVE_DF_RATIO,
  minDocs: 0,
  dfFloor: INFORMATIVE_DF_FLOOR_DOCS,
});

/** 一次扫描的默认配置：在默认值上把证据性闸门的轴钉在生产口径上（渲染的对照点要存在）。 */
export function prodSweepOptions(opts = {}) {
  return {
    dfRatioPoints: [INFORMATIVE_DF_RATIO],
    dfFloorPoints: [INFORMATIVE_DF_FLOOR_DOCS],
    minDocsPoints: [0],
    ...opts,
  };
}

// ────────────────────────────────────────────────────────────── 合成语料
// 语料与题面生成已抽到 `bench/sweep-fixtures.mjs`（M5 重建的装置）。
//
// 为什么抽出去、并整段重写：旧的生成器把可答题与不可答题都锚在**服务名**上，
// 而服务名在每一档语料里的 df ≈ n/12 —— 闸门按「df ≤ 64」把它当证据，
// 于是「命中服务名」的文档覆盖率就是 1.000。实测结果是两类题的覆盖率完全重合
// （不可答题 top-5 最大覆盖率五档全是 1.000，可答题里最小的 12 条也全是 1.000），
// 全网格 1960 格没有一个满足「recall ≥ 0.80 且拒答 ≥ 0.75」。
// 归因是夹具不可分，不是闸门不够严。
//
// 新夹具让判别词的 df 随语料规模真实增长（服务 ≈ n/服务数、领域词 ≈ 0.4n、
// 知识点号 = 覆盖服务数 2→4），并把不可答题改成「库里有近邻、事实不同」的形状：
// 题面与可答题**完全同形**，差别只在「这个知识点号没有覆盖这个服务」。
// 设计依据与实测见 `bench/sweep-fixtures.mjs` 头部注释与
// `docs/06-architecture.md §5.5.1`。
//
// 注意：`export { buildCorpus } from …` 只把名字重新导出，**不会**在本模块里
// 建立本地绑定 —— `sweep()` 里调 `buildCorpus(n)` 会直接 ReferenceError。
// 所以要 import 一次再 export（`node bench/sweep.mjs` 真炸过这一处）。
import { buildCorpus } from './sweep-fixtures.mjs';
export { buildCorpus } from './sweep-fixtures.mjs';
// ────────────────────────────────────────────────────────────── 判定

/**
 * 把 `src/core/recall.js` 的闸门口径在这里**重写一遍**（不是 import）：
 * 本装置要能把常量当参数传进去，而 `recall()` 只认模块里的常量。
 * 口径必须与 `src/core/recall.js` 的 `recall()` 一致：
 *   eligible = relevance > 0 && relevance >= minRelevance && score >= minScore
 *              && coverage >= minCoverage
 *   refuse    = eligible 为空 || 整条查询没有有信息量的词项
 * 阈值取值见 `docs/06-architecture.md §5.4`；两边不一致时以文档为准。
 */
export function judgeQuery(index, query, params) {
  const {
    k = 5, minRelevance, minScore, minCoverage, dfRatio, minDocs, dfFloor,
  } = params;
  const expansions = expandQuery(query);
  // 闸门口径：与 `src/core/bm25.js` 的 `isInformativeTerm()` 同形 ——
  // `df <= dfFloor`（绝对词频，默认不带）**或** `df/n <= dfRatio`（比例）。
  // `dfFloor` 缺省 / 为 0 时退化成修复前的纯比例口径，好把「修复前的曲线」当基线扫出来。
  const floor = Number.isFinite(dfFloor) ? dfFloor : 0;
  const gateOn = () => dfRatio !== null && (floor > 0 || index.n >= minDocs);
  const isInfo = (df) => df > 0 && (df <= floor || df / index.n <= dfRatio);

  // 打分一律走 `keepCommon: true`。原因是一处**非显然的耦合**：
  // `src/core/bm25.js` 里 `totalMass = informative.count === 0 ? 0 : …`，也就是
  // 「一个证据词都没有」时覆盖率**整体塌成 0**（所有笔记 coverage = 0），
  // 于是准入层拿到的是「一条都不合格」，拒答理由 `no_informative_term` 成立。
  // 如果这里用默认参数打分，生产闸门会在 n ≥ 200 的语料上把 coverage 全清零，
  // 本装置无论把 dfRatio 调成多少都读不出差别 —— 曲线是一根压在 0 上的平线。
  // 所以要先把「生产闸门的结论」和「这次扫描要多看的原始匹配」分开：
  // 打分走 keepCommon，覆盖率由本装置按**本次扫描的参数**自己算（见 coveredIds）。
  const scored = scoreDocs(index, expansions, { keepCommon: true, termCap: undefined });
  const qinfo = scored.queryInfo ?? {};
  const gateEnabled = qinfo.informativeGateEnabled !== false
    && dfRatio !== null
    && (qinfo.informativeRatio ?? 0) > 0;
  const informativeTerms = gateEnabled ? (qinfo.informativeTerms ?? []) : null;

  // 第二遍：按**本次扫描的参数**重算证据性闸门。
  // 这里必须自己算，不能复用 qinfo —— qinfo 用的是生产常量。
  const informative = new Set();
  if (gateOn()) {
    for (const e of expansions) {
      const df = index.postings.get(e.term)?.length ?? 0;
      if (isInfo(df)) informative.add(e.term);
    }
  }

  // 覆盖率：与 bm25 同口径（分子 = 某桶在**证据词**里命中的权重和，
  // 分母 = 整条查询在**证据词**里的权重和；权重 = idf × 查询内权重）。
  //
  // 分母为什么要跟证据词闸门一致：生产里 `totalMass` 只在 `informative.count === 0`
  // 时整条塌成 0，其余情况**就是**「证据词的权重和」。
  // 修复前（`INFORMATIVE_MIN_DOCS = 200` 那一版）闸门在小语料上压根不生效
  // （`n < 200` 一律算证据），所以那时「所有命中词」和「证据词」是同一个集合；
  // 现在闸门在所有规模上都有判据（绝对词频地板兜底），分母就必须跟着换成证据词，
  // 否则本装置量的覆盖率会比生产宽，读数对不上（修复前 n=500 档读 63%、
  // 生产实际 75%，差的就是这一处）。
  const covered = coveredIds(scored, index, expansions, {
    minRelevance, minScore, minCoverage, dfRatio, minDocs, dfFloor: floor, isInfo, gateOn: gateOn(),
  });

  const noInformative = gateOn() && informative.size === 0 && expansions.length > 0;

  return {
    hits: covered.hits.slice(0, k),
    eligibleCount: covered.eligible.length,
    refused: covered.eligible.length === 0 || noInformative,
    refuseReason: noInformative ? 'no_informative_term' : (covered.eligible.length === 0 ? 'no_eligible_hit' : null),
    informativeCount: informative.size,
    informativeAll: informative,
    termDf: covered.termDf,
    // 复刻生产口的读数，方便与 run-eval 对照。
    productionGateEnabled: qinfo.informativeGateEnabled !== false,
    productionInformativeCount: informativeTerms ? informativeTerms.length : null,
  };
}

function coveredIds(scored, index, expansions, {
  minRelevance, minScore, minCoverage, isInfo, gateOn,
}) {
  const termDf = new Map();
  for (const e of expansions) {
    const df = index.postings.get(e.term)?.length ?? 0;
    if (df > 0) termDf.set(e.term, df);
  }

  // 覆盖率的词项口径：**库里存在且算得上证据的词项**（df > 0 且过闸）进分母。
  //
  // 为什么要跟着证据性闸门走：生产 `bm25.js` 里
  // `totalMass = informative.count === 0 ? 0 : Σ(证据词的 idf × 权重)` ——
  // 分母就是证据词的权重和（一个证据词都没有时整条塌成 0，那种查询由
  // `no_informative_term` 拒掉，覆盖率本来也不参与判定）。
  // 闸门关掉（`dfRatio === null`）时证据词集合等于「库里存在的词项」，退化成旧口径，
  // 于是「关掉闸门」那一列仍读得出「纯词项覆盖」。
  const eligibleTerm = new Map();
  for (const e of expansions) {
    if (eligibleTerm.has(e.term)) continue;
    const df = index.postings.get(e.term)?.length ?? 0;
    eligibleTerm.set(e.term, df > 0 && (!gateOn || isInfo(df)));
  }
  // 权重 = idf × 查询内权重，与 `src/core/bm25.js` 的 `idf()` 同一个式子。
  // 这里**显式重写**而不是 import：`idf` 没有被导出，而且扫描本来就要把口径写死，
  // 免得生产里换了公式、装置却跟着悄悄变。
  const idfOf = (df) => Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
  const massByTerm = new Map();
  for (const e of expansions) {
    if (!eligibleTerm.get(e.term)) continue;
    if (massByTerm.has(e.term)) continue;
    const df = index.postings.get(e.term)?.length ?? 0;
    massByTerm.set(e.term, idfOf(df) * e.weight);
  }
  const totalMass = [...massByTerm.values()].reduce((a, b) => a + b, 0);

  // 桶级累加，**逐桶算覆盖率** —— 复刻 `scoreDocs` 的公式（`bm25.js` 的
  // `qWeight = weight × termIdf`、`termMass = massOf.get(term)`、
  // `contribution = qWeight(tf(k1+1))/(tf + k1·norm)`、`coverage = mass / totalMass`）。
  //
  // 这里曾经偷懒写成「每条命中记录只按 `Σ t.weight` 算比例」。两个错：
  // ① 少乘词项 idf —— 生产里 `massOf` 是 idf 量级的数，装置算出来的 coverage
  //    分母偏小、比例偏高；
  // ② 只取**分数最高**的那个桶的覆盖率。而生产 `aggregateByNote` 是「同一篇笔记的
  //    多个桶取**覆盖率最大**」（一篇长笔记里只有一段正面回答时，取 max 才不会被
  //    自己的长度摊薄）。两个错叠起来，装置会把一些生产认为合格的笔记判成不合格 ——
  //    M4 的产物检查抓到一例：`Cinderbay 的连接池最多几个？` 装置 eligible=0（判拒），
  //    生产 eligible=12（判答）。所以这一段的正确性由
  //    `test/bench-sweep.test.mjs` 的「装置量的是生产的行为」逐题对账。
  const K1 = index.k1 ?? 1.2;
  const B = index.b ?? 0.4;
  const secById = new Map();
  for (const e of scored) {
    const meta = index.metas[e.docIndex];
    if (!meta) continue;
    let mass = 0;
    for (const t of e.terms ?? []) {
      if (!eligibleTerm.get(t.term)) continue;
      const df = index.postings.get(t.term)?.length ?? 0;
      if (df <= 0) continue;
      const termIdf = idfOf(df);
      const qWeight = t.weight * termIdf;
      const tf = index.postings.get(t.term).find(([d]) => d === e.docIndex)?.[1] ?? 0;
      const len = index.docLen[e.docIndex] || 0;
      const norm = 1 - B + (B * len) / (index.avgLen || 1);
      mass += (qWeight * (tf * (K1 + 1))) / (tf + K1 * norm);
    }
    secById.set(e.docIndex, {
      id: meta.id,
      bm25: e.score,
      coverage: totalMass > 0 ? Math.min(1, mass / totalMass) : 0,
    });
  }

  // 笔记层：取桶的**最高分**定 relevance/score，取桶的**最大覆盖率**定 coverage
  // （`recall.js` 的 `aggregateByNote` 就是这个口径）。
  // 注意：`scoreDocs` 返回的是**按分数排好序的稀疏表**，数组下标不是文档号，
  // 每条自带 `docIndex`。第一版按数组下标去 `index.metas` 取元数据，于是「哪条笔记
  // 命中」全错位 —— recall@5 卡在 4.2% 而 `judgeQuery` 单独看又是对的，就是这个。
  const best = new Map();
  for (const s of scored) {
    const meta = index.metas[s.docIndex];
    if (!meta) continue;
    const sec = secById.get(s.docIndex);
    const rel = saturateRelevance(s.score);
    const total = 0.3 * 1 + 0.2 * 1 + 0.5 * rel; // importance/recency 固定为 1：本装置只扫闸门
    const prev = best.get(meta.id);
    if (!prev) {
      best.set(meta.id, { id: meta.id, score: total, relevance: rel, coverage: sec.coverage, bm25: s.score });
    } else {
      if (total > prev.score) {
        prev.score = total;
        prev.relevance = rel;
        prev.bm25 = s.score;
      }
      if (sec.coverage > prev.coverage) prev.coverage = sec.coverage;
    }
  }
  const all = [...best.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const eligible = all.filter((s) => s.relevance > 0
    && s.relevance >= minRelevance
    && s.score >= minScore
    && (minCoverage === null || !Number.isFinite(s.coverage) || s.coverage >= minCoverage));
  return { hits: all, eligible, termDf };
}

/** 在一档语料上跑一套参数，给出四个读数。 */
export function runPoint(corpus, params) {
  const index = buildIndex(corpus.notes);
  let answerable = 0;
  let recalled = 0;
  let refusalTasks = 0;
  let refusedRight = 0;
  const rows = [];
  for (const t of corpus.tasks) {
    const r = judgeQuery(index, t.query, params);
    if (t.kind === 'refusal') {
      refusalTasks += 1;
      if (r.refused) refusedRight += 1;
      rows.push({ id: t.id, kind: t.kind, refused: r.refused, reason: r.refuseReason, informative: r.informativeCount });
    } else {
      answerable += 1;
      // **拒答的题不算召回**，哪怕命中就在候选里。第一版漏了这个条件，
      // recall 报 0.833 而实际上 120 道题里 108 道被闸门拒掉了 —— 装置虚报了自己的成绩。
      const inHits = r.hits.some((h) => h.id === t.gold);
      const hit = !r.refused && inHits;
      if (hit) recalled += 1;
      rows.push({
        id: t.id,
        kind: t.kind,
        level: t.level,
        gold: t.gold,
        hit,
        in_hits: inHits,
        refused: r.refused,
        reason: r.refuseReason,
        informative: r.informativeCount,
        top: r.hits[0]?.id ?? null,
      });
    }
  }
  return {
    docs: corpus.n,
    answerable,
    recalls: recalled,
    recall_at_k: answerable ? recalled / answerable : null,
    refusal_tasks: refusalTasks,
    refused_right: refusedRight,
    correct_refusal_rate: refusalTasks ? refusedRight / refusalTasks : null,
    rows,
  };
}

// ────────────────────────────────────────────────────────────── 曲线与建议

/** 一次扫描的全部格子：语料 × (覆盖率, df 比, 绝对词频地板) 的笛卡尔积。 */
export function sweep(opts = {}) {
  const cfg = { ...SWEEP_DEFAULTS, ...opts };
  const corpora = cfg.docs.map((n) => buildCorpus(n, { fixed: cfg.fixed === true }));
  const points = [];
  for (const corpus of corpora) {
    for (const minCoverage of cfg.coveragePoints) {
      for (const dfRatio of cfg.dfRatioPoints) {
        for (const minDocs of cfg.minDocsPoints) {
          for (const dfFloor of cfg.dfFloorPoints) {
            // 闸门关掉时地板/门槛都没有意义：跳过重复格子，免得同一件事算 8×5 遍。
            if (dfRatio === null && (dfFloor !== cfg.dfFloorPoints[0] || minDocs !== cfg.minDocsPoints[0])) {
              continue;
            }
            const params = {
              k: cfg.k,
              minRelevance: cfg.minRelevance,
              minScore: cfg.minScore,
              minCoverage,
              dfRatio,
              minDocs,
              dfFloor,
            };
            const point = runPoint(corpus, params);
            points.push({ ...params, ...point, rows: cfg.detail ? point.rows : undefined });
          }
        }
      }
    }
  }
  return { config: cfg, corpora: corpora.map((c) => ({ docs: c.n, notes: c.notes.length, tasks: c.tasks.length })), points };
}

/**
 * 从曲线里挑建议值。判据：**先保召回，再降误答**。
 *  · 可答题的 recall@5 不许低于 `recallFloor`（默认 0.95）—— 丢真答案是硬伤；
 *  · 在满足上一条的格子里，取「拒答率最高」的那组（误答最少）；
 *  · 并列时取更保守（更小 df 比 / 更小覆盖率）的那组。
 */
export function recommend(result, { recallFloor = 0.95 } = {}) {
  const byParams = new Map();
  for (const p of result.points) {
    const key = `${p.minCoverage ?? '-'}|${p.dfRatio ?? '-'}|${p.dfRatio === null ? '-' : (p.dfFloor ?? 0)}`;
    if (!byParams.has(key)) byParams.set(key, []);
    byParams.get(key).push(p);
  }
  const combos = [];
  for (const [key, ps] of byParams) {
    const worstRecall = Math.min(...ps.map((p) => (p.recall_at_k ?? 0)));
    const refusal = ps.reduce((a, p) => a + (p.correct_refusal_rate ?? 0), 0) / ps.length;
    const [cov, df, fl] = key.split('|');
    combos.push({
      key,
      minCoverage: cov === '-' ? null : Number(cov),
      dfRatio: df === '-' ? null : Number(df),
      dfFloor: fl === '-' ? null : Number(fl),
      worst_recall: worstRecall,
      mean_refusal: refusal,
      docs: ps.map((p) => p.docs),
    });
  }
  const feasible = combos.filter((c) => c.worst_recall >= recallFloor);
  feasible.sort((a, b) => b.mean_refusal - a.mean_refusal
    || (a.dfRatio ?? 0) - (b.dfRatio ?? 0)
    || (a.dfFloor ?? 0) - (b.dfFloor ?? 0)
    || (a.minCoverage ?? 0) - (b.minCoverage ?? 0));
  const best = feasible[0] ?? null;
  return { recallFloor, feasible: feasible.length, best, combos };
}

// ────────────────────────────────────────────────────────────── 渲染

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v) => (v === null || v === undefined ? '—' : String(v));

export function renderMarkdown(rep) {
  const { result, rec } = rep;
  const L = [];
  L.push('# 常量扫描（`bench/sweep.mjs`）');
  L.push('');
  L.push(`合成语料档位：${result.corpora.map((c) => `${c.docs} 篇/${c.tasks} 题`).join('、')}`
    + `${result.config.fixed ? '（恒定题量：题目数不随语料增长）' : ''}`);
  L.push('');
  L.push('## 曲线（覆盖率闸门 × 语料规模，证据性闸门用生产值）');
  L.push('');
  L.push('| 语料 | ' + result.config.coveragePoints.map((c) => `coverage ≥ ${c ?? '关'}`).join(' | ') + ' |');
  L.push('| --- | ' + result.config.coveragePoints.map(() => '---').join(' | ') + ' |');
  const prodRatio = PROD_PARAMS.dfRatio;
  const prodFloor = PROD_PARAMS.dfFloor;
  const isProd = (x, cov) => x.minCoverage === cov && x.dfRatio === prodRatio && (x.dfFloor ?? 0) === prodFloor;
  for (const c of result.corpora) {
    const cells = result.config.coveragePoints.map((cov) => {
      const p = result.points.find((x) => x.docs === c.docs && isProd(x, cov));
      return p ? `${pct(p.recall_at_k)} / ${pct(p.correct_refusal_rate)}` : '—';
    });
    L.push(`| ${c.docs} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push('每个格子是 `可答题 recall@5 / 不可答题拒答率`。');
  L.push('');
  L.push('## 曲线（df 比 × 语料规模，覆盖率固定 0.6，绝对地板用生产值）');
  L.push('');
  L.push('| 语料 | ' + result.config.dfRatioPoints.map((d) => (d === null ? '关' : `df/n ≤ ${d}`)).join(' | ') + ' |');
  L.push('| --- | ' + result.config.dfRatioPoints.map(() => '---').join(' | ') + ' |');
  for (const c of result.corpora) {
    const cells = result.config.dfRatioPoints.map((df) => {
      const p = result.points.find((x) => x.docs === c.docs && x.dfRatio === df
        && (x.dfFloor ?? 0) === prodFloor && x.minCoverage === 0.6);
      return p ? `${pct(p.recall_at_k)} / ${pct(p.correct_refusal_rate)}` : '—';
    });
    L.push(`| ${c.docs} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push(`## 曲线（绝对词频地板 × 语料规模，df 比固定 ${prodRatio}，覆盖率固定 0.6）`);
  L.push('');
  L.push('地板这一支是**与语料规模无关**的判据：`df ≤ 地板` 就算证据。'
    + '地板 0 = 修复前的纯比例口径；地板 3200 = 比任何一档语料都大，等价于把闸门关掉。');
  L.push('');
  L.push('| 语料 | ' + result.config.dfFloorPoints.map((f) => `df ≤ ${f}`).join(' | ') + ' |');
  L.push('| --- | ' + result.config.dfFloorPoints.map(() => '---').join(' | ') + ' |');
  for (const c of result.corpora) {
    const cells = result.config.dfFloorPoints.map((fl) => {
      const p = result.points.find((x) => x.docs === c.docs && x.dfFloor === fl
        && x.dfRatio === prodRatio && x.minCoverage === 0.6);
      return p ? `${pct(p.recall_at_k)} / ${pct(p.correct_refusal_rate)}` : '—';
    });
    L.push(`| ${c.docs} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push('## 建议');
  L.push('');
  if (rec.best) {
    L.push(`在「可答题 recall@5 不低于 ${pct(rec.recallFloor)}」的前提下，误答最少的格子是：`);
    L.push('');
    L.push(`- \`MIN_COVERAGE = ${rec.best.minCoverage ?? '（关）'}\``);
    L.push(`- \`INFORMATIVE_DF_RATIO = ${rec.best.dfRatio ?? '（关）'}\``);
    L.push(`- \`INFORMATIVE_DF_FLOOR_DOCS = ${rec.best.dfFloor ?? '（关）'}\``);
    L.push(`- 最差档 recall@5 ${pct(rec.best.worst_recall)}，平均拒答率 ${pct(rec.best.mean_refusal)}`);
  } else {
    L.push(`没有格子能在所有语料档上把 recall@5 保持在 ${pct(rec.recallFloor)} 以上。`);
  }
  L.push('');
  L.push(`生产值：\`MIN_COVERAGE = ${PROD_PARAMS.minCoverage}\`、`
    + `\`INFORMATIVE_DF_RATIO = ${prodRatio}\`、\`INFORMATIVE_DF_FLOOR_DOCS = ${prodFloor}\`。`
    + '（`INFORMATIVE_MIN_DOCS` 已不参与判定，只为兼容旧引用保留。）');
  return `${L.join('\n')}\n`;
}

// ────────────────────────────────────────────────────────────── CLI

export function parseArgs(argv) {
  const opts = { json: false, detail: false, fixed: false, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} 缺参数`);
      return argv[i];
    };
    if (a === '--json') opts.json = true;
    else if (a === '--detail') opts.detail = true;
    else if (a === '--fixed') opts.fixed = true;
    else if (a === '--out') opts.out = next();
    else if (a === '--docs') opts.docs = next().split(',').map((x) => Number(x.trim()));
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  if (opts.docs && opts.docs.some((n) => !Number.isInteger(n) || n < 4)) {
    throw new Error('--docs 必须是 ≥4 的整数列表，用逗号分隔');
  }
  return opts;
}

export function usage() {
  return [
    '用法：node bench/sweep.mjs [--json] [--detail] [--fixed] [--docs 50,200,500] [--out FILE]',
    '',
    '  --json    输出 JSON（stdout 是纯 JSON）',
    '  --detail  带上逐题明细（JSON）',
    '  --fixed   恒定题量：题目数不随语料增长，让 df 是唯一变量',
    '  --docs    语料规模梯度，默认 50,200,500,1000,2000',
    '  --out     写进文件而不是 stdout',
    '',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`参数错误：${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(usage());
    return 0;
  }
  const result = sweep(prodSweepOptions({
    detail: opts.detail,
    fixed: opts.fixed,
    ...(opts.docs ? { docs: opts.docs } : {}),
  }));
  const rec = recommend(result);
  const payload = {
    device: 'sweep',
    version: 2,
    production: {
      MIN_COVERAGE: 0.6,
      INFORMATIVE_DF_RATIO: INFORMATIVE_DF_RATIO,
      INFORMATIVE_DF_FLOOR_DOCS: INFORMATIVE_DF_FLOOR_DOCS,
      INFORMATIVE_MIN_DOCS: INFORMATIVE_MIN_DOCS,
    },
    result,
    rec,
  };
  const text = opts.json ? `${JSON.stringify(payload, null, 2)}\n` : renderMarkdown({ result, rec });
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), text);
  else process.stdout.write(text);
  return 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
