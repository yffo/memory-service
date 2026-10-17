/**
 * 库对外的唯一入口（`06-architecture.md` 的三个原语在 M1 的最小集）。
 *
 * 四个动作的**读写属性**在这里定死，别处不许绕开：
 *
 * | 动作 | 写什么 | 什么时候写 |
 * |---|---|---|
 * | `status` | 只在 `--rebuild-index` 时写 `index/` | 显式要求时 |
 * | `search`/`recall` | **默认什么都不写** | 只有调用方显式 `ledger:true` 才追加事件 |
 * | `read` | **永远不写** | —— |
 * | `remember` | `notes/<id>.md` + 重建 `index/` | 闸门放行后 |
 *
 * 为什么 `search` 默认不写账本：账本是我们自己的审计机制，但它会**让只读操作不再是只读**
 * （只读挂载、`--store` 指向别人的库、评测跑分都不该产生副作用）。
 * 需要审计的宿主（gateway）显式打开即可，`§6.1` 要求的是「事件存在且口径一致」，
 * 不是「每次读都必须落盘」。
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  paths,
  ensureStore,
  scanStore,
  rebuildIndex,
  buildIndexText,
  writeIndexAtomic,
  writeIndexSideFile,
  readIndexFile,
  appendLedger,
  readLedger,
  statsOf,
  readStats,
  writeStats,
  INDEX_CAPS,
  STORE_CAPS,
  defaultStorePath,
  resolveStore,
} from './store/vault.js';
import { buildIndexPlan, fitRoute, readIndexTree, verifyRoutes, pointerLine, groupKeyOf } from './store/index-tree.js';
import { readNote, writeNoteAtomic, parseNoteLoose, safeNoteId, renderNote, MAX_NOTE_CHARS, MAX_NOTE_TOKENS, MAX_NOTE_BYTES } from './store/note.js';
import { ulid } from './util/ulid.js';
import { recall, searchHits, DEFAULT_THRESHOLDS, DEFAULT_TOKENS } from './core/recall.js';
import { buildRecallReceipt, explainReceipt, verifyReceipt, canonicalJson } from './core/receipt.js';
import {
  planConsolidation,
  buildConsolidateReceipt,
  sameFields,
  receiptIntegrity,
  CONSOLIDATE_UNDO_SCHEMA,
  CONSOLIDATE_HASH_LEN,
} from './core/consolidate.js';
import { writeRunPlan, writeRunReceipt, readRunReceipt, writeUndoRecord, readUndoRecord } from './store/consolidate.js';
import { writeReceipt, readReceipt } from './store/receipt.js';
import { estimateTokens } from './core/tokenize.js';
import { finiteOr, sha256 } from './util/text.js';
import { remember as runRemember, candidateFromMarkdown, buildCandidate } from './gate/remember.js';
import { planImport, applyImport } from './import/engramory.js';
import { evaluateIndexWrite } from './gate/gate.js';
import { isoLocal, nowMs as clockNow } from './util/clock.js';

export { defaultStorePath, resolveStore, paths, INDEX_CAPS, STORE_CAPS, MAX_NOTE_CHARS, MAX_NOTE_TOKENS, MAX_NOTE_BYTES };

/**
 * 「这个库被写过了」的广播表：store 路径 → 所有指向它的上下文。
 *
 * 为什么需要广播：`openStore()` 每次调用都会建**新的**扫描缓存，而 `remember()`
 * 内部是 `openStore(ctx.store)` 另起一个 ctx 去落盘。于是调用方手里那个 ctx
 * 的缓存就永远停在写之前 —— 症状是「remember 回 ok:true，紧接着 list/status
 * 还是旧数字」，非常容易被当成闸门没写成功。缓存本来只是省 IO 的优化，
 * 一旦它能让调用方看见过期真相，就必须在写路径上广播失效。
 */
const STORE_REGISTRY = new Map();

/** 让指向同一个库的**所有**上下文忘掉扫描缓存。 */
export function invalidateStore(storePath) {
  // 既能吃路径也能吃 ctx：这个函数会在写路径上被顺手调用，
  // 调用方手里往往是 ctx 而不是字符串，多一步解包就多一次忘掉的机会。
  const raw = storePath && typeof storePath === 'object' ? storePath.store : storePath;
  const key = resolveStore(raw);
  for (const ctx of STORE_REGISTRY.get(key) ?? []) ctx.invalidate();
  return key;
}

