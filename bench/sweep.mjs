// 判据 2/3 的**常量扫描**装置：`score.coverage` 的 `MIN_COVERAGE`，以及
// `no_informative_term` 的 `INFORMATIVE_DF_RATIO` / `INFORMATIVE_DF_FLOOR_DOCS`
// （外加 M4 之前那版「按语料规模开关闸门」的 `INFORMATIVE_MIN_DOCS` 历史轴）。
//
// 为什么要有它：这三个常量目前只在**两个点**上验过 ——
//   · 1321 篇的真实库（`~/memory/engramory`，df/n 有统计意义）
//   · 51 篇的评测语料（`bench/core-30-v1/library`，df/n 没有统计意义，闸门整段关闭）
// 中间量级（几百到两千篇，也就是一个人真用几个月之后的库）**一次都没测过**。
// 「在 51 篇上关掉、在 1321 篇上打开」并不能推出「在 300 篇上打开是对的」。
//
// 本装置造 50 / 200 / 500 / 1000 / 2000 篇的合成语料（取值与事实分布受控），
// 在每档上把「可答题的 recall@5」与「不可答题的拒答率」一起扫出来。
//
// **零依赖、纯词法、不起子进程**：直接调 `src/core/bm25.js` 的 `buildIndex` /
// `scoreDocs`，再用与 `src/core/recall.js` 同一套闸门口径判定。被扫的常量以参数
// 形式传进去（不改生产代码），所以同一次运行能把整条曲线放在一张表里。
//
// 用法：
//   node bench/sweep.mjs                 # 曲线 + 建议值（Markdown）
//   node bench/sweep.mjs --json          # 同样的内容，JSON（stdout 是纯 JSON）
//   node bench/sweep.mjs --json --out x.json
//   node bench/sweep.mjs --detail        # 逐档逐题的表
//   node bench/sweep.mjs --fixed         # 恒定语料（题目数量不随语料增长），看纯 df 效应
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INFORMATIVE_DF_FLOOR_DOCS,
  INFORMATIVE_DF_RATIO,
  INFORMATIVE_MIN_DOCS,
  buildIndex,
  scoreDocs,
} from '../src/core/bm25.js';
import { expandQuery } from '../src/core/tokenize.js';
import { saturateRelevance } from '../src/core/score.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');

