/**
 * 库（vault）的目录布局与整体读写。真相源只有 `notes/`，其余全是生成物或账本。
 *
 * ```
 * <store>/
 *   notes/<id>.md            真相源：一条事实一个文件（唯一手可编辑的东西）
 *   notes/candidates/        候选（`promote` 产出，默认不进检索面；M1 只预留）
 *   index/MEMORY.md          人读索引：生成物 + 人可编辑，行数/字节有闸门
 *   index/MEMORY.md.bak      旧索引（每次重写留一份，可回滚）
 *   index/stats.json         最后一次扫描的统计（截断/解析失败的账）
 *   index/ledger.jsonl       追加型事件日志（`06-architecture.md` §6.1）
 *   runs/                    巩固 receipt（M2）
 *   .bak/                    写入前备份（`remember` 覆盖既有笔记时留）
 * ```
 *
 * 为什么 `MEMORY.md` 放 `index/` 而不是库根：架构文档明写「索引是生成物，
 * 删掉能重建」。放根目录会诱导人和 `notes/` 混着看，进而手改真相源外的第二份真源。
 * 代价是旧插件（把 `MEMORY.md` 放根）不能直接指过来；迁移是 `import` 的事。
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { parseNote, idFromFilename } from './note.js';

export const NOTES_DIRNAME = 'notes';
export const INDEX_DIRNAME = 'index';
export const RUNS_DIRNAME = 'runs';
export const MEMORY_FILE = 'MEMORY.md';
export const LEDGER_FILE = 'ledger.jsonl';
export const STATS_FILE = 'stats.json';

/** 索引行数/字节上限：沿用旧插件被真实验证过的 200 行 / 25KB。 */
export const INDEX_CAPS = Object.freeze({ maxLines: 200, maxBytes: 25 * 1024 });

/** 库级上限（`04-cost-model.md` 的量级；到万级要持久化索引，不是换库的理由）。 */
export const STORE_CAPS = Object.freeze({ maxNotes: 20000, maxNoteBytes: 512 * 1024 });

/**
 * 默认库路径。
 *
 * 与旧插件（`~/memory/engramory`）**必须不同**：两条线并行、共享同一批记忆内容
 * 但各自有独立的库与索引，混用同一个目录会让两边的闸门互相拆台。
 */
export function defaultStorePath() {
  if (process.env.MEMORY_STORE) return resolve(process.env.MEMORY_STORE);
  if (process.env.MEMORY_SERVICE_STORE) return resolve(process.env.MEMORY_SERVICE_STORE);
  return join(homedir(), 'memory', 'memory-service');
}

export function resolveStore(explicit) {
  return explicit ? resolve(explicit) : defaultStorePath();
}

export function paths(storePath) {
  const store = resolve(storePath);
  return {
    store,
    notes: join(store, NOTES_DIRNAME),
    index: join(store, INDEX_DIRNAME),
    runs: join(store, RUNS_DIRNAME),
    memory: join(store, INDEX_DIRNAME, MEMORY_FILE),
    memoryBak: join(store, INDEX_DIRNAME, `${MEMORY_FILE}.bak`),
    ledger: join(store, INDEX_DIRNAME, LEDGER_FILE),
    stats: join(store, INDEX_DIRNAME, STATS_FILE),
    backups: join(store, '.bak'),
  };
}

export function ensureStore(storePath) {
  const p = paths(storePath);
  for (const dir of [p.store, p.notes, p.index, p.runs, p.backups]) mkdirSync(dir, { recursive: true });
  return p;
}

function safeReadFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 扫描库：读 `notes/*.md`，解析每一条。
 *
 * **不抛异常**：读不出来的文件（坏 frontmatter、schema 更高、权限问题）进 `failures`，
 * 它们是账的一部分（`§3.4`：「解析失败时 fail-closed（跳过该文件并记事件）」）。
 * 递归只进一层：`notes/candidates/` 不是默认检索面，但会被单独收进 `candidates`。
 */