/** 建一个库上下文：所有 API 都吃它，便于测试注入路径。 */
export function openStore(storePath) {
  const store = resolveStore(storePath);
  const p = paths(store);
  let cache = null;

  const scan = ({ fresh = false } = {}) => {
    if (fresh || cache === null) cache = scanStore(store);
    return cache;
  };
  const invalidate = () => {
    cache = null;
  };

  const ctx = {
    store,
    paths: p,
    scan,
    invalidate,
    ensure: () => ensureStore(store),
    exists: () => existsSync(p.notes),
    ledger: (event) => appendLedger(store, event),
    readLedger: (opts) => readLedger(store, opts),
    writeNote: (id, text) => writeNoteAtomic(store, id, text),
    rebuildIndex: () => {
      const s = scan({ fresh: true });
      // 不盖时间戳：索引必须是 `notes/` 的**纯函数**，否则「删掉 index/ 重建，
      // 结果 hash 必须一致」（§6.3 的 CI 判据）第一次跑就会红 —— 内容一样、时间戳不一样。
      // 时间落在 `index/stats.json`（那是账，本来就该有「什么时候扫的」）。
      const plan = fitRoute({
        plan: buildIndexPlan(s, { caps: INDEX_CAPS }),
        caps: INDEX_CAPS,
        scan: s,
      });
      const current = readIndexFile(store);
      const next = { lines: countLines(plan.routeText), bytes: Buffer.byteLength(plan.routeText) };
      const gate = evaluateIndexWrite({ current, next, caps: INDEX_CAPS });
      if (gate.verdict !== 'allow') {
        // 路由层过不了闸门：真相源已经改了，索引保持旧版本并记账（宁可报错，不静默截断）。
        appendLedger(store, { kind: 'index_write_denied', reason: gate.reason, ...compact(next) });
        return {
          ok: false,
          path: p.memory,
          lines: current.lines,
          bytes: current.bytes,
          truncated: true,
          denied: gate,
        };
      }
      // 先写清单层再写路由层：路由是入口，入口指向的文件必须先存在。
      // 顺序反了的话，读索引的人会有一瞬间点到 404 —— 幂等重建时同样要知道这个次序。
      const side = plan.listFiles.map((f) => writeIndexSideFile(store, f.rel, f.text));
      const failed = side.filter((w) => !w.ok);
      if (failed.length > 0) {
        appendLedger(store, { kind: 'index_side_write_failed', count: failed.length });
        return {
          ok: false,
          path: p.memory,
          error: failed[0].error,
          lines: current.lines,
          bytes: current.bytes,
          truncated: true,
        };
      }
      const written = writeIndexAtomic(store, plan.routeText);
      writeStats(store, statsOf(s));
      const total = s.notes.length;
      return {
        ...written,
        lines: next.lines,
        bytes: next.bytes,
        truncated: plan.hidden > 0,
        hidden: plan.hidden,
        // 分层索引的账：路由几组、几个清单文件、列了多少条、路由层丢了几个组。
        routed: plan.listed,
        groups: plan.groupCount,
        levels: plan.levels,
        files: plan.listFiles.length,
        routeDropped: plan.routeDropped ?? [],
        reason: gate.reason,
      };
    },
  };

  // 同一个库路径可能有多个 ctx（`remember()` 内部就会再开一个）。
  // 登记 + 返回，写路径上靠 `invalidateStore()` 广播失效。
  const bucket = STORE_REGISTRY.get(store) ?? new Set();
  bucket.add(ctx);
  STORE_REGISTRY.set(store, bucket);
  return ctx;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v !== 'object') out[k] = v;
  return out;
}

/** 一份文本的行数（与 `readIndexFile` 同一口径：末尾换行不算一行）。 */
function countLines(text) {
  return text === '' ? 0 : String(text).replace(/\n$/, '').split('\n').length;
}

/**
 * `tabellio status --json`。
 *
 * 冻结字段：`{store, notes, indexLines, caps}`。其余字段都是**账**，
 * 账是 `status` 存在的理由（旧项目「读不完的笔记必须能被 status 看见」）：
 *  - `failures` / `parseFailures`：读不出来的文件（fail-closed 的代价必须可见）；
 *  - `oversizeChars` / `oversizeTokens`：超过核心档上限的笔记（会在裁剪时被切）；
 *  - `indexTruncated` / `indexHidden`：索引行数装不下的笔记；
 *  - `ledgerEntries` / `ledgerMalformed`：事件账本的可读性。
 */