/** 本装置自己的默认值（不改生产常量，只决定扫哪些点）。 */
export const SWEEP_DEFAULTS = Object.freeze({
  /** 语料规模梯度。50 与 2000 贴着已知的两个点（51 / 1321）。 */
  docs: Object.freeze([50, 200, 500, 1000, 2000]),
  /** `--fixed` 时不管语料多大，都只出这么多题，让 df 是唯一变量。 */
  fixedTasks: 48,
  k: 5,
  /** 与 `src/core/recall.js` 的 `DEFAULT_THRESHOLDS` 对齐（闸门之外的门槛）。 */
  minRelevance: 0.15,
  minScore: 0.18,
  /** 覆盖率闸门的扫描点；null = 关掉覆盖率闸门。 */
  coveragePoints: Object.freeze([null, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
  /** 有信息量闸门的 df/n 扫描点；null = 关掉这条闸门。 */
  /**
   * `df/n` 的扫描点。上限 0.5 是必需的：本语料里判别词每个服务一篇，
   * `df ≈ 12`，在 50 篇档上 `df/n = 0.24` —— 扫描点如果停在 0.2，
   * 「可答题在 50 篇档上就已经被误拒」这件事根本不会出现在表里（n=50 那行会全是 0）。
   * 生产值 0.05 也在表里，好直接看出它落在曲线的哪一段。
   */
  dfRatioPoints: Object.freeze([null, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5]),
  /** `INFORMATIVE_MIN_DOCS` 的历史扫描点（闸门「按语料规模开关」那一版的轴）。 */
  minDocsPoints: Object.freeze([0, 50, 100, 200, 400]),
  /**
   * `INFORMATIVE_DF_FLOOR_DOCS`（绝对词频地板）的扫描点。
   *
   * 这一支是修 M3 扫出的缺陷时加的：`df/n ≤ 0.05` 在小语料上把判别词（n=200 时
   * `df=12`，占 6%）判成「没有信息量」，整条闸退化成「什么都拒」。
   * 扫描点从 0（=旧的纯比例口径）一路到 3200（=比任何一档语料都大，等价于把闸关掉），
   * 好让「地板多大才够」是量出来的，而不是拍的。
   */
  dfFloorPoints: Object.freeze([0, 8, 16, 32, 64, 200, 800, 3200]),
});

/**
 * 生产口径（`src/core/recall.js` 的 `DEFAULT_THRESHOLDS` + `score.js` 的
 * `MIN_COVERAGE` + `bm25.js` 的两个证据性常量）。**唯一副本**在这里：
 * 渲染、CLI 的 JSON、比对脚本都读它，免得「文档里写的生产值」和「装置读的生产值」
 * 各写一份、改一处忘一处。
 */
export const PROD_PARAMS = Object.freeze({
  k: SWEEP_DEFAULTS.k,
  minRelevance: SWEEP_DEFAULTS.minRelevance,
  minScore: SWEEP_DEFAULTS.minScore,
  minCoverage: 0.6,
  dfRatio: INFORMATIVE_DF_RATIO,
  minDocs: 0,
  dfFloor: INFORMATIVE_DF_FLOOR_DOCS,
});

/** 一次扫描的默认配置：在默认值上把证据性闸门的轴钉在生产口径上（渲染的对照点要存在）。 */
export function prodSweepOptions(opts = {}) {
  return {
    dfRatioPoints: [INFORMATIVE_DF_RATIO],
    dfFloorPoints: [INFORMATIVE_DF_FLOOR_DOCS],
    minDocsPoints: [0],
    ...opts,
  };
}

// ────────────────────────────────────────────────────────────── 合成语料

/** 虚构服务名（与 core-30-v1 的 Orchid/Kestrel/Harborlight 不重叠，避免撞词）。 */
const SERVICES = Object.freeze([
  'Lumenpath', 'Quartzwell', 'Tidalmark', 'Fernbrook', 'Copperloom', 'Nightjar',
  'Saltshade', 'Rookfield', 'Pinecrest', 'Millrace', 'Amberdrift', 'Cinderbay',
]);

/**
 * 事实模板。`shared` 是**跨服务共用**的动作词（所以它在语料里的 df 随语料一起涨），
 * `property` 是「问哪一项」，`unit` 决定字数。
 *
 * 关键设计：可答题的题面由「服务名 + 共用动作词 + 疑问式」组成 —— **不含取值**，
 * 所以它的每个词项在语料里都**不稀有**（df 约 0.1n ~ 0.2n）。这正是危险的地方：
 * 稀有词闸门会把「真的能答」的题也判成没有信息量。装置要能量出这件事。
 */
const FACTS = Object.freeze([
  // `subject` 是「判别词」：只有这一类的笔记含它，所以它的 df ≈ 12（每个服务一篇）。
  // 这是**可答题的关键**，也是整台装置最关键的一个设计：真实使用里，你能答上一句
  // 「X 的 Y 是多少」，靠的正是查询和笔记**共用同一个判别词**。
  // 第二版没有 `subject`（题面只有服务名 + 通用动作词），于是 200 篇档上
  // `df/n ≤ 0.05` 把所有词项都判成没信息量，**可答题 recall 直接 0.0%** ——
  // 那不是一个「闸门太严」的结论，那是夹具根本不具备可答性。
  //
  // `property` + `subject` 拼出正文里的复合词，题面里也必须出现 `subject`。
  { key: 'deploy_port', shared: '部署', subject: '监听端口', unit: 'v' },
  { key: 'cache_ttl', shared: '缓存', subject: '过期时间', unit: 'v' },
  { key: 'retry_count', shared: '失败', subject: '重试次数', unit: 'v' },
  { key: 'config_path', shared: '运行', subject: '配置文件路径', unit: 'v' },
  { key: 'batch_limit', shared: '同步', subject: '单批条数上限', unit: 'v' },
  { key: 'log_keep', shared: '日志', subject: '保留天数', unit: 'v' },
  { key: 'api_quota', shared: '接口', subject: '每分钟限流', unit: 'v' },
  { key: 'runner_count', shared: '构建', subject: '机器台数', unit: 'v' },
  { key: 'theme_name', shared: '站点', subject: '主题名称', unit: 'w' },
  { key: 'db_engine', shared: '应用', subject: '数据库引擎', unit: 'w' },
]);

/**
 * 每类事实**自己的词表**。这是让 BM25 能分清「同一个服务的十几件事」的唯一办法。
 *
 * 走过的弯路（记在这里，免得下一个人再走）：第一版里所有事实的填充句取自同一个
 * 句池，只有「服务名」一个变量。结果是同一个服务的十几篇笔记**词法几乎相同**，
 * BM25 分数差不到千分之一，`saturateRelevance` 一压，全部落到 0.878±0.002 ——
 * 真答案靠 id 的字典序在决定排第几。recall 因此与闸门无关，纯粹是掷骰子。
 * 真实的库不是这样：讲「重试」的笔记用重试的词，讲「端口」的笔记用端口的词。
 */
const CONTEXT = Object.freeze({
  deploy_port: { nouns: ['监听端口', '入口网关', '转发规则', '开通申请'], prose: '端口开通要走变更单，安全组那边一起提' },
  cache_ttl: { nouns: ['过期时间', '回源策略', '预热脚本', '命中率'], prose: '过期时间调短之后回源压力会涨，要盯着' },
  retry_count: { nouns: ['重试次数', '退避算法', '失败队列', '熔断阈值'], prose: '重试次数调大能扛住抖动，但也可能把下游压垮' },
  config_path: { nouns: ['配置文件路径', '默认加载顺序', '覆盖规则', '环境变量'], prose: '配置文件路径有好几层，后加载的会盖掉前面的' },
  batch_limit: { nouns: ['单批条数上限', '分页游标', '限速窗口', '断点续传'], prose: '单批条数上限调大之后内存会抖，别一次开太猛' },
  log_keep: { nouns: ['保留天数', '归档策略', '采样比例', '检索索引'], prose: '保留天数从三十天改成九十天之后磁盘要重新算' },
  api_quota: { nouns: ['每分钟限流', '令牌桶容量', '突发额度', '配额告警'], prose: '每分钟限流是按调用方维度算的，不是全局' },
  runner_count: { nouns: ['机器台数', '排队策略', '镜像预热', '缓存挂载'], prose: '机器台数不够的时候任务会在队列里等很久' },
  theme_name: { nouns: ['主题名称', '模板覆盖', '静态资源', '构建产物'], prose: '主题名称换了之后要清一次构建缓存才生效' },
  db_engine: { nouns: ['数据库引擎', '连接串', '迁移脚本', '只读副本'], prose: '数据库引擎升级要停机，得提前排窗口' },
});

/**
 * 「换个说法问同一件事」的同义说法。**这是让扫描真的有意义的那个变量**：
 * 如果可答题的题面就是把笔记标题抄一遍，那么任何覆盖率闸门都必然放行
 * （coverage = 1.000），扫出来的曲线是一根平线 —— 第一版就是这样，7 个覆盖率
 * 取值全给出 100% recall，等于什么都没测。
 * 真实使用里提问的人不会记得笔记怎么写；同义说法让 coverage 落回 0.6 附近，
 * 闸门的高低才真的会把答案拦下来。
 */
const ALIASES = Object.freeze({
  // `keep`：换掉通用动作词，但**留住判别词** —— 现实里同一个东西换个说法问，
  //         判别词是不会变的。这一档是覆盖率与证据性两条闸门都该放行的正常情况。
  // `drop`：连判别词一起换掉，只留服务名 —— 覆盖率与证据性的最低档。
  // 三档（照原话 / keep / drop）让 120 道可答题横跨 coverage 的整条量程。
  deploy_port: { keep: ['对外服务的监听端口是多少', '监听端口开在哪个号上'], drop: ['外面怎么连进来'] },
  cache_ttl: { keep: ['过期时间设的是多久', '过期时间到了会怎样'], drop: ['数据多久刷新一次'] },
  retry_count: { keep: ['重试次数上限设成几', '重试次数能不能调'], drop: ['任务不稳的时候怎么兜底'] },
  config_path: { keep: ['配置文件路径在哪里', '配置文件路径改过吗'], drop: ['机器上的参数从哪读'] },
  batch_limit: { keep: ['单批条数上限是多少', '单批条数上限能调吗'], drop: ['怎么控制搬运的量'] },
  log_keep: { keep: ['保留天数设的是多少', '保留天数要不要改'], drop: ['出问题之后还能翻多久的记录'] },
  api_quota: { keep: ['每分钟限流卡在多少', '每分钟限流会不会调'], drop: ['外面调得太猛怎么办'] },
  runner_count: { keep: ['机器台数一共几台', '机器台数够不够用'], drop: ['排队等机器的情况'] },
  theme_name: { keep: ['主题名称叫什么', '主题名称换过吗'], drop: ['前端看起来怎么样'] },
  db_engine: { keep: ['数据库引擎选的是哪个', '数据库引擎换过没有'], drop: ['数据到底放在哪'] },
});

/**
 * 题面。**题面与正文必须共用同一个复合词**（`${shared}${property}`），否则这道题
 * 测的不是闸门，是「我造的夹具自己打不通」—— 第一版题面写「监听端口是多少」、
 * 正文写「部署监听端口是…」，共享二元组只有 `监听/听端/端口`，而每条同服务的
 * 笔记标题都带这三元组，于是十二件事互相压 score，recall@5 只有 4.2%。
 * 修法是把 `shared` 拼进 `property`：正文 `部署监听端口` ↔ 题面 `部署监听端口是多少`，
 * 歧义只剩「同一个服务里的十几件事」这一层，那才是覆盖率闸门该处理的事。
 */
function queryOf(fact) {
  return `${fact.shared}${fact.subject}`;
}

/** 取值：同时是「服务序号」与「版本序号」的函数，保证三元组在语料里唯一。 */
function literalOf(fact, si, v) {
  if (fact.unit === 'w') return `${SERVICES[si % SERVICES.length].toLowerCase()}-${fact.key}-v${v}`; // 取值只认全局服务表：同一个服务在大小档上取值必须一样
  return String(1000 + si * 37 + v * 13);
}

/**
 * 正文句子的模板池。**每一条都要带 `{svc}` 或 `{id}` 填充**，否则同一句话会在
 * 几十篇笔记里逐字重复：那些字的 df 直接顶到 1.0，任何查询的 coverage 都是 1.000。
 * 第一版的收尾句「上次有人直接改了机器上的配置，…」就是这么把整张曲线压平的 ——
 * 7 个覆盖率取值全给 100% recall，闸门高低一点动静都没有。
 */
const SENTENCE_POOL = Object.freeze([
  '{svc} 这边是先在小范围试，稳一周再全量。',
  '改之前记得跟 {svc} 的值班同学打个招呼。',
  '{id} 这件事以前踩过坑，别再省略审批。',
  '如果 {svc} 那边有意见，以他们的为准。',
  '这条只对 {svc} 生效，别的服务不一样。',
  '上个月 {svc} 刚复盘过一次，结论是流程没问题。',
  '{id} 相关的改动都走同一个发布窗口。',
  '临时绕过的要先记在 {svc} 的待办里。',
  '遇到不确定的地方先问 {svc} 的负责人。',
  '这几个数字每季度对一次，对不上就报上去。',
  '{svc} 的文档更新得比较慢，以实际为准。',
  '之前有人按老经验做，结果在 {svc} 上翻车了。',
  '这条规则从去年沿用到现在，没改过。',
  '{id} 出问题的话优先看最近一次变更。',
]);

/** 一句确定性的填充话：由 (noteId, 序号) 决定，不用随机源。 */
function fillerSentence(noteId, seq, svc) {
  const t = SENTENCE_POOL[(hashStr(noteId) + seq) % SENTENCE_POOL.length];
  return t.replaceAll('{svc}', svc).replaceAll('{id}', noteId);
}

/** 极简字符串散列：只要确定性，不需要密码学强度。 */
function hashStr(x) {
  let h = 2166136261;
  for (let i = 0; i < x.length; i += 1) {
    h ^= x.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 一条笔记：正文是 3~4 句，够 `SECTION_CHARS` 之下（单桶），免得分桶影响覆盖率口径。 */
function noteDoc(id, title, lines) {
  return { id, title, body: `# ${title}\n\n${lines.join('\n')}`, kind: 'semantic', trust: 'user_stated' };
}

/**
 * 造一档语料 + 题目。
 *
 * 规模 n 的构成（比例固定，规模变、比例不变 —— 否则「语料变大」这件事被别的变量污染）：
 *  · 每个服务一套「自有笔记」：服务名出现在标题，df ≈ n/12（每个服务的笔记数）
 *  · 共用动作词（部署/缓存/重试…）出现在所有服务的同类笔记上，df ≈ 0.6n（**故意高频**）
 *  · 一批「别的话题」填充笔记，让语料里有真正的长尾，而不是同一句话抄 n 遍
 *
 * 题目两类：
 *  · 可答（answerable）：问「某服务的某项」，库里**真有**那条笔记；题面不含取值。
 *  · 不可答（refusal）：问「某服务的某项」，但这一项**从没写过**（题面的动作词仍在语料里）。
 */
export function buildCorpus(n, { fixed = false } = {}) {
  const notes = [];
  const tasks = [];

  // 每个服务摊到多少条「自有笔记」。服务名是标题词，也是题面的锚点。
  // 服务数按 `n` 缩放（每个服务约 8 条），否则小档语料会被「每服务至少 3 条 ×
  // 12 个服务」的地板顶到 120 篇 —— `--docs 50` 实际上造出 120 篇，
  // 档位表上写着 50、装置里其实是 120，两个量级都不对。
  const active = Math.max(4, Math.min(SERVICES.length, Math.round(n / 8)));
  const universe = SERVICES.slice(0, active);
  const perService = Math.max(4, Math.floor(n / universe.length));
  const totalServices = universe.length;

  // ① 自有笔记：服务 × 事实
  const answerable = [];
  for (let si = 0; si < totalServices; si += 1) {
    const svc = universe[si];
    for (let fi = 0; fi < FACTS.length; fi += 1) {
      const fact = FACTS[fi];
      const v = 1 + ((si + fi) % 3);
      const id = `${svc.toLowerCase()}-${fact.key}-v${v}`;
      const title = `${svc} ${fact.shared}${fact.property}`;
      const value = literalOf(fact, si, v);
      // 正文里刻意放一个**只在这篇出现**的词（现实里的专有名词/工单号就是这样）：
      // `${svc} 这边的 ${slug}`。它的 df = 1，是「这篇笔记真的有这条信息」的旗帜。
      // 这一点直接决定扫描的结论：证据性闸门如果按 df/n ≤ 0.05 判，连这面旗帜都
      // 不算证据，于是整条查询被拒答 —— 可答题 recall 会掉。装置要量出掉多少。
      const slug = `${svc.toLowerCase()}-${fact.key}`;
      const cx = CONTEXT[fact.key];
      // 第 2~4 句只用**本类事实自己的名词**：同一个服务的十篇笔记因此词法可分，
      // 真答案能靠 BM25 分数站住，recall 才是一个关于闸门的读数。
      notes.push(noteDoc(id, title, [
        `${svc} 的${queryOf(fact)}是 ${value}，这是当前生效的取值。`,
        `${svc} 这边的${cx.nouns[1]}跟${cx.nouns[0]}是一起定的，改一个要跟着改另一个。`,
        `${cx.prose}。${svc} 的${cx.nouns[2]}里记着当初为什么这么定。`,
        `${svc} 的${fact.shared}工单号是 ${slug}，出问题的时候报这个号。`,
      ]));
      // 交替出题：一半「照原话问」，一半「换个说法问」。后一半才是覆盖率闸门的
      // 压力来源；前一半保证 recall 有一个不该被闸门影响的上界。
      const alias = ALIASES[fact.key] ?? null;
      // 三档轮转，让 12 个服务把这三种问法都摊到：
      //   fi % 3 === 0 → 照原话问（coverage 1.000，recall 的上界）
      //   fi % 3 === 1 → keep（留住共用动作词，coverage 中间档）
      //   fi % 3 === 2 → drop（只留服务名，coverage 最低档）
      const level = fi % 3;
      let query = `${svc} 的${queryOf(fact)}是多少？`;
      if (alias && level === 1) query = `${svc} ${alias.keep[(si + fi) % alias.keep.length]}？`;
      // drop 档：判别词换成**同一类事实的另一个名词**（所以仍然是一次真实的提问，
      // 而不是「随便找句话」）。这一档的查询质量最低，是 recall 的下界来源。
      if (alias && level === 2) query = `${svc} 的${cx.nouns[3]}怎么样？`;
      answerable.push({
        kind: 'answerable',
        id: `${svc.toLowerCase()}-${fact.key}`,
        query,
        level: ['verbatim', 'keep', 'drop'][level],
        gold: id,
        answer: value,
      });
    }
  }

  // ② 填充笔记：让语料有长尾。以「服务 × 别的主题」的形式，标题仍锚在服务上。
  const TOPICS = ['值班表', '发布窗口', '告警阈值', '灰度策略', '巡检清单', '容量评估', '依赖清单', '演练计划'];
  let filler = 0;
  const targetOwn = Math.min(n, perService * totalServices);
  for (let si = 0; notes.length < targetOwn; si += 1) {
    const svc = universe[si % totalServices];
    const topic = TOPICS[Math.floor(si / totalServices) % TOPICS.length];
    const seq = Math.floor(si / (totalServices * TOPICS.length));
    notes.push(noteDoc(
      `${svc.toLowerCase()}-${filler}-${topic}`,
      `${svc} ${topic}`,
      [
        `${svc} 的${topic}每季度过一遍，负责人轮流当。`,
        `上一次过 ${svc} 的${topic}是在上个月，结论是没有需要动的。`,
        fillerSentence(`${svc.toLowerCase()}-${filler}-${topic}`, 0, svc),
      ],
    ));
    filler += 1;
    if (filler > n * 2) break; // 兜底：别死循环
  }

  // ③ 补到 n 篇：用「多服务 + 多主题」的组合继续填，保持词汇分布不塌。
  let extra = 0;
  while (notes.length < n) {
    const svc = universe[extra % totalServices];
    const topic = TOPICS[(extra + 3) % TOPICS.length];
    notes.push(noteDoc(
      `${svc.toLowerCase()}-extra-${extra}`,
      `${svc} ${topic}记录`,
      [
        `${svc} 这份${topic}记录是给新人看的，写得比较啰嗦。`,
        `真正要记的只有一句：${svc} 的${topic}照旧，不用特殊处理。`,
        fillerSentence(`${svc.toLowerCase()}-extra-${extra}`, 1, svc),
      ],
    ));
    extra += 1;
  }

  // ④ 不可答题：问「这一项」，但任何服务都没写过这一项。动作词照旧共用。
  // 不可答题与可答题**结构完全一样**（同一个服务名、同一个共用动作词、同一句式），
  // 差别只在「这一项从没写过」。这样拒答率才是在测闸门，而不是在测「题面读起来不一样」。
  // 不可答题参照真实拒答题的样子：**话题贴着库里真有的那篇**，问的却是那一篇
  // 从没写过的一项（`docs/06-architecture.md §5.4` 里 `memory recall --query
  // "量子色动力学里的胶子禁闭"` 命中了 92 条、coverage 1.000 的那个病灶就是这类）。
  // 每一条都与某个**真实存在**的事实共用「服务名 + 一类动作词」，只差一个词项：
  // 用的恰好是覆盖率闸门与证据性闸门的分界处，所以两个闸门的高低都会改这条的读数。
  const MISSING = [
    { near: '缓存', property: '命中率目标', ask: '命中率目标是多少' },
    { near: '接口', property: '每天总配额', ask: '每天总共放多少次' },
    { near: '部署', property: '回滚耗时', ask: '回滚要花多长时间' },
    { near: '同步', property: '平均耗时', ask: '一次平均多久跑完' },
    { near: '日志', property: '单条大小上限', ask: '单条日志最大多少' },
    { near: '构建', property: '排队时间', ask: '平均排多久队' },
    { near: '站点', property: '配色方案', ask: '配色方案是什么' },
    { near: '应用', property: '连接池上限', ask: '连接池最多几个' },
  ];
  const refusals = MISSING.map((m, i) => {
    const svc = universe[(i * 5) % totalServices];
    return {
      kind: 'refusal',
      id: `miss-${i}`,
      query: `${svc} 的${m.ask}？`,
      near: m.near,
      gold: null,
      answer: null,
    };
  });

  // `--fixed`：题目数量不随语料增长。抽一份**固定比例**的子集，且按索引均匀抽，
  // 免得「题目变少」和「题目变简单」同时发生。
  const pickFixed = (list, want) => {
    if (!fixed || list.length <= want) return list;
    const out = [];
    for (let i = 0; i < want; i += 1) out.push(list[Math.floor((i * list.length) / want)]);
    return out;
  };

  return {
    n,
    notes,
    tasks: [
      ...pickFixed(answerable, Math.max(8, Math.floor(SWEEP_DEFAULTS.fixedTasks * 0.8))),
      ...pickFixed(refusals, Math.max(4, Math.floor(SWEEP_DEFAULTS.fixedTasks * 0.2))),
    ],
  };
}

// ────────────────────────────────────────────────────────────── 判定

/**
 * 把 `src/core/recall.js` 的闸门口径在这里**重写一遍**（不是 import）：
 * 本装置要能把常量当参数传进去，而 `recall()` 只认模块里的常量。
 * 口径必须与 `src/core/recall.js` 的 `recall()` 一致：
 *   eligible = relevance > 0 && relevance >= minRelevance && score >= minScore
 *              && coverage >= minCoverage
 *   refuse    = eligible 为空 || 整条查询没有有信息量的词项
 * 阈值取值见 `docs/06-architecture.md §5.4`；两边不一致时以文档为准。
 */
export function judgeQuery(index, query, params) {
  const {
    k = 5, minRelevance, minScore, minCoverage, dfRatio, minDocs, dfFloor,
  } = params;
  const expansions = expandQuery(query);
  // 闸门口径：与 `src/core/bm25.js` 的 `isInformativeTerm()` 同形 ——
  // `df <= dfFloor`（绝对词频，默认不带）**或** `df/n <= dfRatio`（比例）。
  // `dfFloor` 缺省 / 为 0 时退化成修复前的纯比例口径，好把「修复前的曲线」当基线扫出来。
  const floor = Number.isFinite(dfFloor) ? dfFloor : 0;
  const gateOn = () => dfRatio !== null && (floor > 0 || index.n >= minDocs);
  const isInfo = (df) => df > 0 && (df <= floor || df / index.n <= dfRatio);

  // 打分一律走 `keepCommon: true`。原因是一处**非显然的耦合**：
  // `src/core/bm25.js` 里 `totalMass = informative.count === 0 ? 0 : …`，也就是
  // 「一个证据词都没有」时覆盖率**整体塌成 0**（所有笔记 coverage = 0），
  // 于是准入层拿到的是「一条都不合格」，拒答理由 `no_informative_term` 成立。
  // 如果这里用默认参数打分，生产闸门会在 n ≥ 200 的语料上把 coverage 全清零，
  // 本装置无论把 dfRatio 调成多少都读不出差别 —— 曲线是一根压在 0 上的平线。
  // 所以要先把「生产闸门的结论」和「这次扫描要多看的原始匹配」分开：
  // 打分走 keepCommon，覆盖率由本装置按**本次扫描的参数**自己算（见 coveredIds）。
  const scored = scoreDocs(index, expansions, { keepCommon: true, termCap: undefined });
  const qinfo = scored.queryInfo ?? {};
  const gateEnabled = qinfo.informativeGateEnabled !== false
    && dfRatio !== null
    && (qinfo.informativeRatio ?? 0) > 0;
  const informativeTerms = gateEnabled ? (qinfo.informativeTerms ?? []) : null;

  // 第二遍：按**本次扫描的参数**重算证据性闸门。
  // 这里必须自己算，不能复用 qinfo —— qinfo 用的是生产常量。
  const informative = new Set();
  if (gateOn()) {
    for (const e of expansions) {
      const df = index.postings.get(e.term)?.length ?? 0;
      if (isInfo(df)) informative.add(e.term);
    }
  }

  // 覆盖率：与 bm25 同口径（分子 = 某桶在**证据词**里命中的权重和，
  // 分母 = 整条查询在**证据词**里的权重和；权重 = idf × 查询内权重）。
  //
  // 分母为什么要跟证据词闸门一致：生产里 `totalMass` 只在 `informative.count === 0`
  // 时整条塌成 0，其余情况**就是**「证据词的权重和」。
  // 修复前（`INFORMATIVE_MIN_DOCS = 200` 那一版）闸门在小语料上压根不生效
  // （`n < 200` 一律算证据），所以那时「所有命中词」和「证据词」是同一个集合；
  // 现在闸门在所有规模上都有判据（绝对词频地板兜底），分母就必须跟着换成证据词，
  // 否则本装置量的覆盖率会比生产宽，读数对不上（修复前 n=500 档读 63%、
  // 生产实际 75%，差的就是这一处）。
  const covered = coveredIds(scored, index, expansions, {
    minRelevance, minScore, minCoverage, dfRatio, minDocs, dfFloor: floor, isInfo, gateOn: gateOn(),
  });

  const noInformative = gateOn() && informative.size === 0 && expansions.length > 0;

  return {
    hits: covered.hits.slice(0, k),
    eligibleCount: covered.eligible.length,
    refused: covered.eligible.length === 0 || noInformative,
    refuseReason: noInformative ? 'no_informative_term' : (covered.eligible.length === 0 ? 'no_eligible_hit' : null),
    informativeCount: informative.size,
    informativeAll: informative,
    termDf: covered.termDf,
    // 复刻生产口的读数，方便与 run-eval 对照。
    productionGateEnabled: qinfo.informativeGateEnabled !== false,
    productionInformativeCount: informativeTerms ? informativeTerms.length : null,
  };
}

function coveredIds(scored, index, expansions, {
  minRelevance, minScore, minCoverage, isInfo, gateOn,
}) {
  const termDf = new Map();
  for (const e of expansions) {
    const df = index.postings.get(e.term)?.length ?? 0;
    if (df > 0) termDf.set(e.term, df);
  }

  // 覆盖率的词项口径：**库里存在且算得上证据的词项**（df > 0 且过闸）进分母。
  //
  // 为什么要跟着证据性闸门走：生产 `bm25.js` 里
  // `totalMass = informative.count === 0 ? 0 : Σ(证据词的 idf × 权重)` ——
  // 分母就是证据词的权重和（一个证据词都没有时整条塌成 0，那种查询由
  // `no_informative_term` 拒掉，覆盖率本来也不参与判定）。
  // 闸门关掉（`dfRatio === null`）时证据词集合等于「库里存在的词项」，退化成旧口径，
  // 于是「关掉闸门」那一列仍读得出「纯词项覆盖」。
  const eligibleTerm = new Map();
  for (const e of expansions) {
    if (eligibleTerm.has(e.term)) continue;
    const df = index.postings.get(e.term)?.length ?? 0;
    eligibleTerm.set(e.term, df > 0 && (!gateOn || isInfo(df)));
  }
  // 权重 = idf × 查询内权重，与 `src/core/bm25.js` 的 `idf()` 同一个式子。
  // 这里**显式重写**而不是 import：`idf` 没有被导出，而且扫描本来就要把口径写死，
  // 免得生产里换了公式、装置却跟着悄悄变。
  const idfOf = (df) => Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
  const massByTerm = new Map();
  for (const e of expansions) {
    if (!eligibleTerm.get(e.term)) continue;
    if (massByTerm.has(e.term)) continue;
    const df = index.postings.get(e.term)?.length ?? 0;
    massByTerm.set(e.term, idfOf(df) * e.weight);
  }
  const totalMass = [...massByTerm.values()].reduce((a, b) => a + b, 0);

  // 桶级累加，**逐桶算覆盖率** —— 复刻 `scoreDocs` 的公式（`bm25.js` 的
  // `qWeight = weight × termIdf`、`termMass = massOf.get(term)`、
  // `contribution = qWeight(tf(k1+1))/(tf + k1·norm)`、`coverage = mass / totalMass`）。
  //
  // 这里曾经偷懒写成「每条命中记录只按 `Σ t.weight` 算比例」。两个错：
  // ① 少乘词项 idf —— 生产里 `massOf` 是 idf 量级的数，装置算出来的 coverage
  //    分母偏小、比例偏高；
  // ② 只取**分数最高**的那个桶的覆盖率。而生产 `aggregateByNote` 是「同一篇笔记的
  //    多个桶取**覆盖率最大**」（一篇长笔记里只有一段正面回答时，取 max 才不会被
  //    自己的长度摊薄）。两个错叠起来，装置会把一些生产认为合格的笔记判成不合格 ——
  //    M4 的产物检查抓到一例：`Cinderbay 的连接池最多几个？` 装置 eligible=0（判拒），
  //    生产 eligible=12（判答）。所以这一段的正确性由
  //    `test/bench-sweep.test.mjs` 的「装置量的是生产的行为」逐题对账。
  const K1 = index.k1 ?? 1.2;
  const B = index.b ?? 0.4;
  const secById = new Map();
  for (const e of scored) {
    const meta = index.metas[e.docIndex];
    if (!meta) continue;
    let mass = 0;
    for (const t of e.terms ?? []) {
      if (!eligibleTerm.get(t.term)) continue;
      const df = index.postings.get(t.term)?.length ?? 0;
      if (df <= 0) continue;
      const termIdf = idfOf(df);
      const qWeight = t.weight * termIdf;
      const tf = index.postings.get(t.term).find(([d]) => d === e.docIndex)?.[1] ?? 0;
      const len = index.docLen[e.docIndex] || 0;
      const norm = 1 - B + (B * len) / (index.avgLen || 1);
      mass += (qWeight * (tf * (K1 + 1))) / (tf + K1 * norm);
    }
    secById.set(e.docIndex, {
      id: meta.id,
      bm25: e.score,
      coverage: totalMass > 0 ? Math.min(1, mass / totalMass) : 0,
    });
  }

  // 笔记层：取桶的**最高分**定 relevance/score，取桶的**最大覆盖率**定 coverage
  // （`recall.js` 的 `aggregateByNote` 就是这个口径）。
  // 注意：`scoreDocs` 返回的是**按分数排好序的稀疏表**，数组下标不是文档号，
  // 每条自带 `docIndex`。第一版按数组下标去 `index.metas` 取元数据，于是「哪条笔记
  // 命中」全错位 —— recall@5 卡在 4.2% 而 `judgeQuery` 单独看又是对的，就是这个。
  const best = new Map();
  for (const s of scored) {
    const meta = index.metas[s.docIndex];
    if (!meta) continue;
    const sec = secById.get(s.docIndex);
    const rel = saturateRelevance(s.score);
    const total = 0.3 * 1 + 0.2 * 1 + 0.5 * rel; // importance/recency 固定为 1：本装置只扫闸门
    const prev = best.get(meta.id);
    if (!prev) {
      best.set(meta.id, { id: meta.id, score: total, relevance: rel, coverage: sec.coverage, bm25: s.score });
    } else {
      if (total > prev.score) {
        prev.score = total;
        prev.relevance = rel;
        prev.bm25 = s.score;
      }
      if (sec.coverage > prev.coverage) prev.coverage = sec.coverage;
    }
  }
  const all = [...best.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const eligible = all.filter((s) => s.relevance > 0
    && s.relevance >= minRelevance
    && s.score >= minScore
    && (minCoverage === null || !Number.isFinite(s.coverage) || s.coverage >= minCoverage));
  return { hits: all, eligible, termDf };
}

/** 在一档语料上跑一套参数，给出四个读数。 */
export function runPoint(corpus, params) {
  const index = buildIndex(corpus.notes);
  let answerable = 0;
  let recalled = 0;
  let refusalTasks = 0;
  let refusedRight = 0;
  const rows = [];
  for (const t of corpus.tasks) {
    const r = judgeQuery(index, t.query, params);
    if (t.kind === 'refusal') {
      refusalTasks += 1;
      if (r.refused) refusedRight += 1;
      rows.push({ id: t.id, kind: t.kind, refused: r.refused, reason: r.refuseReason, informative: r.informativeCount });
    } else {
      answerable += 1;
      // **拒答的题不算召回**，哪怕命中就在候选里。第一版漏了这个条件，
      // recall 报 0.833 而实际上 120 道题里 108 道被闸门拒掉了 —— 装置虚报了自己的成绩。
      const inHits = r.hits.some((h) => h.id === t.gold);
      const hit = !r.refused && inHits;
      if (hit) recalled += 1;
      rows.push({
        id: t.id,
        kind: t.kind,
        level: t.level,
        gold: t.gold,
        hit,
        in_hits: inHits,
        refused: r.refused,
        reason: r.refuseReason,
        informative: r.informativeCount,
        top: r.hits[0]?.id ?? null,
      });
    }
  }
  return {
    docs: corpus.n,
    answerable,
    recalls: recalled,
    recall_at_k: answerable ? recalled / answerable : null,
    refusal_tasks: refusalTasks,
    refused_right: refusedRight,
    correct_refusal_rate: refusalTasks ? refusedRight / refusalTasks : null,
    rows,
  };
}

// ────────────────────────────────────────────────────────────── 曲线与建议

/** 一次扫描的全部格子：语料 × (覆盖率, df 比, 绝对词频地板) 的笛卡尔积。 */
export function sweep(opts = {}) {
  const cfg = { ...SWEEP_DEFAULTS, ...opts };
  const corpora = cfg.docs.map((n) => buildCorpus(n, { fixed: cfg.fixed === true }));
  const points = [];
  for (const corpus of corpora) {
    for (const minCoverage of cfg.coveragePoints) {
      for (const dfRatio of cfg.dfRatioPoints) {
        for (const dfFloor of cfg.dfFloorPoints) {
          // 闸门关掉时地板没有意义：跳过重复格子，免得同一件事算 8 遍。
          if (dfRatio === null && dfFloor !== cfg.dfFloorPoints[0]) continue;
          const params = {
            k: cfg.k,
            minRelevance: cfg.minRelevance,
            minScore: cfg.minScore,
            minCoverage,
            dfRatio,
            minDocs: cfg.minDocsPoints[0],
            dfFloor,
          };
          const point = runPoint(corpus, params);
          points.push({ ...params, ...point, rows: cfg.detail ? point.rows : undefined });
        }
      }
    }
  }
  return { config: cfg, corpora: corpora.map((c) => ({ docs: c.n, notes: c.notes.length, tasks: c.tasks.length })), points };
}

/**
 * 从曲线里挑建议值。判据：**先保召回，再降误答**。
 *  · 可答题的 recall@5 不许低于 `recallFloor`（默认 0.95）—— 丢真答案是硬伤；
 *  · 在满足上一条的格子里，取「拒答率最高」的那组（误答最少）；
 *  · 并列时取更保守（更小 df 比 / 更小覆盖率）的那组。
 */
export function recommend(result, { recallFloor = 0.95 } = {}) {
  const byParams = new Map();
  for (const p of result.points) {
    const key = `${p.minCoverage ?? '-'}|${p.dfRatio ?? '-'}|${p.dfRatio === null ? '-' : (p.dfFloor ?? 0)}`;
    if (!byParams.has(key)) byParams.set(key, []);
    byParams.get(key).push(p);
  }
  const combos = [];
  for (const [key, ps] of byParams) {
    const worstRecall = Math.min(...ps.map((p) => (p.recall_at_k ?? 0)));
    const refusal = ps.reduce((a, p) => a + (p.correct_refusal_rate ?? 0), 0) / ps.length;
    const [cov, df, fl] = key.split('|');
    combos.push({
      key,
      minCoverage: cov === '-' ? null : Number(cov),
      dfRatio: df === '-' ? null : Number(df),
      dfFloor: fl === '-' ? null : Number(fl),
      worst_recall: worstRecall,
      mean_refusal: refusal,
      docs: ps.map((p) => p.docs),
    });
  }
  const feasible = combos.filter((c) => c.worst_recall >= recallFloor);
  feasible.sort((a, b) => b.mean_refusal - a.mean_refusal
    || (a.dfRatio ?? 0) - (b.dfRatio ?? 0)
    || (a.dfFloor ?? 0) - (b.dfFloor ?? 0)
    || (a.minCoverage ?? 0) - (b.minCoverage ?? 0));
  const best = feasible[0] ?? null;
  return { recallFloor, feasible: feasible.length, best, combos };
}

// ────────────────────────────────────────────────────────────── 渲染

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v) => (v === null || v === undefined ? '—' : String(v));

export function renderMarkdown(rep) {
  const { result, rec } = rep;
  const L = [];
  L.push('# 常量扫描（`bench/sweep.mjs`）');
  L.push('');
  L.push(`合成语料档位：${result.corpora.map((c) => `${c.docs} 篇/${c.tasks} 题`).join('、')}`
    + `${result.config.fixed ? '（恒定题量：题目数不随语料增长）' : ''}`);
  L.push('');
  L.push('## 曲线（覆盖率闸门 × 语料规模，证据性闸门用生产值）');
  L.push('');
  L.push('| 语料 | ' + result.config.coveragePoints.map((c) => `coverage ≥ ${c ?? '关'}`).join(' | ') + ' |');
  L.push('| --- | ' + result.config.coveragePoints.map(() => '---').join(' | ') + ' |');
  const prodRatio = PROD_PARAMS.dfRatio;
  const prodFloor = PROD_PARAMS.dfFloor;
  const isProd = (x, cov) => x.minCoverage === cov && x.dfRatio === prodRatio && (x.dfFloor ?? 0) === prodFloor;
  for (const c of result.corpora) {
    const cells = result.config.coveragePoints.map((cov) => {
      const p = result.points.find((x) => x.docs === c.docs && isProd(x, cov));
      return p ? `${pct(p.recall_at_k)} / ${pct(p.correct_refusal_rate)}` : '—';
    });
    L.push(`| ${c.docs} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push('每个格子是 `可答题 recall@5 / 不可答题拒答率`。');
  L.push('');
  L.push('## 曲线（df 比 × 语料规模，覆盖率固定 0.6，绝对地板用生产值）');
  L.push('');
  L.push('| 语料 | ' + result.config.dfRatioPoints.map((d) => (d === null ? '关' : `df/n ≤ ${d}`)).join(' | ') + ' |');
  L.push('| --- | ' + result.config.dfRatioPoints.map(() => '---').join(' | ') + ' |');
  for (const c of result.corpora) {
    const cells = result.config.dfRatioPoints.map((df) => {
      const p = result.points.find((x) => x.docs === c.docs && x.dfRatio === df
        && (x.dfFloor ?? 0) === prodFloor && x.minCoverage === 0.6);
      return p ? `${pct(p.recall_at_k)} / ${pct(p.correct_refusal_rate)}` : '—';
    });
    L.push(`| ${c.docs} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push(`## 曲线（绝对词频地板 × 语料规模，df 比固定 ${prodRatio}，覆盖率固定 0.6）`);
  L.push('');
  L.push('地板这一支是**与语料规模无关**的判据：`df ≤ 地板` 就算证据。'
    + '地板 0 = 修复前的纯比例口径；地板 3200 = 比任何一档语料都大，等价于把闸门关掉。');
  L.push('');
  L.push('| 语料 | ' + result.config.dfFloorPoints.map((f) => `df ≤ ${f}`).join(' | ') + ' |');
  L.push('| --- | ' + result.config.dfFloorPoints.map(() => '---').join(' | ') + ' |');
  for (const c of result.corpora) {
    const cells = result.config.dfFloorPoints.map((fl) => {
      const p = result.points.find((x) => x.docs === c.docs && x.dfFloor === fl
        && x.dfRatio === prodRatio && x.minCoverage === 0.6);
      return p ? `${pct(p.recall_at_k)} / ${pct(p.correct_refusal_rate)}` : '—';
    });
    L.push(`| ${c.docs} | ${cells.join(' | ')} |`);
  }
  L.push('');
  L.push('## 建议');
  L.push('');
  if (rec.best) {
    L.push(`在「可答题 recall@5 不低于 ${pct(rec.recallFloor)}」的前提下，误答最少的格子是：`);
    L.push('');
    L.push(`- \`MIN_COVERAGE = ${rec.best.minCoverage ?? '（关）'}\``);
    L.push(`- \`INFORMATIVE_DF_RATIO = ${rec.best.dfRatio ?? '（关）'}\``);
    L.push(`- \`INFORMATIVE_DF_FLOOR_DOCS = ${rec.best.dfFloor ?? '（关）'}\``);
    L.push(`- 最差档 recall@5 ${pct(rec.best.worst_recall)}，平均拒答率 ${pct(rec.best.mean_refusal)}`);
  } else {
    L.push(`没有格子能在所有语料档上把 recall@5 保持在 ${pct(rec.recallFloor)} 以上。`);
  }
  L.push('');
  L.push(`生产值：\`MIN_COVERAGE = ${PROD_PARAMS.minCoverage}\`、`
    + `\`INFORMATIVE_DF_RATIO = ${prodRatio}\`、\`INFORMATIVE_DF_FLOOR_DOCS = ${prodFloor}\`。`
    + '（`INFORMATIVE_MIN_DOCS` 已不参与判定，只为兼容旧引用保留。）');
  return `${L.join('\n')}\n`;
}

// ────────────────────────────────────────────────────────────── CLI

export function parseArgs(argv) {
  const opts = { json: false, detail: false, fixed: false, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} 缺参数`);
      return argv[i];
    };
    if (a === '--json') opts.json = true;
    else if (a === '--detail') opts.detail = true;
    else if (a === '--fixed') opts.fixed = true;
    else if (a === '--out') opts.out = next();
    else if (a === '--docs') opts.docs = next().split(',').map((x) => Number(x.trim()));
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  if (opts.docs && opts.docs.some((n) => !Number.isInteger(n) || n < 4)) {
    throw new Error('--docs 必须是 ≥4 的整数列表，用逗号分隔');
  }
  return opts;
}

export function usage() {
  return [
    '用法：node bench/sweep.mjs [--json] [--detail] [--fixed] [--docs 50,200,500] [--out FILE]',
    '',
    '  --json    输出 JSON（stdout 是纯 JSON）',
    '  --detail  带上逐题明细（JSON）',
    '  --fixed   恒定题量：题目数不随语料增长，让 df 是唯一变量',
    '  --docs    语料规模梯度，默认 50,200,500,1000,2000',
    '  --out     写进文件而不是 stdout',
    '',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`参数错误：${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(usage());
    return 0;
  }
  const result = sweep(prodSweepOptions({
    detail: opts.detail,
    fixed: opts.fixed,
    ...(opts.docs ? { docs: opts.docs } : {}),
  }));
  const rec = recommend(result);
  const payload = {
    device: 'sweep',
    version: 2,
    production: {
      MIN_COVERAGE: 0.6,
      INFORMATIVE_DF_RATIO: INFORMATIVE_DF_RATIO,
      INFORMATIVE_DF_FLOOR_DOCS: INFORMATIVE_DF_FLOOR_DOCS,
      INFORMATIVE_MIN_DOCS: INFORMATIVE_MIN_DOCS,
    },
    result,
    rec,
  };
  const text = opts.json ? `${JSON.stringify(payload, null, 2)}\n` : renderMarkdown({ result, rec });
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), text);
  else process.stdout.write(text);
  return 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