export function scanStore(storePath, { includeCandidates = false } = {}) {
  const p = paths(storePath);
  const result = {
    store: p.store,
    files: [],
    notes: [],
    failures: [],
    candidates: [],
    ignored: [],
    bytes: 0,
  };
  if (!existsSync(p.notes)) return result;

  let entries;
  try {
    entries = readdirSync(p.notes, { withFileTypes: true });
  } catch (e) {
    result.failures.push({ id: null, path: p.notes, errors: [{ code: 'E_STORE_UNREADABLE', message: String(e.message) }] });
    return result;
  }

  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === 'candidates' && includeCandidates) {
        for (const c of readdirSync(join(p.notes, e.name), { withFileTypes: true })) {
          if (c.isFile() && /\.md$/i.test(c.name)) files.push(join(p.notes, e.name, c.name));
        }
      }
      continue;
    }
    if (!e.isFile()) continue;
    if (!/\.md$/i.test(e.name)) {
      result.ignored.push(e.name); // .tmp/.bak/.DS_Store：记数不报错
      continue;
    }
    files.push(join(p.notes, e.name));
  }
  files.sort();

  for (const file of files) {
    const isCandidate = file.includes('/candidates/');
    const id = idFromFilename(file);
    let text;
    let stat;
    try {
      text = readFileSync(file, 'utf8');
      stat = statSync(file);
    } catch (e) {
      result.failures.push({ id, path: file, errors: [{ code: 'E_STORE_UNREADABLE', message: String(e.message) }] });
      continue;
    }
    result.bytes += stat.size;
    const parsed = parseNote(text, { id, mtime: stat.mtimeMs, bytes: stat.size });
    const entry = {
      id,
      path: file,
      title: parsed.title,
      body: parsed.body,
      text: parsed.text,
      note: parsed.note,
      mtime: stat.mtimeMs,
      bytes: stat.size,
      ok: parsed.ok,
      errors: parsed.errors,
      warnings: parsed.warnings,
    };
    if (!parsed.ok) {
      result.failures.push(entry);
      continue;
    }
    result.files.push(entry);
    if (isCandidate) result.candidates.push(entry);
    else result.notes.push(entry);
  }
  return result;
}

/** 从扫描结果里挑出「核心档」：kind=core 的笔记，按重要度+新鲜度排序。 */
export function coreNotes(scan) {
  return scan.notes.filter((n) => n.note.kind === 'core');
}

/** 读 `index/MEMORY.md`。不存在返回 `{exists:false, text:'', lines:0, bytes:0}`。 */
export function readIndexFile(storePath) {
  const p = paths(storePath);
  const text = safeReadFile(p.memory);
  if (text === null) return { exists: false, text: '', lines: 0, bytes: 0, path: p.memory };
  return {
    exists: true,
    text,
    lines: text === '' ? 0 : text.replace(/\n$/, '').split('\n').length,
    bytes: Buffer.byteLength(text),
    path: p.memory,
  };
}

/**
 * 从 `notes/` 重建 `index/MEMORY.md`（**纯函数式的生成物**）。
 *
 * 一行一条笔记：`- [标题](notes/<id>.md) — #tag1 #tag2 (kind/trust, valid_from)`。
 * 只写指针不写内容（旧项目的纪律），行序按 `valid_from` 倒序（新的在上），
 * 同输入永远同输出——所以「删掉 index/ 重建，结果字节一致」是可以断言的。
 *
 * 超过 `maxLines` 时**追加一行截断说明**（`… 还有 N 条`），
 * 并把这行也算进 lines —— 索引超限是必须被 `status` 看见的账。
 */
