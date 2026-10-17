/**
 * 测试夹具（虚构语料）。
 *
 * 铁律：`tabellio` 里**不许出现任何真实私人记忆内容**。所以这里的语料
 * 全是自造的假项目：`acme-widget` 这个并不存在的项目、假的人名、假的部署步骤。
 * 需要"像真的"的是**结构**（中文夹英文、长笔记、过期笔记、外部低信任笔记），
 * 不是内容。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 建一个临时目录；用例结束后由 `cleanup()` 删掉。 */
export function tempDir(prefix = 'memory-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

export function rm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不该让用例变红：临时目录在系统里，不留业务影响。 */
  }
}

/** 写一个文件，自动建父目录。 */
export function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

/**
 * 一条笔记的 markdown 文本（frontmatter + 正文）。
 * 只给需要覆盖的字段，其余走 `note.js` 的默认值。
 */
export function noteMarkdown({ id, kind = 'semantic', trust = 'user_stated', scope = 'user', status, validFrom, validTo, tags = [], body = '正文', title }) {
  const fm = ['---', `kind: ${kind}`, `trust: ${trust}`, `scope: ${scope}`];
  if (id) fm.push(`id: ${id}`);
  if (status) fm.push(`status: ${status}`);
  if (validFrom) fm.push(`valid_from: ${validFrom}`);
  if (validTo) fm.push(`valid_to: ${validTo}`);
  if (tags.length) fm.push(`tags: ${tags.join(', ')}`);
  fm.push('---');
  return `${fm.join('\n')}\n\n# ${title ?? '测试笔记'}\n\n${body}\n`;
}

/**
 * 虚构语料：一个假项目的构建/部署约定。
 *
 * 语料形状刻意做成真实库的样子：中英混排、短笔记与长笔记并存，
 * 有一条 `external` 低信任笔记（用来验证拒答路径）。
 */
export const FIXTURE_NOTES = Object.freeze([
  {
    name: 'build-command',
    fm: 'kind: semantic\ntrust: user_stated\ntags: convention,build',
    title: '假项目 acme-widget 的构建命令',
    body: 'acme-widget 的构建命令是 `pnpm run build`，产物落在 `dist/`。发布前必须先跑 `pnpm run typecheck`。',
    queries: ['acme-widget 构建命令', 'build'],
  },
  {
    name: 'deploy-steps',
    fm: 'kind: procedural\ntrust: user_stated\ntags: deploy',
    title: '假项目 acme-widget 的部署步骤',
    body: '部署三步：① `pnpm run build`；② 把 `dist/` 同步到 `staging` bucket；③ 跑一遍冒烟脚本。回滚就是把上一次的产物重新同步回去。',
    queries: ['怎么部署 acme-widget', '部署 步骤'],
  },
  {
    name: 'test-runner',
    fm: 'kind: semantic\ntrust: user_stated\ntags: convention,test',
    title: '假项目 acme-widget 的测试怎么跑',
    body: '单测用 `node --test`，端到端用例放在 `e2e/` 下、默认不跑。',
    queries: ['acme-widget 测试怎么跑', 'test'],
  },
  {
    name: 'external-blog',
    fm: 'kind: semantic\ntrust: external\ntags: reference',
    title: '网上抄来的 BM25 参数笔记',
    body: '某博客说 BM25 的 b 参数应该取 0.75，k1 取 1.2。这条是外部资料，未经本地实测。',
    queries: ['BM25 b 参数'],
  },
  {
    name: 'long-note',
    fm: 'kind: semantic\ntrust: user_stated\ntags: log',
    title: '假项目的长日志',
    body: Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 次构建记录：产物大小 ${100 + i} KB，耗时 ${i + 2} 秒。`).join('\n'),
    queries: ['第 42 次构建', '产物大小'],
  },
]);

/**
 * 把夹具笔记写进一个临时库。
 *
 * @param {object} api   `src/api.js` 的导出（用例自己 import，夹具不反向依赖实现）
 * @param {object} [options] `{ notes, dir }`
 * @returns {{dir:string, ctx:object, ids:string[]}}
 */
export function seedStore(api, options = {}) {
  const dir = options.dir ?? tempDir('memory-fixture-');
  const ctx = api.openStore(dir);
  ctx.ensure();
  const ids = [];
  for (const item of options.notes ?? FIXTURE_NOTES) {
    // 夹具笔记直接手写 frontmatter：要让用例能精确控制 trust/kind，
    // 走 `noteMarkdown()` 的默认值反而会掩盖「默认值是什么」这件事。
    const text = `---\n${item.fm ?? `kind: ${item.kind}\ntrust: ${item.trust}`}\n---\n\n# ${item.title}\n\n${item.body}\n`;
    const r = api.remember(ctx, { text }, { writtenBy: 'test:seed' });
    if (!r.ok) throw new Error(`夹具写入被拒：${item.name} → ${r.reason}`);
    ids.push(r.id);
  }
  return { dir, ctx, ids };
}

/** 极简的「一行 JSON-RPC」驱动：不需要起进程。 */
export function rpc(handler, message) {
  return handler.handleLine(JSON.stringify(message));
}
