/**
 * 分层索引：把「一行一条指针」的平铺列表换成**装得下的路由树**。
 *
 * ## 为什么要有这个文件
 *
 * 平铺索引有一个致命容量：`MEMORY.md` 被 `INDEX_CAPS`（200 行 / 25KB）盯着，
 * 而真实库导入后有 1321 篇笔记 —— 实测平铺索引只列得下 **127** 篇，
 * `status` 报 `indexHidden: 1194`。也就是说「读索引」这条路**九成是瞎的**：
 * 人（或 agent）读 `MEMORY.md` 看不到 1194 篇笔记的存在，会以为库里没有。
 * 检索面（`notes/` 全扫）一直是好的 —— 坏掉的只有「读索引」这条路。
 *
 * ## 方案：索引的每一行都是一条**路由**，而不是一条**记录**
 *
 * 关键的不对称：索引行数有上限，而索引**文件**数量没有。
 *
 * ```
 * index/MEMORY.md              路由层：一行一个主题组（装得下 72 个组）
 * index/groups/<name>.md       清单层：一组一行指针（默认每文件 ≤ 400 行）
 * ```
 *
 * 容量算一下就清楚了：路由层一行约 40 字节、装 190 个组；清单层每个文件装 400 条。
 * 于是「一行一条指针」的 190 条上限，变成 **190 × 400 = 76,000 条**，
 * 而且**每一篇笔记都有一条能走到的路** —— 不再是「前 127 篇可见、其余不存在」。
 *
 * 为什么不是「把指针压缩得更短」：一行再省也就省 20 字节、多装几十条，
 * 改不动「上限 200 条 vs 有 1321 条」这个量级差。压缩是延命，路由是换维度。
 *
 * ## 为什么不是「consolidate 把碎片合成整篇」
 *
 * 架构文档原先给的方向是「先把碎片笔记合并成整篇，再分层索引」。实测真实库之后
 * 这一半**不成立**，理由是可验证的：
 *  - 1321 篇里 1164 篇集中在 7 个大组（最大一组 200 篇），它们**不是同一件事的碎片**，
 *    而是同名主题的高频重复记录（`…#1` 到 `…#200`）。合并它们等于把 200 条记录
 *    压成 1 条，丢掉的是内容，不是重复 —— 而索引的职责是「指得着」，不是「替人删减」。
 *  - 真正与该合并的（同主题的 3–4 条改写）合起来也就省几十行，救不了 1194 的缺口。
 *  - 更要紧的是：consolidate 会**改真相源**（`notes/`）。为了让索引好看而改写记忆内容，
 *    是把「索引装不下」这个生成物的问题，转嫁给唯一手可编辑的真源。这个交换不划算。
 * 所以这里只做分层：**真相源一个字不动**，索引层重新组织。
 * 小组（≤ `CONSOLIDATE_AT` 条）仍然是「一行一条指针」的平铺列表 —— 人读起来没变。
 *
 * ## 诚实边界
 *
 * 路由树消除的是**结构性**盲区（前 N 条可见、其余不存在）。它不消除**分组**盲区：
 * 路由层最多装 `ROUTE_BUDGET` 行，一个组占一行；组数超过预算时会把相邻小组打包
 * 成中间层（digest），打包到底还是装不下就**明着报** `routeHidden`，不静默截断。
 * 这些都是算出来的、报出来的账 —— 见 `memory index --json`。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 每个清单文件的指针行上限。400 行 ≈ 20KB，仍在人能一次读完的量级里。 */
export const LIST_FILE_MAX_LINES = 400;

/**
 * 路由层可用行预算。
 *
 * 比 `INDEX_CAPS.maxLines`（200）留出 10 行余量：表头/表尾/说明是**固定开销**，
 * 而且闸门是按整份文件算的 —— 预算必须给它们留位置，否则会精确地在边界上被拒写。
 */
export const ROUTE_BUDGET = 190;

