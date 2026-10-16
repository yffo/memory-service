/**
 * 从旧 Engramory 库（`~/memory/engramory`，dsh-engramory-recall 格式）导入。
 *
 * 旧格式（真实样本，只读参考）：
 *
 * ```
 * ---
 * name: feedback-collaboration-and-safety-rules
 * description: 一句话摘要
 * type: feedback            # user | feedback | project | reference
 * scope: global
 * created: 2026-09-12
 * updated: 2026-09-12
 * ---
 * # 标题
 * 正文…
 * ```
 *
 * 索引 `MEMORY.md`：`## <分类>` 小节 + `- [标题](文件.md) — 摘要` 指针行。
 *
 * 三条纪律：
 *
 * 1. **单向只读**：这个模块只读源库，永远不写源库（旧插件是并行的另一条线，它自己
 *    还在跑；导入一次就动它的文件等于两个进程抢同一个真相源）。
 * 2. **可重入**：源文件名记进 `legacy.source_file`，`legacy.rev` 记内容指纹。
 *    同一个文件第二次导入且内容没变 → `skipped_unchanged`；变了 → 更新那一条
 *    （走闸门，通常命中「缩小的重写放行」）。所以 `import` 可以反复跑。
 * 3. **转换不猜**：旧 frontmatter 没有的字段就用我们自己的默认值，并且把
 *    `legacy.raw` 完整留在笔记里——将来要核对「这条到底从哪来」不用去翻旧库。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ulid } from '../util/ulid.js';
import { parseNoteLoose, safeNoteId } from '../store/note.js';
import { buildCandidate } from '../gate/remember.js';
import { contentFingerprint, DEFAULT_LIMITS } from '../gate/gate.js';
import { sha256, collapse, charLength, chunkText } from '../util/text.js';
import { parseTime, isoLocal } from '../util/clock.js';

/** 旧库的四个分类 → 我们的 `kind`。 */
export const TYPE_TO_KIND = Object.freeze({
  user: 'semantic',
  feedback: 'procedural',
  project: 'semantic',
  reference: 'semantic',
});

/** 旧库的分类 → 信任等级：`user`/`feedback` 是用户亲口定的，其余按外部资料算。 */
export const TYPE_TO_TRUST = Object.freeze({
  user: 'user_stated',
  feedback: 'user_stated',
  project: 'system_derived',
  reference: 'external',
});

/** 旧笔记里出现过的分类小节（索引的 `## x`）；不在表里的按 `reference` 处理。 */
export const INDEX_SECTIONS = Object.freeze(['user', 'feedback', 'project', 'reference']);

/** 旧库文件名前缀 → 分类（文件名比 frontmatter 更可靠：有些老笔记没写 type）。 */
/**
 * 旧库是「一个主题一大篇」，我们是「一条事实一个文件 ≤ 400 字」。
 * 实测旧库 72 篇里 50 篇超限（最长 58902 字），拿上限去卡它们的结果是
 * **大部分旧知识进不来** —— 迁移的意义恰恰是别丢东西，所以要切不要拒。
 */
export const IMPORT_CHUNK_CHARS = 400;
export const IMPORT_MAX_PARTS = 200;
/**
 * 短于这个长度的碎片**根本不送进闸门**。
 *
 * 为什么不送：旧库里有 12 片是「- 参见上文」这种一句话碎片，送进闸门必然拿
 * `too_short`，于是 `denied` 里混进一堆「本来就没打算要」的东西 ——
 * `denied` 应该只表示「想收但规则不许」，否则这个数字会失去意义（噪声一多就没人看）。
 * 它们仍然**有账**：计入 `fragments_dropped`。
 */
export const IMPORT_MIN_CHUNK_CHARS = 8;

const FILENAME_PREFIX = [
  [/^user[-_]/i, 'user'],
  [/^feedback[-_]/i, 'feedback'],
  [/^project[-_]/i, 'project'],
  [/^reference[-_]/i, 'reference'],
];

function classify(file, data) {
  const type = String(data?.type ?? '').trim().toLowerCase();
  if (TYPE_TO_KIND[type]) return { category: type, via: 'frontmatter.type' };
  for (const [re, cat] of FILENAME_PREFIX) {
    if (re.test(basename(file))) return { category: cat, via: 'filename' };
  }
  return { category: 'reference', via: 'default' };
}