export function status(ctx, options = {}) {
  const rebuild = Boolean(options.rebuildIndex);
  let indexWrite = null;
  if (rebuild) indexWrite = ctx.rebuildIndex();

  const scan = ctx.scan({ fresh: rebuild });
  const index = readIndexFile(ctx.store);
  const stats = readStats(ctx.store);
  const ledger = ctx.readLedger({ limit: 0 });
  const malformed = ledger.filter((e) => e.kind === 'malformed').length;

  const oversizeChars = scan.notes.filter((n) => [...String(n.body)].length > MAX_NOTE_CHARS).length;
  const oversizeTokens = scan.notes.filter((n) => estimateTokens(n.body) > MAX_NOTE_TOKENS).length;
  const total = scan.notes.length;
  // 分层索引的账走**磁盘上的真实文件**（不信内存里的计划）：
  // 「计划对了但没写全」这种失败必须能被 status 看见，否则它就是下一次的静默盲区。
  const tree = readIndexTree(ctx.store, { caps: INDEX_CAPS });
  const indexListed = tree.listed;
  // 路由层里所有组报的条数之和 = 索引层认为「库里有这些条」。它与真实笔记数不符时，
  // 说明索引是旧的（真相源改了、索引没重建）—— 这是比「列不下」更该叫出来的事。
  const indexed = tree.route.routed;
  const indexTruncated = index.exists ? indexListed < total : false;

  const result = {
    ok: true,
    store: ctx.store,
    notes: total,
    indexLines: index.lines,
    // 冻结字段之外的第一个契约字段：**索引层列了多少条**。旧库（平铺索引）下
    // 它等于 `indexListed`；分层索引下它是「所有清单文件加起来列了多少条」。
    // 加这个字段是因为「读索引这条路还瞎不瞎」必须有个一眼能看的数。
    indexListed,
    caps: {
      notes: STORE_CAPS.maxNotes,
      noteBytes: STORE_CAPS.maxNoteBytes,
      noteChars: MAX_NOTE_CHARS,
      noteTokens: MAX_NOTE_TOKENS,
      indexLines: INDEX_CAPS.maxLines,
      indexBytes: INDEX_CAPS.maxBytes,
    },
    // ── 以下是账 ──
    indexBytes: index.bytes,
    indexExists: index.exists,
    indexTruncated,
    indexHidden: indexTruncated ? Math.max(0, total - indexListed) : 0,
    // 分层索引（Task 1）：路由几组、几个清单文件、索引层的条数对不对得上真相源。
    indexLayers: tree.route.exists ? (tree.files > 0 ? 2 : 1) : 0,
    indexGroups: tree.route.groups,
    indexRoutes: tree.route.entries ?? [],
    indexListFiles: tree.files,
    indexStale: index.exists ? indexed !== total : false,
    candidates: scan.candidates.length,
    failures: scan.failures.map((f) => ({
      id: f.id,
      path: f.path,
      codes: (f.errors ?? []).map((e) => e.code),
      messages: (f.errors ?? []).map((e) => e.message),
    })),
    parseFailures: scan.failures.length,
    oversizeChars,
    oversizeTokens,
    bytes: scan.bytes,
    coreNotes: scan.notes.filter((n) => n.note.kind === 'core').length,
    ledgerEntries: ledger.length - malformed,
    ledgerMalformed: malformed,
    lastScan: stats,
    indexWrite: indexWrite ? compact(indexWrite) : null,
    warnings: buildWarnings({ scan, index, total, oversizeChars, oversizeTokens, indexListed, indexed }),
  };
  return result;
}

function buildWarnings({ scan, index, total, oversizeChars, oversizeTokens, indexListed = 0, indexed = null }) {
  const w = [];
  if (scan.failures.length) w.push(`${scan.failures.length} 个文件解析失败（fail-closed，已退出检索面）`);
  if (oversizeChars) w.push(`${oversizeChars} 条笔记超过 ${MAX_NOTE_CHARS} 字（检索按 400 字切桶）`);
  if (oversizeTokens) w.push(`${oversizeTokens} 条笔记超过 ${MAX_NOTE_TOKENS} token`);
  if (index.exists && indexListed < total) {
    // 分层索引之后这句警告的含义变了：不再是「索引装不下」，而是「有笔记没有路可走」。
    // 路由树把容量从 ~190 条提到 ~76000 条，正常库里**不该**再看到这句；
    // 看到就是路由层真的削了（组多到打包都装不下），必须查 `tabellio index --json`。
    w.push(
      `索引层只列了 ${indexListed}/${total} 条（路由层上限 ${INDEX_CAPS.maxLines} 行 / ${INDEX_CAPS.maxBytes} 字节），` +
        '其余笔记仍在 notes/ 里、检索不受影响，但「读索引」这条路径看不到它们（见 `tabellio index --json`）',
    );
  }
  if (index.exists && Number.isFinite(indexed) && indexed !== total) {
    w.push(
      `索引是旧的：路由层记着 ${indexed} 条、库里有 ${total} 条（跑 \`memory status --rebuild-index\` 重建）`,
    );
  }
  if (!index.exists) w.push('索引还没生成（跑 `tabellio status --rebuild-index`）');
  return w;
}

/**
 * 索引层的账（`tabellio index --json` 的全部内容；`status` 用的是它的一部分）。
 *
 * **只读**：不带 `--rebuild` 时一个字都不写。为什么单开一条命令而不是塞进 `status`：
 * `status` 的契约字段已经冻结（`{store, notes, indexLines, caps}`），而索引层的账
 * （路由几组、每组的清单文件、哪些笔记没路可走）是**索引自己的体检报告**，
 * 塞进 status 会让「库大不大」和「索引好不好」两件事挤在一个输出里。
 *
 * 三个数必须能对上，否则就是有鬼：
 *  - `total`：`notes/` 里能解析的条数（真相源）
 *  - `listed`：清单层真正列出来的条数（磁盘上的指针行数之和）
 *  - `reachable`：从 `MEMORY.md` 出发、顺着链接真能走到的条数（`verifyRoutes` 的实测）
 * 健康状态是三者相等且 `routeHidden === 0`。
 */