/** 少于等于这个条数的组，清单层就是「一行一条指针」的平铺列表（人读的习惯不变）。 */
export const CONSOLIDATE_AT = 400;

/** 组名到文件名的安全转换：非 `[A-Za-z0-9_-]` 一律换成 `-`。 */
export function slugOf(name) {
  const s = String(name).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s === '' ? 'group' : s;
}

/**
 * 组名：从笔记 id 推。
 *
 * `topic-alpha#137` → `topic-alpha`
 * `topic-beta`      → `topic-beta`
 *
 * 为什么按 id 而不是按 tag/kind 分组：id 是**文件名**，人写笔记时就是按这个前缀成组
 * 命名的（真实库 1321 篇只有 72 个前缀）。按 `kind` 分只有 4 个组、每组几百条，
 * 路由层能装下但清单层一个文件装不下，等于把问题往下推一层。按 id 前缀分，
 * 组数（72）与组内条数（多为个位数）都落在「人扫得动」的量级上。
 */
export function groupKeyOf(id) {
  const s = String(id);
  const hash = s.indexOf('#');
  return hash > 0 ? s.slice(0, hash) : s;
}

/**
 * 把笔记条目按组名聚成树，再按 `budget` 决定要几层。
 *
 * 返回 `{ groups, levels, routeHidden, packSize }`：
 *  - `groups` 是**第一层路由条目**（每个都有 `name` / `count` / `ids` / `children`）；
 *  - `levels > 1` 表示做过打包（相邻小组并成一个 digest）或者要中间层；
 *  - `routeHidden` 是打包也装不下、明确放弃的条数（正常为 0）。
 *
 * 打包算法：条目数超过预算就按「顺序每 k 个并一组」打包，`k` 取
 * `ceil(count / budget)`，然后重新检查 —— 最多迭代 8 轮，装不下就报 `routeHidden`。
 * 为什么按顺序而不是按相似度：相邻组的名字前缀天然相近（`topic-c-3`
 * 和 `topic-c-4` 挨着），顺序打包等于免费拿到了「同主题聚在一起」。按相似度要引词表，不值得。
 */
