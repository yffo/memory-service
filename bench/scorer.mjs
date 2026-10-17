/**
 * core-30-v1 判分器 —— 纯函数，不读文件、不起进程、不联网。
 *
 * 输入：一次运行的原始记录（每题一条 run 记录，形状见下）；输出：指标对象。
 * 之所以做成纯函数：判据 1 的争议必须落在「口径」上，而不是落在「这次跑得对不对」上，
 * 所以判分逻辑要能被单测钉住（test/eval-scorer.test.mjs）。
 *
 * ── run 记录的形状 ────────────────────────────────────────────────
 *   {
 *     task_id: 'f01',        // 对应 tasks.json 里的 id
 *     answer: '……',          // 回答器的输出
 *     injected: '……',        // 真正写进上下文的那段文本（空串 = 无记忆）
 *     hits: [{ id, title, score }],  // 召回排名（none 臂为空数组）
 *     tokens: 123,           // 这次注入消耗的 token（CLI 报的，或估算的）
 *     refused: false,        // 系统是否明确拒答
 *     reason: null           // 拒答原因（可选）
 *   }
 *
 * ── 指标口径（写死在代码里，runbook 抄的是同一份说明）────────────────
 *   recall@k            有来源的题里，来源笔记进了 top-k 的比例。定 k=5 时为 recall@5。
 *   correct_refusal_rate 拒答题里判对的（拒答了、且没把编造值说出来）÷ 拒答题数。
 *                        只在拒答题上算 —— 这样它既不能被「一律拒答」骗（那会掉 recall@5），
 *                        也不能被「一律硬答」骗（拒答题直接判错）。
 *   refusal_calibration  全部题里「该拒的拒了、该答的答了」的比例（文档口径，一起印出来做参照）。
 *   injected_tokens      所有题注入 token 之和；injected_tokens_mean 是单题均值（预算是 500/题）。
 *   token_efficiency     命中信息的密度 = 上下文里真的含正确答案的题数 ÷ 注入千 token 数。
 *                        无注入（token 为 0）时是 null，不是 Infinity。
 *   hit_but_unused_rate  召回把正确答案带进了上下文、但回答里没用上的比例（漏用率）。
 *                        死板回显全部上下文的回答器结构性为 0，这是真结论不是 bug：
 *                        要看出信号得用 --answerer first-hit（只回显 rank-1 那篇）。
 *   match_rate           答案逐字命中 expect、且没命中 forbid 的比例（回答器无关的准头）。
 *   answer_accuracy      match_rate 在回答层口径下的别名：接入模型回答器后，它就是「答对率」。
 *   negative_transfer    acc(closed_book) − acc(real)，**正值=记忆有害**（02 §4.5）。
 *   trap_fall_rate       带 negative_transfer_probe 的题里，答案落入 fall_patterns 的比例。
 *                        只统计规则判分器认得的字面陷阱，不是 LLM 语义陷阱率。
 *   oracle_gap           acc(oracle_gold) − acc(real)：检索/注入丢掉了多少本可答对的题。
 *   answer_token_efficiency  Δaccuracy ÷（real 臂注入千 token）：每千 token 换多少百分点准确率。
 *                        与上面检索层的 token_efficiency 不是一回事，报告里分开印。
 *
 * ── 三条硬规则 ───────────────────────────────────────────────────
 *   1. 比较前一律 normalizeText（NFKC + 去空白 + 小写）：中文没有词边界，
 *      逐字比较必须先把排版差异吃掉，否则「2 GB」和「2GB」会被判成两回事。
 *   2. 答案里出现 forbid 就是错的，哪怕 expect 也在里面（编造与真值同时出现，不算答对）。
 *   3. answer_aliases 是**题级**的等价答案，只放宽 expect 的写法，不能绕过 forbid；
 *      它要显式写在题集里，不许在判分器里临时放水。
 */

/** 判据阈值（docs/06-architecture.md §M1）。 */
export const THRESHOLDS = Object.freeze({
  recallAt5: 0.8,
  correctRefusalRate: 0.75,
  maxInjectedTokensPerQuery: 500,
  negativeTransfer: 0.02,
  answerTokenEfficiency: 2.0,
});

