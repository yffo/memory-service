/**
 * 反馈事件的落盘与读取（`<store>/runs/feedback.jsonl`，一行一个事件）。
 *
 * 为什么是 JSONL 而不是回执：反馈是高频、小条、只追加的信号，不需要回执那种
 * 哈希与不可覆盖保证；半截行在读取时被跳过即可。
 *
 * 读取时同时兼容两个**历史插件文件**（`panel-feedback.jsonl` 与
 * `outcome.jsonl`，都在库根目录）。插件把反馈迁到核心后，旧数据不会被丢掉；
 * 新写入只进 `runs/feedback.jsonl`。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from './vault.js';
import { FEEDBACK_SIGNALS } from '../core/feedback.js';

export const FEEDBACK_LOG = 'feedback.jsonl';
export const LEGACY_FILES = Object.freeze(['panel-feedback.jsonl', 'outcome.jsonl']);

export function feedbackLogPath(storePath) {
  return join(paths(storePath).runs, FEEDBACK_LOG);
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const signal = String(row.signal ?? '');
  if (!FEEDBACK_SIGNALS.includes(signal)) return null;
  const noteIds = Array.isArray(row.noteIds)
    ? row.noteIds.map(String).filter(Boolean).slice(0, 6)
    : row.id
      ? [String(row.id)]
      : [];
  if (!noteIds.length) return null;
  return {
    signal,
    noteIds,
    query: String(row.query ?? '').slice(0, 120),
    source: String(row.source ?? '').slice(0, 40),
    at: Number(row.at) || Date.now(),
  };
}

export function appendFeedback(storePath, entry = {}) {
  const row = normalizeRow(entry);
  if (!row) return { ok: false, reason: 'invalid_entry' };
  try {
    const file = feedbackLogPath(storePath);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true, path: file, signal: row.signal, noteIds: row.noteIds };
  } catch (error) {
    return { ok: false, reason: 'write_failed', message: String(error?.message ?? error) };
  }
}

function readFileRows(file, max) {
  if (!existsSync(file)) return [];
  const rows = [];
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  for (const line of lines.slice(-max)) {
    try {
      const row = normalizeRow(JSON.parse(line));
      if (row) rows.push(row);
    } catch {
      // A torn line from a crashed write is skipped, never fatal.
    }
  }
  return rows;
}

/** 读取核心日志与两个历史插件文件，按时间排序（旧数据自动接上）。 */
export function readFeedbackRows(storePath, { max = 5000, legacy = true } = {}) {
  const files = [feedbackLogPath(storePath)];
  if (legacy) {
    for (const name of LEGACY_FILES) files.push(join(storePath, name));
  }
  const rows = [];
  for (const file of files) rows.push(...readFileRows(file, max));
  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return rows.slice(-Math.max(1, max));
}