export function indexReport(ctx, options = {}) {
  const rebuild = Boolean(options.rebuild);
  let write = null;
  if (rebuild) write = ctx.rebuildIndex();

  const scan = ctx.scan({ fresh: rebuild });
  const total = scan.notes.length;
  const route = readIndexFile(ctx.store);
  const tree = readIndexTree(ctx.store, { caps: INDEX_CAPS });
  const verify = verifyRoutes(ctx.store);
  const unreachable = scan.notes.filter((n) => !verify.ids.has(n.id)).map((n) => n.id);

  const byGroup = new Map();
  for (const n of scan.notes) {
    const key = groupKeyOf(n.id);
    byGroup.set(key, (byGroup.get(key) ?? 0) + 1);
  }

  return {
    ok: true,
    store: ctx.store,
    notes: total,
    // ── 索引层 ──
    exists: route.exists,
    lines: route.lines,
    bytes: route.bytes,
    caps: { lines: INDEX_CAPS.maxLines, bytes: INDEX_CAPS.maxBytes, listLines: LIST_CAPS.maxLines },
    levels: tree.route.exists ? (tree.files > 0 ? 2 : 1) : 0,
    groups: byGroup.size,
    routes: tree.route.entries ?? [],
    listFiles: tree.lists,
    listed: tree.listed,
    // 路由层装不下被削掉的条目数（正常为 0；组数超过路由预算、打包也救不了时才会 > 0）。
    hidden: Math.max(0, total - tree.listed),
    reachable: verify.reachable,
    unreachable: unreachable.slice(0, 50),
    unreachableCount: unreachable.length,
    missingFiles: verify.missingFiles ?? [],
    stale: route.exists ? (tree.route.routed !== total) : false,
    write: write ? compact(write) : null,
    warnings: buildIndexWarnings({ route, total, listed: tree.listed, unreachable: unreachable.length, verify }),
  };
}

function buildIndexWarnings({ route, total, listed, unreachable, verify }) {
  const w = [];
  if (!route.exists) {
    w.push('索引还没生成（跑 `tabellio index --rebuild`）');
    return w;
  }
  if (verify.reason === 'list_file_missing') {
    w.push(`路由层指向的清单文件不存在：${(verify.missingFiles ?? []).slice(0, 3).join('、')}（重建索引）`);
  }
  if (unreachable > 0) {
    // 两种成因要分开说，不然人会去修错误的那一层：
    //   ① 路由层压根没有（旧的平铺索引 / 从没重建过）→ 逐条都走不到；
    //   ② 路由层在，但组数超过路由预算、打包也救不下 → 真被削了。
    // 报同一句「被削了」会让人明明什么都没削却在找削点。
    w.push(
      verify.reachable === 0
        ? `${unreachable} 条笔记从索引走不到（索引还是旧的平铺形态，跑 \`memory index --rebuild\` 换成分层索引）`
        : `${unreachable} 条笔记从索引走不到（路由层装不下被削了）`,
    );
  }
  if (listed < total && verify.reachable > 0) w.push(`清单层列了 ${listed}/${total} 条`);
  return w;
}

// 清单层的行上限（与 `index-tree.js` 的默认值同源；写在这里只是为了报告里有数）。
const LIST_CAPS = Object.freeze({ maxLines: 400 });
/** 从选项里解出检索参数（CLI / MCP 共用，保证两边口径一致）。 */
export function recallOptions(options = {}) {
  return {
    budget: {
      maxTokens:
        finiteOr(options.budgetTokens, finiteOr(options['budget-tokens'], finiteOr(options.maxTokens, DEFAULT_TOKENS))),
      maxNotes: finiteOr(options.maxNotes, undefined),
      maxChars: finiteOr(options.maxChars, undefined),
      includeCore: options.includeCore !== false,
    },
    kinds: options.kinds,
    trusts: options.trusts,
    scope: options.scope,
    asOfMs: options.asOfMs ?? null,
    sinceMs: options.sinceMs ?? null,
    minRelevance: options.minRelevance,
    minCoverage: options.minCoverage,
    minScore: options.minScore,
    nowMs: options.nowMs ?? clockNow(),
    includeCore: options.includeCore !== false,
  };
}

/**
 * `tabellio recall`（完整形状）。`§9` 的返回：`items` / `budget` / `why_not` / `nearest`。
 */
export function recallQuery(ctx, query, options = {}) {
  const normalized = recallOptions(options);
  const scan = ctx.scan();
  const result = recall({ entries: scan.notes, query, options: normalized });

  // 回执是**可选**的：默认 recall 仍然只读、也不多生成对象。只有显式
  // --receipt / --save-receipt 时才 build；--save-receipt 才落 runs/。
  let receipt = null;
  let receiptPath = null;
  let receiptError = null;
  if (options.receipt || options.saveReceipt) {
    receipt = buildRecallReceipt({
      result,
      entries: scan.notes,
      store: ctx.store,
      query,
      options: normalized,
      nowMs: normalized.nowMs,
    });
    if (options.saveReceipt) {
      try {
        ctx.ensure();
        const saved = writeReceipt(ctx.store, receipt);
        if (saved.ok) receiptPath = saved.path;
        else receiptError = saved.error;
      } catch (err) {
        receiptError = { code: 'E_RECEIPT_WRITE', message: err?.message ?? String(err) };
      }
    }
  }

  if (options.ledger) {
    ctx.ledger({
      kind: result.refused ? 'recall_refused' : 'recall',
      query,
      hits: result.items.map((i) => i.id),
      tokens: result.tokens,
      refused: result.refused,
      reason: result.reason,
      dropped: result.dropped,
      // 账本里只记 id，不复制整张回执；回执本体在 runs/ 里。
      receipt_id: receipt?.receiptId ?? null,
    });
  }
  const out = {
    ...result,
    parseFailures: scan.failures.length,
    store: ctx.store,
    notes: scan.notes.length,
  };
  if (receipt) {
    out.receipt = receipt;
    if (receiptPath) out.receiptPath = receiptPath;
    if (receiptError) out.receiptError = receiptError;
  }
  return out;
}

