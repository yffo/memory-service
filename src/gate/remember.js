/**
 * 闸门之上的一层：把「一次写入请求」变成「一个候选 + 一次判定 +（可能）一次落盘」。
 *
 * 分工：
 *  - `gate/gate.js`：纯判定，不碰 IO；
 *  - 本文件：IO 编排（扫描既有内容 → 判定 → 原子写 → 重建索引 → 记账）。
 *
 * 「重建索引」放在写入之后是刻意的：索引是生成物，它必须**跟得上真相源**，
 * 而且重建失败不该让写入回滚——真相源已经改了，索引晚一步重建只是难看，不是坏事。
 * 重建失败会记进账本（`index_rebuild_failed`），`status` 能看见。
 */
import { evaluateWrite, contentFingerprint, DEFAULT_LIMITS } from './gate.js';
import { parseNoteLoose, renderNote } from '../store/note.js';

export { contentFingerprint };

/**
 * 把一个「候选输入」归一化成完整 note 对象。
 *
 * @param {object} input
 * @param {object} [input.frontmatter] 已有的 frontmatter（来自 md 文件）
 * @param {string}  input.body
 * @param {object}  [input.defaults]   CLI/MCP 给的默认值
 * @param {number}  [input.nowMs]
 * @param {() => string} [input.nextId] 生成 id（注入，便于确定性测试）
 */
export function buildCandidate({ frontmatter = null, body = '', defaults = {}, nowMs = Date.now(), nextId } = {}) {
  const fm = frontmatter ?? {};
  const id = String(fm.id ?? defaults.id ?? (nextId ? nextId() : ''));
  const scopeDetail = defaults.scopeDetail ?? null;
  const base = {
    schema: 'memory.note/1',
    id,
    scope: fm.scope ? String(fm.scope).split(':')[0] : defaults.scope ?? 'user',
    scope_detail: scopeDetail ?? (typeof fm.scope === 'string' && fm.scope.includes(':') ? fm.scope.split(':')[1] : null),
    kind: fm.kind ?? defaults.kind ?? 'semantic',
    trust: fm.trust ?? defaults.trust ?? 'user_stated',
    status: fm.status ?? defaults.status ?? 'active',
    confidence: typeof fm.confidence === 'number' ? fm.confidence : defaults.confidence ?? 0.9,
    valid_from: fm.valid_from ?? defaults.validFrom ?? null,
    valid_to: fm.valid_to ?? null,
    supersedes: Array.isArray(fm.supersedes) ? fm.supersedes : defaults.supersedes ?? [],
    superseded_by: fm.superseded_by ?? null,
    verify_after: fm.verify_after ?? defaults.verifyAfter ?? null,
    tags: Array.isArray(fm.tags) ? fm.tags : defaults.tags ?? [],
    subject: fm.subject ?? defaults.subject ?? null,
    predicate: fm.predicate ?? defaults.predicate ?? null,
    provenance: {
      written_by: fm.provenance?.written_by ?? defaults.writtenBy ?? 'unknown',
      source_ref: fm.provenance?.source_ref ?? defaults.sourceRef ?? null,
      derived_from: Array.isArray(fm.provenance?.derived_from) ? fm.provenance.derived_from : [],
    },
    legacy: fm.legacy ?? null,
  };
  // 正文在这里**只归一化一次**（去首尾空白），因为闸门量的是 `candidate.body`，
  // 而落盘时 `renderNote()` 写的是 `body.trimEnd()`（首尾空白进 markdown 没有意义）。
  // 两处各 trim 各的，就会出现「闸门说 401 字超限、写下去的文件只有 400 字」这种
  // 自相矛盾的账 —— 数字对不上时人只会怀疑整套限额，而不是怀疑那一行代码。
  const raw = String(body ?? '');
  const normalized = raw.trimEnd();
  return { note: base, body: normalized, trimmed: normalized !== raw };
}

