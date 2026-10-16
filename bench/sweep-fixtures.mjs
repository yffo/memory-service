// 常量扫描装置（`bench/sweep.mjs`）的**语料与题面生成层**。
//
// 这一层是 M5 重建的。旧夹具（M4 时还在 `sweep.mjs` 里）的否定结果：
// 在旧夹具上「recall ≥ 0.80 且拒答 ≥ 0.75」的格子**一个都没有**（1960 格全扫过）。
//
// 旧夹具为什么不可分（三条硬证据，都实测过）：
//
//   ① 判别词的 df **恒为 12**，不随语料增长。真实库里一个知识点的篇数是跟着库长的。
//   ② 不可答题的形状是「服务名 + 一个通用词」。服务名在整档语料里 df ≈ n/12，
//      闸门按 `df ≤ INFORMATIVE_DF_FLOOR_DOCS(64)` 把它当证据，于是
//      「命中服务名」的文档覆盖率直接 = 1.000。
//      实测：8 条不可答题在五档上 top-5 最大覆盖率**全是 1.000**，
//      120 条可答题里最小的 12 条**也全是 1.000** —— 两类题在覆盖率上完全重合。
//   ③ 于是「关掉覆盖率闸门」也救不了：两类题的覆盖率读数根本不含鉴别信息。
//
// 新夹具造的是**有结构**的库：服务（谁）× 领域（关于什么）× 知识点号（哪一条事实）。
// 判别词的 df 随语料规模真实增长（实测六档，服务数与覆盖跨度按档位缩放）：
//
//   · 服务名   → 该服务的所有笔记，df = 17 / 40 / 42 / 84 / 168（n = 50…2000）
//   · 领域词   → 同领域的多篇笔记，df = 6~7 / 24~28 / 60~63 / 122~128 / 246~252
//   · 知识点号 → 覆盖该号的 2~4 个服务，df = 2 / 2 / 3 / 4 / 4（**不随规模增长**）
//
// 「不随规模增长」的那个才是判别词 —— 这正是旧夹具搞反的地方：它让判别词的 df
// 恒为 12（不真实），却让「服务名」这种每篇都有的词去承担判别。
//
// 两类题：
//
//   可答题（answerable）：问「服务 X 的 kpNNNNN 取值是多少」。
//     证据在库（`${svc}-${kp}` 那篇），答案唯一（那篇里写死的取值）。
//
//   不可答题（refusal）：问「服务 X 的 kpNNNNN 取值是多少」，其中 kpNNNNN 是
//     一个**没有覆盖 X** 的号 —— 同族、同词表、同领域的近邻都在库，
//     被问到的那条事实（X + kpNNNNN）从没写过。题面里**没有生僻词**。
//
// 本文件零依赖、纯函数：给 `n` 返回 `{n, docs, notes, tasks}`。不读盘、不起子进程。
//
// 用法（装置内部）：
//   import { buildCorpus, verifyCorpus } from './sweep-fixtures.mjs';
//   const corpus = buildCorpus(200);
//   verifyCorpus(corpus); // 自检：可答题证据在库、不可答题零命中

/**
 * 服务名（编造的，不与真实产品重名）。服务是「谁」这一维，
 * 出现在该服务的**所有**笔记里，所以 df 随语料增长：df ≈ n / 服务数。
 */
export const SERVICES = Object.freeze([
  'Lumenpath',
  'Quartzwell',
  'Tidalmark',
  'Fernbrook',
  'Copperloom',
  'Nightjar',
  'Saltshade',
  'Rookfield',
  'Pinecrest',
  'Millrace',
  'Amberdrift',
  'Cinderbay',
]);

/**
 * 领域词：这条取值是**关于什么**的。领域词是高频共现词 ——
 * 同一领域的多篇笔记会用到它，所以 df ≈ 0.1n ~ 0.6n。
 * 单独一个领域词命中**不构成证据**（真实库里「缓存」这种词到处都是），
 * 这正是闸门要丢掉的信号。
 */