/**
 * `tabellio verify`：核验一张已落盘/指定的回执是否仍与当前笔记一致。
 *
 * 三种状态分开报（tampered / drifted / verified），不把「回执被改」和
 * 「笔记变了」混成同一个失败。
 */
export function verifyRecallReceipt(ctx, ref) {
  const got = readReceipt(ctx.store, ref);
  if (!got.ok) {
    return {
      ok: false,
      status: 'unreadable',
      receiptId: null,
      path: got.error?.path ?? null,
      error: got.error,
    };
  }
  const scan = ctx.scan();
  const verification = verifyReceipt(got.receipt, scan.notes);
  return {
    ...verification,
    path: got.path,
    store: ctx.store,
    receiptStore: got.receipt.store ?? null,
    storeMismatch: Boolean(got.receipt.store && got.receipt.store !== ctx.store),
    query: got.receipt.query ?? '',
    createdAt: got.receipt.createdAt ?? null,
  };
}

/**
 * `tabellio explain`：要么按一张回执解释，要么按查询现场生成一张**不落盘**的
 * 回执再解释。两种模式返回同一套字段，调用方不用写两套读法。
 */
export function explainRecall(ctx, { query = null, receiptRef = null, options = {} } = {}) {
  const hasQuery = typeof query === 'string' && query.trim().length > 0;
  const hasReceipt = typeof receiptRef === 'string' && receiptRef.trim().length > 0;
  if (hasQuery === hasReceipt) {
    return {
      ok: false,
      status: 'invalid',
      error: { code: 'E_EXPLAIN_INPUT', message: 'explain 需要且只需要 --query 或 --receipt 之一' },
    };
  }

  if (hasReceipt) {
    const got = readReceipt(ctx.store, receiptRef);
    if (!got.ok) {
      return { ok: false, status: 'unreadable', receiptId: null, path: got.error?.path ?? null, error: got.error };
    }
    const scan = ctx.scan();
    const verification = verifyReceipt(got.receipt, scan.notes);
    return {
      ok: true,
      status: 'ok',
      mode: 'receipt',
      receiptId: got.receipt.receiptId,
      receiptPath: got.path,
      createdAt: got.receipt.createdAt ?? null,
      query: got.receipt.query ?? '',
      decision: got.receipt.decision ?? null,
      explanation: explainReceipt(got.receipt),
      verification,
      store: ctx.store,
      notes: scan.notes.length,
    };
  }

  const text = query.trim();
  // 现场解释是只读的：force receipt 以便解释，但绝不落盘。
  const result = recallQuery(ctx, text, { ...options, receipt: true, saveReceipt: false });
  const scan = ctx.scan();
  const verification = verifyReceipt(result.receipt, scan.notes);
  return {
    ok: true,
    status: 'ok',
    mode: 'query',
    receiptId: result.receipt.receiptId,
    receiptPath: null,
    createdAt: result.receipt.createdAt ?? null,
    query: text,
    decision: result.receipt.decision ?? null,
    explanation: explainReceipt(result.receipt),
    verification,
    store: ctx.store,
    notes: scan.notes.length,
  };
}

/**
 * `tabellio search --json`。**冻结形状**：
 * `{hits:[{id,title,score}], tokens, refused:boolean, reason}`。
 *
 * 这是 `recall` 的投影（同一个函数内部投影，不是第二套检索），
 * 所以两个命令报的数字永远一致。
 */
export function search(ctx, query, options = {}) {
  const scan = ctx.scan();
  const { hits, tokens, refused, reason, result } = searchHits({
    entries: scan.notes,
    query,
    options: recallOptions(options),
  });
  if (options.ledger) {
    ctx.ledger({
      kind: refused ? 'search_refused' : 'search',
      query,
      hits: hits.map((h) => h.id),
      tokens,
      refused,
      reason,
    });
  }
  return {
    hits,
    tokens,
    refused,
    reason,
    // 冻结契约之外的诊断字段：评测器与 `explain` 需要，但调用方只依赖上面四个。
    diagnostics: {
      store: ctx.store,
      notes: scan.notes.length,
      parseFailures: scan.failures.length,
      candidates: result.candidates,
      thresholds: result.thresholds,
      nearest: result.nearest,
      skipped: result.skipped,
      dropped: result.dropped,
      // 查询侧口径：哪些词项算「证据」、覆盖率的分母是不是塌了。
      // 拒答时最该看的就是这个 —— `reason: 'no_informative_term'` 的含义全在这一行里。
      queryInfo: result.diagnostics?.queryInfo ?? null,
      why: result.items.map((i) => ({ id: i.id, why: i.why, via: i.via, score: i.score?.total ?? null })),
    },
  };
}

