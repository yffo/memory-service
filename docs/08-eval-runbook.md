# 08 · 评测跑手册（core-30-v1 / 判据 1）

这份文档只回答三件事：**怎么跑**、**那张表怎么读**、**判据 1 算不算成立**。
判据本身的口径在 `docs/02-evaluation.md §5`，本文只负责把它落到可执行的命令与可核对的数字。

- 题集：`bench/core-30-v1/tasks.json`（40 题：四类能力题 32 条 —— 事实召回 9 / 偏好 8 / 纠错 8 / 流程 7 —— 加拒答集 8 条。
  拒答题靠 `source: []` 判定（不是靠 `kind`），它不新增能力维度，但必须单独存在才可能算 `correct_refusal_rate`；
  每条的 `forbid` 都是「最诱人的编造值」，且那个值能在**别的**笔记里找到，不是凭空编的）
- 语料库：`bench/core-30-v1/library/*.md`（50 篇，全虚构）
- 判分器：`bench/scorer.mjs`（纯函数，零依赖、零模型调用）
- 跑分器：`bench/run-eval.mjs`（三臂，取上下文一律**子进程调 CLI**，不 import 被测代码内部模块）

## 0. 一分钟版

```bash
node --test                                        # 判分器 + 题集纪律 + MCP 一致性（36 条，全绿无 skip）
node bench/run-eval.mjs --same-corpus              # 判据 1 的主口径（三臂同语料，Markdown 表）
node bench/run-eval.mjs --json | jq .judgement      # 机器可读；提示信息走 stderr，stdout 是纯 JSON
node bench/run-eval.mjs --dry                       # 不调 CLI：只验证评分路径没坏
```

零模型成本：回答器是 `none`（非模型，只回显注入上下文），量的是「检索有没有把正确笔记拿进上下文」。
整轮 40 题 × 3 臂约 9 秒，远在 `docs/00-brief.md §5` 判据 B 的 15 分钟预算之内。

## 1. 跑之前要有什么

| 依赖 | 说明 |
| --- | --- |
| `bin/memory` | 被测 CLI（接口冻结：`status/search/read/remember --json`）。不在场就退到 `--dry` |
| `bench/core-30-v1/library` | 虚构语料。跑分时默认**复制**到 `/tmp` 的临时库，仓库里的语料一个字都不会被改写 |
| `~/memory/engramory` + `~/yffto/dsh-engramory-recall` | legacy 臂的默认来源（只读）。同语料对照见 `--same-corpus` |
| 官方 MCP SDK | 仅 `test/mcp-conformance.test.mjs` 需要；找不到时该文件自报原因（本机在 `@modelcontextprotocol/client` v2 路径上，不是裸的 `sdk`） |

不需要装任何依赖：`bench/*.mjs` 零依赖，只用 node 内置模块。

## 2. 三臂是什么

| 臂 | 上下文从哪来 | 看什么 |
| --- | --- | --- |
| `none` | 空上下文 | 退化基线。它答对任何一题都说明题集泄题了 |
| `new` | `node bin/memory search --query "<q>" --json` | 被测系统。库是语料库的临时副本 |
| `legacy` | 子进程 import 旧仓库的 `store.js` + `bm25.js`（**只读**） | 旧插件基线。默认读 `~/memory/engramory` |

`--same-corpus` 让 legacy 臂也读同一份虚构语料（临时 flat 库）。**判据 1 的主口径用同语料**：
不同库的 recall 不可比（旧库是 74 篇私人笔记，本来就不该命中虚构题集）。

## 3. 选项

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `--tasks <file>` | `bench/core-30-v1/tasks.json` | 换题集（同格式即可） |
| `--library <dir>` | `bench/core-30-v1/library` | 换语料 |
| `--cli <path>` / `--cli-args <str>` | `bin/memory` / 空 | 换被测 CLI、追加参数（CLI 改口径时对齐用） |
| `--store <dir>` / `--store-mode <mode>` | 临时副本 / `auto` | 库怎么告诉 CLI：`auto`＝同时给 `--store` 与 `MEMORY_STORE`；也可 `flag`/`env`/`plain` |
| `--same-corpus` | 关 | legacy 臂读同一份虚构语料（同语料对照） |
| `--legacy-repo` / `--legacy-store` | 旧仓库 / `~/memory/engramory` | 旧臂来源；旧仓库**只读**，别写 |
| `--answerer <mode>` | `echo` | `echo`＝回显全部注入上下文；`first-hit`＝只回显 rank-1（看漏用信号用这个） |
| `--k <n>` | 5 | recall@k |
| `--arms <list>` | `none,new,legacy` | 只跑其中几臂 |
| `--json` / `--out <file>` | — | stdout 纯 JSON / 额外写一份 Markdown |
| `--keep-scratch` | 关 | 保留临时库，排查用 |
| `--dry` | 关 | 不调 CLI，只跑 none 臂 + 评分路径 |