/**
 * 领域：这条取值是**关于什么**的。`key` 是领域标识（笔记之间共现的高频词），
 * `subject` 是被问的那个属性名（题面里「的X是多少」的那个 X）。
 *
 * 两者都出现在笔记正文里，这一点是刻意的：题面用的词必须是库里真有的词，
 * 否则「拒答」就会退化成「问了一个库里没有的词」——那是零命中，
 * 不是本装置要测的「近邻在库、事实不同」。`subject` 的所有字不得与 `key`
 * 有任何二元组重叠，否则题面的判别跨度会被别的领域的笔记命中（模块底部有断言）。
 */
export const DOMAINS = Object.freeze([
  { key: '缓存预热', subject: '过期时限' },
  { key: '限流配额', subject: '额度峰值' },
  { key: '灰度批次', subject: '温升步幅' },
  { key: '告警收敛', subject: '静默区间' },
  { key: '容量水位', subject: '余量标线' },
  { key: '发布窗口', subject: '可发时段' },
  { key: '对账周期', subject: '核对频度' },
  { key: '熔断阈值', subject: '断开界线' },
  { key: '采样比例', subject: '抽样密度' },
  { key: '排队上限', subject: '队列长度' },
  { key: '扩缩容步长', subject: '扩容台量' },
  { key: '调度优先级', subject: '业务权重' },
]);

/** 取值本身：库里的答案。每条事实唯一。 */
export const VALUES = Object.freeze([7, 12, 30, 45, 90, 120, 200, 480, 900, 1500]);

/** 知识点号的固定宽度。定宽保证任何一个号都不是另一个号的前缀。 */
export const KP_PREFIX = 'kp';
export const KP_WIDTH = 5;

/**
 * 每档每类题的预算上限。题数固定在常数上（不随语料增长），有两个理由：
 *   ① 扫描是全网格，题数一涨，五档的总时间就失控；
 *   ② 「档位变难」会跟「题量变大」混在一起，读数不再可比。
 * 旧装置是 `fixedTasks: 48`，也就是两类各 48，这里沿用同一个量级。
 */
export const TASK_BUDGET = 48;

/**
 * 知识点号：`kp00042`。定宽是必需的 —— 词法器把拉丁字母/数字连读当成
 * **一个词**，不定宽的话 `kp100` 会被 `kp1000` 的题面命中。
 */
export function kpOf(i) {
  return `${KP_PREFIX}${String(i).padStart(KP_WIDTH, '0')}`;
}

/** 知识点号是否在本题面生成器的合法范围内。越界 = 库里一定没有。 */
export function kpInRange(id, n) {
  const m = /^kp(\d{5})$/.exec(id);
  return m ? Number(m[1]) < knowledgeCount(n) : false;
}

/**
 * 每个知识点覆盖几个服务。知识点是「一族事实」：同一个号在 2~4 个服务上
 * 各有一篇，所以知识点号的 df = 覆盖服务数（2 → 4）。
 * 反过来，任何一个服务都有一大批知识点**没有**覆盖它 ——
 * 不可答题就从这些「没覆盖本服务」的号里取，保证那个组合在库里零命中。
 */
export function serviceSpan(n) {
  return Math.max(2, Math.min(4, Math.round(n / 500) + 2));
}

/**
 * 语料里活跃的服务数。
 *
 * 这个数必须让**每个服务**都摊到足够多的笔记，否则小档上「服务名」这一维
 * 会退化成「每篇一个词」（df=1），df 就不再随规模增长，旧夹具的毛病原样复现。
 * n=50 → 3 个服务，n=200 → 6，n≥500 顶到 12。
 *
 * 另有一条硬约束：`serviceCount(n) > serviceSpan(n)`。两者相等时每个知识点
 * 都覆盖了每个服务，于是「服务 + 没覆盖它的号」这种组合一个都不存在，
 * 出题器会一道不可答题都造不出来（这个 bug 实际发生过）。
 */
export function serviceCount(n) {
  return Math.max(3, Math.min(SERVICES.length, Math.round(n / 40)));
}

/**
 * 知识点总数。
 *
 * 一个知识点覆盖 `serviceSpan(n)` 个服务，也就是 `span` 篇笔记。
 * 这里让事实只占语料的一半左右，另一半留给不承载事实的背景笔记 ——
 * 真实的库不是「每篇都在答一道题」，得有长尾，否则 df 分布是假的。
 *
 * 硬约束：**号必须与真正造出来的严格一致**。号一旦超出实际造出的范围，
 * 那个号在库里 df = 0，不可答题就退化成「问了一个不存在的号」，
 * 闸门会因为零命中而拒答 —— 那是另一个机制（零命中），不是本装置要测的
 * 覆盖率/证据性口径。（这个 bug 实际发生过：n=1000 档 `kp00384` 从未被造出来，
 * 拒答率虚高到 1.000。）`verifyCorpus` 每次造完都当场验这一条。
 */
