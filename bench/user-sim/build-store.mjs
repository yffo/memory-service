#!/usr/bin/env node
/**
 * 把「模拟用户」人格 JSON 编译成 tabellio 能读的库：
 *   node bench/user-sim/build-store.mjs --out <dir> personas/a.json [personas/b.json ...]
 * 产出 <dir>/notes/*.md 与 <dir>/queries.json（gold 已解析成 note id）。
 *
 * 只读人格文件、只写 --out 目录。--combined 时把所有笔记放进同一个库（id 不冲突）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from '../../src/util/ulid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { out: null, combined: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--combined') out.combined = true;
    else out.files.push(a);
  }
  if (!out.out || out.files.length === 0) {
    console.error('用法：node bench/user-sim/build-store.mjs --out <dir> [--combined] <persona.json...>');
    process.exit(2);
  }
  return out;
}

const q = (s) => JSON.stringify(String(s));
const arr = (xs) => `[${(xs ?? []).map((x) => (typeof x === 'string' && !/^[A-Za-z0-9_.:-]+$/.test(x) ? q(x) : x)).join(', ')}]`;

const stamp = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T09:00:00+08:00` : iso);

function normalizeScope(scope) {
  if (!scope || scope === 'personal' || scope === 'user') return 'user';
  if (String(scope).startsWith('project:')) return String(scope);
  return `project:${scope}`;
}

function supersedesTitle(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function renderNote(note) {
  const lines = [
    '---',
    'schema: memory.note/1',
    `id: ${note.id}`,
    `scope: ${q(normalizeScope(note.scope))}`,
    `kind: ${note.kind ?? 'semantic'}`,
    `trust: ${note.trust ?? 'user_stated'}`,
    'provenance:',
    '  written_by: "user:sim"',
    '  source_ref: null',
    '  derived_from: []',
    `valid_from: ${q(stamp(note.valid_from ?? '2026-06-01'))}`,
    `valid_to: ${note.valid_to ? q(stamp(note.valid_to)) : 'null'}`,
    `supersedes: ${arr(note.supersedesIds ?? [])}`,
    `superseded_by: ${note.supersededById ? q(note.supersededById) : 'null'}`,
    `confidence: ${Number(note.confidence ?? 0.9)}`,
    'verify_after: null',
    `tags: ${arr(note.tags ?? [])}`,
    '---',
    '',
    `# ${note.title}`,
    '',
    String(note.body ?? '').trim(),
    '',
  ];
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const personas = opts.files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const outDir = path.resolve(opts.out);
  const notesDir = path.join(outDir, 'notes');
  fs.rmSync(notesDir, { recursive: true, force: true });
  fs.mkdirSync(notesDir, { recursive: true });

  const allNotes = [];
  const allQueries = [];
  for (const persona of personas) {
    const byTitle = new Map();
    const notes = (persona.notes ?? []).map((n) => ({ ...n, id: ulid() }));
    for (const n of notes) {
      if (!n.title) throw new Error(`${persona.persona}: 笔记缺 title`);
      if (byTitle.has(n.title)) throw new Error(`${persona.persona}: title 重复：${n.title}`);
      byTitle.set(n.title, n);
    }
    // supersedes 先解析成 id，再把旧笔记的 superseded_by / valid_to 补上
    for (const n of notes) {
      const target = supersedesTitle(n.supersedes);
      if (!target) continue;
      const old = byTitle.get(target);
      if (!old) throw new Error(`${persona.persona}: supersedes 指向不存在的 title：${target}`);
      n.supersedesIds = [old.id];
      old.supersededById = n.id;
      if (!old.valid_to) old.valid_to = n.valid_from;
    }
    for (const n of notes) {
      if (opts.combined && n.scope && !n.scope.startsWith('project:') && n.scope !== 'personal') {
        n.scope = `${persona.persona}:${n.scope}`;
      }
      fs.writeFileSync(path.join(notesDir, `${n.id}.md`), renderNote(n), 'utf8');
      allNotes.push(n);
    }
    for (const query of persona.queries ?? []) {
      const goldIds = (query.gold ?? []).map((title) => {
        const n = byTitle.get(title);
        if (!n) throw new Error(`${persona.persona}/${query.id}: gold 指向不存在的 title：${title}`);
        return n.id;
      });
      allQueries.push({
        persona: persona.persona,
        id: `${persona.persona}-${query.id}`,
        query: query.query,
        gold: goldIds,
        answerable: query.answerable !== false && goldIds.length > 0,
        why: query.why ?? null,
      });
    }
  }

  fs.writeFileSync(
    path.join(outDir, 'queries.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), notes: allNotes.length, queries: allQueries }, null, 1),
    'utf8',
  );
  const answerable = allQueries.filter((x) => x.answerable).length;
  console.log(`库：${outDir}`);
  console.log(`笔记 ${allNotes.length} 篇，查询 ${allQueries.length} 条（可答 ${answerable} / 不可答 ${allQueries.length - answerable}）`);
}

main();
