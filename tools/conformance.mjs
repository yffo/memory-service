#!/usr/bin/env node
/**
 * 核心一致性自检（conformance）。
 *
 * 这是给「宿主适配器」用的契约检查：任何把 tabellio 接进 agent 的适配器（DSH 插件、Claude Code
 * hooks、MCP 客户端……）都应该通过同一组不变量。检查只碰临时库，不联网、不写真实库。
 *
 *   node tools/conformance.mjs             # 全部检查
 *   node tools/conformance.mjs --json      # 机器可读（含契约声明）
 *   node tools/conformance.mjs --contract  # 只打印适配器契约（版本 + 能力表）
 *
 * 退出码：0 全过；1 有失败；2 用法错误（未知参数）。
 *
 * 覆盖的不变量：
 *   1. 空库可读、状态自洽
 *   2. 写入闸：过短/凭据值拒绝
 *   3. remember → search/recall 能看到
 *   4. draft 笔记：read 可见、recall 不可见
 *   5. 候选先入候选区，批准后才成为笔记
 *   6. archived 笔记：read 可见、recall 不可见、语义索引不收录
 *   7. 反馈重排不增删条目
 *   8. 回执可回放校验
 *   9. CLI 与 MCP 看到同一个库
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addCandidate,
  consolidate,
  indexSemantic,
  recallQuery,
  recordFeedback,
  remember,
  reviewCandidates,
  search,
  semanticRecall,
  mergeSemanticItems,
  openStore,
  read,
  status,
  verifyRecallReceipt,
} from '../src/api.js';
import { contractView } from '../src/conformance.js';
import { READ_TOOLS, SUPPORTED_PROTOCOL_VERSIONS, WRITE_TOOLS } from '../src/mcp/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'bin');

const results = [];
const pass = (name) => results.push({ name, ok: true });
const fail = (name, detail) => results.push({ name, ok: false, detail: String(detail ?? '') });

/** 确定性假向量：只用于验证索引/合并/排序的管道，不代表语义质量。 */
function fakeVector(text, dims = 12) {
  const vector = new Array(dims).fill(0);
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0) ?? 0;
    vector[code % dims] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

function writeDraft(storePath, id, body) {
  fs.mkdirSync(path.join(storePath, 'notes'), { recursive: true });
  const text = [
    '---',
    'schema: memory.note/1',
    'id: ' + id,
    'scope: project:conformance',
    'kind: semantic',
    'trust: user_stated',
    'status: draft',
    'valid_from: 2026-10-21',
    'provenance:',
    '  written_by: conformance',
    '  source_ref: null',
    'name: ' + id,
    '---',
    '',
    '# ' + id,
    '',
    body,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(storePath, 'notes', id + '.md'), text);
}

