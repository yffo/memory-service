#!/usr/bin/env node
/**
 * 评测门控调参：在冻结题集上扫阈值网格，给出**不退化**的建议值；不写任何配置。
 *
 *   node tools/tune-recall.mjs                      # 默认 bench/core-30-v1 题集 + 临时库
 *   node tools/tune-recall.mjs --json               # 机器可读
 *   node tools/tune-recall.mjs --store <dir>        # 用显式库（默认把 library/ 复制到 /tmp）
 *
 * 退出码：0 = 建议与基线相同；3 = 存在更优候选，需要人批准后手动落配置。
 *
 * 口径：正例看 source 是否进 top-k；拒答题（题集里没有 `source` 的）看有没有被注入内容。
 * 决策规则在 `src/core/tuning.js`：命中不能少、误注入不能多、至少一项严格更好。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, recallQuery } from '../src/api.js';
import { DEFAULT_THRESHOLDS } from '../src/core/recall.js';
import { chooseCandidate, gridPoints, scoreRun } from '../src/core/tuning.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const opts = {
    tasks: path.join(ROOT, 'bench', 'core-30-v1', 'tasks.json'),
    library: path.join(ROOT, 'bench', 'core-30-v1', 'library'),
    store: null,
    k: 5,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') opts.json = true;
    else if (token === '--tasks') opts.tasks = argv[++index];
    else if (token === '--library') opts.library = argv[++index];
    else if (token === '--store') opts.store = argv[++index];
    else if (token === '--k') opts.k = Math.max(1, Number(argv[++index]) || 5);
    else if (token === '--help' || token === '-h') {
      process.stdout.write('usage: tune-recall.mjs [--tasks FILE] [--library DIR] [--store DIR] [--k N] [--json]\n');
      process.exit(0);
    }
  }
  return opts;
}

function prepareStore(opts) {
  if (opts.store) return { storePath: path.resolve(opts.store), scratch: null };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabellio-tune-'));
  const storePath = path.join(scratch, 'store');
  fs.mkdirSync(path.join(storePath, 'notes'), { recursive: true });
  let copied = 0;
  for (const file of fs.readdirSync(opts.library)) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
    fs.copyFileSync(path.join(opts.library, file), path.join(storePath, 'notes', file));
    copied += 1;
  }
  return { storePath, scratch, copied };
}

function runPoint(ctx, tasks, { point, k }) {
  const runs = tasks.map((task) => {
    const result = recallQuery(ctx, task.prompt, {
      maxNotes: k,
      minRelevance: point.minRelevance,
      minScore: point.minScore,
      minCoverage: point.minCoverage,
    });
    return { task_id: task.id, hits: Array.isArray(result.items) ? result.items.map((item) => ({ id: item.id })) : [] };
  });
  return scoreRun({ tasks, runs, k });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const set = JSON.parse(fs.readFileSync(opts.tasks, 'utf8'));
  const tasks = Array.isArray(set.tasks) ? set.tasks : [];
  if (!tasks.length) {
    process.stderr.write('tune-recall: tasks file has no tasks: ' + opts.tasks + '\n');
    process.exit(2);
  }
  const { storePath, scratch, copied } = prepareStore(opts);
  try {
    const ctx = openStore(storePath);
    const baselinePoint = {
      minRelevance: DEFAULT_THRESHOLDS.minRelevance,
      minScore: DEFAULT_THRESHOLDS.minScore,
      minCoverage: DEFAULT_THRESHOLDS.minCoverage,
    };
    const baseline = { ...runPoint(ctx, tasks, { point: baselinePoint, k: opts.k }), point: baselinePoint };
    const evaluated = gridPoints().map((point) => ({
      ...runPoint(ctx, tasks, { point, k: opts.k }),
      point,
    }));
    const pick = chooseCandidate(baseline, evaluated);
    const improved = pick && JSON.stringify(pick.point) !== JSON.stringify(baselinePoint);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            tasks: tasks.length,
            k: opts.k,
            copied,
            baseline,
            candidate: pick ? { point: pick.point, hit: pick.hit, falseInjects: pick.falseInjects } : null,
            changed: Boolean(improved),
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      const line = (label, row) =>
        `${label.padEnd(10)} hit ${row.hit}/${row.positives}  false-inject ${row.falseInjects}/${row.refusals}  ` +
        `(${['minRelevance', 'minScore', 'minCoverage'].map((key) => `${key}=${row.point[key]}`).join(' ')})`;
      process.stdout.write(`tasks ${tasks.length} · k=${opts.k} · store ${scratch ? '临时副本(' + copied + ' 篇)' : storePath}\n`);
      process.stdout.write(line('baseline', baseline) + '\n');
      if (pick && improved) process.stdout.write(line('candidate', pick) + '\n');
      else process.stdout.write('candidate  none（没有不退化且更优的点，保持基线）\n');
    }
    process.exitCode = improved ? 3 : 0;
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main();