隐私：库路径落在仓库之外时，报告与 JSON 里的笔记 id 一律打码成 `note#N`；
打码之前先判分（`hits_display` 才是给人看的那份），所以打码不会影响数字。

## 4. 表怎么读

### 4.1 指标（口径写死在 `bench/scorer.mjs`，别处不要另立）

| 指标 | 定义 | 阈值 |
| --- | --- | --- |
| `recall@5` | 有来源的题上，gold 笔记是否**全部**进 top-5（多金标题要全中）的平均。拒答题不进分母 | **≥ 0.80** |
| `correct_refusal_rate` | **只在拒答题上算**：干净拒答（说了「没有记录」且没把编造值端出来）的比例 | **≥ 0.75** |
| `refusal_calibration` | 文档口径（该答的答 + 该拒的拒，分母=全部题）的参照值 | 参照 |
| `match_rate` | 答案逐字命中期望串的比例；拒答题干净拒答也算 match | 参照 |
| `expect_hit_rate` | 期望串出现在**注入上下文**里的比例（信息有没有进上下文） | 参照 |
| `injected_tokens` / `_mean` | 每题注入的 token；CLI 报了 `tokens` 就用它的，没报才按 CJK≈0.6 token/字估 | 均值 **≤ 500** |
| `token_efficiency` | 命中题数 ÷（注入 token/1000）。越大越省 | 越大越好 |
| `hit_but_unused_rate` | gold 进了上下文却**没进答案**的比例（分母=进了上下文的题） | 越小越好 |
| `answered_rate` | 没拒答的比例（拒答可能是好事也可能是坏事，配合上面两行看） | 参照 |
| 调用失败数 / 缺题数 | CLI 非零退出、输出不是 JSON、某题没记录 | 必须 0 |

判分优先级：确定性的字符串/集合判定 > `refusal_match`。**「拒绝」绝不用 LLM 裁判判**。

### 4.2 逐题表

`| 题号 | 类型 | prompt | none | new | legacy |`，每格 `✓`/`✗`/`R`/`-`。
逐题的 `✗` 比聚合值有用：先看 `f*`（事实）在 `new` 上是不是全中，再看 `r*`（拒答）为什么没拒。

### 4.3 判据 1 段落（报告自带）

```
- recall@5：new 臂 1 → 达标（阈值 0.8）
- correct_refusal_rate：new 臂 0.125 → 不达标（阈值 0.75）
- 单题注入 token 均值：new 臂 450.38 → 达标（阈值 500）
- 差距：correct_refusal_rate 差 0.625
- verdict: 判据 1 不成立（有指标没达标）
```

## 5. 判据 1 成不成立怎么判

**deny-by-default**：三条同时达标才算成立；任何一条算不出来（`--dry`、缺题、CLI 调用失败、命中一个都不落在题集语料里）都不是「成立」，而是「算不出来」，报告会单列 blocker。

1. `recall@5 ≥ 0.80` —— 有来源的题。
2. `correct_refusal_rate ≥ 0.75` —— **只在拒答题上算**。这是有意偏离文档口径的反作弊选择：
   若按全部题算，一个「从不说不知道」的系统能靠 27/32 = 0.84 白过 0.75 门槛。
   文档口径另存为 `refusal_calibration` 一起印出来做参照。
3. `injected_tokens_mean ≤ 500` —— 判据 1 的预算约束（`docs/06-architecture.md §M1`）。

不成立先别改题集：**先查索引**。单跳命中 < 90% 就是索引/召回的问题；索引没坏再动检索。
`recall@5` 与 `correct_refusal_rate` 要分开归因：前者是召回，后者是「证据不够时敢不敢拒」。

## 6. 当前状态（2026-10-17，52 题 / 50 篇语料）

同语料口径（`--same-corpus`，判据 1 用这张）：

| 指标 | none | new（M3） | legacy | 判据 |
| --- | --- | --- | --- | --- |
| recall@5 | 0 | **0.844**（27/32） | 1（32/32） | ≥ 0.8 |
| correct_refusal_rate | 1 | **0.800**（16/20） | 0.10（2/20） | ≥ 0.75 |
| injected_tokens_mean | 0 | **254.9** | 320.6 | ≤ 500 |
| token_efficiency | — | **2.037** | 1.919 | 越大越好 |
| match_rate（答对率，含拒答） | 0.385 | **0.769** | 0.327 | 参照 |

（上一版的这张表还停在 M1 时代：`new` 臂 recall@5 = 1、`correct_refusal_rate` = 0.125、
`injected_tokens_mean` = 450.4。**那一版是错的**，它写的是 40 题口径下 M1 的第一次测量结果，
之后 M2 的切词修正把 `correct_refusal_rate` 抬到 0.750、M3 又把拒答题从 8 加到 20。
数字对不上时以 `node bench/run-eval.mjs --same-corpus --json` 的当次输出为准。）

