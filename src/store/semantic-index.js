/**
 * 语义索引的落盘格式（`runs/semantic-index.json`）。
 *
 * 索引是派生物：删掉可重建，模型换了自动失效，解析失败一律当空索引。
 * 这里只管读写和形状校验；「哪些笔记该进索引」由 `core/semantic.js` 决定。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './vault.js';

export const SEMANTIC_INDEX_FILE = 'semantic-index.json';
export const SEMANTIC_INDEX_SCHEMA = 1;

export function semanticIndexPath(storePath) {
  return join(paths(storePath).runs, SEMANTIC_INDEX_FILE);
}

function validEntry(entry) {
  return Boolean(
    entry &&
      typeof entry.id === 'string' &&
      entry.id &&
      typeof entry.hash === 'string' &&
      Array.isArray(entry.vector) &&
      entry.vector.length > 0 &&
      entry.vector.every((value) => Number.isFinite(value)),
  );
}

/** 读索引；模型不一致、文件坏了、没建过，都返回空 Map（调用方按「需要重建」处理）。 */
export function loadSemanticIndex(storePath, model) {
  const path = semanticIndexPath(storePath);
  if (!existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || raw.model !== model || !Array.isArray(raw.notes)) return new Map();
    const index = new Map();
    for (const entry of raw.notes) {
      if (validEntry(entry)) index.set(entry.id, { hash: entry.hash, vector: entry.vector });
    }
    return index;
  } catch {
    return new Map();
  }
}

/** 原子性不做强求：索引是派生物，写坏了下次重建。返回是否落盘成功。 */
export function saveSemanticIndex(storePath, model, index) {
  try {
    const runs = paths(storePath).runs;
    mkdirSync(runs, { recursive: true });
    const notes = [];
    for (const [id, entry] of index) notes.push({ id, hash: entry.hash, vector: entry.vector });
    writeFileSync(
      join(runs, SEMANTIC_INDEX_FILE),
      JSON.stringify({ schema: SEMANTIC_INDEX_SCHEMA, model, builtAt: new Date().toISOString(), notes }),
    );
    return true;
  } catch {
    return false;
  }
}
