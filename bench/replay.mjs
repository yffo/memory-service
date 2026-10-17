#!/usr/bin/env node
/**
 * 判据 3 的回放装置：**合成时钟上的 4 周使用回放**（`02-evaluation.md §5` 判据 3）。
 *
 * ```
 * node bench/replay.mjs                      # 人类可读报告
 * node bench/replay.mjs --json               # 机器可读（同种子**逐字一致**）
 * node bench/replay.mjs --seed 7 --weeks 4 --verbose
 * ```
 *
 * ## 判据 3 的两个量，本装置怎么定义
 *
 * 判据原文：「4 周回放后 `staleness_rate ≤ 0.05`，且 `negative_transfer ≤ 0.02`
 * （正值=有害，即记忆不得让准确率下降超过 2 个百分点）」。
 *
 * 两个量都是**事件占比**（分子/分母同时打印，别只看比值）：
 *
 * - `staleness_rate = 陈旧注入事件 / 全部召回事件`。
 *   一次事件算陈旧：召回返回了至少一条笔记，而其中**最靠前的一条**（回答器会先看到
 *   哪条就抄哪条）在**当时**已经被新事实取代（`superseded_by` 非空）。
 *   在事件发生的那一刻，那条笔记已经不是真话了 —— 这就是「4 周后仍被召回、
 *   但已被新事实取代」的可测量版本。
 * - `negative_transfer = 有害注入事件 / 全部召回事件`。
 *   一次事件算有害：被注入的集合里**最靠前**的那条是陈旧的，而当前真值另有其条
 *   （即「加记忆比不加更差」：closed-book 会答不知道，注入却把它引向旧值）。
 *   等于 0 时可以直接说「记忆没有让它答错」，>0 就是判据 3 的证伪条件。
 * - 附带 `post_window_unanswered`：4 周结束这一刻，重放全部问题，有多少题
 *   **答不出当前真值**（拒答、或当前笔记没进 top-5）。这是「腐烂」而不是「害人」，
 *   单独记，别混进上面两个量。
 *
 * ## 为什么可信（口径写死，不靠模型裁判）
 *
 * 1. **合成时钟**：所有 `valid_from` / `valid_to` / `nowMs` 都来自一个从固定纪元
 *    推出来的虚拟时间轴，一次回放里没有任何一处读 `Date.now()`（`runner.nowMs` 是
 *    唯一的时间源）。跑十年后重跑，数字一样。
 * 2. **零 LLM 裁判**：判「陈旧」是查 `superseded_by` 与 `valid_to`，判「有害」是看
 *    有序结果里的位置，全是集合与序运算。
 * 3. **同一份真值表**：每次写入都更新 `current[fact]`，回放器与被测系统看的是同一张表
 *    （表由回放器维护，被测系统只能从笔记里推）。
 * 4. **同种子可复现**：全部随机性来自 `mulberry32(seed)`；报告里不含时间戳/耗时，
 *    所以两次 `--json` 的输出**逐字节相同**（`test/replay.test.mjs` 钉住这一点）。
 *
 * ## 明确没做的
 *
 * - **不写盘**：语料在内存里以 `{id, title, body, note}` 的条目形状喂给 `recall()`，
 *   与 `scanStore()` 的产物同形。回放要的是「时间轴上发生了什么」，而落盘只增加
 *   文件系统噪声（且 `writeNoteAtomic` 会用真实时钟写 mtime）。落盘路径由
 *   `test/store-*.test.mjs` 与 `bench/run-eval.mjs` 覆盖。
 * - **不模拟巩固进程**（§4.2 的 consolidate）：M2 只落了「谁取代谁」的生命周期事实，
 *   没有跑过空闲期巩固。回放里的取代是**用户显式纠错**，不是系统推断的。
 * - **不测向量档**：默认档是纯词法，判据 3 只对默认档负责。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recall } from '../src/core/recall.js';
import { parseNote } from '../src/store/note.js';
import { parseTime } from '../src/util/clock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LIBRARY = path.join(HERE, 'core-30-v1', 'library');

/** 未在本模块内联实现的默认值集中在这里，让「回放参数」只有一处可读。 */
export const REPLAY_DEFAULTS = Object.freeze({
  seed: 20261017,
  weeks: 4,
  /** 一周几个「使用日」。4 周 = 28 个使用日。 */
  daysPerWeek: 7,
  /** 每个使用日几次召回会话。 */
  sessionsPerDay: 6,
  /** 「现在几点」的候选时刻（UTC 小时），让同一句话在不同时段被问。 */
  hours: Object.freeze([10.5, 15]),
  k: 5,
  maxTokens: 500,
});

/**
 * 判据 3 的阈值（`02-evaluation.md §5`）。**复制而不是 import**：阈值属于文档口径，
 * 装置只负责测；哪天文档改了阈值，这里跟着改，但不会因为别处改了常量而漂移。
 */
