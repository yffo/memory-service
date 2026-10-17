/**
 * 记忆回执（recall receipt）—— 把一次 recall 的**判断**固化成可核验的 JSON。
 *
 * 为什么要有它：检索系统最容易糊弄人的地方不是「没搜到」，而是「搜到了但说不清
 * 为什么是这几条、为什么丢了那几条」。回执把查询、阈值、预算、纳入项、丢弃项、
 * 拒答时最接近的候选、以及每条被纳入笔记的正文 hash 一起记账，事后可以：
 *  - `verify`：对照当前笔记，确认回执没有被改、笔记正文没有被换；
 *  - `explain`：不重跑检索，直接回答「为什么纳入 / 为什么没纳入 / 为什么丢弃」。
 *
 * 边界（很重要）：这是**读取回执**，只证明「当时按这套输入和阈值算出了这个结果」。
 * 它不是「答案正确」的证明，也不是巩固/写入回执（写入前后 diff 属于 M2）。
 * 回执里不存正文，只存正文 hash；正文仍然以文件为准。
 */
import { sha256 } from '../util/text.js';
import { isoLocal } from '../util/clock.js';
import { ulid } from '../util/ulid.js';
import { budgetOf } from './select.js';

export const RECEIPT_SCHEMA = 'tabellio.receipt/1';
export const RECEIPT_KIND = 'recall';
export const RECEIPT_HASH_LEN = 32;

/** 诊断列表在回执里的上限：超出的只留计数，避免一次 recall 生成几 MB JSON。 */
export const MAX_RECEIPT_LIST = 100;

const EMPTY_CHECK = Object.freeze({
  checked: 0,
  itemsChecked: 0,
  nearestChecked: 0,
  matched: 0,
  changed: [],
  missing: [],
  problems: [],
});

/**
 * 稳定的 JSON 序列化：对象 key 递归排序，数组保持原序。
 *
 * hash 必须建立在稳定序列化上，否则同一份回执在不同 JS 引擎/不同写入顺序下
 * 会算出不同 hash，verify 就会把好回执误判成被篡改。
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`回执只能包含 JSON 值，收到 ${type}`);
}

/** 回执自身的 hash（不包含 `hash` 字段）。 */
export function receiptHash(receipt) {
  const { hash: _ignored, ...unsigned } = receipt ?? {};
  return sha256(canonicalJson(unsigned), RECEIPT_HASH_LEN);
}

/** 回执形状校验；返回问题列表，空数组表示形状可用。 */
export function receiptShapeProblems(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['回执必须是 JSON 对象'];
  const problems = [];
  if (receipt.schema !== RECEIPT_SCHEMA) problems.push(`schema 必须是 ${RECEIPT_SCHEMA}`);
  if (receipt.kind !== RECEIPT_KIND) problems.push(`kind 必须是 ${RECEIPT_KIND}`);
  if (typeof receipt.receiptId !== 'string' || !receipt.receiptId.startsWith('rcp_')) problems.push('receiptId 缺失或非法');
  if (typeof receipt.hash !== 'string' || receipt.hash.length !== RECEIPT_HASH_LEN) problems.push('hash 缺失或长度不对');
  if (!Array.isArray(receipt.items)) problems.push('items 必须是数组');
  if (receipt.nearest !== null && !Array.isArray(receipt.nearest)) problems.push('nearest 必须是数组或 null');
  if (!receipt.decision || typeof receipt.decision !== 'object') problems.push('decision 缺失');
  return problems;
}

