/**
 * 笔记（note）的读写。**文件是唯一真相源**（`06-architecture.md §3.1`）。
 *
 * 一条事实一个 markdown 文件，形状见 `§3.1`：`---` 围栏 + YAML 子集 frontmatter + 正文。
 *
 * 三条贯穿全文件的纪律：
 *
 *  1. **fail-closed**：任何解析/校验失败都返回 `errors`（带 code 与行号），调用方必须
 *     让这条笔记退出检索面，并且**记账**（`status` 的 `parseFailures` 是一等指标，
 *     `§3.4` 明写 "doctor 必须把解析失败数当一等指标暴露"）。
 *  2. **不猜着解析**：`schema` 比本实现高 → 拒绝解释、原样透出（`§3.4`）。
 *  3. **写入是原子的**：先写 `*.tmp` 再 `rename`，rename 在同一文件系统上是原子的。
 *     中途崩了最坏留下一个 tmp 文件，绝不会留下半截真相源。
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { parseFrontmatter, serializeFrontmatter, NOTE_KEY_ORDER } from './frontmatter.js';
import { isUlid } from './ids.js';
import { parseTime } from '../util/clock.js';

/** 本实现认识的 schema 版本。 */
export const NOTE_SCHEMA = 'memory.note/1';
export const NOTE_SCHEMA_VERSION = 1;
export const NOTES_DIR = 'notes';

export const KINDS = Object.freeze(['core', 'semantic', 'episodic', 'procedural']);
export const TRUSTS = Object.freeze(['user_stated', 'system_derived', 'external']);
export const STATUSES = Object.freeze(['draft', 'active', 'stale', 'superseded', 'archived']);
export const SCOPES = Object.freeze(['user', 'project']);

/**
 * 核心档上限（`§3.1` 末段：「单条事实必须 ≤ 200 token / ≤ 400 字核心档」）。
 * 超限不是拒绝写入，是**闸门记一条 warn** 并让 `status` 能看见（见 `gate/`）。
 */
export const MAX_NOTE_CHARS = 400;
export const MAX_NOTE_TOKENS = 200;
/** 单文件字节上界（正文 + frontmatter）。汉字按 UTF-8 三字节算，400 字 ≈ 1.2KB。 */
export const MAX_NOTE_BYTES = 8 * 1024;

const FENCE = /^---\r?\n/;

/**
 * 切出 frontmatter 与正文。没有围栏 → 整篇都是正文，frontmatter 为空对象
 * （人手丢进来的裸 md 不该被判成坏文件，只是少了元数据；缺必填字段会在校验里报）。
 */
export function splitDocument(text) {
  // BOM 要先摘掉：`^---` 匹配不上 `\uFEFF---`，否则带 BOM 的文件会被当成
  // 「没有 frontmatter」，于是**整段 frontmatter 变成正文被索引**
  // （`\uFEFF` 本身还会污染第一个词项）。BOM 是 Windows 编辑器的默认行为，
  // 不是异常输入。
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  if (!FENCE.test(src)) return { frontmatter: '', body: src, hasFrontmatter: false };
  const rest = src.replace(FENCE, '');
  const end = rest.search(/^---\s*$/m);
  if (end === -1) return { frontmatter: rest, body: '', hasFrontmatter: true };
  const after = rest.slice(end).replace(/^---\s*\r?\n?/, '').replace(/^---\s*$/, '');
  return { frontmatter: rest.slice(0, end), body: after.replace(/^\r?\n/, ''), hasFrontmatter: true };
}

function err(code, message, line) {
  return line === undefined ? { code, message } : { code, message, line };
}

/**
 * 校验一份已解析的 frontmatter。
 *
 * 返回 `{ok, value, errors, warnings}`：`value` 是归一化后的对象（字段有默认值）。
 * 校验失败时 `value` 仍是 null —— 绝不让调用方拿到半份数据。
 */