export const CRITERION3 = Object.freeze({
  stalenessRate: 0.05,
  negativeTransfer: 0.02,
  trapRate: 0.25,
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** 回放的 t0：一个固定的周一。用 UTC 构造，避免本地时区把数字改掉。 */
export const T0_MS = Date.UTC(2026, 0, 5, 9, 0, 0);

// ────────────────────────────────────────────────────────────── 虚构语料

/**
 * 虚构服务名。与 `core-30-v1/library` 的 Orchid/Kestrel/Harborlight **不重叠**：
 * 回放语料是另造的一批，两边混在一起时也不会互相撞词。
 */
export const FICTIONAL_SERVICES = Object.freeze([
  'Lumenpath', 'Quartzwell', 'Tidalmark', 'Fernbrook', 'Copperloom',
  'Nightjar', 'Saltshade', 'Rookfield', 'Pinecrest', 'Millrace',
  'Amberdrift', 'Cinderbay',
]);

/**
 * 事实模板。每个模板给出：
 *  - `key`：事实种类（= 检索时问的「那件事」）；
 *  - `literal`：真值的取值生成器 `(v, si)`（v = 版本序号，si = 服务序号）；
 *  - `sentence`：写进笔记正文的那句话（取值生成器）；
 *  - `query`：人怎么问这件事（**不含取值**，防泄漏的构造性版本）；
 *  - `fillers`：同一份语料里的干扰词，让「有信息量」这件事不是白给的。
 *
 * **取值必须同时是 v 和 si 的函数。** 只按 v 取值（`8000 + v * 7`）时，
 * 12 个服务的 `deploy_port` 会写出 12 篇「监听端口是 8007」—— 那不是一个含糊的
 * 夹具，「Rookfield 监听哪个端口」在库里就**真的没有唯一答案**了，检索器把
 * Rookfield 那篇排在 Nightjar 那篇后面并不算错。第一版就是这么写的，审计里
 * 10/32 的「第一条不是当前真值」全是这个原因（不是召回的问题）。
 * 现在 `si * 常量 + v * 常量` 让 (服务, 事实, 版本) 三元组在语料里唯一。
 */
export const FACT_TEMPLATES = Object.freeze({
  deploy_port: {
    literal: (v, si) => String(8000 + si * 20 + v * 7),
    sentence: (v, si) => [`监听端口是 ${8000 + si * 20 + v * 7}，不是默认的 8080。`],
    query: () => ['监听哪个端口？'],
    fillers: ['连接串里端口写错会表现成连上了但查询超时。'],
  },
  sync_hour: {
    literal: (v, si) => `${String(1 + si * 3 + v).padStart(2, '0')}:40`,
    sentence: (v, si) => [`每天 ${String(1 + si * 3 + v).padStart(2, '0')}:40 自动同步一次，错过就等第二天。`],
    query: () => ['每天几点自动同步？'],
    fillers: ['同步窗口之外触发的手动同步不写检查点。'],
  },
  batch_limit: {
    literal: (v, si) => `${2 + si * 5 + v} GB`,
    sentence: (v, si) => [`单次同步的数据量上限是 ${2 + si * 5 + v} GB，超了会被拆成两批。`],
    query: () => ['单次同步的数据量上限是多少？'],
    fillers: ['拆分发生在入队之前，所以下游看不到半批数据。'],
  },
  artifact_dir: {
    literal: (v, si) => `out/v${v}/site-${si}`,
    sentence: (v, si) => [`正式构建产物写在 out/v${v}/site-${si}，预览产物不在这里。`],
    query: () => ['正式构建产物写在哪个目录？'],
    fillers: ['构建目录不进版本库，换机器要重新生成。'],
  },
  theme_name: {
    literal: (v, si) => `slate-tide-${si}${v}`,
    sentence: (v, si) => [`站点主题用的 slate-tide-${si}${v}，深色偏好下自动切换。`],
    query: () => ['站点用的主题是哪一套？'],
    fillers: ['主题包按季度更新一次，改主题要走设计评审。'],
  },
  rate_limit: {
    literal: (v, si) => `每分钟 ${30 + si * 10 + v * 6} 次`,
    sentence: (v, si) => [`公开接口的限流是每分钟 ${30 + si * 10 + v * 6} 次，超了返回 429。`],
    query: () => ['公开接口的限流是多少？'],
    fillers: ['限流按调用方维度算，不按接口维度算。'],
  },
  cache_ttl: {
    literal: (v, si) => `${20 + si * 4 + v * 5} 分钟`,
    sentence: (v, si) => [`缓存在生产环境的过期时间是 ${20 + si * 4 + v * 5} 分钟。`],
    query: () => ['缓存在生产环境的过期时间是多久？'],
    fillers: ['过期时间到了不会主动刷新，要等下一次访问。'],
  },
  config_path: {
    literal: (v, si) => `~/.config/svc${si}${v}/config.toml`,
    sentence: (v, si) => [`配置文件固定放在 ~/.config/svc${si}${v}/config.toml。`],
    query: () => ['配置文件放在哪个路径？'],
    fillers: ['本地覆盖文件与主配置同目录，不同名。'],
  },
  retry_count: {
    literal: (v, si) => `最多重试 ${si + v} 次`,
    sentence: (v, si) => [`同一个任务连续失败之后最多重试 ${si + v} 次，再失败就报警。`],
    query: () => ['同一个任务连续失败之后最多重试几次？'],
    fillers: ['重试之间有指数退避，间隔不是固定的。'],
  },
  ci_runner: {
    literal: (v, si) => ((si + v) % 2 === 0 ? `四台 arm64 runner（第 ${v} 代）` : `两台 x86-64 runner（第 ${v} 代）`),
    sentence: (v, si) => [`CI 跑在 ${(si + v) % 2 === 0 ? '四台 arm64' : '两台 x86-64'} runner 上（第 ${v} 代），排队超过十分钟会扩容。`],
    query: () => ['CI 跑在哪种机器上？'],
    fillers: ['扩容出来的 runner 是临时的，任务结束后自动回收。'],
  },
  db_port: {
    literal: (v, si) => `连接池端口 ${5000 + si * 17 + v * 13}`,
    sentence: (v, si) => [`数据库连接池端口改成 ${5000 + si * 17 + v * 13} 了，应用不再直连数据库。`],
    query: () => ['连数据库走哪个端口？'],
    fillers: ['连接池与应用在同一台机器上，走本地回环。'],
  },
  log_retention: {
    literal: (v, si) => `${10 + si * 2 + v * 3} 天`,
    sentence: (v, si) => [`日志默认保留 ${10 + si * 2 + v * 3} 天，之后自动清理。`],
    query: () => ['日志默认保留多少天？'],
    fillers: ['清理任务在凌晨跑，不做人工确认。'],
  },
  package_manager: {
    literal: (v, si) => `${['npm', 'pnpm', 'yarn', 'bun'][(si + v) % 4]}（第 ${v} 代为准）`,
    sentence: (v, si) => [`包管理器换成 ${['npm', 'pnpm', 'yarn', 'bun'][(si + v) % 4]} 了，锁文件已同步迁移。`],
    query: () => ['用哪个包管理器？'],
    fillers: ['换包管理器要删掉旧锁文件，否则会读回旧解析结果。'],
  },
  branch_flow: {
    literal: (v, si) => `${['trunk-based', 'git-flow', 'release-train', 'stacked-pr'][(si + v) % 4]}（第 ${v} 版流程）`,
    sentence: (v, si) => [`分支流改成 ${['trunk-based', 'git-flow', 'release-train', 'stacked-pr'][(si + v) % 4]} 了，评审规则跟着改。`],
    query: () => ['仓库用哪套分支流？'],
    fillers: ['分支保护规则与分支流配套，改流程要一起改。'],
  },
});

const TEMPLATE_KEYS = Object.freeze(Object.keys(FACT_TEMPLATES));

/** 服务名 → 服务序号（取值生成器的第二个参数，保证跨服务不撞值）。 */
const SERVICE_INDEX = new Map(FICTIONAL_SERVICES.map((name, i) => [name, i]));

/** 一件事的取值：`(服务, 事实, 版本)` 三元组唯一。 */
export function literalOf(service, template, version) {
  return FACT_TEMPLATES[template].literal(version, SERVICE_INDEX.get(service) ?? 0);
}

/** 这件事写进笔记正文的那句话。 */
export function sentenceOf(service, template, version) {
  return FACT_TEMPLATES[template].sentence(version, SERVICE_INDEX.get(service) ?? 0);
}

/**
 * 事实种类 → 提问句式。查询 = 服务名 + 句式，**句式里没有取值**，
 * 所以「题面泄答案」在这份语料上是构造性不可能的。
 */
function queryText(templateKey, service) {
  const tpl = FACT_TEMPLATES[templateKey];
  const tail = tpl.query(1)[0];
  return `${service} ${tail}`;
}

/** mulberry32：32 位状态、无依赖、跨平台逐位一致。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 合成时钟的**精确时刻**（带 `Z`），写 `valid_from` / `valid_to` 用它。
 *
 * 为什么不用 date-only：`parseTime` 把 `2026-01-05` 解析成**本机时区的正午**，
 * 而回放的日界是 `T0_MS` 的 09:00Z。于是同一份时间轴，在 UTC+8 上「笔记当天就有效」，
 * 在 UTC 上要等到 12:00Z 才有效 —— 09:00Z 的查询看不到它，整批召回被日期过滤掉
 * （实测 TZ=UTC 时 168 次会话塌成 0 次，CI 直接红）。事件本身是精确到小时的，
 * 落盘也该是精确到小时的时刻，而不是一个要靠时区猜的日期。
 */
function isoInstant(ms) {
  return new Date(ms).toISOString();
}

/**
 * 语料条目：与 `scanStore().notes` 的条目**同形**（`{id, title, body, note}`）。
 *
 * 走 `parseNote()` 而不是手搓 `note` 对象，是为了让「回放里的笔记」与「库里的笔记」
 * 真的是同一套 schema —— 手搓一个 `{kind:'semantic'}` 也能被 `recall` 吃下去，
 * 但那是在测一个不存在的库。
 */
export function makeEntry(id, meta, bodyLines, mtime = null) {
  const rendered = [
    '---',
    `schema: memory.note/1`,
    `id: ${id}`,
    `scope: ${meta.scope ?? 'project:replay'}`,
    `kind: ${meta.kind ?? 'semantic'}`,
    `trust: ${meta.trust ?? 'user_stated'}`,
    `status: ${meta.status ?? 'active'}`,
    `valid_from: ${meta.valid_from}`,
    `valid_to: ${meta.valid_to ?? 'null'}`,
    `supersedes: [${(meta.supersedes ?? []).join(', ')}]`,
    `superseded_by: ${meta.superseded_by ?? 'null'}`,
    `confidence: ${meta.confidence ?? 0.9}`,
    `provenance:`,
    `  written_by: user`,
    `  source_ref: null`,
    '---',
    '',
    `# ${meta.title}`,
    '',
    ...bodyLines,
    '',
  ].join('\n');
  const parsed = parseNote(rendered, { id, mtime });
  if (!parsed.ok) {
    const first = parsed.errors[0];
    throw new Error(`回放语料生成失败（这是装置的 bug，不是被测系统的）：${id} ${first?.code ?? ''} ${first?.message ?? ''}`);
  }
  return { id, title: parsed.title, body: parsed.body, note: parsed.note, mtime };
}

// ────────────────────────────────────────────────────────────── 回放主体

/**
 * 生成「第几周、第几天、哪几件事」的时间轴。
 *
 * 关键：**取代只发生在第 2..N 周**。第 1 周写下的每一件事在写下时都是真话，
 * 如果取代也发生在第 1 周，那么「陈旧」在一开始就存在，这个回放就没测到
 * 「用了四周之后烂不烂」。
 */
export function makeTimeline({ seed = REPLAY_DEFAULTS.seed, weeks = REPLAY_DEFAULTS.weeks, factsPerWeek = 8 } = {}) {
  const rnd = mulberry32(seed);
  const services = [...FICTIONAL_SERVICES];
  const templates = [...TEMPLATE_KEYS];
  const events = [];
  let serviceCursor = Math.floor(rnd() * services.length);

  /** 已经写过的 (服务, 事实种类, 版本)：同一个三元组只能写一次。 */
  const used = new Set();

  const pickPair = (version) => {
    // 400 次重试 = 同一批模板 + 同一版本上换个随机起点再抽，抽不到才是真的抽不到。
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const svc = services[serviceCursor % services.length];
      serviceCursor += 1;
      const tpl = templates[Math.floor(rnd() * templates.length)];
      const key = `${svc}::${tpl}::v${version}`;
      if (used.has(key)) continue;
      used.add(key);
      return { service: svc, template: tpl };
    }
    throw new Error(`回放时间轴：可用 (服务, 事实) 组合耗尽（版本 ${version}），把 factsPerWeek 调小或扩服务表`);
  };

  const daysPerWeek = REPLAY_DEFAULTS.daysPerWeek;
  const nDays = weeks * daysPerWeek;
  for (let week = 0; week < weeks; week += 1) {
    for (let d = 0; d < daysPerWeek; d += 1) {
      const day = week * daysPerWeek + d;
      const dayMs = T0_MS + day * DAY_MS;
      if (d === 0) {
        // 每周第一天：写下这一周的新事实（都是「当前」版本 v1）。
        for (let i = 0; i < factsPerWeek; i += 1) {
          events.push({ week, day, dayMs, type: 'write', pair: pickPair(1), version: 1, reason: 'new_fact' });
        }
      } else if (d === 1 && week > 0) {
        // 每周第二天：用户纠正上一周写下的若干条，老版本就此被取代。
        //
        // 这里只看 `event.week`，它在构造时就填好了。第一版是等整条时间轴建完
        // 才补 `e.week` 的，而这一行当时读到的全是 `undefined` —— 一次纠正都没发生，
        // `staleness` 测的是**空集**。消融对照本来是用来证明「0 是挣来的」的，
        // 结果先把「0 是白给的」照了出来（见报告里的 `ablation`）。
        const candidates = events.filter((e) => e.type === 'write' && e.version === 1 && e.week === week - 1);
        const nCorrect = Math.max(1, Math.floor(candidates.length / 2));
        for (const e of candidates.slice(0, nCorrect)) {
          events.push({ week, day, dayMs, type: 'write', pair: e.pair, version: 2, reason: 'correction' });
        }
      }
    }
  }
  return { events, nDays, weeks, seed, daysPerWeek };
}

/** 一次使用的时刻：（虚拟日 + 时段）→ 毫秒。 */
function timeOfDay(day, hour) {
  return T0_MS + day * DAY_MS + (hour - 9) * 60 * 60 * 1000;
}

/**
 * 跑一次回放。
 *
 * @param {object} [opts]
 * @param {number} [opts.seed] 随机种子（同种子 → 逐字一致的报告）
 * @param {number} [opts.weeks] 回放几周（默认 4）
 * @param {number} [opts.factsPerWeek] 每周写下几件新事实
 * @param {number} [opts.sessionsPerDay] 每个使用日几次召回
 * @param {number} [opts.k] 一次召回取几条（回答器能看到几条）
 * @param {number} [opts.maxTokens] 注入预算
 * @param {boolean} [opts.detail] 报告里带逐事件明细
 */
export function runReplay(opts = {}) {
  const seed = opts.seed ?? REPLAY_DEFAULTS.seed;
  const traps = Boolean(opts.traps);
  const trapIds = new Set();
  const weeks = opts.weeks ?? REPLAY_DEFAULTS.weeks;
  const factsPerWeek = opts.factsPerWeek ?? 8;
  const sessionsPerDay = opts.sessionsPerDay ?? REPLAY_DEFAULTS.sessionsPerDay;
  const k = opts.k ?? REPLAY_DEFAULTS.k;
  const maxTokens = opts.maxTokens ?? REPLAY_DEFAULTS.maxTokens;
  const wantDetail = Boolean(opts.detail);

  const { events, nDays } = makeTimeline({ seed, weeks, factsPerWeek });
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);

  /** 库：同形条目 + 真值表。`current[factKey] = {id, value}` 是「此刻的真话」。 */
  const store = new Map();
  const current = new Map();
  const facts = new Map(); // factKey → {service, template, query, history:[{id, version, day}]}
  const notes = new Map(); // id → {factKey, version, day, supersededOnDay|null}
  const valueOf = new Map(); // factKey → Map(version → literal)
  const probeCache = new Map(); // id → 校准用的孤立条目（与正式写入的正文一致）
  const writtenOn = new Map(); // factKey → 第一次写下它的虚拟日

  const makeId = (service, template, v) => `${service.toLowerCase()}-${template}-v${v}`;
  const factKeyOf = (service, template) => `${service}::${template}`;

  function writeFact({ pair, version, day, dayMs, reason }) {
    const { service, template } = pair;
    const factKey = factKeyOf(service, template);
    const tpl = FACT_TEMPLATES[template];
    const literal = literalOf(service, template, version);
    const id = makeId(service, template, version);
    const prev = current.get(factKey) ?? null;
    const body = [
      ...sentenceOf(service, template, version),
      ...(tpl.fillers ?? []),
      reason === 'correction' && prev ? `上一版是 ${prev.value}，已经不用了。` : '这条是当时的唯一口径。',
    ];
    const entry = makeEntry(
      id,
      {
        title: `${service}：${template}`,
        valid_from: isoInstant(dayMs),
        supersedes: prev ? [prev.id] : [],
        valid_to: null,
        scope: `project:${service.toLowerCase()}`,
      },
      body,
      dayMs,
    );
    if (prev) {
      // 老版本：显式标成被取代 + 关掉有效期。两处都写，因为真实的取代路径就是这么落的
      // （`archive-*` 那些笔记在 `core-30-v1/library` 里也是两处都写）。
      const old = store.get(prev.id);
      old.note.superseded_by = id;
      old.note.valid_to = isoInstant(dayMs);
      old.note.status = 'active'; // 显式字段不写 superseded：由 superseded_by/valid_to 推
      notes.get(prev.id).supersededOnDay = day;
      // `--traps`：在库里多留一条**没有取代标记的旧值副本**（陷阱）。
      //
      // 这是真实世界里「取代关系没落盘」的坏笔记，形态有两个要素，缺一不可：
      //   ① 正文是旧取值，但 `valid_to`/`superseded_by` 都是空的 —— 看起来仍然有效；
      //   ② `valid_from` 用的是**这次取代发生的那天**，不是旧笔记原来那天。
      //      只做 ① 的话陷阱根本咬不到人：旧的 `valid_from` 让 recency 掉下去，
      //      光是这一项就把它压在下面了（实测过，35 次陷阱探测一次都没中）。
      //      真实故障也是长 ② 这样的 —— 旧笔记被重新导入/重建索引，时间戳刷成了新的。
      // 主口径（`traps: false`）永远不造这个。
      if (traps) {
        const trapId = `${id}~stale-trap`;
        const trapBody = [...sentenceOf(service, template, prev.version), ...(tpl.fillers ?? []), '后来改过一版，但这条还没被归档。'];
        store.set(
          trapId,
          makeEntry(
            trapId,
            {
              title: `${service}：${template}（旧版）`,
              valid_from: isoInstant(dayMs),
              supersedes: [],
              valid_to: null,
              scope: `project:${service.toLowerCase()}`,
            },
            trapBody,
            dayMs,
          ),
        );
        notes.set(trapId, { factKey, version: prev.version, day, supersededOnDay: null, reason: 'trap_stale_copy' });
        trapIds.add(trapId);
      }
    }
    store.set(id, entry);
    notes.set(id, { factKey, version, day, supersededOnDay: null, reason });
    current.set(factKey, { id, value: literal, version });
    if (!facts.has(factKey)) {
      facts.set(factKey, { service, template, query: queryText(template, service), history: [] });
    }
    facts.get(factKey).history.push({ id, version, value: literal, day });
    if (!valueOf.has(factKey)) valueOf.set(factKey, new Map());
    valueOf.get(factKey).set(version, literal);
    if (reason === 'new_fact' || !writtenOn.has(factKey)) writtenOn.set(factKey, day);
  }

  // ── 先做「校准」：一次笔记写下来，它自己被问到时够不够格 ──
  //
  // 不校准的话，装置测的是**它自己写坏的语料**：一篇措辞与别的事实撞词、或写得太短的
  // 笔记本来就召不回来，那是夹具的问题，记到系统头上是冤枉它。校准只做两件事：
  //   ① 单条够格（把这条单独放进空库，问它自己，能不能进 top-k）；
  //   ② 家族内够格（同一件事的新旧两版同时在场，仍能进 top-k —— 取代关系不能把
  //      两条一起挤掉，否则回放里根本没有「新的赢了」这件事可测）。
  // 两条都过的版本才进使用序列。被筛掉的条数照实报出来（`corpus.excluded`）。
  const probeOf = (service, template, version, dayMs) => {
    const id = makeId(service, template, version);
    if (probeCache.has(id)) return probeCache.get(id);
    const tpl = FACT_TEMPLATES[template];
    const entry = makeEntry(
      id,
      { title: `${service}：${template}`, valid_from: isoInstant(dayMs), supersedes: [], valid_to: null, scope: `project:${service.toLowerCase()}` },
      [...sentenceOf(service, template, version), ...(tpl.fillers ?? [])],
      dayMs,
    );
    probeCache.set(id, entry);
    return entry;
  };

  const alone = new Set();
  const withinFamily = new Set();
  const writeEvents = events.filter((e) => e.type === 'write');
  for (const ev of writeEvents) {
    const { service, template } = ev.pair;
    const id = makeId(service, template, ev.version);
    const single = recall({
      entries: [probeOf(service, template, ev.version, ev.dayMs)],
      query: queryText(template, service),
      options: { nowMs: ev.dayMs, budgetTokens: maxTokens },
    });
    if (!single.refused && single.items.some((it) => it.id === id)) alone.add(id);
    const family = writeEvents.filter((e) => e.pair.service === service && e.pair.template === template).map((e) => probeOf(service, template, e.version, e.dayMs));
    const joint = recall({ entries: family, query: queryText(template, service), options: { nowMs: ev.dayMs + 12 * 60 * 60 * 1000, budgetTokens: maxTokens } });
    const rank = joint.items.findIndex((it) => it.id === id);
    if (!joint.refused && rank >= 0 && rank < k) withinFamily.add(id);
  }
  const admissible = (id) => alone.has(id) && withinFamily.has(id);

  // ── 第二遍：真正的 4 周回放（合成时钟是唯一的时间源）──
  const writes = [];
  const recalls = [];
  const excluded = new Set();
  const eventsByDay = new Map();
  for (const ev of events) {
    if (!eventsByDay.has(ev.day)) eventsByDay.set(ev.day, []);
    eventsByDay.get(ev.day).push(ev);
  }

  let sessionSeq = 0;
  for (let day = 0; day < nDays; day += 1) {
    const dayMs = T0_MS + day * DAY_MS;
    for (const ev of eventsByDay.get(day) ?? []) {
      const factKey = factKeyOf(ev.pair.service, ev.pair.template);
      writeFact({ ...ev, dayMs });
      const id = ev.type === 'write' ? makeId(ev.pair.service, ev.pair.template, ev.version) : null;
      writes.push({ day, id, reason: ev.reason });
      if (id && !admissible(id)) excluded.add(id);
    }
    // 当天的召回会话：**当前真值够格**的事实里随机挑一件问。
    // 只问够格的：校准确认过「这条写得清楚」，剩下的就是系统的事了。
    const askable = [...facts.entries()].filter(([factKey]) => {
      const cur = current.get(factKey);
      return cur && writtenOn.get(factKey) <= day && admissible(cur.id);
    });
    if (askable.length === 0) continue;
    for (let s = 0; s < sessionsPerDay; s += 1) {
      const hour = REPLAY_DEFAULTS.hours[Math.floor(rnd() * REPLAY_DEFAULTS.hours.length)];
      const nowMs = timeOfDay(day, hour);
      const [factKey, fact] = askable[Math.floor(rnd() * askable.length)];
      const cur = current.get(factKey);
      // 「那一刻已经被新事实取代」的笔记 = 那天之前写下的、不是当前真值的全部版本。
      //
      // 这里**故意不套 `admissible()`**（当前真值的校准过滤器）。第一版套了，结果
      // `superseded_ids` 在 168 次会话里只有 35 次非空：被取代的笔记正文里写的是**旧取值**，
      // 而查询问的是现在这件事，词法上根本不重合 —— `admissible()` 于是把它判成「这条笔记
      // 答不了这个问题」，陈旧笔记就此从分母里消失。可「它答不了这个问题」正是被测系统的
      // 功劳，不该由装置的准入过滤器替它记功。口径改成照实算，分子能不能咬到就是系统的事了。
      const supersededIds = fact.history.filter((h) => h.day <= day && h.id !== cur.id).map((h) => h.id);
      for (const tid of trapIds) if (notes.get(tid)?.factKey === factKey) supersededIds.push(tid);

      // 今天的会话：
      //  ① 正常一问 —— 问句式（不带取值），用户想知道「现在」是什么。
      //  ② 陷阱模式额外一问 —— 把**上一版的取值原样问出来**（「缓存过期时间还是 20 分钟吧？」）。
      //     这是真实世界里最容易踩的一脚：用户带着过期口径来核对，库里还留着那条旧值，
      //     它当然是这条查询字面上最像的答案。系统若没把旧值压下去，第一条注入就是陈旧的。
      const probes = [{ query: fact.query, kind: 'ask' }];
      if (traps && supersededIds.length > 0) {
        // 陷阱副本的正文是**再上一版**那句话（取代发生时 v1 被 v2 顶掉，副本留的是 v1 的取值）。
        // 不要用 `oldNote.version` 去取字面量：陷阱副本记的 `version` 是它**被取代前**的版本号，
        // 而它正文里那句话来自更早的版本 —— 拿错版本号会问出一个库里根本没有的取值，
        // 那次注入当然不陈旧（第一版就是这么写的，35 次陷阱探测一次都没咬中）。
        const trap = supersededIds.map((tid) => notes.get(tid)).find((n) => n && n.reason === 'trap_stale_copy');
        const staleVersion = trap ? Math.max(1, trap.version - 1) : notes.get(supersededIds[0])?.version;
        const staleLiteral = staleVersion === undefined ? null : valueOf.get(factKey)?.get(staleVersion) ?? null;
        if (staleLiteral !== null) {
          probes.push({
            query: `${fact.service} ${FACT_TEMPLATES[fact.template].query(1)[0].replace('？', `，还是 ${staleLiteral} 吧？`)}`,
            kind: 'stale_literal',
          });
        }
      }
      for (const probe of probes) {
        const res = recall({
          entries: [...store.values()],
          query: probe.query,
          options: { nowMs, budgetTokens: maxTokens, k },
        });
        const ids = (res.items ?? []).slice(0, k).map((i) => i.id);
        const rankOf = (id) => ids.indexOf(id);
        const currentRank = cur ? rankOf(cur.id) : -1;
        // 被注入的第一条（回答器先看到的那条）是旧值 —— 两个量的分子都从这里来。
        const topIsSuperseded = ids.length > 0 && supersededIds.includes(ids[0]);
        const stalePresent = supersededIds.some((id) => rankOf(id) >= 0);
        recalls.push({
          session: (sessionSeq += 1),
          probe: probe.kind,
          day,
          hour,
          week: Math.floor(day / REPLAY_DEFAULTS.daysPerWeek),
          query: probe.query,
          fact: factKey,
          refused: Boolean(res.refused),
          reason: res.reason ?? null,
          items: ids,
          top: ids[0] ?? null,
          current: cur?.id ?? null,
          current_rank: currentRank,
          superseded_ids: supersededIds,
          // 陈旧注入：返回了笔记，且最靠前那条**在那一刻**已经被新事实取代。
          staleness: topIsSuperseded,
          // 有害注入：当前真值另有其条，但没排到旧值前面（此时回答器一定抄旧值）。
          negative_transfer: topIsSuperseded && currentRank < 0,
          stale_in_context: stalePresent,
        });
      }
    }
  }

  // ── 4 周结束的审计：重放全部问题，看「现在还答得出来吗」 ──
  //
  // 与上面的事件口径分开：这里问的是「回放结束这一刻，库里还答得出当前真值吗」。
  // 拒答、当前笔记掉出 top-k、第一条注入是旧值 —— 三种都算「没答对」，各自单列。
  const endMs = T0_MS + (nDays - 1) * DAY_MS + 20 * 60 * 60 * 1000;
  const audit = [];
  for (const [factKey, fact] of facts) {
    const cur = current.get(factKey);
    if (!cur || !admissible(cur.id)) continue;
    const res = recall({ entries: [...store.values()], query: fact.query, options: { nowMs: endMs, budgetTokens: maxTokens, k } });
    const ids = (res.items ?? []).slice(0, k).map((i) => i.id);
    const rank = ids.indexOf(cur.id);
    const supersededIds = fact.history.filter((h) => h.id !== cur.id).map((h) => h.id);
    for (const tid of trapIds) if (notes.get(tid)?.factKey === factKey) supersededIds.push(tid);
    audit.push({
      fact: factKey,
      query: fact.query,
      refused: Boolean(res.refused),
      current: cur.id,
      current_rank: rank,
      answered: rank >= 0,
      stale_in_context: ids.some((id) => supersededIds.includes(id)),
      // 用户实际会读到的口径：回答器读注入上下文的第一条 —— 那是当前真值才叫「答对了」。
      first_item: ids[0] ?? null,
      first_item_is_current: ids[0] === cur.id,
    });
  }

  // ── 消融对照：把「取代」这件事从库里拿掉，同样的问题再问一遍 ──
  //
  // 不加这一段，`staleness_rate = 0` 是个**没法解读的数**：它既可能是「系统把旧笔记
  // 管得很好」，也可能是「这个装置根本测不出陈旧」。做法是把每条被取代的笔记改回
  // 「看起来还有效」（`valid_to = null`、去掉 `superseded_by`），其余一个字不动，然后
  // 拿同一批会话重跑一次。消融只影响这一段，不进主口径。
  //
  // 实测（seed 20261017 / 4 周 / 35 次有机会的会话）：
  //   主线   —— 被取代的笔记 **35/35 次根本没进上下文**（`expired_at_as_of` 挡在准入层）。
  //   消融后 —— 同一批问题 **35/35 次都进了上下文**，但排第一的仍然是当前真值，旧值排第 2。
  // 所以这个 `0` 是两道机制叠出来的：准入层的 `valid_to` 硬过滤，加上打分层的 recency——
  // 旧笔记的 `valid_from` 更早，`exp(-age/30)` 更低，词法打平也翻不了身。
  // 真正**挣来**的部分是后者：把准入层整段拿掉，读数照样是 0。写在这里，免得以后有人
  // 看到 `ablation.staleness_rate = 0` 就以为消融没接上。
  const withoutLifecycle = new Map();
  for (const [id, entry] of store) {
    const note = entry.note;
    withoutLifecycle.set(
      id,
      makeEntry(
        id,
        {
          title: note.title ?? id,
          scope: note.scope,
          kind: note.kind,
          trust: note.trust,
          status: note.status,
          valid_from: note.valid_from,
          valid_to: null,
          supersedes: note.supersedes ?? [],
          superseded_by: null,
          confidence: note.confidence,
        },
        String(entry.body ?? '').split('\n'),
        entry.mtime,
      ),
    );
  }
  let ablationStale = 0;
  let ablationHarmful = 0;
  let ablationInContext = 0;
  for (const row of recalls) {
    const res = recall({
      entries: [...withoutLifecycle.values()],
      query: row.query,
      // 用**这次会话当时的时刻**，不是当天 9:00 —— 会话时刻会影响 recency 项，
      // 消融唯一该变的变量是「取代标记」，时间也换掉就不再是单变量对照了。
      options: { nowMs: timeOfDay(row.day, row.hour), budgetTokens: maxTokens, k },
    });
    const ids = (res.items ?? []).slice(0, k).map((i) => i.id);
    if (ids.length === 0 || row.superseded_ids.length === 0) continue;
    if (row.superseded_ids.some((id) => ids.includes(id))) ablationInContext += 1;
    if (row.superseded_ids.includes(ids[0])) {
      ablationStale += 1;
      if (ids.indexOf(row.current) < 0) ablationHarmful += 1;
    }
  }

  const total = recalls.length;
  // 机会口径：只有「这一刻库里确实存在已被取代的笔记」的会话才可能读到陈旧笔记。
  // 4 周里 32 件事只有 12 件被改过：其余会话的「不陈旧」是**白给的**。把白给的会话
  // 算进分母，分母越大比率越小，读数只会更好看 —— 那不是一个能证伪的数。
  // 两个分母都出，判据用总口径（分母大、更难成立），另附 opportunity 口径看真实表现。
  const opportunities = recalls.filter((r) => r.superseded_ids.length > 0).length;
  const staleEvents = recalls.filter((r) => r.staleness).length;
  const harmfulEvents = recalls.filter((r) => r.negative_transfer).length;
  const staleInContext = recalls.filter((r) => r.stale_in_context).length;
  // 回放结束时的抽查里「第一条不是当前真值」的次数。
  //
  // 注意它**不是**陈旧率：这 13 次里没有一次第一条是被取代的笔记（那 12 条被 `valid_to`
  // 挡在准入层外）。命中的是**同一模板、别家服务**的笔记 —— 12 个服务的笔记正文几乎同构，
  // 区分它们只能靠标题里的服务名，词法上很弱。这是合成语料的性质，不是被测系统的缺陷，
  // 所以它不进判据，只在报告里如实列出来。
  const wrongFirst = audit.filter((a) => !a.first_item_is_current).length;
  const unanswered = audit.filter((a) => !a.answered).length;
  const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1e6) / 1e6 : null);

  // 明细里带上「库最后长什么样」：被取代的笔记在最后一步的分数、排名都能直接看出来，
  // 排查「为什么第一条不是当前真值」时不用再去重建整个回放。
  const detail = wantDetail
    ? {
        recalls,
        audit,
        writes,
        store: [...store.keys()].map((id) => {
          const n = notes.get(id);
          return {
            id,
            fact: n.factKey,
            version: n.version,
            written_day: n.day,
            superseded_on_day: n.supersededOnDay,
            is_current: (current.get(n.factKey) ?? {}).id === id,
          };
        }),
      }
    : null;

  const report = {
    device: 'replay',
    version: 1,
    criterion: 3,
    seed,
    weeks,
    facts_per_week: factsPerWeek,
    sessions_per_day: sessionsPerDay,
    k,
    max_tokens: maxTokens,
    corpus: { notes_written: store.size - trapIds.size, facts: facts.size, days: nDays },
    traps: {
      enabled: traps,
      notes: trapIds.size,
      what: '没有取代标记的旧值副本 —— 被取代的老笔记换成一个看起来仍然有效的坏笔记',
    },
    usage: { recall_events: total, sessions_per_day: sessionsPerDay, days: nDays },
    staleness: {
      events: staleEvents,
      denominator: total,
      rate: rate(staleEvents, total),
      // 「有机会」的会话数与同一分子的另一个比率（见上面 opportunities 的注释）。
      opportunities,
      rate_with_opportunity: rate(staleEvents, opportunities),
      limit: CRITERION3.stalenessRate,
      pass: rate(staleEvents, total) !== null && rate(staleEvents, total) <= CRITERION3.stalenessRate,
      // 更宽的口径：只要上下文里**混进**了旧值就算（不管它排第几）。
      // 它是上界，不是判据 —— 判据用最靠前那条，见文件头。
      stale_in_context_events: staleInContext,
      stale_in_context_rate: rate(staleInContext, total),
    },
    negative_transfer: {
      events: harmfulEvents,
      denominator: total,
      rate: rate(harmfulEvents, total),
      limit: CRITERION3.negativeTransfer,
      pass: rate(harmfulEvents, total) !== null && rate(harmfulEvents, total) <= CRITERION3.negativeTransfer,
      definition: '注入的第一条是被取代的旧值，而当前真值没排到它前面',
    },
    // 消融对照：同样的问题、同样的库，只把「取代」抹掉重问一次。
    // `staleness.rate = 0` 只有在 `ablation.rate` 明显不为 0 时才算一个**挣来的** 0。
    ablation: {
      what: '把被取代的笔记改回「看起来还有效」（valid_to=null、去掉 superseded_by），同一批会话重跑',
      runs: opportunities,
      staleness_events: ablationStale,
      staleness_rate: rate(ablationStale, opportunities),
      negative_transfer_events: ablationHarmful,
      negative_transfer_rate: rate(ablationHarmful, opportunities),
      stale_in_context_events: ablationInContext,
      stale_in_context_rate: rate(ablationInContext, opportunities),
    },
    post_window: {
      what: '回放结束时把 32 件事全部重问一遍（这一刻的库，不是历史某一刻）',
      facts: audit.length,
      unanswered,
      unanswered_rate: rate(unanswered, audit.length),
      wrong_first: wrongFirst,
      wrong_first_rate: rate(wrongFirst, audit.length),
      stale_in_context: audit.filter((a) => a.stale_in_context).length,
    },
    refusals: {
      events: recalls.filter((r) => r.refused).length,
      rate: rate(recalls.filter((r) => r.refused).length, total),
      reasons: recalls.reduce((acc, r) => {
        if (r.refused) acc[r.reason ?? 'unknown'] = (acc[r.reason ?? 'unknown'] ?? 0) + 1;
        return acc;
      }, {}),
    },
    detail,
  };
  report.criterion3_pass = report.staleness.pass && report.negative_transfer.pass;
  return report;
}