/** 读旧索引的指针行：`- [标题](文件.md) — 摘要`。坏行进 `badLines`，不抛。 */
export function parseIndexPointers(text) {
  const pointers = new Map();
  const badLines = [];
  let section = null;
  for (const [i, raw] of String(text ?? '').split('\n').entries()) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      section = line.slice(3).trim().toLowerCase();
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const m = /^-\s+\[(?<title>.*?)\]\((?<file>[^)]+)\)\s*(?:[—–-]\s*(?<note>.*))?$/.exec(line);
    if (!m) {
      badLines.push({ line: i + 1, text: line.slice(0, 200) });
      continue;
    }
    const file = basename(m.groups.file.trim());
    pointers.set(file, {
      file,
      title: m.groups.title.trim(),
      summary: (m.groups.note ?? '').trim(),
      section,
      line: i + 1,
    });
  }
  return { pointers, badLines };
}

/** 列表源库里所有候选笔记文件。 */
export function listSourceNotes(sourceDir) {
  if (!existsSync(sourceDir)) return { files: [], missing: true };
  const entries = readdirSync(sourceDir).filter((f) => f.toLowerCase().endsWith('.md'));
  const files = entries.filter((f) => basename(f).toUpperCase() !== 'MEMORY.MD');
  files.sort();
  return { files, missing: false };
}

function safeRead(path) {
  try {
    return { ok: true, text: readFileSync(path, 'utf8'), bytes: statSync(path).size };
  } catch (e) {
    return { ok: false, error: { code: e.code ?? 'E_READ', message: String(e.message ?? e) } };
  }
}

/**
 * 生成导入计划（**纯读**）。
 *
 * @param {string} sourceDir 旧库目录
 * @param {object} [options] `{existing:[{id,note,body}], nextId:()=>string, now:number}`
 * @returns {{entries:Array, failures:Array, source:{dir,indexPointers,badLines,files}}}
 */