默认口径（legacy 读旧私人库）里 legacy 的 recall@5 很低 —— 那不是旧插件差，
是**库不同**（它的库里根本没有这道虚构题集的答案）。要对比检索质量就用 `--same-corpus`。

**结论：判据 1 成立。** `recall@5 = 0.844` 与 `correct_refusal_rate = 0.800` 都过线，
且拒答这一项现在有 **1/20 = 0.05 的余量**（M2 时是 0.750 压线，少对一题就不达标）。
`token_efficiency = 2.037` 只比门槛 2.0 高 1.8% —— **这一条是当前最薄的地方**，
它的分母是注入 token，而注入量随题集里长题的比例变（M2 时 32 题 310.0，
现在 52 题 254.9，变的不是系统而是题目组合）。

`new` 臂仍然答错（该拒没拒）的 4 题：`r03` / `r07` / `r11` / `r12`，全是假命中
（跨词碎片或话题相关笔记把 coverage 顶到 0.6 以上）。它们**故意留在题集里当负例**。

## 6.1 判据 3 怎么跑（M3 新增，与判据 1 无关的一套装置）

`node bench/replay.mjs`（`--json` 出机器可读；`--seed N` 固定随机种子；`--traps` 打开对抗档）。
它用**合成时钟**模拟 4 周使用，语料是**另造**的 12 个虚构服务（不与 `core-30-v1` 重叠）。
输出 `staleness_rate` 与 `negative_transfer` 两个量与判定；同种子两次结果逐字一致。

读的时候记住三件事：① 它是**装置**不是真实库的预测（见 `06-architecture.md §6.1` 的口径偏离）；
② 报告里的消融臂（把旧值改回「看起来还有效」）是**灵敏度对照** —— 35/35 全部把旧值排到第一，
证明全 0 不是测不出来；③ `negative_transfer` 目前是**窄口径**（没有旧值被当成答案），
三档对照（closed_book / oracle_gold / real）要等模型回答器，见 `06-architecture.md §6.1` 的记账。

## 6.2 常量扫描怎么跑（M3 新增）

`node bench/sweep.mjs`（`--docs 50,200,500` 收窄档位；`--json` 出机器可读；约 20 秒跑全五档）。
它扫 `MIN_COVERAGE` 与 `INFORMATIVE_DF_RATIO` / `INFORMATIVE_MIN_DOCS` 在 **50–2000 篇**合成语料上的
「可答题 recall@5 / 不可答题拒答率」曲线。**它不判任何判据**（不设通过/不通过），
只输出曲线与一个「在召回 ≥ 0.95 约束下有没有可行解」的建议。
当前结论见 `06-architecture.md §5.5`：证据性闸门在刚过 200 篇的语料上是坏的，建议把启用阈值抬到 1000 篇、df 比收到 0.02 —— M3 **没有动生产常量**。


## 7. 已知局限（读数字时要扣掉的部分）

- **`hit_but_unused_rate` 结构性为 0**：回答器是 `echo`（回显全部上下文），进了上下文的必然进答案。
  要看漏用信号必须 `--answerer first-hit`。当前表里的 0 不代表「模型都会用」。
- **量的是检索，不是模型**：这套跑分回答器是非模型。判据 1 只要求集合运算，所以成立；
  但「模型会不会用」不在这里测。
- **防泄漏是两道网，不是证明**：题面与 gold 笔记的 8-gram 重叠按**正文（不含 H1 标题）**算 ≤ 30%，
  含标题的宽松口径有 75% 兜底。题集纪律用例会把这两条都跑一遍。
- **legacy 臂是复刻不是原样**：旧插件本体是 dsh 里的 recall 钩子，这里复用的是它的
  `store.js` + `bm25.js`（同一个 BM25、同一个库），没跑它的 prompt 拼装。旧仓库只读。
- **`--json` 的输出契约**：stdout 必须是**一条完整 JSON**（进程末尾设 `exitCode` 而不是 `process.exit()`，
  否则管道会被截断）。`test/eval-scorer.test.mjs` 里有一条专门守这个。

## 8. CI 怎么接

```bash
# 每次 push：判据 1 的子集（单跳 6 + 拒答 4）+ 判分器单测，秒级
node --test
node bench/run-eval.mjs --dry

# nightly：全量三臂 + 成本曲线，留档
node bench/run-eval.mjs --same-corpus --out bench/core-30-v1/runs/$(date +%F).md
```

结论可追溯需要三样一起记：题集版本（`core-30-v1`）、被测代码的 git hash、判据阈值所在文档的版本。
本仓库还没有第一个 commit，所以现在只能追到「题集版本 + 本文档」，接 CI 后补 hash。