export function knowledgeCount(n) {
  const total = Math.max(4, Math.floor(n));
  return Math.max(4, Math.floor(total / 2 / serviceSpan(total)));
}

/** FNV-1a：只用它做确定性派发，不用它保证统计性质。 */
export function hashStr(x) {
  let h = 2166136261;
  const s = String(x);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 按 `src/core/tokenize.js` 的口径切「词项」。
 *
 * 必须逐条对齐，否则生成器会以为某段跨度不在库里、而检索器能找到它：
 *   · CJK 边界字 `的了是在和与` **切段并整个丢掉**，不产生跨词片段；
 *   · 长度 ≥ 2 的段只出**相邻二元组**（不出 unigram）；
 *   · 拉丁/数字连读是**一个**词项（小写化）；
 *   · 两种脚本切换时先 flush，且必须复位 `latin`（否则后续 CJK 段会被当成拉丁段，
 *     所有 df 查询返回 0 —— 这个 bug 让拒答题一度一条都生成不出来）。
 */
export function bigramsOf(text) {
  const out = [];
  const s = String(text).normalize('NFKC').toLowerCase();
  const boundary = new Set(['的', '了', '是', '在', '和', '与']);
  let buf = [];
  let latin = false;
  const flush = () => {
    if (buf.length === 0) return;
    if (latin) {
      out.push(buf.join(''));
    } else if (buf.length === 1) {
      out.push(buf[0]);
    } else {
      for (let i = 0; i + 1 < buf.length; i += 1) out.push(buf[i] + buf[i + 1]);
    }
    buf = [];
  };
  for (const ch of s) {
    const isHan = /\p{Script=Han}/u.test(ch);
    const isWordy = /[0-9a-z_]/.test(ch);
    if (boundary.has(ch)) {
      flush();
      latin = false;
    } else if (isHan) {
      if (latin) flush();
      latin = false;
      buf.push(ch);
    } else if (isWordy) {
      if (!latin) flush();
      latin = true;
      buf.push(ch);
    } else {
      flush();
      latin = false;
    }
  }
  flush();
  return out;
}

/** 笔记文档：与 `buildIndex` 期望的字段一致。 */
export function noteDoc(id, title, lines) {
  return {
    id,
    title,
    body: `# ${title}\n\n${lines.join('\n')}`,
    kind: 'semantic',
    trust: 'user_stated',
  };
}

/** 本装置自己的默认值（与 `sweep.mjs` 的 `SWEEP_DEFAULTS` 互补，不改生产常量）。 */
export const FIXTURE_DEFAULTS = Object.freeze({
  docs: Object.freeze([50, 200, 500, 1000, 2000]),
});

/**
 * 造一档语料。
 *
 * @param {number} n 目标篇数
 * @param {{fixed?: boolean}} [opts] `fixed` 保留给装置的历史轴（题目数量不随语料增长）
 * @returns {{n: number, docs: number, notes: object[], tasks: object[]}}
 */
export function buildCorpus(n, { fixed = false } = {}) {
  const total = Math.max(4, Math.floor(n));
  const svcN = serviceCount(total);
  const span = serviceSpan(total);
  const kpN = knowledgeCount(total);
  const services = SERVICES.slice(0, svcN);

  const notes = [];
  const facts = [];

  // —— 主体：知识点 × 覆盖服务 ——
  for (let kp = 0; kp < kpN; kp += 1) {
    const domain = DOMAINS[kp % DOMAINS.length];
    const value = VALUES[(kp * 7 + 3) % VALUES.length];
    const stamp = 1 + ((kp * 13) % 9);
    for (let s = 0; s < span; s += 1) {
      // 覆盖服务用步长错开，保证同一服务上的知识点分布均匀（不塌成几个服务）。
      const si = (kp + s * Math.max(1, Math.floor(svcN / span))) % svcN;
      const svc = services[si];
      if (facts.some((f) => f.si === si && f.kp === kp)) continue;
      const id = `${svc.toLowerCase()}-${kpOf(kp)}`;
      const title = `${svc} ${kpOf(kp)}`;
      // 正文：服务名 2 次（标题 1 次 + 正文 1 次）+ 知识点号 + 领域词 + 被问的属性名。
      // 属性名必须在这里出现：题面问的就是它，库里没有它的话，拒答就变成了
      // 「问了一个不存在的词」，而不是「事实没写过」。
      const lines = [
        `${svc} 这边 ${kpOf(kp)} 的${domain.subject}取值是 ${value}。`,
        `这条是 ${domain.key} 相关的，${domain.key} 按 ${kpOf(kp)} 走。`,
        `改 ${kpOf(kp)} 之前先看 ${domain.key} 与${domain.subject}，单号 ${stamp}-${kpOf(kp)}。`,
      ];
      notes.push(noteDoc(id, title, lines));
      facts.push({ id, si, svc, kp, domain: domain.key, subject: domain.subject, value });
    }
  }

  // —— 长尾：不承载事实的背景笔记，让语料有真实的 df 分布 ——
  let filler = 0;
  while (notes.length < total) {
    const svc = services[filler % svcN];
    const domain = DOMAINS[(filler * 5 + 1) % DOMAINS.length];
    const domain2 = DOMAINS[(filler * 11 + 3) % DOMAINS.length];
    const id = `${svc.toLowerCase()}-memo-${String(filler).padStart(5, '0')}`;
    const title = `${svc} 的${domain.key}备忘`;
    const lines = [
      `${svc} 的${domain.key}这周没有变化，${domain.subject}也没动。`,
      `${domain2.key} 那边也照旧，${svc} 这边不用动。`,
      `记录人：${svc} 值班。`,
    ];
    notes.push(noteDoc(id, title, lines));
    filler += 1;
    if (filler > total * 4) break; // 兜底：别死循环
  }

  const tasks = buildTasks({ facts, total, kpN, fixed });
  return { n: total, docs: notes.length, notes, tasks };
}

/**
 * 出题。两类数量相等，都锚在**真实存在**的服务与词表上。
 *
 * 两类题的形状**完全同形**：`${服务} 的${知识点号}取值是多少？`。
 * 差别只有一处：可答题问的那个号**覆盖了这个服务**（库里有 `服务-号` 那一篇），
 * 不可答题问的号**没有覆盖这个服务**（同族的号、同服务的别号都在库，
 * 唯独 `服务-号` 这个组合从没写过）。所以难度不来自生僻词。
 */
function buildTasks({ facts, total, kpN, fixed }) {
  const tasks = [];
  const budget = fixed ? Math.min(facts.length, 48) : Math.min(facts.length, TASK_BUDGET);
  const step = Math.max(1, Math.ceil(facts.length / budget));

  // 知识点 → 覆盖了哪些服务。不可答题要从「没覆盖本服务」的号里取。
  const covered = new Map();
  for (const f of facts) {
    if (!covered.has(f.kp)) covered.set(f.kp, new Set());
    covered.get(f.kp).add(f.si);
  }

  let answerable = 0;
  let refusal = 0;
  for (let i = 0; i < facts.length && (answerable < budget || refusal < budget); i += step) {
    const f = facts[i];

    // —— 可答：证据在库（`${svc}-${kp}` 那篇），答案唯一（那篇里写死的取值）——
    if (answerable < budget) {
      tasks.push({
        id: `ans-${f.id}`,
        kind: 'answerable',
        level: 'verbatim',
        gold: f.id,
        query: `${f.svc} 的${f.subject} ${kpOf(f.kp)} 是多少？`,
        domain: f.domain,
        subject: f.subject,
        anchor: kpOf(f.kp),
      });
      answerable += 1;
    }

    // —— 不可答：近邻在库、事实不同 ——
    // 取一个**不同领域**、且没覆盖本服务的号。
    //
    // 领域必须不同，这一条是算出来的、不是风格偏好：题面里的属性名（如「过期时限」）
    // 会拆成三个二字项进分母。若近邻笔记属于同一领域，它正文里也写着同一个属性名，
    // 于是它命中「服务名之外的其它全部证据项」，覆盖率 = 1.000，闸门必然放行。
    // 换到别的领域后，近邻只命中知识点号一项，覆盖率掉到阈值以下。
    // （这个 bug 实际发生过：`verifyCorpus` 全过、recall 1.000、refusal 0.000，
    //   根因就是同领域近邻把除服务名以外的证据项全命中了。）
    if (refusal >= budget) continue;
    const stride = DOMAINS.length;
    let pick = -1;
    for (let d = stride; d <= kpN * stride && pick < 0; d += stride) {
      const cand = (f.kp + d) % kpN;
      if (cand === f.kp) continue;
      if (cand % stride === f.kp % stride) continue; // 换领域
      const svcSet = covered.get(cand);
      if (svcSet && svcSet.has(f.si)) continue;
      pick = cand;
    }
    for (let d = 1; d <= kpN && pick < 0; d += 1) {
      const cand = (f.kp + d) % kpN;
      if (cand === f.kp) continue;
      if (cand % stride === f.kp % stride) continue; // 换领域
      const svcSet = covered.get(cand);
      if (svcSet && svcSet.has(f.si)) continue;
      pick = cand;
    }
    // 找不到号就不出这道题；`verifyCorpus` 会验「事实不同」，
    // 所以宁可少出一道，也不能出一道事实其实在库的假不可答题。
    if (pick < 0) continue;
    const picked = DOMAINS[pick % DOMAINS.length];
    tasks.push({
      id: `ref-${f.id}`,
      kind: 'refusal',
      level: 'crossed',
      gold: null,
      // 题面形状与可答题**完全同形**（服务 + 属性名 + 知识点号 + 是多少），
      // 属性名也与可答题同族（同领域）。差别只有一处：这个号没覆盖这个服务。
      // 所以难度不来自生僻词 —— `verifyCorpus` 会验这一点。
      query: `${f.svc} 的${picked.subject} ${kpOf(pick)} 是多少？`,
      missing: `${f.svc}|${kpOf(pick)}`,
      domain: picked.key,
      subject: picked.subject,
      anchor: kpOf(pick),
      nearby_domain: DOMAINS[f.kp % DOMAINS.length].key,
    });
    refusal += 1;
  }
  return tasks;
}

/**
 * 自检：语料与题面必须满足「可答题证据在库、答案唯一、不可答题近邻在库但事实不同」。
 *
 * 这是**可证伪**的那一步。如果哪天生成器改坏了（不可答题的问号根本没造出来、
 * 或者可答题的答案被删了），装置读数会退化成「零命中」而不是「闸门判得好」，
 * 于是拿一个假成绩去改生产常量。所以每次造完都当面验，不满足就抛 ——
 * 宁可装置炸掉，也不要一个悄悄失真的读数。
 *
 * 四条断言：
 *   ① 可答题的答案篇存在，且含判别词（服务名 + 知识点号）；
 *   ② 可答题的答案篇**唯一** —— 同 (服务, 知识点号) 不许有第二篇；
 *   ③ 不可答题的题面**没有词项是全局零命中** —— 近邻必须在库。
 *      这条是 M5 的核心口径：靠「生僻词零命中」制造的不可答题一律不算数，
 *      因为那种题问的是一个不存在的词，不是「库里有近邻但事实不同」。
 *   ④ 不可答题被问的 `(服务, 知识点号)` 组合在库里**确实不存在** ——
 *      这才是「事实不同」的可证伪形式。
 *
 * @param {{notes: object[], tasks: object[]}} corpus
 * @returns {{answerable: number, refusal: number, refused: number}}
 */
export function verifyCorpus(corpus) {
  const df = new Map();
  for (const note of corpus.notes) {
    for (const term of new Set(bigramsOf(`${note.title}\n${note.body}`))) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const byId = new Set(corpus.notes.map((x) => x.id));
  const byPair = new Map();
  for (const note of corpus.notes) {
    byPair.set(note.id, (byPair.get(note.id) ?? 0) + 1);
  }

  let answerable = 0;
  let refusal = 0;
  let refused = 0;
  const pairs = new Set();
  for (const note of corpus.notes) pairs.add(note.id);

  for (const t of corpus.tasks) {
    const terms = [...new Set(bigramsOf(t.query))];
    if (t.kind === 'answerable') {
      answerable += 1;
      if (!byId.has(t.gold)) throw new Error(`可答题的答案不在库里：${t.id}`);
      if (byPair.get(t.gold) !== 1) throw new Error(`可答题的答案篇不唯一：${t.id}`);
      const gold = corpus.notes.find((x) => x.id === t.gold);
      const goldTerms = new Set(bigramsOf(`${gold.title}\n${gold.body}`));
      const anchors = terms.filter(
        (x) => SERVICES.some((s) => x === s.toLowerCase()) || new RegExp(`^${KP_PREFIX}\\d{${KP_WIDTH}}$`).test(x),
      );
      if (anchors.length < 2) throw new Error(`可答题的题面缺少判别词：${t.id} ${t.query}`);
      const lost = anchors.filter((x) => !goldTerms.has(x));
      if (lost.length > 0) {
        throw new Error(`可答题的答案缺少判别词 ${t.id}：${lost.join(',')}`);
      }
    } else {
      refusal += 1;
      // ③ 近邻在库：判别词（服务名、知识点号、被问的属性名）都必须在库里出现过。
      //    只查判别词，不查「是多少」这类疑问词 —— 疑问词本来就不会写进笔记，
      //    把它们算进来会把每一道拒答题都判成「零命中」，口径就废了。
      const judgeable = [t.anchor, t.subject, String(t.missing ?? '').split('|')[0]]
        .filter(Boolean)
        .flatMap((x) => bigramsOf(x));
      const oov = [...new Set(judgeable)].filter((x) => !df.has(x));
      if (oov.length > 0) {
        throw new Error(
          `不可答题的判别词在库里零命中（这是在问不存在的词，不是在问不存在的事实）：${t.id} ${oov.join(',')}`,
        );
      }
      // ④ 事实不同：被问的组合确实没有那篇。
      const [svc, kp] = String(t.missing ?? '').split('|');
      if (!svc || !kp) throw new Error(`不可答题缺少 missing 标注：${t.id}`);
      if (pairs.has(`${svc.toLowerCase()}-${kp}`)) {
        throw new Error(`不可答题的组合其实在库里（题出错了）：${t.id} ${svc}|${kp}`);
      }
      // ⑤ 判别词必须真在库里「活着」：出现至少 2 次（跨服务/跨领域），
      //    不是只在某一篇里孤零零的一次 —— 后者就是生僻词，被禁。
      if ((df.get(kp) ?? 0) < 2) throw new Error(`不可答题的知识点号是生僻词：${t.id} ${kp}`);
      if ((df.get(svc.toLowerCase()) ?? 0) < 2) throw new Error(`不可答题的服务名是生僻词：${t.id} ${svc}`);
      refused += 1;
    }
  }
  return { answerable, refusal, refused };
}

// —— 生成期的词表断言 ——
//
// 加在模块加载时，是因为这几条约束一旦破了，故障现象是**读数的方向反了**
// （比如「拒答率突然很好看」），而不是报错 —— 那种故障查起来最贵。
// 这里宁可让装置在 import 阶段就炸。
//
// ① 属性名之间的二元组不得重叠。`过期时长` 与 `过期窗口` 共享 `过期`，
//    于是「库里没写过 过期时长」的题面会被 `过期窗口` 的笔记命中，
//    覆盖率读数失去鉴别力（旧夹具的 `k00002` 就是这么被别的服务命中的）。
// ② 属性名的二元组不得落在任何领域词里。原因同上。
{
  const gramsOf = (s) => new Set(bigramsOf(s));
  for (let i = 0; i < DOMAINS.length; i += 1) {
    const a = gramsOf(DOMAINS[i].subject);
    for (let j = 0; j < DOMAINS.length; j += 1) {
      if (i === j) continue;
      const b = gramsOf(DOMAINS[j].subject);
      const shared = [...a].filter((x) => b.has(x));
      if (shared.length > 0) {
        throw new Error(`属性名二元组重叠：${DOMAINS[i].subject} / ${DOMAINS[j].subject} → ${shared.join(',')}`);
      }
    }
    for (const d of DOMAINS) {
      const shared = [...a].filter((x) => gramsOf(d.key).has(x));
      if (shared.length > 0) {
        throw new Error(`属性名与领域词重叠：${DOMAINS[i].subject} / ${d.key} → ${shared.join(',')}`);
      }
    }
  }
}