export function planImport(sourceDir, options = {}) {
  const now = options.now ?? Date.now();
  const nextId = options.nextId ?? (() => ulid(now));
  const existing = options.existing ?? [];

  // 已导入过的：`legacy.source_file` → 既有笔记（可重入的关键）
  const bySourceFile = new Map();
  // 按 id 索引：一篇切成 N 片后，每片各自认领自己那一条（`file#1`、`file#2`…）。
  // 只按 source_file 认领会把 N 片全指向同一条旧记录 —— 于是重跑时
  // N-1 片会去更新同一个 id，最后只剩一片，其余静默消失。
  const byId = new Map();
  for (const entry of existing) {
    if (entry.id) byId.set(String(entry.id), entry);
    const sf = entry.note?.legacy?.source_file;
    if (sf) bySourceFile.set(String(sf), entry);
  }

  const { files, missing } = listSourceNotes(sourceDir);
  const indexPath = join(sourceDir, 'MEMORY.md');
  let indexText = '';
  if (existsSync(indexPath)) {
    const got = safeRead(indexPath);
    if (got.ok) indexText = got.text;
  }
  const { pointers, badLines } = parseIndexPointers(indexText);

  const entries = [];
  const failures = [];

  for (const file of files) {
    const path = join(sourceDir, file);
    const got = safeRead(path);
    if (!got.ok) {
      failures.push({ file, code: got.error.code, message: got.error.message });
      continue;
    }
    const parsed = parseNoteLoose(got.text);
    if (parsed.errors?.length) {
      failures.push({ file, code: 'E_FRONTMATTER_SYNTAX', message: parsed.errors.map((e) => e.message).join('; ') });
      continue;
    }
    // 没有 frontmatter 的旧文件**不收**。
    //
    // 看起来可以「给它套一份默认元数据」，但那等于凭空断言：`classify()` 会按默认值
    // 把它判成 `reference` + `external`，于是文件里任何一句话都变成了「外部资料」，
    // 而它真正的类别（是用户偏好？是项目流程？）我们根本不知道。
    // 猜错的代价是双向的：猜成 external 就永远进不了 core 档，
    // 猜成 user_stated 就等于替用户认领了一句他从没说过的话。
    // 这种文件在旧库里通常是随手记的草稿，正确处置是列进 `not_imported` 让人看一眼。
    if (!parsed.frontmatter) {
      failures.push({
        file,
        code: 'E_FRONTMATTER_MISSING',
        message: '旧文件没有 frontmatter，判不出 type/scope（不猜：猜错会伪造 provenance）',
      });
      continue;
    }
    const fm = parsed.frontmatter ?? {};
    const body = String(parsed.body ?? '').trim();
    if (body === '') {
      failures.push({ file, code: 'E_EMPTY_BODY', message: '正文为空，导入没有意义' });
      continue;
    }
    const { category, via } = classify(file, fm);
    const kind = TYPE_TO_KIND[category] ?? 'semantic';
    const trust = TYPE_TO_TRUST[category] ?? 'external';
    const pointer = pointers.get(file) ?? null;
    const previous = bySourceFile.get(file) ?? null;

    const created = parseTime(fm.created ?? fm.updated ?? fm.date ?? null);
    const validFrom = created ? isoLocal(created) : isoLocal(now);
    const rev = sha256(body, 16);

    // 切分：旧文件里的一条「大篇」在这里变成 N 条独立事实。
    // 每片自己过闸门、自己发 id、自己算指纹 —— 一片不合格不该连累整篇。
    const cut = chunkText(body, IMPORT_CHUNK_CHARS, { maxParts: IMPORT_MAX_PARTS });
    if (cut.truncated) {
      failures.push({
        file,
        code: 'E_TOO_LARGE',
        message: `切分后仍超过 ${IMPORT_MAX_PARTS} 片，只收前 ${IMPORT_MAX_PARTS} 片（丢掉的记在这里，不静默）`,
      });
    }
    const stem = preferredId(file) ?? null;
    const stemId = stem ?? nextId();
    const made = [];
    let fragmentsDropped = 0;
    let fragmentsChars = 0;
    for (const [i, part] of cut.parts.entries()) {
      const partBody = String(part.text ?? '').trim();
      if (partBody === '') continue;
      if (partBody.length < IMPORT_MIN_CHUNK_CHARS) {
        fragmentsDropped += 1;
        fragmentsChars += partBody.length;
        continue;
      }
      const partRev = sha256(partBody, 16);
      // 单片的文件名就是源文件名（`gold_notes` 那套标注直接命中）；多片才加 `#n`。
      const partId = cut.parts.length === 1 ? stemId : stem ? `${stem}#${i + 1}` : nextId();
      const prev = byId.get(partId) ?? null;
      const chunkDefaults = {
        id: String(partId),
        scope: 'user',
        kind,
        trust,
        // 草稿状态给 user / feedback：这两类是「对用户的断言」，gated 写入才是常态；
        // 项目/资料类直接 active（它们是可核对的事实）。
        status: category === 'user' || category === 'feedback' ? 'draft' : 'active',
        tags: ['imported', category],
        writtenBy: 'import:engramory',
        sourceRef: 'engramory:' + file,
        validFrom,
        confidence: category === 'user' || category === 'feedback' ? 0.95 : 0.7,
      };
      const { note: partNote, body: builtBody } = buildCandidate({
        frontmatter: { ...fm, kind, trust },
        body: partBody,
        defaults: chunkDefaults,
      });
      partNote.scope = 'user';
      partNote.scope_detail = null;
      partNote.legacy = {
        source: 'engramory',
        source_file: file,
        // 从同一篇切出来的兄弟片：把「它们本来是一条」这件事留下，
        // 将来要做合并 / 去重时不必回头猜。用 `#` 分隔，永远不可能是合法 id，
        // 所以不会跟真实笔记混起来。
        derived_from: cut.parts.length > 1 ? [`engramory:${file}`] : [],
        part: cut.parts.length > 1 ? i + 1 : null,
        parts: cut.parts.length > 1 ? cut.parts.length : null,
        source_type: fm.type ?? category,
        classified_by: via,
        name: fm.name ?? null,
        description: fm.description ?? null,
        index_line: pointer?.line ?? null,
        index_section: pointer?.section ?? null,
        created: fm.created ?? null,
        updated: fm.updated ?? null,
        rev: partRev,
        imported_at: isoLocal(now),
      };
      const fp = contentFingerprint({ scope: partNote.scope, kind: partNote.kind, body: builtBody, subject: null, predicate: null });
      const same = Boolean(
        prev &&
          prev.note?.legacy?.rev === partRev &&
          contentFingerprint({
            scope: prev.note.scope,
            kind: prev.note.kind,
            body: prev.body,
            subject: prev.note.subject,
            predicate: prev.note.predicate,
          }) === fp,
      );
      made.push({
        id: String(partId),
        body: builtBody,
        rev: partRev,
        fingerprint: fp,
        note: partNote,
        chars: charLength(builtBody),
        action: prev ? (same ? 'skip' : 'update') : 'create',
      });
    }

    if (made.length === 0) {
      failures.push({
        file,
        code: fragmentsDropped > 0 ? 'E_ONLY_FRAGMENTS' : 'E_EMPTY_BODY',
        message:
          fragmentsDropped > 0
            ? `整篇都是小于 ${IMPORT_MIN_CHUNK_CHARS} 字的碎片（${fragmentsDropped} 片），没有可入档的事实`
            : '切分后没有可用内容',
      });
      continue;
    }

    entries.push({
      file,
      path,
      id: made[0].id,
      ids: made.map((c) => c.id),
      title: pointer?.title ?? noteTitle(body),
      category,
      kind,
      trust,
      status: made[0].note.status,
      chars: charLength(body),
      bytes: got.bytes,
      rev,
      fingerprint: sha256(body, 16),
      valid_from: validFrom,
      index_summary: pointer?.summary ?? collapse((fm.description ?? body).toString(), 120),
      split: cut.parts.length > 1 ? { parts: made.length, chars: IMPORT_CHUNK_CHARS } : null,
      fragments_dropped: fragmentsDropped,
      fragments_chars: fragmentsChars,
      action: made.every((c) => c.action === 'skip') ? 'skip' : 'create',
      chunks: made,
    });
  }

  return {
    source: {
      dir: sourceDir,
      missing,
      notes: files.length,
      index: indexPath,
      indexExists: existsSync(indexPath),
      indexLines: indexText === '' ? 0 : indexText.replace(/\n$/, '').split('\n').length,
      indexPointers: pointers.size,
      badLines,
    },
    entries,
    failures,
  };
}