export function buildIndexText(scan, { maxLines = INDEX_CAPS.maxLines, maxBytes = INDEX_CAPS.maxBytes } = {}) {
  const sorted = [...scan.notes].sort((a, b) => {
    const ta = a.note.valid_from ?? '';
    const tb = b.note.valid_from ?? '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
  const header = [
    '# MEMORY',
    '',
    '<sub>生成物：由 `notes/` 重建（`memory status --rebuild-index`）。一行一条指针，内容在笔记里。</sub>',
    '',
  ];
  const lines = [];
  let shown = 0;
  // 行数与字节数**两个上限都要自觉遵守**。
  //
  // 旧项目的血：索引守卫会拒掉超限的写入，于是「生成器只管行数、守门员只管放不放行」
  // 的分工结果是 —— 超限时一个字都写不出去，库从「索引不全」直接变成「没有索引」。
  // 实测：1321 条笔记生成的索引 200 行 / 41015 字节，超过 25KB 上限，
  // 索引守卫拒写（这是对的），磁盘上 `index/MEMORY.md` 干脆没有这个文件。
  // 生成器必须自己先削到装得下，剩下的条数报出来（`hidden`），而不是交给守门员去拒。
  const cost = (text) => Buffer.byteLength(`${text}\n`);
  let usedBytes = cost(header.join('\n'));
  // 给截断说明留一行 + 它的字节
  const hintReserve = 96;
  const budget = maxLines - header.length - 1;
  for (const n of sorted) {
    if (shown >= budget) break;
    const line = pointerLine(n);
    const size = cost(line);
    if (usedBytes + size + hintReserve > maxBytes) break;
    lines.push(line);
    usedBytes += size;
    shown += 1;
  }
  const out = [...header, ...lines];
  const hidden = sorted.length - shown;
  if (hidden > 0) {
    out.push(`- … 还有 ${hidden} 条未列入索引（上限 ${maxLines} 行 / ${maxBytes} 字节，见 \`memory status\`）`);
  }
  return `${out.join('\n')}\n`;
}

export function pointerLine(entry) {
  const note = entry.note;
  const tags = (note.tags ?? []).map((t) => `#${t}`).join(' ');
  const when = note.valid_from ? ` · ${String(note.valid_from).slice(0, 10)}` : '';
  const meta = `(${note.kind}/${note.trust}${when})`;
  return `- [${entry.title}](${NOTES_DIRNAME}/${entry.id}.md) — ${tags ? `${tags} ` : ''}${meta}`.replace(/\s+$/, '');
}

/**
 * 写索引（原子 + 留 `.bak`）。
 *
 * 为什么写索引也要过闸门：旧项目 200 行上限膨胀的根因就是「写入时没人拦」。
 * 这里的闸门在 `gate/`，本函数只负责 IO —— 分开是为了让闸门可以被单测，
 * 不用造一个真文件系统。
 */
export function writeIndexAtomic(storePath, text) {
  const p = paths(storePath);
  ensureStore(storePath);
  const existing = safeReadFile(p.memory);
  if (existing === text) return { ok: true, path: p.memory, bytes: Buffer.byteLength(text), unchanged: true };
  if (existing !== null) writeFileSync(p.memoryBak, existing, 'utf8');
  const tmp = `${p.memory}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, p.memory);
  } catch (e) {
    return { ok: false, path: p.memory, error: { code: 'E_STORE_WRITE_FAILED', message: String(e.message) } };
  }
  return { ok: true, path: p.memory, bytes: Buffer.byteLength(text), unchanged: false };
}

/**
 * 写索引的子文件（分层索引的清单层 `index/groups/*.md`）。
 *
 * 与 `writeIndexAtomic` 的区别：**不覆盖 `MEMORY.md`、不写 `.bak`**。
 * 清单层文件的真相源是 `notes/`，删掉能重建（`§6.3` 的幂等性判据同样适用），
 * 所以不需要给它们留回滚副本；只有 `MEMORY.md`（人可能手改的那一份）才留 `.bak`。
 * 内容相同就直接跳过 —— 重建索引幂等的前提是**不产生无意义的写入**。
 */
export function writeIndexSideFile(storePath, relPath, text) {
  const p = paths(storePath);
  const target = join(p.index, relPath);
  const existing = safeReadFile(target);
  if (existing === text) return { ok: true, path: target, bytes: Buffer.byteLength(text), unchanged: true };
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, target);
  } catch (e) {
    return { ok: false, path: target, error: { code: 'E_STORE_WRITE_FAILED', message: String(e.message) } };
  }
  return { ok: true, path: target, bytes: Buffer.byteLength(text), unchanged: false };
}

/** 重建索引，返回新索引的统计。 */
export function rebuildIndex(storePath, { scan } = {}) {
  const s = scan ?? scanStore(storePath);
  const text = buildIndexText(s);
  const written = writeIndexAtomic(storePath, text);
  writeStats(storePath, statsOf(s));
  const listed = text.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- … ')).length;
  const total = s.notes.length;
  return {
    ...written,
    lines: text.replace(/\n$/, '').split('\n').length,
    bytes: Buffer.byteLength(text),
    // 「静默截断」是旧项目最贵的一课：索引装不下时必须**报出装不下的条数**，
    // 而不是让人从「怎么搜不到那条」倒推。
    listed,
    hidden: Math.max(0, total - listed),
    truncated: listed < total,
  };
}

/**
 * 账本事件（`§6.1`：hit / injected / used / opened 四个独立事件）。
 * 追加一行 JSON，永不改写——append-only 是「可回放」的前提。
 */
export function appendLedger(storePath, event) {
  const p = paths(storePath);
  ensureStore(storePath);
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  try {
    writeFileSync(p.ledger, line, { encoding: 'utf8', flag: 'a' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { code: 'E_LEDGER_WRITE_FAILED', message: String(e.message) } };
  }
}

export function readLedger(storePath, { limit = 0 } = {}) {
  const p = paths(storePath);
  const text = safeReadFile(p.ledger);
  if (text === null) return [];
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const slice = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 坏行不该让整个账本读不出来；坏行本身在 status 里由 ledgerMalformed 计数 */
      out.push({ ts: null, kind: 'malformed', raw: line.slice(0, 200) });
    }
  }
  return out;
}

/** 扫描统计：这就是「任何静默截断都要有账」的那个账。 */
export function statsOf(scan) {
  return {
    scannedAt: new Date().toISOString(),
    files: scan.files.length + scan.failures.length,
    notes: scan.notes.length,
    candidates: scan.candidates.length,
    parseFailures: scan.failures.length,
    ignored: scan.ignored.length,
    bytes: scan.bytes,
    failureIds: scan.failures.map((f) => f.id).filter(Boolean),
  };
}

export function writeStats(storePath, stats) {
  const p = paths(storePath);
  ensureStore(storePath);
  const tmp = `${p.stats}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
    renameSync(tmp, p.stats);
    return { ok: true, path: p.stats };
  } catch (e) {
    return { ok: false, error: { code: 'E_STORE_WRITE_FAILED', message: String(e.message) } };
  }
}

export function readStats(storePath) {
  const p = paths(storePath);
  const text = safeReadFile(p.stats);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