function runNode(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--json', '--contract', '--help', '-h']);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    process.stderr.write('conformance: unknown argument ' + unknown.join(' ') + '\n');
    process.exitCode = 2;
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: conformance [--json] [--contract]\n');
    return;
  }
  if (argv.includes('--contract')) {
    process.stdout.write(JSON.stringify(contractView(), null, 2) + '\n');
    return;
  }
  const json = argv.includes('--json');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabellio-conformance-'));
  const storePath = path.join(scratch, 'store');
  fs.mkdirSync(path.join(storePath, 'notes'), { recursive: true });
  const ctx = openStore(storePath);
  try {
    // 1. 空库
    const empty = status(ctx);
    if (Number(empty.notes) === 0) pass('empty store reports zero notes');
    else fail('empty store reports zero notes', JSON.stringify(empty).slice(0, 200));

    // 2. 写入闸
    const tooShort = remember(ctx, { content: '短' });
    if (!tooShort.ok) pass('write gate rejects too-short content');
    else fail('write gate rejects too-short content', 'accepted');
    const credential = remember(ctx, { content: '数据库密码是 Abc123xyz' });
    if (!credential.ok) pass('write gate rejects credential values');
    else fail('write gate rejects credential values', 'accepted');

    // 3. remember → search / recall
    const note = remember(ctx, { content: 'Conformance 检查：青鸟部署端口是 8443，只在内网监听。' });
    const noteId = note.id ?? note.noteId ?? note.note?.id;
    if (note.ok && noteId) pass('remember writes a note');
    else fail('remember writes a note', JSON.stringify(note).slice(0, 300));
    const found = search(ctx, '青鸟部署端口');
    if ((found.hits ?? []).some((hit) => hit.id === noteId)) pass('search finds the new note');
    else fail('search finds the new note', JSON.stringify(found).slice(0, 300));
    const recalled = recallQuery(ctx, '青鸟部署端口是多少？');
    if ((recalled.items ?? []).some((item) => item.id === noteId)) pass('recall returns the new note');
    else fail('recall returns the new note', JSON.stringify(recalled.items ?? []).slice(0, 300));

    // 4. draft 隔离
    writeDraft(storePath, 'conformance-draft', 'ConformanceDraft 只在草稿里，永远不该被自动召回。');
    ctx.invalidate();
    const draftRead = read(ctx, 'conformance-draft');
    if (draftRead.ok !== false && draftRead.note?.status === 'draft') pass('draft note is readable');
    else fail('draft note is readable', JSON.stringify(draftRead).slice(0, 200));
    const draftRecall = recallQuery(ctx, 'ConformanceDraft 草稿在哪里？');
    if (!(draftRecall.items ?? []).some((item) => item.id === 'conformance-draft')) pass('draft note is excluded from recall');
    else fail('draft note is excluded from recall', JSON.stringify(draftRecall.items).slice(0, 200));

    // 5. 候选漏斗
    const before = Number(status(ctx).notes);
    const candidate = addCandidate(ctx, { text: 'Conformance 候选：每周五下午发版，必须走 tag。', source: 'conformance' });
    const candidateId = (candidate.candidate ?? candidate).id;
    const afterCandidate = status(ctx);
    if (afterCandidate.notes === before && afterCandidate.candidates >= 1) pass('candidates do not become notes');
    else fail('candidates do not become notes', JSON.stringify(afterCandidate).slice(0, 200));
    const reviewed = reviewCandidates(ctx, { accept: [candidateId] });
    if (reviewed.ok && (reviewed.accepted ?? []).length === 1 && Number(status(ctx).notes) === before + 1) pass('approving a candidate writes a note');
    else fail('approving a candidate writes a note', JSON.stringify(reviewed).slice(0, 300));

    // 6. archived 隔离
    const archived = consolidate(ctx, { archive: [noteId], apply: true });
    if (archived.ok) pass('consolidate can archive a note');
    else fail('consolidate can archive a note', JSON.stringify(archived).slice(0, 200));
    const archivedRead = read(ctx, noteId);
    if (archivedRead.note?.status === 'archived') pass('archived note stays readable');
    else fail('archived note stays readable', JSON.stringify(archivedRead).slice(0, 200));
    const archivedRecall = recallQuery(ctx, '青鸟部署端口是多少？');
    if (!(archivedRecall.items ?? []).some((item) => item.id === noteId)) pass('archived note is excluded from recall');
    else fail('archived note is excluded from recall', JSON.stringify(archivedRecall.items).slice(0, 200));

    // 7. 语义索引 / 合并不复活归档
    const indexed = await indexSemantic(ctx, { embed: (texts) => texts.map((text) => fakeVector(text)), model: 'conformance-fake' });
    if (indexed.ok && indexed.size > 0) pass('semantic index builds from active notes');
    else fail('semantic index builds from active notes', JSON.stringify(indexed).slice(0, 200));
    const semanticHits = await semanticRecall(ctx, '青鸟部署端口', { embed: (texts) => texts.map((text) => fakeVector(text)), model: 'conformance-fake', top: 5 });
    if (Array.isArray(semanticHits.hits)) pass('semantic recall returns ranked hits');
    else fail('semantic recall returns ranked hits', JSON.stringify(semanticHits).slice(0, 200));
    const merged = mergeSemanticItems(
      { items: [], refused: true, why_not: 'no_match' },
      {
        hits: [{ id: noteId, score: 0.9 }, { id: 'conformance-draft', score: 0.95 }],
        readNote: (id) => read(ctx, id),
        maxNotes: 5,
        allowedTrusts: ['user_stated', 'system_derived'],
      },
    );
    if (!(merged.items ?? []).some((item) => item.id === noteId)) pass('semantic merge never resurrects archived notes');
    else fail('semantic merge never resurrects archived notes', JSON.stringify(merged.items).slice(0, 200));

    // 8. 反馈重排不增删
    const approvedId = (reviewed.accepted ?? [])[0]?.id;
    recordFeedback(ctx, { id: approvedId, signal: 'wrong' });
    const withFeedback = recallQuery(ctx, '每周五下午发版', { applyFeedback: true });
    const withoutFeedback = recallQuery(ctx, '每周五下午发版', { applyFeedback: false });
    if ((withFeedback.items ?? []).length === (withoutFeedback.items ?? []).length) pass('feedback re-ranks without adding or removing items');
    else fail('feedback re-ranks without adding or removing items', `${withFeedback.items?.length} vs ${withoutFeedback.items?.length}`);

    // 9. 回执
    const receiptRun = recallQuery(ctx, '每周五下午发版', { saveReceipt: true });
    const opened = verifyRecallReceipt(ctx, receiptRun.receiptPath);
    if (receiptRun.receiptPath && fs.existsSync(receiptRun.receiptPath) && opened.ok) pass('recall receipt verifies offline');
    else fail('recall receipt verifies offline', JSON.stringify(opened).slice(0, 200));

    // 9.5 契约声明与真实工具面一致
    const contract = contractView();
    const mcpSurface = contract.capabilities.mcp;
    const sameCounts = mcpSurface.readTools === READ_TOOLS.length && mcpSurface.writeTools === WRITE_TOOLS.length;
    const sameVersions = mcpSurface.protocolVersions.join(',') === SUPPORTED_PROTOCOL_VERSIONS.join(',');
    if (sameCounts && sameVersions) pass('contract declaration matches the MCP tool surface');
    else fail('contract declaration matches the MCP tool surface', JSON.stringify({ mcpSurface, read: READ_TOOLS.length, write: WRITE_TOOLS.length }));

    // 10. CLI 与 MCP 一致性
    const cli = await runNode([path.join(BIN, 'memory'), 'status', '--store', storePath, '--json']);
    let cliNotes = null;
    try {
      cliNotes = Number(JSON.parse(cli.stdout).notes);
    } catch {
      cliNotes = null;
    }
    if (cliNotes === Number(status(ctx).notes)) pass('CLI reads the same store');
    else fail('CLI reads the same store', `exit ${cli.code} stdout ${cli.stdout.slice(0, 160)}`);
    const mcpMessages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'conformance', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } },
    ];
    const mcp = await runNode([path.join(BIN, 'memory-mcp'), '--store', storePath], {
      input: mcpMessages.map((message) => JSON.stringify(message)).join('\n') + '\n',
    });
    const replies = new Map();
    const noise = [];
    for (const line of mcp.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id != null) replies.set(parsed.id, parsed);
      } catch {
        noise.push(trimmed);
      }
    }
    const tools = replies.get(2)?.result?.tools ?? [];
    if (replies.get(1)?.result?.serverInfo && tools.some((tool) => tool.name === 'recall')) pass('MCP initialize + tools/list succeeds');
    else fail('MCP initialize + tools/list succeeds', mcp.stdout.slice(0, 200));
    if (replies.get(3)?.result?.content) pass('MCP tools/call status returns content');
    else fail('MCP tools/call status returns content', JSON.stringify(replies.get(3)).slice(0, 200));
    if (noise.length === 0) pass('MCP stdout carries only JSON-RPC');
    else fail('MCP stdout carries only JSON-RPC', noise.slice(0, 1).join(' ').slice(0, 200));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const failures = results.filter((result) => !result.ok);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: failures.length === 0, contract: contractView(), checks: results }, null, 2) + '\n');
  } else {
    for (const result of results) {
      process.stdout.write((result.ok ? 'PASS ' : 'FAIL ') + result.name + (result.ok ? '' : ' — ' + result.detail) + '\n');
    }
    process.stdout.write(`\n${results.length - failures.length}/${results.length} checks passed\n`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write('conformance: ' + (error?.stack ?? error) + '\n');
  process.exit(1);
});