/**
 * 源文件名能不能直接当 id：能就用它，不能返回 null。
 *
 * 条件是**宽松但有底线**：只取 basename、去掉 `.md`，然后必须过 `safeNoteId()`
 * 那关（不许有路径分隔符/`..`/空字节/超长）。旧库里已经有 `.md` 后缀的名字
 * （`store.js` 的 `notePath` 会再拼一次 `.md`，`safeNoteId` 会先剥掉一层后缀，
 * 所以 `user-preferences.md` 落到磁盘上仍然是 `notes/user-preferences.md.md` —— 见下面注释）。
 */
function preferredId(file) {
  const stem = basename(String(file ?? '')).replace(/\.md$/i, '');
  if (!stem) return null;
  const safe = safeNoteId(stem);
  return safe.ok ? safe.id : null;
}

function previouslyMissing(prev) {
  return !prev;
}

function noteTitle(body) {
  const first = String(body).split('\n').find((l) => /^#{1,3}\s+/.test(l.trim()));
  return first ? first.trim().replace(/^#{1,3}\s+/, '') : String(body).split('\n')[0].slice(0, 80);
}

/**
 * 执行导入：把计划里 `create`/`update` 的条目过闸门后写入目标库，最后重建索引。
 *
 * `dry:true` 时**只跑判定不落盘**（判定的函数与真写完全同一个）。
 */
export function applyImport(store, plan, { dry = false, remember, force = false, ledger = () => {} } = {}) {
  // `store` 是 `openStore()` 的 ctx（有 `rebuildIndex()`），也可以是纯路径字符串
  // （测试与脚本只想拿结果时不必造 ctx）。索引重建是唯一需要 ctx 的地方。
  const results = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let denied = 0;

  for (const entry of plan.entries) {
    const chunks = entry.chunks ?? [];
    let partSkipped = 0;
    let created = 0;
    let updatedHere = 0;
    let partDenied = 0;
    let last = { gate: 'allow', reason: null, details: null };
    for (const chunk of chunks) {
      if (chunk.action === 'skip') {
        skipped += 1;
        partSkipped += 1;
        results.push({ file: entry.file, id: chunk.id, action: 'skip', verdict: 'allow', reason: 'unchanged' });
        continue;
      }
      const outcome = remember(
        { candidate: chunk.note, body: chunk.body },
        { dry, force, writtenBy: 'import:engramory', skipIndex: true },
      );
      const verdict = outcome.verdict === 'allow' ? 'allow' : 'deny';
      last = { gate: outcome.gate, reason: outcome.reason, details: outcome.details };
      if (verdict === 'allow') {
        // `--dry` 只报计划：磁盘上什么都没发生，所以 `imported` 必须是 0。
        // 把「如果真跑会写几条」计进 `imported`，会让 `--dry` 的输出与「真跑一遍」
        // 无法区分 —— 而 `--dry` 存在的全部意义就是让人先看一眼再决定。
        // 想写会写几条，看 `planned`。
        if (!dry) {
          if (chunk.action === 'create') imported += 1;
          else updated += 1;
        }
        if (chunk.action === 'create') created += 1;
        else updatedHere += 1;
      } else {
        denied += 1;
        partDenied += 1;
      }
      results.push({
        file: entry.file,
        id: chunk.id,
        action: chunk.action,
        verdict,
        gate: outcome.gate,
        reason: outcome.reason,
        detail: outcome.gate === 'deny' ? firstDetail(outcome.details) : null,
      });
    }
    // 逐**源文件**的结论：一篇切成 7 片、其中 1 片被拒时，
    // 只看总计数会以为「这篇进来了」。
    entry.result = {
      parts: chunks.length,
      skipped: partSkipped,
      created,
      updated: updatedHere,
      denied: partDenied,
      gate: last.gate,
      reason: last.reason,
    };
  }

  const summary = {
    source: plan.source.dir,
    // `source` 是路径字符串（打印用）；「源库在不在」得单独带出来，
    // 否则调用方只能靠 `planned === 0` 猜，而空源库和打错的路径长得一模一样。
    sourceMissing: Boolean(plan.source.missing),
    dry,
    // `planned` 是**要写几条笔记**，不是「几个源文件」：一篇切成 7 片就是 7 条。
    // 两个口径混用会让「导入了 22 条」这种输出没法解释。
    planned: plan.entries.reduce((n, e) => n + (e.chunks?.length ?? 1), 0),
    sourceFiles: plan.entries.length,
    // 碎片有账：它们没进闸门，所以 `denied` 里看不到，但不记就等于静默丢弃。
    fragmentsDropped: plan.entries.reduce((n, e) => n + (e.fragments_dropped ?? 0), 0),
    fragmentsChars: plan.entries.reduce((n, e) => n + (e.fragments_chars ?? 0), 0),
    imported,
    updated,
    skipped,
    denied,
    failures: plan.failures.length,
    indexPointers: plan.source.indexPointers,
    badIndexLines: plan.source.badLines.length,
    // 「任何静默截断都要有账」同样适用于导入：源库有、我们没收下的，逐条列出来。
    not_imported: plan.failures.map((f) => ({ file: f.file, code: f.code })),
    denied_files: results.filter((r) => r.verdict === 'deny').map((r) => ({ file: r.file, id: r.id, reason: r.reason })),
  };
  ledger({ kind: dry ? 'import_planned' : 'import_applied', ...summary });
  // `source.missing` 也算不 ok：源路径打错时导 0 条并报成功，
  // 会让调用方以为「源库本来就是空的」。
  // 索引重建放在**最后一次性做**：写路径上每笔都重建是 O(n²)（见 `remember()` 注释）。
  // `--dry` 什么都不写，自然也不用重建。
  let index = null;
  if (!dry && (imported > 0 || updated > 0) && typeof store?.rebuildIndex === 'function') {
    index = store.rebuildIndex();
  }
  const ok = !plan.source.missing && summary.denied === 0 && summary.failures === 0;
  return { ok, ...summary, index, results };
}

function firstDetail(details) {
  for (const [k, v] of Object.entries(details ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') return { [k]: v };
  }
  return null;
}

export function readSourceIndex(sourceDir) {
  const path = join(sourceDir, 'MEMORY.md');
  if (!existsSync(path)) return { exists: false, path, text: '' };
  const got = safeRead(path);
  return { exists: true, path, text: got.ok ? got.text : '' };
}