/**
 * `tabellio read --id <file> --json`。**冻结形状**：`{id, title, body}`。
 * 永远只读；读不到或解析失败时 `ok:false` 且 `reason` 有值（不抛异常）。
 */
export function read(ctx, id, options = {}) {
  // id 归一与安全判定都在 store 层（`safeNoteId`）：那里是文件系统的唯一入口，
  // 把它复制到 API 层就会出现「两个地方各判断一次、迟早不一致」的经典裂缝。
  const cleanId = String(id ?? '').replace(/^notes\//, '').replace(/\.md$/, '');
  const got = readNote(ctx.store, id);
  if (!got.ok) {
    return { ok: false, id: cleanId, title: null, body: null, reason: got.errors[0]?.code ?? 'E_NOT_FOUND', errors: got.errors };
  }
  const out = {
    ok: true,
    id: cleanId,
    title: got.title,
    body: got.body,
    note: got.note,
    warnings: got.warnings,
    path: got.path,
  };
  if (options.withText) out.text = got.text;
  return out;
}

/**
 * `tabellio remember`。冻结形状：`{ok, verdict:'allow'|'deny', reason}`。
 *
 * 输入三选一：`--file <md>`（必须有）/ 直接给 `content` / 给 `candidate`（程序内调用）。
 * `--dry` 走同一条判定，只是不落盘——**dry 与真写的判定必须是同一个函数**，
 * 否则「先 dry 看看」就成了骗人的。
 */
export function remember(ctx, input = {}, options = {}) {
  // 复用调用方手里那个 ctx（它自带扫描缓存），而不是每次重开一个。
  // 重开一个的代价不是「多一行代码」：`openStore()` 的 ctx 缓存是空的，
  // 于是每一笔写入都把整个库重扫一遍 —— 导入 1300 条时这是 O(n²) 次 `readdir`
  // 加 `stat`，实测一分钟都跑不完（而正确实现是秒级）。
  const store = ctx?.scan ? ctx : openStore(ctx.store);
  const now = options.nowMs ?? clockNow();
  const defaults = {
    id: options.id,
    scope: options.scope ?? 'user',
    scopeDetail: options.scopeDetail ?? null,
    kind: options.kind ?? 'semantic',
    trust: options.trust ?? 'user_stated',
    tags: options.tags ?? [],
    writtenBy: options.writtenBy ?? 'cli:remember',
    sourceRef: options.sourceRef ?? null,
    validFrom: options.validFrom ?? isoLocal(now),
    subject: options.subject ?? null,
    predicate: options.predicate ?? null,
    confidence: options.confidence,
  };

  let candidate;
  let body;
  if (input.candidate) {
    candidate = input.candidate;
    body = input.body ?? candidate.body ?? '';
  } else if (input.content !== undefined) {
    body = String(input.content ?? '');
    candidate = null;
  } else {
    const parsed = parseNoteLoose(String(input.text ?? ''));
    body = parsed.body;
    candidate = candidateFromMarkdown(String(input.text ?? ''), { defaults, id: defaults.id }).note;
  }
  if (!candidate) {
    // 直接给 `content` 的路径：还要从正文里认一下有没有 `# 标题` 之外的 frontmatter 语义
    // （这里没有 frontmatter，全部走 defaults）
    candidate = buildCandidate({ frontmatter: null, body, defaults }).note;
  }
  if (!candidate.id) candidate.id = ulid(now);
  // 闸门读的是 `candidate.body`（`evaluateWrite` 的长度/指纹判定都基于它），
  // 而 `buildCandidate` 只回 `{note, body}`。在这里补齐，避免两处各读一个字段。
  candidate.body = String(body ?? '').trimEnd();

  // 正文里的 frontmatter 若与默认值冲突，以**文件里的**为准（人手写的是更强的意图）。
  const dry = Boolean(options.dry);
  const result = runRemember(
    {
      scan: () => store.scan(),
      writeNote: (id, text) => store.writeNote(id, text),
      rebuildIndex: () => store.rebuildIndex(),
      ledger: (event) => store.ledger(event),
      relPath: (id) => `notes/${id}.md`,
    },
    {
      candidate,
      body,
      options: { dry, force: options.force, limits: options.limits, skipIndex: options.skipIndex },
    },
  );

  // 写成功就广播失效：调用方手里那个 ctx 的缓存必须跟着作废，
  // 否则「回 ok:true 但 list/status 还是旧数字」这种自相矛盾的状态会出现。
  // dry-run 不落盘，也就没什么可失效的（但代价极低，顺手做掉更不容易忘）。
  if (result.ok && !dry) invalidateStore(store);
  return result;
}

function metaOf(note) {
  return {
    status: note?.status ?? 'active',
    valid_to: note?.valid_to ?? null,
    superseded_by: note?.superseded_by ?? null,
  };
}

function bodySha(entry) {
  return sha256(String(entry?.body ?? ''), 16);
}

function restoreApplied(store, applied) {
  const restored = [];
  const failed = [];
  for (const op of [...applied].reverse()) {
    const fresh = readNote(store, op.id);
    if (!fresh.ok) {
      failed.push({ id: op.id, reason: 'read_failed', error: fresh.errors?.[0] ?? null });
      continue;
    }
    if (bodySha(fresh) !== op.after.body_sha256) {
      failed.push({ id: op.id, reason: 'body_changed' });
      continue;
    }
    if (!sameFields(metaOf(fresh.note), op.after)) {
      failed.push({ id: op.id, reason: 'fields_changed' });
      continue;
    }
    const updated = { ...fresh.note, ...metaOf(op.before) };
    const text = renderNote(updated, fresh.body);
    const written = writeNoteAtomic(store, op.id, text);
    if (!written.ok) {
      failed.push({ id: op.id, reason: 'write_failed', error: written.error });
      continue;
    }
    restored.push(op.id);
  }
  return { ok: failed.length === 0, restored: restored.reverse(), failed };
}

function undoRecordHash(record) {
  const { hash: _ignored, ...unsigned } = record ?? {};
  return sha256(canonicalJson(unsigned), CONSOLIDATE_HASH_LEN);
}

/**
 * `tabellio consolidate`：M2 的显式巩固。
 *
 * 默认 dry-run，只产出计划，不改任何笔记。`--apply` 才落盘：
 *   1. 先写 `runs/<run>.plan.json`（决策留痕）；
 *   2. 逐条执行 `invalidate` / `archive`（只改元数据，正文不动）；
 *   3. 写巩固回执；回执写失败则回滚已改的笔记，绝不留下「改了但没账」的状态。
 *
 * 5% 改动上限是保险丝，不是配额：超限时连 apply 也不做，返回 aborted 计划。
 */
export function consolidate(ctx, options = {}) {
  const apply = options.apply === true || options.dryRun === false;
  const nowMs = options.nowMs ?? clockNow();
  const scan = ctx.scan();
  const plan = planConsolidation({
    entries: scan.notes,
    nowMs,
    maxChangeRatio: options.maxChangeRatio,
    scope: options.scope,
    kinds: options.kinds,
    runId: options.runId,
    archiveIds: options.archive ?? options.archiveIds,
  });
  const { runId, ...planRest } = plan;
  if (!plan.ok) return { ...planRest, run_id: runId, dry_run: !apply, applied: 0 };
  if (!apply) return { ...planRest, run_id: runId, dry_run: true, applied: 0 };

  ctx.ensure();
  const planSaved = writeRunPlan(ctx.store, plan);
  if (!planSaved.ok) {
    return {
      ok: false,
      status: 'aborted',
      reason: 'plan_write_failed',
      run_id: plan.runId,
      operations: plan.operations,
      error: planSaved.error,
    };
  }

  const applied = [];
  const skipped = [...(plan.skipped ?? [])];
  for (const op of plan.operations) {
    const fresh = readNote(ctx.store, op.id);
    if (!fresh.ok) {
      skipped.push({ id: op.id, reason: 'read_failed', error: fresh.errors?.[0] ?? null });
      continue;
    }
    if (bodySha(fresh) !== op.before.body_sha256) {
      skipped.push({ id: op.id, reason: 'body_changed' });
      continue;
    }
    if (!sameFields(metaOf(fresh.note), op.before)) {
      skipped.push({ id: op.id, reason: 'fields_changed' });
      continue;
    }
    const updated = { ...fresh.note, ...metaOf(op.after) };
    const text = renderNote(updated, fresh.body);
    const written = writeNoteAtomic(ctx.store, op.id, text);
    if (!written.ok) {
      skipped.push({ id: op.id, reason: 'write_failed', error: written.error });
      continue;
    }
    applied.push({
      ...op,
      before_text_sha256: sha256(fresh.text, 16),
      after_text_sha256: sha256(text, 16),
      path: written.path,
    });
  }

  const receipt = buildConsolidateReceipt({ plan, store: ctx.store, applied, skipped, nowMs });
  const receiptSaved = writeRunReceipt(ctx.store, receipt);
  if (!receiptSaved.ok) {
    // 没有回执的写入是 bug（§4.2 护栏 1）。回执写不进去，就把已经改掉的
    // 元数据恢复原样；恢复也失败时必须如实报 partial，不能假装成功。
    const rollback = restoreApplied(ctx.store, applied);
    invalidateStore(ctx.store);
    return {
      ok: false,
      status: 'aborted',
      reason: 'receipt_write_failed',
      run_id: plan.runId,
      plan_path: planSaved.path,
      dry_run: false,
      stats: { ...plan.stats, applied: 0, skipped: skipped.length, failed: 0 },
      error: receiptSaved.error,
      rolled_back: rollback.ok,
      rollback,
      applied: 0,
    };
  }
  invalidateStore(ctx.store);
  return {
    ok: true,
    status: 'applied',
    run_id: plan.runId,
    plan_path: planSaved.path,
    receipt_path: receiptSaved.path,
    dry_run: false,
    stats: { ...plan.stats, applied: applied.length, skipped: skipped.length, failed: 0 },
    applied: applied.length,
    skipped: skipped.length,
    skipped_detail: skipped,
    reversible: true,
    operations: applied,
    receipt,
  };
}

/**
 * `tabellio consolidate --undo <run>`：撤销一次巩固。
 *
 * 先全量预检、再动手：只要有一条笔记的当前状态不是回执里的 after，就整单拒绝，
 * 不做「能撤几条撤几条」的部分撤销。撤销本身也只恢复元数据，正文不动。
 */
export function undoConsolidation(ctx, ref, options = {}) {
  const got = readRunReceipt(ctx.store, ref);
  if (!got.ok) {
    return { ok: false, status: 'unreadable', run_id: null, error: got.error };
  }
  const receipt = got.receipt;
  const integrity = got.integrity ?? receiptIntegrity(receipt);
  if (!integrity.ok) {
    return {
      ok: false,
      status: 'tampered',
      run_id: receipt.runId,
      receipt_path: got.path,
      problems: integrity.problems,
    };
  }

  const prior = readUndoRecord(ctx.store, receipt.runId);
  if (prior.ok) {
    return {
      ok: true,
      status: 'already_undone',
      run_id: receipt.runId,
      receipt_path: got.path,
      undo_path: prior.path,
      restored: 0,
      skipped: (receipt.operations ?? []).length,
    };
  }

  const restorable = [];
  const skipped = [];
  const conflicts = [];
  for (const op of [...(receipt.operations ?? [])].reverse()) {
    const fresh = readNote(ctx.store, op.id);
    if (!fresh.ok) {
      conflicts.push({ id: op.id, reason: 'missing' });
      continue;
    }
    const current = metaOf(fresh.note);
    if (bodySha(fresh) !== op.after.body_sha256) {
      conflicts.push({ id: op.id, reason: 'body_changed' });
      continue;
    }
    if (sameFields(current, op.before)) {
      skipped.push({ id: op.id, reason: 'already_restored' });
      continue;
    }
    if (!sameFields(current, op.after)) {
      conflicts.push({ id: op.id, reason: 'fields_changed', expected: op.after, actual: current });
      continue;
    }
    restorable.push({ op, fresh });
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      status: 'conflict',
      run_id: receipt.runId,
      receipt_path: got.path,
      conflicts,
      restored: 0,
    };
  }

  const restored = [];
  const failed = [];
  for (const { op, fresh } of restorable) {
    const updated = { ...fresh.note, ...metaOf(op.before) };
    const text = renderNote(updated, fresh.body);
    const written = writeNoteAtomic(ctx.store, op.id, text);
    if (!written.ok) {
      failed.push({ id: op.id, reason: 'write_failed', error: written.error });
      continue;
    }
    restored.push(op.id);
  }

  if (failed.length > 0) {
    invalidateStore(ctx.store);
    return {
      ok: false,
      status: 'partial',
      run_id: receipt.runId,
      receipt_path: got.path,
      restored,
      failed,
    };
  }

  const record = {
    schema: CONSOLIDATE_UNDO_SCHEMA,
    runId: receipt.runId,
    createdAt: isoLocal(options.nowMs ?? clockNow()),
    store: ctx.store,
    receipt_hash: receipt.hash,
    restored,
    skipped,
  };
  record.hash = undoRecordHash(record);
  const saved = writeUndoRecord(ctx.store, record);
  invalidateStore(ctx.store);
  if (!saved.ok) {
    return {
      ok: false,
      status: 'undo_record_write_failed',
      run_id: receipt.runId,
      receipt_path: got.path,
      restored,
      error: saved.error,
    };
  }
  return {
    ok: true,
    status: restored.length > 0 ? 'undone' : 'already_undone',
    run_id: receipt.runId,
    receipt_path: got.path,
    undo_path: saved.path,
    restored: restored.length,
    skipped: skipped.length,
    operations: restored,
  };
}