function listOf(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((x) => String(x)).filter(Boolean);
  return String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function safeNum(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function entryMapOf(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    if (entry && entry.id !== undefined && entry.id !== null) map.set(String(entry.id), entry);
  }
  return map;
}

function entryHash(entry) {
  if (!entry) return null;
  return sha256(String(entry.body ?? ''), 16);
}

function itemFor({ item, entry }) {
  return {
    id: String(item.id),
    title: item.title ?? entry?.title ?? '',
    kind: item.kind ?? entry?.note?.kind ?? null,
    trust: item.trust ?? entry?.note?.trust ?? null,
    confidence: item.confidence ?? entry?.note?.confidence ?? null,
    scope: item.scope ?? entry?.note?.scope ?? null,
    status: entry?.note?.status ?? null,
    valid_from: item.valid_from ?? entry?.note?.valid_from ?? null,
    valid_to: item.valid_to ?? entry?.note?.valid_to ?? null,
    superseded_by: item.superseded_by ?? entry?.note?.superseded_by ?? null,
    via: item.via ?? null,
    source: item.source ?? null,
    why: item.why ?? '',
    score: item.score ?? null,
    relevance: safeNum(item.relevance),
    noteSha256: entryHash(entry),
  };
}

function nearestFor({ item, entry }) {
  return {
    id: String(item.id),
    title: item.title ?? entry?.title ?? '',
    score: safeNum(item.score),
    relevance: safeNum(item.relevance),
    why: item.why ?? '',
    noteSha256: entryHash(entry),
  };
}

function droppedFor({ dropped, scoreById, entryById }) {
  const id = String(dropped.id);
  const score = scoreById.get(id) ?? null;
  const entry = entryById.get(id) ?? null;
  return {
    id,
    title: entry?.title ?? '',
    reason: dropped.reason ?? null,
    limitReason: dropped.limitReason ?? null,
    source: dropped.source ?? null,
    hard: Boolean(dropped.hard),
    score: safeNum(score?.score),
    relevance: safeNum(score?.relevance),
    coverage: safeNum(score?.coverage),
    noteSha256: entryHash(entry),
  };
}

function ignoredFor(ignored) {
  return {
    id: String(ignored.id),
    score: safeNum(ignored.score),
    relevance: safeNum(ignored.relevance),
    coverage: safeNum(ignored.coverage),
    cooccurrence: ignored.cooccurrence ?? null,
  };
}

/**
 * 从 `recall()` 的结果生成回执。
 *
 * 回执不包含笔记正文，只包含元数据与正文 hash；`entries` 用来补 hash 和状态。
 * 如果调用方拿不到 entries（例如只拿到 result），hash 会是 null，`verify` 会
 * 把对应条目报成 changed —— 这是刻意的：没有正文对照，就不该声称核验通过。
 */
export function buildRecallReceipt({
  result,
  entries = [],
  store = null,
  query = '',
  options = {},
  nowMs = Date.now(),
  receiptId = null,
} = {}) {
  if (!result || typeof result !== 'object') throw new TypeError('buildRecallReceipt 需要 recall 结果');
  const entryById = entryMapOf(entries);
  const scoreById = new Map((result.scores ?? []).map((score) => [String(score.id), score]));
  const diagnostics = result.diagnostics ?? {};
  const ignoredAll = diagnostics.ignored ?? [];
  const ignored = ignoredAll.slice(0, MAX_RECEIPT_LIST).map(ignoredFor);
  const droppedAll = result.dropped ?? result.budget?.dropped ?? [];
  const budget = budgetOf({ budget: options.budget ?? {} });
  const requested = safeNum(result.budget?.requested, budget.maxTokens);
  const used = safeNum(result.tokens, 0);
  const maxNotes = safeNum(result.budget?.maxNotes, budget.maxNotes);
  const items = (result.items ?? []).map((item) => itemFor({ item, entry: entryById.get(String(item.id)) }));
  const nearest = (result.nearest ?? []).map((item) => nearestFor({ item, entry: entryById.get(String(item.id)) }));
  const dropped = droppedAll
    .slice(0, MAX_RECEIPT_LIST)
    .map((entry) => droppedFor({ dropped: entry, scoreById, entryById }));

  const receipt = {
    schema: RECEIPT_SCHEMA,
    kind: RECEIPT_KIND,
    receiptId: receiptId ?? `rcp_${ulid(nowMs)}`,
    createdAt: isoLocal(nowMs),
    decidedAt: isoLocal(options.nowMs ?? nowMs),
    store,
    query: String(query ?? result.query ?? ''),
    options: {
      budget: {
        maxTokens: budget.maxTokens,
        maxNotes: budget.maxNotes,
        maxChars: budget.maxChars,
        includeCore: budget.includeCore,
      },
      kinds: listOf(options.kinds),
      trusts: listOf(options.trusts),
      scope: options.scope ?? null,
      includeCore: options.includeCore !== false,
      asOf: Number.isFinite(options.asOfMs) ? isoLocal(options.asOfMs) : null,
      since: Number.isFinite(options.sinceMs) ? isoLocal(options.sinceMs) : null,
    },
    decision: {
      status: result.status ?? (result.refused ? 'insufficient_evidence' : 'ok'),
      refused: Boolean(result.refused),
      reason: result.reason ?? null,
    },
    thresholds: result.thresholds ?? null,
    coverageGate: safeNum(result.coverageGate ?? diagnostics.coverageGate),
    budget: {
      requested,
      used,
      maxNotes,
      droppedCount: safeNum(result.droppedCount, droppedAll.length),
      dropped,
    },
    items,
    nearest: result.refused ? nearest : null,
    diagnostics: {
      skipped: safeNum(diagnostics.skipped, 0),
      candidates: safeNum(diagnostics.candidates, 0),
      eligible: safeNum(diagnostics.eligible, 0),
      ignoredTotal: ignoredAll.length,
      ignoredShown: ignored.length,
      ignored,
      pulled: safeNum(diagnostics.pulled, 0),
      core: safeNum(diagnostics.core, 0),
      droppedTotal: safeNum(result.droppedCount, droppedAll.length),
      queryInfo: diagnostics.queryInfo ?? null,
      cooccurrence: diagnostics.cooccurrence ?? null,
    },
  };
  receipt.hash = receiptHash(receipt);
  return receipt;
}

const TRACKED_FIELDS = ['kind', 'trust', 'scope', 'status', 'valid_from', 'valid_to', 'superseded_by'];

function trackedReceipts(receipt) {
  return [
    ...(receipt.items ?? []).map((item) => ({ role: 'item', item })),
    ...(receipt.nearest ?? []).map((item) => ({ role: 'nearest', item })),
  ];
}

/**
 * 对照当前 entries 核验回执。
 *
 * 三种失败要分开报：
 *  - `tampered`：回执自己的 hash 对不上（回执被改过）；
 *  - `drifted`：回执没被改，但笔记正文/元数据在回执之后变了（内容漂移）；
 *  - `missing`：回执里记的笔记已经不在库里。
 * 把三种混成一句「verify 失败」，审计时就无法区分「谁改了谁」。
 */
export function verifyReceipt(receipt, entries = []) {
  const shape = receiptShapeProblems(receipt);
  if (shape.length) {
    return { ok: false, status: 'invalid', receiptId: receipt?.receiptId ?? null, ...EMPTY_CHECK, problems: shape.map((message) => ({ code: 'E_RECEIPT_SHAPE', message })) };
  }
  const computed = receiptHash(receipt);
  if (computed !== receipt.hash) {
    return {
      ok: false,
      status: 'tampered',
      receiptId: receipt.receiptId,
      ...EMPTY_CHECK,
      problems: [{ code: 'E_RECEIPT_HASH_MISMATCH', expected: receipt.hash, actual: computed }],
    };
  }

  const entryById = entryMapOf(entries);
  const changed = [];
  const missing = [];
  let matched = 0;
  const tracked = trackedReceipts(receipt);
  for (const { role, item } of tracked) {
    const id = String(item.id);
    const entry = entryById.get(id);
    if (!entry) {
      missing.push({ id, role });
      continue;
    }
    const fields = [];
    const expected = {};
    const actual = {};
    const currentHash = entryHash(entry);
    if ((item.noteSha256 ?? null) !== currentHash) {
      fields.push('noteSha256');
      expected.noteSha256 = item.noteSha256 ?? null;
      actual.noteSha256 = currentHash;
    }
    if (role === 'item') {
      for (const field of TRACKED_FIELDS) {
        const want = item[field] ?? null;
        const got = entry.note?.[field] ?? null;
        if (want !== got) {
          fields.push(field);
          expected[field] = want;
          actual[field] = got;
        }
      }
    }
    if (fields.length) {
      changed.push({ id, role, fields, expected, actual });
    } else {
      matched += 1;
    }
  }

  const status = missing.length || changed.length ? 'drifted' : 'verified';
  return {
    ok: status === 'verified',
    status,
    receiptId: receipt.receiptId,
    checked: tracked.length,
    itemsChecked: receipt.items.length,
    nearestChecked: (receipt.nearest ?? []).length,
    matched,
    changed,
    missing,
    problems: [],
  };
}

function ignoredReasonOf(ignored, receipt) {
  const thresholds = receipt.thresholds ?? {};
  const gate = safeNum(receipt.coverageGate);
  if (Number.isFinite(thresholds.minRelevance) && Number.isFinite(ignored.relevance) && ignored.relevance < thresholds.minRelevance) {
    return 'below_min_relevance';
  }
  if (Number.isFinite(thresholds.minScore) && Number.isFinite(ignored.score) && ignored.score < thresholds.minScore) {
    return 'below_min_score';
  }
  if (Number.isFinite(gate) && Number.isFinite(ignored.coverage) && ignored.coverage < gate) {
    return 'below_min_coverage';
  }
  if (ignored.cooccurrence && ignored.cooccurrence.ok === false) return 'cooccurrence_missing';
  return 'unknown';
}

/**
 * 只读回执就能给出的解释；**不重新召回、不读正文**。
 *
 * 这是和「把 recall 再跑一遍」的关键区别：解释必须对应**当时**的阈值和候选，
 * 重跑会得到今天的分数，那解释的就不是这张回执了。
 */
export function explainReceipt(receipt) {
  const problems = receiptShapeProblems(receipt);
  if (problems.length) {
    return { ok: false, status: 'invalid', receiptId: receipt?.receiptId ?? null, problems };
  }
  const diagnostics = receipt.diagnostics ?? {};
  const notRecalled = (diagnostics.ignored ?? []).map((ignored) => ({
    id: ignored.id,
    score: ignored.score ?? null,
    relevance: ignored.relevance ?? null,
    coverage: ignored.coverage ?? null,
    reason: ignoredReasonOf(ignored, receipt),
  }));
  const dropped = (receipt.budget?.dropped ?? []).map((entry) => ({
    id: entry.id,
    title: entry.title ?? '',
    reason: entry.reason ?? null,
    limitReason: entry.limitReason ?? null,
    source: entry.source ?? null,
    hard: Boolean(entry.hard),
    score: entry.score ?? null,
    relevance: entry.relevance ?? null,
    coverage: entry.coverage ?? null,
  }));
  const recalled = (receipt.items ?? []).map((item) => ({
    id: item.id,
    title: item.title ?? '',
    via: item.via ?? null,
    score: item.score ?? null,
    relevance: item.relevance ?? null,
    why: item.why ?? '',
    noteSha256: item.noteSha256 ?? null,
  }));
  const nearest = (receipt.nearest ?? []).map((item) => ({
    id: item.id,
    title: item.title ?? '',
    score: item.score ?? null,
    relevance: item.relevance ?? null,
    why: item.why ?? '',
    noteSha256: item.noteSha256 ?? null,
  }));
  const computed = receiptHash(receipt);
  return {
    ok: true,
    status: 'ok',
    receiptId: receipt.receiptId,
    createdAt: receipt.createdAt ?? null,
    query: receipt.query ?? '',
    decision: receipt.decision ?? null,
    thresholds: receipt.thresholds ?? null,
    coverageGate: receipt.coverageGate ?? null,
    summary: {
      recalled: recalled.length,
      notRecalled: notRecalled.length,
      dropped: dropped.length,
      nearest: nearest.length,
      ignoredTotal: diagnostics.ignoredTotal ?? notRecalled.length,
      ignoredTruncated: Number.isFinite(diagnostics.ignoredTotal) && Number.isFinite(diagnostics.ignoredShown)
        ? diagnostics.ignoredTotal > diagnostics.ignoredShown
        : false,
    },
    recalled,
    notRecalled,
    dropped,
    nearest,
    skipped: diagnostics.skipped ?? 0,
    integrity: { hashOk: computed === receipt.hash, computed },
  };
}