// ────────────────────────────────────────────────────────────── 渲染

/** 报告去掉明细后的稳定文本：同种子两次逐字一致（测试拿它比对）。 */
export function stableText(report) {
  const clone = JSON.parse(JSON.stringify({ ...report, detail: null }));
  return JSON.stringify(clone, null, 2);
}

function pct(x) {
  return x === null || x === undefined ? '—' : `${(x * 100).toFixed(2)}%`;
}

export function renderMarkdown(rep) {
  const L = [];
  L.push('# 判据 3 · 4 周回放');
  L.push('');
  L.push(`种子 \`${rep.seed}\`，${rep.weeks} 周 / ${rep.corpus.days} 个使用日 / ${rep.usage.recall_events} 次召回会话；`);
  L.push(`合成语料 ${rep.corpus.notes_written} 篇（${rep.corpus.facts} 件事，其中一部分被后来的事实取代）。`);
  L.push('');
  L.push('| 量 | 分子/分母 | 值 | 阈值 | 判定 |');
  L.push('|---|---|---|---|---|');
  L.push(
    `| \`staleness_rate\` | ${rep.staleness.events}/${rep.staleness.denominator} | **${pct(rep.staleness.rate)}** | ≤ ${pct(rep.staleness.limit)} | ${rep.staleness.pass ? '达标' : '**不达标**'} |`,
  );
  L.push(
    `| \`negative_transfer\` | ${rep.negative_transfer.events}/${rep.negative_transfer.denominator} | **${pct(rep.negative_transfer.rate)}** | ≤ ${pct(rep.negative_transfer.limit)} | ${rep.negative_transfer.pass ? '达标' : '**不达标**'} |`,
  );
  L.push('');
  L.push(`宽口径（上下文里混进旧值，不管排第几）：${rep.staleness.stale_in_context_events}/${rep.staleness.denominator} = ${pct(rep.staleness.stale_in_context_rate)}`);
  L.push('');
  L.push('## 4 周结束时的现状（重放全部问题）');
  L.push('');
  L.push(
    `- 问得出当前真值：${rep.post_window.facts - rep.post_window.unanswered}/${rep.post_window.facts}` +
      `（答不出 ${pct(rep.post_window.unanswered_rate)}）`,
  );
  L.push(`- 第一条注入就是旧值：${rep.post_window.wrong_first}/${rep.post_window.facts} = ${pct(rep.post_window.wrong_first_rate)}`);
  L.push(`- 上下文里混进旧值：${rep.post_window.stale_in_context}/${rep.post_window.facts}`);
  L.push('');
  const refusals = Object.entries(rep.refusals.reasons).sort();
  L.push(`拒答：${rep.refusals.events}/${rep.usage.recall_events}（${pct(rep.refusals.rate)}）` + (refusals.length ? `，理由 ${refusals.map(([k, v]) => `${k}=${v}`).join(' / ')}` : ''));
  if (rep.detail) {
    L.push('');
    L.push('## 逐事件');
    L.push('');
    L.push('| # | 日 | 问题 | 拒答 | 第一条 | 当前真值排名 | 陈旧注入 | 有害 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const r of rep.detail.recalls) {
      L.push(`| ${r.session} | d${r.day} | ${r.query} | ${r.refused ? r.reason : '—'} | ${r.top ?? '—'} | ${r.current_rank < 0 ? '未进 top-k' : r.current_rank} | ${r.staleness ? '是' : ''} | ${r.negative_transfer ? '**是**' : ''} |`);
    }
  }
  L.push('');
  L.push(`**判据 3：${rep.criterion3_pass ? '成立' : '不成立'}**`);
  return `${L.join('\n')}\n`;
}