/** 库的初始化（`tabellio status` 会顺手做，不单独暴露命令）。 */
export function initStore(storePath) {
  const p = ensureStore(storePath);
  const index = readIndexFile(p.store);
  if (!index.exists) {
    const scan = scanStore(p.store);
    rebuildIndex(p.store, { scan });
  }
  return p;
}

/**
 * `tabellio import --from <engramory 库> [--dry]`。
 *
 * 读源库 → 生成计划 → 逐条过闸门写入。`--dry` 与真写走**同一套判定**，
 * 区别只在最后落不落盘（`applyImport({dry:true})`）。
 */
export function importFrom(ctx, sourceDir, options = {}) {
  const plan = planImport(sourceDir, {
    existing: ctx.scan().notes,
    nextId: () => ulid(options.nowMs ?? clockNow()),
    now: options.nowMs ?? clockNow(),
  });
  const result = applyImport(ctx, plan, {
    dry: Boolean(options.dry),
    force: Boolean(options.force),
    remember: (input, opts) => remember(ctx, input, { ...opts, ...(options.rememberOptions ?? {}) }),
    ledger: (event) => ctx.ledger(event),
  });
  return { ...result, plan: options.withPlan ? plan : undefined };
}

export {
  recall,
  searchHits,
  buildIndexText,
  statsOf,
  writeStats,
  parseNoteLoose,
  planImport,
  applyImport,
  DEFAULT_THRESHOLDS,
  DEFAULT_TOKENS,
};