export function buildIndexTree(entries, { budget = ROUTE_BUDGET, listMaxLines = LIST_FILE_MAX_LINES } = {}) {
  const byGroup = new Map();
  for (const e of entries) {
    const key = groupKeyOf(e.id);
    let g = byGroup.get(key);
    if (!g) {
      g = { name: key, ids: [] };
      byGroup.set(key, g);
    }
    g.ids.push(e);
  }
  for (const g of byGroup.values()) {
    g.ids.sort((a, b) => cmpId(a.id, b.id));
    g.count = g.ids.length;
  }
  // 组本身也排序：大的在前（人最该先看到大组），同大小按名字 —— 保证确定性。
  let items = [...byGroup.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  const total = entries.length;
  let levels = 1;
  let packSize = 0;
  for (let round = 0; round < 8 && items.length > budget; round++) {
    const k = Math.ceil(items.length / budget);
    packSize = Math.max(packSize, k);
    const packed = [];
    for (let i = 0; i < items.length; i += k) {
      const chunk = items.slice(i, i + k);
      const first = chunk[0].name;
      const last = chunk[chunk.length - 1].name;
      packed.push({
        name: chunk.length === 1 ? first : `${first} … ${last}`,
        count: chunk.reduce((a, g) => a + g.count, 0),
        ids: chunk.flatMap((g) => g.ids),
        children: chunk,
        packed: true,
      });
    }
    items = packed;
    levels += 1;
  }
  const routeHidden = Math.max(0, items.length - budget);
  const groups = routeHidden > 0 ? items.slice(0, budget) : items;
  return { groups, levels, routeHidden, packSize, total, groupCount: byGroup.size, listMaxLines };
}

function cmpId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 一篇笔记要被列进清单层，它所在的那个「叶子组」是什么。
 *
 * `groups[i].children` 存在说明这一条是打包出来的 digest，真正的清单在 `children` 里，
 * 每个 child 一个文件。所以清单文件是**按叶子**切的，路由层可以比文件数少。
 */
export function leafGroupsOf(node) {
  if (!node.children || node.children.length === 0) return [node];
  return node.children.flatMap((c) => leafGroupsOf(c));
}

/**
 * 清单文件相对 `index/` 的路径。
 *
 * 两层：`groups/<slug>.md`。为什么带 `n` 前缀的序号：两个不同的组名可能 slug 之后撞车
 * （中文组名会被 slug 成一串 `-`），加序号就不撞了，而且 `ls` 出来是按路由顺序排的。
 * 组名本身仍在文件里的 H1 上，人点进去看得到原名。
 */
export function listRelPath(node, ordinal) {
  const n = String(ordinal).padStart(3, '0');
  return join('groups', `${n}-${slugOf(node.name)}.md`);
}

/** 清单文件里的一行指针（与平铺索引的行**同格式**，人的读法不用换）。 */
export function pointerLine(entry) {
  const note = entry.note ?? {};
  const tags = (note.tags ?? []).map((t) => `#${t}`).join(' ');
  const when = note.valid_from ? ` · ${String(note.valid_from).slice(0, 10)}` : '';
  const meta = `(${note.kind ?? 'semantic'}/${note.trust ?? 'user_stated'}${when})`;
  // 标题要转义：真实库里有标题带 `]`、`(` 的笔记（旧文档切出来的片段标题就是正文第一句），
  // 不转义会让 `[title](notes/id.md)` 这个链接**解析不出来** ——
  // 于是「点得进去」这条保证对那几条笔记静默失效，而索引的整个价值就是点得进去。
  const title = escapeLinkText(entry.title ?? entry.id);
  return `- [${title}](notes/${entry.id}.md) — ${tags ? `${tags} ` : ''}${meta}`.replace(/\s+$/, '');
}

/** 把标题里的 markdown 链接符号转义成 HTML 实体（渲染出来还是原字，解析时不打架）。 */
export function escapeLinkText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\r?\n/g, ' ');
}

/**
 * 渲染路由层（`index/MEMORY.md`）。
 *
 * 每一行都是 `- [组名](groups/xxx.md) — N 条`：**是链接**，所以「点进去看得到」
 * 这件事对人和对只认 markdown 链接的工具都成立。表头把「这是路由不是清单」
 * 说清楚 —— 否则人看到 72 行会以为库里只有 72 篇。
 */
export function renderRoute({ tree, listFiles, caps, generatedAt }) {
  const out = [
    '# MEMORY',
    '',
    '<sub>生成物：由 `notes/` 重建（`memory status --rebuild-index`）。本页是**路由层**：',
    `一行一个主题组，点进去才是逐条指针。全库 ${tree.total} 条 / ${tree.groupCount} 组，`,
    `逐条清单在 \`index/groups/\`（${listFiles.length} 个文件）。检索不受索引影响。</sub>`,
    '',
  ];
  const fileByName = new Map(listFiles.map((f) => [f.name, f]));
  const reserved = out.length + 3; // 表尾 + 余量
  const budget = Math.max(1, caps.maxLines - reserved);
  let shown = 0;
  for (const g of tree.groups) {
    if (shown >= budget) break;
    const f = fileByName.get(g.name);
    const rel = f ? f.rel : listRelPath(g, shown + 1);
    out.push(`- [${g.name}](${rel}) — ${g.count} 条`);
    shown += 1;
  }
  const hidden = tree.groups.length - shown;
  if (hidden > 0) out.push(`- … 路由层还有 ${hidden} 组未列出（上限 ${caps.maxLines} 行）`);
  out.push('');
  out.push(
    `<sub>${generatedAt ? `生成于 ${generatedAt}。` : ''}上限 ${caps.maxLines} 行 / ${caps.maxBytes} 字节；` +
      `组数超过路由预算时自动打包成中间层，装不下会在 \`memory index\` 里报出来。</sub>`,
  );
  return `${out.join('\n')}\n`;
}