export function validateFrontmatter(data, { id, strictId = true } = {}) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== 'object') {
    return { ok: false, value: null, errors: [err('E_FRONTMATTER_MISSING', '没有 frontmatter')], warnings };
  }

  const schema = data.schema;
  if (schema === null || schema === undefined) {
    errors.push(err('E_SCHEMA_MISSING', '缺 schema 字段'));
  } else if (typeof schema !== 'string' || !/^memory\.note\/(\d+)$/.test(schema)) {
    errors.push(err('E_SCHEMA_UNSUPPORTED', `schema 形状不认识：${JSON.stringify(schema)}`));
  } else {
    const v = Number(schema.split('/')[1]);
    if (v > NOTE_SCHEMA_VERSION) {
      errors.push(
        err('E_SCHEMA_UNSUPPORTED', `schema ${schema} 比本实现（v${NOTE_SCHEMA_VERSION}）新，拒绝解释`),
      );
    }
  }

  // 宽松模式下**文件名赢**：`id` 是这个库里的身份，用它做去重、引用、删除，
  // 所以 `notes/<id>.md` 的 `<id>` 必须是那个身份。frontmatter 里那个外来 id
  // 不丢弃 —— 塞进 `legacy.frontmatter_id`，导入报告里能看到「来的时候叫什么」。
  const noteId = !strictId && id ? id : data.id ?? id;
  if (!noteId || typeof noteId !== 'string') {
    errors.push(err('E_ID_MISSING', '缺 id'));
  } else if (id && noteId !== id && strictId) {
    // `strictId` 是**给导入用的逃生门**：库内写入必须两边一致（id 是身份，不能一处一个说法），
    // 但把外部库搬进来时，文件名是别人起的、frontmatter 里的 name 是自己写的，
    // 这种情况一眼就该看出「文件名说了算」，而不是整份文件判失败。
    // 默认 true —— 宽松是显式选项，不是默认行为。
    errors.push(err('E_ID_MISMATCH', `frontmatter id(${noteId}) 与文件名(${id}) 不一致`));
  }

  if (data.kind === undefined || data.kind === null) {
    warnings.push(err('W_KIND_DEFAULT', '缺 kind，按 semantic 处理'));
  } else if (!KINDS.includes(data.kind)) {
    errors.push(err('E_KIND_INVALID', `kind 不在 ${KINDS.join('|')}：${JSON.stringify(data.kind)}`));
  }

  if (data.trust !== undefined && data.trust !== null && !TRUSTS.includes(data.trust)) {
    errors.push(err('E_TRUST_INVALID', `trust 不在 ${TRUSTS.join('|')}：${JSON.stringify(data.trust)}`));
  }
  if (data.status !== undefined && data.status !== null && !STATUSES.includes(data.status)) {
    errors.push(err('E_STATUS_INVALID', `status 不在 ${STATUSES.join('|')}：${JSON.stringify(data.status)}`));
  }

  let scope = 'user';
  let scopeDetail = null;
  if (typeof data.scope === 'string' && data.scope.startsWith('project:')) {
    scope = 'project';
    scopeDetail = data.scope.slice('project:'.length) || null;
  } else if (data.scope === 'project') {
    scope = 'project';
  } else if (data.scope !== undefined && data.scope !== null && data.scope !== 'user') {
    errors.push(err('E_SCOPE_INVALID', `scope 只能是 user 或 project[:<origin>]：${JSON.stringify(data.scope)}`));
  }

  if (data.valid_from !== undefined && data.valid_from !== null && !parseTime(data.valid_from)) {
    errors.push(err('E_VALID_FROM_INVALID', `valid_from 不是合法时间：${JSON.stringify(data.valid_from)}`));
  }
  if (data.valid_to !== undefined && data.valid_to !== null && !parseTime(data.valid_to)) {
    errors.push(err('E_VALID_TO_INVALID', `valid_to 不是合法时间：${JSON.stringify(data.valid_to)}`));
  }
  // confidence 允许字符串数字（`"0.9"`）—— YAML 没有类型标注，手写文件和 export
  // 出来的 JSON 都会出现带引号的小数，判成非法属于拿格式洁癖惩罚用户。
  // 归一化后写回 `data`，下游（`value` 构造）就不用再判一次类型。
  if (data.confidence !== undefined && data.confidence !== null) {
    const rawC = data.confidence;
    const c = typeof rawC === 'number' ? rawC : typeof rawC === 'string' && rawC.trim() !== '' ? Number(rawC) : NaN;
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      errors.push(err('E_CONFIDENCE_INVALID', `confidence 必须在 [0,1]：${JSON.stringify(rawC)}`));
    } else {
      data.confidence = c;
    }
  }

  // valid_from/valid_to 的**形状**在这里已经查过（parseTime 认得出），
  // 但字符串形态保留原样：`isoLocal()` 的 +08:00 偏移是本地事实，
  // 归一成 Z 会让「这条是什么时候写的」在跨时区阅读时变味。需要比较时由
  // `asOfTime()` / `isValidAt()` 现场解析（它们走同一套 parseTime，不会有两种解释）。

  if (errors.length) return { ok: false, value: null, errors, warnings };

  const provenance = data.provenance && typeof data.provenance === 'object' ? data.provenance : {};
  const value = {
    schema: NOTE_SCHEMA,
    id: noteId,
    scope,
    scope_detail: scopeDetail,
    kind: KINDS.includes(data.kind) ? data.kind : 'semantic',
    trust: TRUSTS.includes(data.trust) ? data.trust : 'external',
    status: STATUSES.includes(data.status) ? data.status : 'active',
    confidence: typeof data.confidence === 'number' ? data.confidence : 0.7,
    valid_from: data.valid_from ?? null,
    valid_to: data.valid_to ?? null,
    supersedes: Array.isArray(data.supersedes) ? data.supersedes.filter(Boolean) : [],
    superseded_by: data.superseded_by ?? null,
    verify_after: data.verify_after ?? null,
    tags: Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string') : [],
    // 别名是作者显式给的同义说法。库里既有 `[a, b]` 也有 `a, b` 两种写法，
    // 都收；它只参与身份核对（共现），不进 postings、不参与打分。
    aliases: Array.isArray(data.aliases)
      ? data.aliases.filter((t) => typeof t === 'string')
      : typeof data.aliases === 'string'
        ? data.aliases.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
    subject: data.subject ?? null,
    predicate: data.predicate ?? null,
    provenance: {
      written_by: provenance.written_by ?? 'unknown',
      source_ref: provenance.source_ref ?? null,
      derived_from: Array.isArray(provenance.derived_from) ? provenance.derived_from.filter(Boolean) : [],
    },
    legacy: {
      ...(data.legacy && typeof data.legacy === 'object' ? data.legacy : {}),
      ...(!strictId && id && data.id && data.id !== id
        ? { frontmatter_id: data.id, id_source: 'filename' }
        : {}),
      ...(!strictId && id && data.id && data.id !== id ? {} : {}),
    },
  };
  return { ok: true, value, errors: [], warnings };
}

