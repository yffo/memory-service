/**
 * 自动巩固提案的落盘：只是 `runs/proposals/` 下的 JSON 清单，不是真相源。
 *
 * 为什么单独放文件而不是塞进 `notes/candidates/`：候选是「一条还没入库的记忆」，
 * 巩固提案是「一次对多条现有记忆的操作」。两者批准后的动作不同，混在一起会让
 * `inbox --accept` 分不清该写笔记还是该合并笔记。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { paths } from './vault.js';

export const PROPOSAL_SCHEMA = 'tabellio.consolidate.auto.proposal/1';

export function proposalsDir(storePath) {
  return join(paths(storePath).runs, 'proposals');
}

function proposalPath(storePath, id) {
  return join(proposalsDir(storePath), String(id) + '.json');
}

function safeId(id) {
  const value = String(id ?? '').trim();
  if (!/^prop_[a-z0-9]{16,40}$/.test(value)) return null;
  return value;
}

function writeJsonAtomic(path, value, { replace = false } = {}) {
  const tmp = path + '.tmp-' + process.pid;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!replace && existsSync(path)) return { ok: false, reason: 'exists', path };
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* tmp 可能没建起来 */ }
    return { ok: false, reason: 'write_failed', path, error: String(e?.message ?? e) };
  }
  return { ok: true, path };
}

export function writeConsolidationProposal(storePath, proposal, { replace = false } = {}) {
  const id = safeId(proposal?.proposal_id);
  if (!id) return { ok: false, reason: 'invalid_id', path: null };
  if (proposal?.schema !== PROPOSAL_SCHEMA) return { ok: false, reason: 'invalid_schema', path: null };
  return writeJsonAtomic(proposalPath(storePath, id), { ...proposal, status: 'pending' }, { replace });
}

function parseProposal(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'unreadable', path, error: String(e?.message ?? e) };
  }
  if (data?.schema !== PROPOSAL_SCHEMA) return { ok: false, reason: 'invalid_schema', path };
  const id = safeId(data.proposal_id);
  if (!id || !Array.isArray(data.source_ids) || data.source_ids.length < 2) {
    return { ok: false, reason: 'invalid_proposal', path };
  }
  if (data.status !== undefined && data.status !== 'pending') return { ok: false, reason: 'not_pending', path };
  return { ok: true, proposal: data, path };
}

export function readConsolidationProposal(storePath, id) {
  const safe = safeId(id);
  if (!safe) return { ok: false, reason: 'invalid_id', path: null };
  const path = proposalPath(storePath, safe);
  if (!existsSync(path)) return { ok: false, reason: 'not_found', path };
  return parseProposal(path);
}

export function listConsolidationProposals(storePath) {
  const dir = proposalsDir(storePath);
  if (!existsSync(dir)) return { ok: true, count: 0, proposals: [], failures: [] };
  const proposals = [];
  const failures = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith('.json')) continue;
    const got = parseProposal(join(dir, item.name));
    if (!got.ok) {
      failures.push({ file: item.name, reason: got.reason });
      continue;
    }
    proposals.push(got.proposal);
  }
  proposals.sort((a, b) => {
    const ta = a.created_at ?? '';
    const tb = b.created_at ?? '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.proposal_id < b.proposal_id ? 1 : a.proposal_id > b.proposal_id ? -1 : 0;
  });
  return { ok: true, count: proposals.length, proposals, failures };
}

/** 批准/拒绝后把提案移出待处理目录；不覆盖已有决策记录。 */
export function moveConsolidationProposal(storePath, id, decision) {
  if (decision !== 'accepted' && decision !== 'rejected') {
    return { ok: false, reason: 'invalid_decision', path: null };
  }
  const safe = safeId(id);
  if (!safe) return { ok: false, reason: 'invalid_id', path: null };
  const from = proposalPath(storePath, safe);
  if (!existsSync(from)) return { ok: false, reason: 'not_found', path: from };
  const dir = join(proposalsDir(storePath), decision);
  const to = join(dir, safe + '.json');
  if (existsSync(to)) return { ok: false, reason: 'decision_exists', path: to };
  try {
    mkdirSync(dir, { recursive: true });
    renameSync(from, to);
  } catch (e) {
    return { ok: false, reason: 'move_failed', path: to, error: String(e?.message ?? e) };
  }
  return { ok: true, path: to };
}