/**
 * 渲染一个清单文件。
 *
 * 小组就是平铺的一行一条指针（与旧索引观感一致）；大组**不截断** ——
 * 清单文件有 `listMaxLines` 的软上限，超过就分页（`…（续）`），
 * 分页而不是截断，是因为截断在这里等于重新制造一个盲区。
 */
export function renderList({ node, caps, listMaxLines = LIST_FILE_MAX_LINES }) {
  const kids = node.children ?? [];
  const out = [
    `# ${node.name}`,
    '',
    `<sub>这一组 ${node.count} 条笔记（索引清单层，生成物）。</sub>`,
    '',
  ];
  if (kids.length > 1) {
    // 打包出来的 digest：先给子组的**真名**（文件里能看到原名，不是只看到被拼出来的标题）。
    out.push(
      `<sub>本文件由 ${kids.length} 个相邻小组打包而成，子组为：` +
        `${kids.map((k) => `\`${k.name}\`（${k.count}）`).join('、')}。打包只为省路由行，条目一条不少。</sub>`,
    );
    out.push('');
  }
  const ids = node.ids;
  if (ids.length <= caps.maxLines) {
    for (const e of ids) out.push(pointerLine(e));
  } else {
    // 超过单文件上限：同一文件里继续列，中间插一个分隔说明。**不截断、不丢条**。
    for (let i = 0; i < ids.length; i++) {
      if (i > 0 && i % listMaxLines === 0) {
        out.push('');
        out.push(`<sub>…（续，第 ${Math.floor(i / listMaxLines) + 1} 段）</sub>`);
        out.push('');
      }
      out.push(pointerLine(ids[i]));
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * 写入整套分层索引（**只写 `index/`，不碰 `notes/`**）。
 *
 * 返回的账必须诚实报三件事：写了几个文件、列了多少条、有多少条**没列进去**。
 * 「静默截断」是旧项目最贵的一课（`buildIndexText` 的注释里记着），
 * 换成路由树之后这条纪律一个字都不能松。
 *
 * `writeFile` 由调用方注入（`vault.js` 的原子写 + `.bak`），这样本模块是纯函数 + IO 注入，
 * 单测不用造真文件系统。
 */
export function buildIndexPlan(scan, { caps, listMaxLines = LIST_FILE_MAX_LINES, routeBudget = ROUTE_BUDGET, generatedAt } = {}) {
  const tree = buildIndexTree(scan.notes, { budget: routeBudget, listMaxLines });
  // 叶子顺序里加一道**显式**的稳定排序：同条数的两个组必须每次排在同一个位置，
  // 否则文件名里的序号会在两次重建之间对调 —— 那会让「重建索引幂等」（§6.3 的 CI 判据）
  // 变成随机通过。Map 的插入序本身稳定，但这里不依赖它：判据要的是不变量，不是巧合。
  const leaves = leafGroupsOf({ children: tree.groups }).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  const listFiles = leaves.map((node, i) => ({
    name: node.name,
    rel: listRelPath(node, i + 1),
    text: renderList({ node, caps: { maxLines: listMaxLines }, listMaxLines }),
    count: node.ids.length,
  }));
  const routeText = renderRoute({ tree, listFiles, caps, generatedAt });
  const listed = listFiles.reduce((a, f) => a + f.count, 0);
  return {
    routeText,
    listFiles,
    tree,
    // 账：`routeHidden` 是路由层装不下的组数；`listed` 是真正被列出来的条数。
    listed,
    total: tree.total,
    hidden: Math.max(0, tree.total - listed),
    levels: tree.levels,
    groupCount: tree.groupCount,
    listFileCount: listFiles.length,
    routeBytes: Buffer.byteLength(routeText),
  };
}

/**
 * 路由层过不了字节闸门时**逐条丢最小组**，直到装得下。
 *
 * 为什么要有这一步：`renderRoute` 只按行数削，但闸门是「行数**和**字节数都不超」。
 * 组名长的库（`topic-with-a-long-name` 这种）可能行数够、字节超；
 * 那时如果直接交给闸门，结果是**一个字都写不出去**（闸门拒绝非收缩写入），
 * 库从「索引不全」退化成「没有索引」—— 旧项目正是这么丢过一次索引。
 * 所以生成器自己先削到装得下，削掉多少**如实报**。
 *
 * 丢的是**最小组**：路由层的作用是让人知道「库里有这些主题」，
 * 丢一个 1 条的小组，比丢一个 200 条的组代价小得多。
 */
export function fitRoute({ plan, caps, scan, listMaxLines = LIST_FILE_MAX_LINES, generatedAt }) {
  if (plan.routeBytes <= caps.maxBytes) {
    return { ...plan, routeDropped: [], routeGroupsListed: plan.tree.groups.length };
  }
  const kept = [...plan.listFiles];
  const dropped = [];
  let attempt = null;
  while (kept.length > 1) {
    // 每次丢当前最小的那个清单文件，重排编号，重渲染路由层。
    kept.sort((a, b) => a.count - b.count || (a.rel < b.rel ? -1 : 1));
    const gone = kept.shift();
    dropped.push(gone);
    const byName = new Map(kept.map((f) => [f.name, f]));
    const tree = {
      ...plan.tree,
      groups: plan.tree.groups.filter((g) => byName.has(g.name)),
    };
    const renumbered = kept
      .sort((a, b) => (a.rel < b.rel ? -1 : 1))
      .map((f, i) => ({ ...f, rel: listRelPath({ name: f.name }, i + 1) }));
    const routeText = renderRoute({ tree, listFiles: renumbered, caps, generatedAt });
    attempt = {
      ...plan,
      tree,
      listFiles: renumbered,
      routeText,
      routeBytes: Buffer.byteLength(routeText),
      listed: renumbered.reduce((a, f) => a + f.count, 0),
      listFileCount: renumbered.length,
      routeGroupsListed: tree.groups.length,
      routeDropped: dropped.map((d) => d.name),
    };
    attempt.hidden = Math.max(0, attempt.total - attempt.listed);
    if (attempt.routeBytes <= caps.maxBytes) break;
  }
  return attempt ?? { ...plan, routeDropped: [], routeGroupsListed: plan.tree.groups.length };
}

/**
 * 读回分层索引的账（`memory index` / `status` 用）。
 *
 * **只读 `index/`**，从不因为读而写。目录不存在或文件缺失都返回 0 计数而不是抛 ——
 * 「索引还没建」是一种正常状态，不是错误。
 */
export function readIndexTree(storePath, { indexDir = 'index', caps = { maxLines: 200, maxBytes: 25 * 1024 } } = {}) {
  const root = join(storePath, indexDir);
  const memoryPath = join(root, 'MEMORY.md');
  const result = {
    route: { exists: false, lines: 0, bytes: 0, groups: 0, routed: 0 },
    lists: [],
    listed: 0,
    files: 0,
  };
  const routeText = safeRead(memoryPath);
  if (routeText !== null) {
    const parsed = parseRoute(routeText);
    result.route = {
      exists: true,
      lines: routeText === '' ? 0 : routeText.replace(/\n$/, '').split('\n').length,
      bytes: Buffer.byteLength(routeText),
      groups: parsed.length,
      routed: parsed.reduce((a, g) => a + g.count, 0),
      entries: parsed,
    };
  }
  const groupsDir = join(root, 'groups');
  if (existsSync(groupsDir)) {
    let names = [];
    try {
      names = readdirSync(groupsDir).filter((n) => /\.md$/i.test(n)).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const text = safeRead(join(groupsDir, name));
      if (text === null) continue;
      const count = countPointerLines(text);
      result.lists.push({ name, count, bytes: Buffer.byteLength(text) });
      result.listed += count;
    }
    result.files = result.lists.length;
  }
  return result;
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 数一份文本里的指针行数。
 *
 * 口径 = **这行真能走到一篇笔记**（能解析出 `](notes/…)`）。这个口径比
 * 「以 `- ` 开头且不是说明行」更硬：说明行（`- … 还有 N 条未列入索引`）本来就没有
 * 笔记链接，天然被排除，不用靠前缀去猜。旧实现正是靠前缀猜的 ——
 * 那个 off-by-one 在 M1 把 `indexHidden` 算错过一次（差一个数骗过整个账本），
 * 所以这里换成一个**无法被前缀骗到**的判据。
 */
export function countPointerLines(text) {
  if (!text) return 0;
  let n = 0;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('- ') && idFromPointerLine(line)) n += 1;
  }
  return n;
}

/** 解析路由层：`- [组名](groups/xxx.md) — N 条`。 */
export function parseRoute(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^- \[(.+?)\]\(([^)]+)\)\s*—\s*(\d+)\s*条\s*$/.exec(line);
    if (m) out.push({ name: m[1], rel: m[2], count: Number(m[3]) });
  }
  return out;
}

/**
 * 从一行指针里取出笔记 id。取**最后**一个 `](notes/…)`：标题里可能带 `](`，
 * 但链接目标只会在行尾那一个。这一条是 `pointerLine` 转义之外的**第二重保险** ——
 * 索引的账（`reachable`）必须比「生成器声称列了几条」更硬。
 */
export function idFromPointerLine(line) {
  // 取**最后**一个 `](notes/…)`：标题里可能带 `](`（旧文档切出来的片段标题就是
  // 正文第一句，里面什么符号都有），但链接目标只会在行尾那一个。
  //
  // 为什么不能只写正则：id 的字符集没有限制（真实库里就有 `…history-3#100`），
  // 而「贪婪」会把标题里的假链接一起吃进来、「非贪婪」又会先撞上标题里的假链接。
  // 所以反过来做 —— 从行尾往前找**离行尾最近的那个 `](notes/…`**，它是真的。
  // 行尾往前扫保证的是「最后一个」这个语义，不依赖 id 里有什么字符。
  const text = String(line ?? '');
  const tail = text.lastIndexOf('](notes/');
  if (tail < 0) return null;
  const rest = text.slice(tail + '](notes/'.length);
  const close = rest.indexOf(')');
  if (close < 0) return null;
  const target = rest.slice(0, close);
  return target.endsWith('.md') ? target.slice(0, -3) : null;
}