export function parseArgs(argv) {
  const opts = { seed: REPLAY_DEFAULTS.seed, weeks: REPLAY_DEFAULTS.weeks, json: false, markdown: false, verbose: false, traps: false, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} 缺参数`);
      return argv[i];
    };
    if (a === '--json') opts.json = true;
    else if (a === '--markdown') opts.markdown = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--traps') opts.traps = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--seed') opts.seed = Number(next());
    else if (a === '--weeks') opts.weeks = Number(next());
    else if (a === '--facts-per-week') opts.factsPerWeek = Number(next());
    else if (a === '--sessions-per-day') opts.sessionsPerDay = Number(next());
    else if (a === '--k') opts.k = Number(next());
    else if (a === '--max-tokens') opts.maxTokens = Number(next());
    else if (a === '--out') opts.out = next();
    else throw new Error(`不认识的参数：${a}`);
  }
  if (!Number.isFinite(opts.seed)) throw new Error('--seed 必须是数字');
  if (!Number.isInteger(opts.weeks) || opts.weeks < 1) throw new Error('--weeks 必须是 ≥1 的整数');
  return opts;
}

export function usage() {
  return `用法：node bench/replay.mjs [选项]

  --seed <n>               随机种子（默认 ${REPLAY_DEFAULTS.seed}）；同种子两次 --json 逐字一致
  --weeks <n>              回放几周（默认 ${REPLAY_DEFAULTS.weeks}，判据 3 要的是 4 周）
  --facts-per-week <n>     每周写下几件新事实（默认 8）
  --sessions-per-day <n>   每个使用日几次召回（默认 ${REPLAY_DEFAULTS.sessionsPerDay}）
  --k <n>                  一次召回取几条（默认 ${REPLAY_DEFAULTS.k}）
  --max-tokens <n>         注入预算（默认 ${REPLAY_DEFAULTS.maxTokens}）
  --traps                  在库里塞「没有取代标记的旧值副本」（灵敏度对照，判据 3 不成立）
  --json                   输出 JSON（同种子逐字一致）
  --markdown               输出 markdown 报告
  --verbose                逐事件明细
  --out <file>             写到文件（默认 stdout）
  -h, --help               这份说明
`;
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
  const rep = runReplay({ ...opts, detail: opts.verbose });
  const text = opts.json ? `${stableText(rep)}\n` : renderMarkdown(rep);
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), text);
  else process.stdout.write(text);
  // 判据不成立时退出码 1：CI 里不看输出也能发现（与 `memory index` 的约定一致：
  // `ok` 说的是查询成功，退出码说的是判据成不成立）。
  return rep.criterion3_pass ? 0 : 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exitCode = main();