/** expect 的等价写法白名单：只有这里列的写法才算「能追到笔记」，不许临时放水。 */
export const EXPECT_ALIASES = Object.freeze([
  {
    name: '速率两种写法（12 次/秒 ⇄ 每秒 12 次）',
    from: /^(.+)次\/秒$/,
    to: (m) => `每秒${m[1]}次`,
  },
  {
    name: '周几两种写法（周二和周四 09:15 ⇄ 每周二、周四 09:15）',
    from: /^周二和周四\s*(\d{2}:\d{2})$/,
    to: (m) => `每周二、周四${m[1]}`,
  },
  {
    name: '家目录两种写法（$HOME/x ⇄ ~/x）',
    from: /^\$HOME(\/.*)$/,
    to: (m) => `~${m[1]}`,
  },
]);

/** 认得出「这是拒答」的措辞。回答器不一定会把 refused 字段填对，但不能因此把诚实拒答判成硬答。 */
export const REFUSAL_PATTERNS = Object.freeze([
  /没有(找到|相关|记录|提到|这条|任何)/,
  /未(找到|检索到|记录|提及)/,
  /查不到|找不到|不存在(这条|相关)?/,
  /不确定|无法确认|无从判断|说不好|不知道/,
  /not\s*found|no\s+(relevant\s+)?(record|note|information|mention)/i,
]);