/**
 * 写入（`§9.2` 的 `remember`）。
 *
 * @returns 冻结接口要求的 `{ok, verdict:'allow'|'deny', reason}`，
 *   并附带 `status`（`stored|skipped|duplicate|denied|planned`）、`id`、`details`。
 *   `reason` 对 `duplicate` / `skipped` 也一定有值——调用方不该靠 `ok` 反推原因。
 */
export function remember(ctx, { candidate, body, options = {} } = {}) {
  const { scan, writeNote, rebuildIndex, ledger, relPath } = ctx;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const existing = scan().notes;

  // 没有 id 的候选由调用方先取好（`nextId()`），这里只做「有没有」的兜底
  if (!candidate?.id) {
    return deny('missing_id', { why: '候选没有 id（应由调用方生成 ULID）' });
  }

  const verdict = evaluateWrite({ candidate, existing, limits, options });
  const record = {
    ok: verdict.verdict === 'allow',
    verdict: verdict.verdict === 'skip' ? 'deny' : verdict.verdict,
    gate: verdict.verdict,
    status: verdict.status,
    reason: verdict.reason,
    id: String(candidate.id),
    details: verdict.details,
  };
  if (options.dry) {
    record.dry = true;
    record.status = verdict.verdict === 'allow' ? 'planned' : verdict.status;
    record.would_write = verdict.verdict === 'allow' ? relPath(String(candidate.id)) : null;
    return record;
  }

  if (verdict.verdict === 'skip') {
    ledger({ kind: 'write_skipped', id: String(candidate.id), reason: verdict.reason, bytes: body?.length ?? 0 });
    return record;
  }
  if (verdict.verdict === 'deny') {
    ledger({
      kind: 'write_denied',
      id: String(candidate.id),
      reason: verdict.reason,
      details: compactDetails(verdict.details),
    });
    return record;
  }

  const text = renderNote(candidate, body);
  const written = writeNote(String(candidate.id), text);
  if (!written.ok) {
    return { ...record, ok: false, verdict: 'deny', status: 'error', reason: 'store_write_failed', error: written.error };
  }
  // 批量写入（导入）时每一步重建索引是 O(笔数 × 库大小)：实测 1300 条笔记的迁移
  // 跑了一分钟还没完 —— 每一笔都要把所有文件重扫一遍、把整份索引重写一遍。
  // `skipIndex` 让调用方自己决定什么时候重建；单笔写入（人 / Agent 的常规路径）
  // 仍然是写完立刻重建，因为那才是「索引是 notes 的纯函数」的默认保证。
  const index = options.skipIndex ? null : rebuildIndex();
  ledger({
    kind: 'write_stored',
    id: String(candidate.id),
    mode: verdict.details.mode,
    shrink: Boolean(verdict.details.shrinkEscape),
    bytes: written.bytes,
    fingerprint: verdict.details.fingerprint,
    index_lines: index?.lines ?? null,
    index_truncated: Boolean(index?.truncated),
    index_deferred: Boolean(options.skipIndex),
  });
  return {
    ...record,
    status: 'stored',
    path: written.path,
    bytes: written.bytes,
    backup: written.backup || null,
    unchanged: Boolean(written.unchanged),
    index: index ? { lines: index.lines, bytes: index.bytes, truncated: Boolean(index.truncated) } : null,
  };
}

function deny(reason, extra = {}) {
  return { ok: false, verdict: 'deny', gate: 'deny', status: 'denied', reason, ...extra };
}

function compactDetails(details) {
  const out = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (v === undefined) continue;
    if (typeof v === 'object' && v !== null) continue;
    out[k] = v;
  }
  return out;
}

/** 供 `remember --file` 用：从 md 文本得到候选（有 frontmatter 就用它的元数据）。 */
export function candidateFromMarkdown(text, { defaults = {}, nextId, id } = {}) {
  const parsed = parseNoteLoose(text);
  return buildCandidate({
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    defaults: { ...defaults, id },
    nextId,
  });
}