/**
 * 解析一份笔记全文。
 *
 * @returns {{ok:boolean, id:string, title:string, body:string, note:object|null,
 *            text:string, errors:Array, warnings:Array}}
 */
export function parseNote(text, { id, mtime = null, bytes = null, strictId = true } = {}) {
  const { frontmatter, body, hasFrontmatter } = splitDocument(text);
  const title = firstHeading(body) ?? (id ? String(id) : '');
  const shape = {
    ok: false,
    id: id ?? null,
    title,
    body,
    text: body,
    hasFrontmatter,
    note: null,
    mtime,
    bytes,
    errors: [],
    warnings: [],
  };
  if (!hasFrontmatter) {
    shape.errors = [err('E_FRONTMATTER_MISSING', '文件没有 --- 围栏，按解析失败处理（fail-closed）')];
    return shape;
  }
  const parsed = parseFrontmatter(frontmatter);
  if (!parsed.data) {
    shape.errors = parsed.errors.map((e) => err('E_FRONTMATTER_SYNTAX', e.message, e.line));
    return shape;
  }
  const validated = validateFrontmatter(parsed.data, { id, strictId });
  shape.warnings = validated.warnings;
  if (!validated.ok) {
    shape.errors = validated.errors;
    return shape;
  }
  shape.ok = true;
  shape.note = validated.value;
  shape.title = firstHeading(body) ?? validated.value.id;
  return shape;
}