/**
 * 走一遍路由树，判断「所有笔记都有路可走」。
 *
 * 这是 Task 1 的**验收判据**，所以在 `memory index --json` 里是首屏数字：
 * `reachable` 必须等于 `total`，否则 `unreachable` 会具体列出没路可走的 id。
 * 只读磁盘上真实存在的文件，不信任内存里的计划 —— 否则「计划对了但没写全」
 * 这种失败会被判成通过。
 */
export function verifyRoutes(storePath, { indexDir = 'index' } = {}) {
  const root = join(storePath, indexDir);
  const routeText = safeRead(join(root, 'MEMORY.md'));
  if (routeText === null) return { ok: false, reason: 'route_missing', reachable: 0, ids: new Set(), unreachable: [] };
  const entries = parseRoute(routeText);
  const reachableIds = new Set();
  const missingFiles = [];
  for (const g of entries) {
    const text = safeRead(join(root, g.rel));
    if (text === null) {
      missingFiles.push(g.rel);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.startsWith('- ')) continue;
      const id = idFromPointerLine(line);
      if (id) reachableIds.add(id);
    }
  }
  return {
    ok: missingFiles.length === 0,
    reason: missingFiles.length ? 'list_file_missing' : null,
    missingFiles,
    reachable: reachableIds.size,
    ids: reachableIds,
  };
}