/** 比较用的归一化：NFKC（全角→半角、兼容字形）→ 去所有空白 → 小写。 */
export function normalizeText(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 粗估 token：中文按 2 字符 ≈ 1 token。只在 CLI 没报 token 时兜底，报告里会标明是估算。 */
export function estimateTokens(text) {
  const chars = [...String(text ?? '')].length;
  return chars === 0 ? 0 : Math.ceil(chars / 2);
}

/** 拒答题 = tasks.json 里 source 为空的题。 */
export function isRefusalTask(task) {
  return !Array.isArray(task?.source) || task.source.length === 0;
}

/** 六类能力（02 §4.6）。题集里显式写 capability；缺省时按 kind 给一个保守的默认值。 */
export const CAPABILITIES = Object.freeze([
  'single_hop',
  'multi_hop',
  'temporal',
  'knowledge_update',
  'abstention',
  'negative_transfer',
]);

/**
 * 题目的 capability。显式字段优先；没写时按 kind 映射，保证旧题/手写测试仍能判分。
 * 显式写了但不认识的值返回 unknown，而不是悄悄套默认值——脏数据要浮出来。
 */
export function taskCapability(task) {
  const explicit = typeof task?.capability === 'string' ? task.capability.trim() : '';
  if (explicit) return CAPABILITIES.includes(explicit) ? explicit : 'unknown';
  if (task?.kind === 'refusal') return 'abstention';
  if (task?.kind === 'correction') return 'knowledge_update';
  if (['fact_recall', 'preference', 'procedure'].includes(task?.kind)) return 'single_hop';
  return 'unknown';
}

/**
 * 负迁移陷阱探针。只认完整形状，缺字段就当没有——不能拿半个探针算陷阱率。
 * 返回 null 表示这题没有可判的陷阱；返回对象则 fall_patterns 至少一条。
 */
export function taskNegativeTransferProbe(task) {
  const probe = task?.negative_transfer_probe;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return null;
  const distractorNote = typeof probe.distractor_note === 'string' ? probe.distractor_note.trim() : '';
  const whyWrong = typeof probe.why_wrong === 'string' ? probe.why_wrong.trim() : '';
  const fallPatterns = Array.isArray(probe.fall_patterns)
    ? probe.fall_patterns
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : [];
  if (!distractorNote || !whyWrong || fallPatterns.length === 0) return null;
  return { distractor_note: distractorNote, why_wrong: whyWrong, fall_patterns: fallPatterns };
}

/** multi_hop 题要求 expect 全部命中；其它题保持「任一等价写法命中」的旧语义。 */
export function taskExpectAll(task) {
  return task?.expect_all === true;
}

/**
 * 题级等价答案。目标 schema 写在 expected.answer_aliases；当前 core-30-v1 用顶层
 * answer_aliases，两种都认。非数组/空串会静静丢掉——评分不能让一条脏数据把整轮打挂。
 */
export function taskAnswerAliases(task) {
  const raw = task?.answer_aliases ?? task?.expected?.answer_aliases;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** 一次运行里所有题的 id 列表（缺题的运行必须能被发现，不能悄悄按「跑过的题」算分）。 */
export function coveredTaskIds(tasks, runs) {
  const ran = new Set((runs ?? []).map((r) => r.task_id));
  return tasks.filter((t) => ran.has(t.id)).map((t) => t.id);
}

export function missingTaskIds(tasks, runs) {
  const ran = new Set((runs ?? []).map((r) => r.task_id));
  return tasks.filter((t) => !ran.has(t.id)).map((t) => t.id);
}

/** 一条 hit 可能用文件名、也可能用不带后缀的名字；两种都认。 */
export function isSourceHit(hit, file) {
  if (!hit) return false;
  const target = normalizeText(file);
  const bare = normalizeText(String(file).replace(/\.md$/i, ''));
  return [hit.id, hit.title, hit.name, hit.path]
    .filter((x) => typeof x === 'string' && x.length > 0)
    .map((x) => normalizeText(x))
    .some((x) => x === target || x === bare || x.endsWith(`/${target}`) || x.endsWith(`/${bare}`));
}

/**
 * 来源笔记有没有进 top-k。拒答题没有来源，返回 null（不进 recall 分母）。
 * index 从 0 数：k=5 时 rank 5（第 5 名）算命中，第 6 名不算。
 */
export function recallAtK(task, hits, k = 5) {
  if (isRefusalTask(task)) return null;
  const top = (hits ?? []).slice(0, Math.max(0, k));
  return task.source.every((file) => top.some((hit) => isSourceHit(hit, file)));
}

/**
 * expect 的等价写法：原样 + 白名单里的变体。
 * 笔记正文不会为了迁就判分器改措辞（「每秒 12 次」就是「每秒 12 次」），
 * 所以换算放在判分器这一侧：命中任一等价写法都算命中。
 */
export function termVariants(text) {
  const out = [String(text ?? '')].filter((v) => normalizeText(v).length > 0);
  for (const alias of EXPECT_ALIASES) {
    for (const candidate of [...out]) {
      const m = candidate.match(alias.from);
      if (m && typeof alias.to === 'function') {
        const variant = alias.to(m);
        if (variant && !out.includes(variant)) out.push(variant);
      }
    }
  }
  return out;
}

/** expect 在归一化文本里出现 → hit/used 真值。空 expect 一律 false。 */
function matchTerms(terms, haystack) {
  return (terms ?? []).map((text) => {
    const variants = termVariants(text).map(normalizeText).filter((v) => v.length > 0);
    return { text, hit: variants.some((v) => haystack.includes(v)) };
  });
}

function looksRefused(run, forbidUsed) {
  const answer = String(run?.answer ?? '');
  if (run?.refused === true) return true;
  if (answer.trim() === '') return true;
  if (forbidUsed) return false; // 一边说「不确定」一边把编造值端出来，不算干净的拒答
  return REFUSAL_PATTERNS.some((re) => re.test(answer));
}

const round = (value, digits = 4) =>
  value === null || value === undefined || Number.isNaN(value) ? null : Number(value.toFixed(digits));

/** 单题判分。返回逐字命中明细，方便报告里逐题解释「为什么这题错了」。 */
export function scoreTask(task, run = {}, options = {}) {
  const k = Number.isInteger(options.k) ? options.k : 5;
  const injected = normalizeText(run.injected);
  const answer = normalizeText(run.answer);
  const answerAliases = taskAnswerAliases(task);
  const expectAll = taskExpectAll(task);
  const probe = taskNegativeTransferProbe(task);
  const expects = matchTerms(task.expect, injected);
  const expectedInAnswer = matchTerms(task.expect, answer);
  const aliasesInContext = matchTerms(answerAliases, injected);
  const aliasesInAnswer = matchTerms(answerAliases, answer);
  const forbidsInContext = matchTerms(task.forbid, injected);
  const forbidsInAnswer = matchTerms(task.forbid, answer);
  const trapTerms = matchTerms(probe?.fall_patterns ?? [], answer);

  // multi_hop 要求整组 expect 都在；旧题保持 OR（expect 里是同一事实的等价写法）。
  const expectHit = expectAll
    ? expects.length > 0 && expects.every((d) => d.hit)
    : expects.some((d) => d.hit) || aliasesInContext.some((d) => d.hit);
  const expectUsed = expectAll
    ? expectedInAnswer.length > 0 && expectedInAnswer.every((d) => d.hit)
    : expectedInAnswer.some((d) => d.hit) || aliasesInAnswer.some((d) => d.hit);
  const forbidHit = forbidsInContext.some((d) => d.hit);
  const forbidUsed = forbidsInAnswer.some((d) => d.hit);
  const trapFall = probe ? trapTerms.some((d) => d.hit) : null;
  // 陷阱值也算「错值已出口」：哪怕它没写进 forbid，也不能判对，更不能算干净拒答。
  const wrongValueUsed = forbidUsed || trapFall === true;
  const refused = looksRefused(run, wrongValueUsed);
  const answered = !refused;
  const refusalTask = isRefusalTask(task);
  const recall = recallAtK(task, run.hits, k);

  const correctRefusal = refusalTask ? refused && !wrongValueUsed : null;
  const match = refusalTask ? refused && !wrongValueUsed : answered && expectUsed && !wrongValueUsed;

  return {
    task_id: task.id,
    kind: task.kind ?? 'unknown',
    capability: taskCapability(task),
    refusal_task: refusalTask,
    recall_at_k: recall,
    expect_all: expectAll,
    expect_hit: expectHit,
    expect_used: expectUsed,
    forbid_hit: forbidHit,
    forbid_used: forbidUsed,
    trap_fall: trapFall,
    refused,
    answered,
    hit_but_unused: expectHit && !expectUsed,
    correct_refusal: correctRefusal,
    match: Boolean(match),
    error: run.error ?? null,
    tokens: Number(run.tokens ?? 0) || 0,
    alias_used: aliasesInAnswer.filter((d) => d.hit).map((d) => d.text),
    details: {
      expect: expects.map((d, i) => ({ ...d, used: expectedInAnswer[i].hit })),
      answer_aliases: aliasesInContext.map((d, i) => ({ ...d, used: aliasesInAnswer[i].hit })),
      forbid: forbidsInContext.map((d, i) => ({ ...d, used: forbidsInAnswer[i].hit })),
      trap: probe
        ? { distractor_note: probe.distractor_note, why_wrong: probe.why_wrong, fall_patterns: trapTerms }
        : null,
    },
  };
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function aggregate(rows, k) {
  const answerable = rows.filter((r) => !r.refusal_task);
  const refusal = rows.filter((r) => r.refusal_task);
  const recallHits = answerable.filter((r) => r.recall_at_k === true).length;
  const expectHits = rows.filter((r) => r.expect_hit).length;
  const hitButUnused = rows.filter((r) => r.hit_but_unused).length;
  const matched = rows.filter((r) => r.match).length;
  const answered = rows.filter((r) => r.answered).length;
  const trapRows = rows.filter((r) => r.trap_fall === true || r.trap_fall === false);
  return {
    tasks: rows.length,
    answerable_tasks: answerable.length,
    refusal_tasks: refusal.length,
    recall_at_5: rate(recallHits, answerable.length),
    recall_hits: recallHits,
    correct_refusal_rate: rate(refusal.filter((r) => r.correct_refusal).length, refusal.length),
    refusal_correct: refusal.filter((r) => r.correct_refusal).length,
    refusal_calibration: rate(
      answerable.filter((r) => r.answered).length + refusal.filter((r) => r.correct_refusal).length,
      rows.length,
    ),
    answered_rate: rate(answered, rows.length),
    match_rate: rate(matched, rows.length),
    expect_hits: expectHits,
    expect_hit_rate: rate(expectHits, rows.length),
    hit_but_unused: hitButUnused,
    hit_but_unused_rate: rate(hitButUnused, expectHits),
    injected_tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
    trap_tasks: trapRows.length,
    trap_falls: trapRows.filter((r) => r.trap_fall).length,
    trap_fall_rate: rate(trapRows.filter((r) => r.trap_fall).length, trapRows.length),
  };
}

/**
 * 整轮判分。
 * @param {Array} tasks tasks.json 里的 tasks
 * @param {Array} runs  同一轮的 run 记录
 * @param {{k?: number, arm?: string, errors?: number}} [options]
 */
export function scoreRun(tasks, runs, options = {}) {
  const k = Number.isInteger(options.k) ? options.k : 5;
  const byId = new Map((runs ?? []).map((r) => [r.task_id, r]));
  const rows = (tasks ?? []).map((task) => scoreTask(task, byId.get(task.id) ?? {}, { k }));
  const overall = aggregate(rows, k);
  const kinds = {};
  const capabilities = {};
  for (const row of rows) {
    (kinds[row.kind] ??= []).push(row);
    (capabilities[row.capability] ??= []).push(row);
  }
  const byKind = Object.fromEntries(Object.entries(kinds).map(([kind, list]) => [kind, aggregate(list, k)]));
  const byCapability = Object.fromEntries(
    Object.entries(capabilities).map(([capability, list]) => [capability, aggregate(list, k)]),
  );

  const injectedTokens = overall.injected_tokens;
  const tokenEfficiency = injectedTokens > 0 ? overall.expect_hits / (injectedTokens / 1000) : null;
  const meanTokens = rate(injectedTokens, overall.tasks);
  const arm = options.arm ?? 'unknown';

  const verdict = {
    arm,
    recall_at_5: verdictOf(overall.recall_at_5, THRESHOLDS.recallAt5, 'min'),
    correct_refusal_rate: verdictOf(overall.correct_refusal_rate, THRESHOLDS.correctRefusalRate, 'min'),
    injected_tokens: verdictOf(meanTokens, THRESHOLDS.maxInjectedTokensPerQuery, 'max'),
    missing_tasks: missingTaskIds(tasks ?? [], runs ?? []).length,
    errors: Number(options.errors ?? 0),
  };
  verdict.pass =
    verdict.recall_at_5 === true && verdict.correct_refusal_rate === true && verdict.injected_tokens === true &&
    verdict.missing_tasks === 0 && verdict.errors === 0;

  return {
    arm,
    k,
    ...overall,
    injected_tokens_mean: meanTokens === null ? null : round(meanTokens, 2),
    token_efficiency: tokenEfficiency === null ? null : round(tokenEfficiency, 4),
    by_kind: byKind,
    by_capability: byCapability,
    verdict,
    rows,
  };
}

/**
 * 判据比对：op 是 'min'（越大越好，actual ≥ limit 达标）或 'max'（越小越好）。
 * 返回 true（达标）/ false（不达标）/ null（算不出来）—— null 不等于不达标，报告里要分开说。
 */
function verdictOf(actual, limit, op = 'min') {
  if (actual === null || actual === undefined) return null;
  return op === 'min' ? actual >= limit : actual <= limit;
}

/* ────────────────────────── 回答层指标（02 §4.5） ────────────────────────── */

/**
 * 答对率。match_rate 已经把「该拒的拒了」算成对，所以它就是三臂共同的口径。
 * @param {object|null} result scoreRun 的结果
 * @returns {number|null}
 */
export function answerAccuracy(result) {
  const v = result?.match_rate;
  return Number.isFinite(v) ? v : null;
}

/**
 * negative_transfer = acc(no_memory) − acc(real)。正值=加了记忆反而更差（有害）。
 * 只在两个臂用的是**同一个回答器**时才有意义；调用方负责检查（echo 下数字无意义）。
 */
export function negativeTransfer(closedBook, real) {
  const a = answerAccuracy(closedBook);
  const b = answerAccuracy(real);
  return a === null || b === null ? null : round(a - b, 4);
}

/** oracle_gap = acc(oracle_gold) − acc(real)：检索上限与实跑之间的差距。 */
export function oracleGap(oracle, real) {
  const a = answerAccuracy(oracle);
  const b = answerAccuracy(real);
  return a === null || b === null ? null : round(a - b, 4);
}

/**
 * answer_token_efficiency = Δaccuracy ÷（real 臂单题注入 token 均值/1000），02 §4.5 的定义。
 * 分母必须是 injected_tokens_mean（单题均值），不是整套题的总注入量——
 * 用总量会让分母随题数膨胀 52 倍，1.38 被算成 0.027（2026-10-17 实测踩过）。
 * Δaccuracy 可能为负（记忆帮了倒忙）；那时效率也是负的，不许截成 0。
 * 单题均值为 0 或 acc 算不出来时返回 null（"没有分母" 不是 "效率无限大"）。
 */
export function answerTokenEfficiency(real, closedBook) {
  const accReal = answerAccuracy(real);
  const accBase = answerAccuracy(closedBook);
  const tokensMean = real?.injected_tokens_mean;
  if (accReal === null || accBase === null || !Number.isFinite(tokensMean) || tokensMean <= 0) return null;
  return round((accReal - accBase) / (tokensMean / 1000), 4);
}

export { round };