/**
 * 宽松解析：只切围栏 + 解 frontmatter，**不校验**。
 *
 * 为什么需要它：写入路径上「这份 frontmatter 不合法」本身应该是一条**闸门判定**
 * （有 reason 可报、要记进账本），而不是一个抛出来的异常。校验因此归闸门，
 * 解析归这里。
 */
export function parseNoteLoose(text) {
  const { frontmatter, body, hasFrontmatter } = splitDocument(text);
  if (!hasFrontmatter) return { frontmatter: null, body: String(text ?? '').trim(), errors: [] };
  const parsed = parseFrontmatter(frontmatter);
  return { frontmatter: parsed.data, body: body.trim(), errors: parsed.errors };
}

/** 正文第一个标题（`# x` 或 `## x`）；没有就用第一行非空文本，再没有返回 null。 */export function firstHeading(body) {
  const lines = String(body ?? '').split('\n');
  for (const line of lines) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    const t = line.trim();
    if (t !== '') return t.replace(/^[-*]\s+/, '').slice(0, 120);
  }
  return null;
}

/** 把一条笔记渲染回 markdown 文本（确定性）。 */
export function renderNote(note, body) {
  const data = {
    schema: note.schema ?? NOTE_SCHEMA,
    id: note.id,
    scope: note.scope_detail ? `project:${note.scope_detail}` : note.scope,
    kind: note.kind,
    trust: note.trust,
    provenance: note.provenance,
    valid_from: note.valid_from,
    valid_to: note.valid_to,
    supersedes: note.supersedes ?? [],
    superseded_by: note.superseded_by ?? null,
    confidence: note.confidence,
    verify_after: note.verify_after ?? null,
    tags: note.tags ?? [],
  };
  if (Array.isArray(note.aliases) && note.aliases.length > 0) data.aliases = note.aliases;
  if (note.status && note.status !== 'active') data.status = note.status;
  if (note.subject) data.subject = note.subject;
  if (note.predicate) data.predicate = note.predicate;
  // `legacy` 是**必须落盘**的：`import/engramory.js` 把 `source_file` / `rev` /
  // `imported_at` 放在这里，而重跑导入正是靠 `legacy.source_file` 认领既有笔记、
  // 靠 `legacy.rev` 判断「源文件改了没有」。不写它 → 每次导入都当新文件 →
  // 库里的同一条事实变成 N 份（幂等性不是优化，是「一条事实一个文件」的底线）。
  // 空对象不写：`legacy: {}` 会让「有没有外来痕迹」这个判断永远为真。
  if (note.legacy && typeof note.legacy === 'object' && Object.keys(note.legacy).length > 0) {
    data.legacy = note.legacy;
  }
  return `---\n${serializeFrontmatter(data, NOTE_KEY_ORDER)}\n---\n\n${String(body ?? '').trimEnd()}\n`;
}

/** `notes/<id>.md` 的绝对路径。 */
export function notePath(storePath, id) {
  return join(storePath, NOTES_DIR, `${id}.md`);
}

/** 从文件名反推 id（`notes/01ABC.md` → `01ABC`）。 */
export function idFromFilename(file) {
  return basename(String(file)).replace(/\.md$/i, '');
}

/**
 * 把外部来的 id 归一成库内安全的 id。
 *
 * 返回值 `{ok, id}` 或 `{ok:false, reason:'E_INVALID_ID'}`。规则：
 *  - 去掉 `notes/` 前缀与 `.md` 后缀（`read --id notes/x.md` 与 `--id x` 等价）；
 *  - **含 `..`、绝对路径、路径分隔符、空字节的一律判非法**。
 *
 * 为什么必须显式拒绝而不是靠 `join()` 兜：`notePath()` 拼的是 `<store>/notes/<id>.md`，
 * 绝大多数穿越写法会因为多出一个 `.md` 后缀而恰好读不到（fail-closed 的运气），
 * 但「恰好读不到」不是保证 —— 库目录旁边真放了一个同名 `.md` 就会被读出去。
 * 安全要靠判据，不靠巧合。
 */
export function safeNoteId(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s.length > 256) return { ok: false, id: s, reason: 'E_INVALID_ID' };
  if (s.includes('\0')) return { ok: false, id: s, reason: 'E_INVALID_ID' };
  const stripped = s.replace(/^notes\//, '').replace(/\.md$/i, '');
  if (stripped === '' || stripped === '.' || stripped === '..') {
    return { ok: false, id: stripped, reason: 'E_INVALID_ID' };
  }
  if (stripped.includes('/') || stripped.includes('\\') || stripped.includes('..')) {
    return { ok: false, id: stripped, reason: 'E_INVALID_ID' };
  }
  if (stripped.startsWith('.')) return { ok: false, id: stripped, reason: 'E_INVALID_ID' };
  return { ok: true, id: stripped };
}

/** 读一条笔记（按 id）。文件不存在 → `ok:false` + `E_NOT_FOUND`；id 非法 → `E_INVALID_ID`。 */
export function readNote(storePath, id, { strictId = true } = {}) {
  const safe = safeNoteId(id);
  if (!safe.ok) {
    return {
      ok: false,
      id: safe.id,
      path: null,
      note: null,
      errors: [err('E_INVALID_ID', `id 不合法：${JSON.stringify(String(id))}`)],
    };
  }
  const path = notePath(storePath, safe.id);
  let text;
  let st;
  try {
    text = readFileSync(path, 'utf8');
    st = statSync(path);
  } catch (e) {
    return { ok: false, id, path, note: null, errors: [err('E_NOT_FOUND', `${path} 读不到：${e.code ?? e.message}`)] };
  }
  const parsed = parseNote(text, { id: safe.id, mtime: st.mtimeMs, bytes: st.size, strictId });
  return { ...parsed, path };
}

/** 解析后的笔记 + 原始文本。 */
export function readNoteRaw(storePath, id) {
  const safe = safeNoteId(id);
  if (!safe.ok) throw Object.assign(new Error(`id 不合法：${JSON.stringify(String(id))}`), { code: 'E_INVALID_ID' });
  const path = notePath(storePath, safe.id);
  const text = readFileSync(path, 'utf8');
  return { path, text };
}

/**
 * 原子写：`<id>.md.tmp` → rename。
 *
 * 返回 `{ok, path, bytes, backup}`；`backup` 是覆盖前旧内容的路径（`` 表示新建）。
 * 为什么留 backup：闸门允许「缩小的重写」，那种情况**不可逆**，
 * 留一份 `.bak` 是让「不可逆」至少变成「可手工回滚」。写入成功后 backup 会被保留，
 * 由 `doctor` 负责清理（不是热路径的事）。
 */
export function writeNoteAtomic(storePath, id, text, { keepBackup = true } = {}) {
  const path = notePath(storePath, id);
  const tmp = `${path}.tmp`;
  let backup = '';
  try {
    const existing = readFileSync(path, 'utf8');
    if (existing === text) return { ok: true, path, bytes: Buffer.byteLength(text), backup: '', unchanged: true };
    if (keepBackup) {
      backup = `${path}.bak`;
      writeFileSync(backup, existing, 'utf8');
    }
  } catch {
    /* 文件不存在 = 新建，正常路径 */
  }
  try {
    // 父目录不存在就建：`notePath()` 拼的是 `<store>/notes/<id>.md`，
    // 而「第一次写入」时 `<store>/notes/` 往往还不存在（新库、或者有人直接
    // `memory remember` 没先跑 status）。旧项目在这里的表现是
    // `ENOENT: no such file or directory`，被上层翻译成一句含糊的
    // 「写入失败」—— 用户看到的是「明明给对了参数却写不进去」。
    // 建目录是幂等的，放在原子写内部（而不是要求每个调用方先 ensure）
    // 才能保证「能拼出路径的地方就能写进去」。
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp 可能压根没建起来 */
    }
    return { ok: false, path, error: { code: 'E_STORE_WRITE_FAILED', message: String(e.message ?? e) } };
  }
  return { ok: true, path, bytes: Buffer.byteLength(text), backup, unchanged: false };
}
