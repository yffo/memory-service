# 08 · 评测跑手册（core-30-v1 / 判据 1·2·3）

这份文档回答四件事：**怎么跑**、**那张表怎么读**、**判据 1 算不算成立**、**判据 2/3 的回答层怎么测**。
判据本身的口径在 `docs/02-evaluation.md §5`，本文只负责把它落到可执行的命令与可核对的数字。

- 题集：`bench/core-30-v1/tasks.json`（52 题：四类能力题 32 条 —— 事实召回 9 / 偏好 8 / 纠错 8 / 流程 7 —— 加拒答集 20 条。
  拒答题靠 `source: []` 判定（不是靠 `kind`），它不新增能力维度，但必须单独存在才可能算 `correct_refusal_rate`；
  每条的 `forbid` 都是「最诱人的编造值」，且那个值能在**别的**笔记里找到，不是凭空编的）
- 语料库：`bench/core-30-v1/library/*.md`（50 篇，全虚构）
- 判分器：`bench/scorer.mjs`（纯函数，零依赖、零模型调用）
- 跑分器：`bench/run-eval.mjs`（三臂，取上下文一律**子进程调 CLI**，不 import 被测代码内部模块）

## 0. 一分钟版

```bash
node --test                                        # 判分器 + 题集纪律 + MCP 一致性（条数见当次输出，全绿无 skip）
node bench/run-eval.mjs --same-corpus              # 判据 1 的主口径（三臂同语料，Markdown 表）
node bench/run-eval.mjs --json | jq .judgement      # 机器可读；提示信息走 stderr，stdout 是纯 JSON
node bench/run-eval.mjs --dry                       # 不调 CLI：只验证评分路径没坏
```

**默认零模型成本**：回答器是 `echo`（非模型，只回显注入上下文），量的是「检索有没有把正确笔记拿进上下文」。
整轮 52 题 × 3 臂约 9 秒，远在 `docs/00-brief.md §5` 判据 B 的 15 分钟预算之内。

判据 2/3 的回答层**要显式打开模型回答器**（默认不开，CI 永远不调网络）：

```bash
EVAL_LLM_API_KEY=... node bench/run-eval.mjs --arms none,new,oracle \
  --answerer llm --runs 3 --concurrency 4 --out bench/core-30-v1/runs/$(date +%F)-answer.md
```

一次 52 题 × 3 臂 × 3 轮 ≈ 468 次调用，deepseek-flash 约 **$0.02 / 2 分钟**。

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
| `none` | 空上下文（closed_book） | 退化基线。它答对任何一题都说明题集泄题了 |
| `new` | `node bin/memory search --query "<q>" --json` | 被测系统（real）。库是语料库的临时副本 |
| `legacy` | 子进程 import 旧仓库的 `store.js` + `bm25.js`（**只读**） | 旧插件基线。默认读 `~/memory/engramory` |
| `oracle` | 题集 `source` 声明的 gold 笔记正文直接读进上下文 | oracle_gold 上限。只配 `--answerer llm`，否则回显 gold 会得出假准确率 |

`--same-corpus` 让 legacy 臂也读同一份虚构语料（临时 flat 库）。**判据 1 的主口径用同语料**：
不同库的 recall 不可比（旧库是 74 篇私人笔记，本来就不该命中虚构题集）。
回答器另有一层 `echo` / `first-hit` / `llm` 三档，与检索臂正交：判据 1 只用检索臂（零模型），
判据 2/3 的三档准确率必须 `--answerer llm`。

## 3. 选项

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `--tasks <file>` | `bench/core-30-v1/tasks.json` | 换题集（同格式即可） |
| `--library <dir>` | `bench/core-30-v1/library` | 换语料 |
| `--cli <path>` / `--cli-args <str>` | `bin/memory` / 空 | 换被测 CLI、追加参数（CLI 改口径时对齐用） |
| `--store <dir>` / `--store-mode <mode>` | 临时副本 / `auto` | 库怎么告诉 CLI：`auto`＝同时给 `--store` 与 `MEMORY_STORE`；也可 `flag`/`env`/`plain` |
| `--same-corpus` | 关 | legacy 臂读同一份虚构语料（同语料对照） |
| `--legacy-repo` / `--legacy-store` | 旧仓库 / `~/memory/engramory` | 旧臂来源；旧仓库**只读**，别写 |
| `--answerer <mode>` | `echo` | `echo`＝回显全部注入上下文；`first-hit`＝只回显 rank-1；`llm`＝真调模型（判据 2/3 要这个） |
| `--runs <n>` | 1 | 每臂重复几轮；模型回答器建议 ≥3，报告给逐轮稳定性与均值 |
| `--concurrency <n>` | 1 | 模型调用的并发数；4 时 468 次约 2 分钟 |
| `--k <n>` | 5 | recall@k |
| `--arms <list>` | `none,new,legacy` | 只跑其中几臂；回答层三档用 `none,new,oracle` |
| `--json` / `--out <file>` | — | stdout 纯 JSON / 额外写一份 Markdown |
| `--keep-scratch` | 关 | 保留临时库，排查用 |
| `--dry` | 关 | 不调 CLI，只跑 none 臂 + 评分路径 |

环境变量（只在 `--answerer llm` 时读，默认值适合 deepseek-flash）：`EVAL_LLM_API_KEY`（缺省回落到 `DEEPSEEK_API_KEY`）、`EVAL_LLM_BASE_URL`（默认 `https://api.deepseek.com`）、`EVAL_LLM_MODEL`（默认 `deepseek-flash`）、`EVAL_LLM_TIMEOUT_MS`（30000）、`EVAL_LLM_MAX_TOKENS`（256）、`EVAL_LLM_TEMPERATURE`（0）。没有 key 时明确报错退出 2，不会静默退回 echo。

隐私：库路径落在仓库之外时，报告与 JSON 里的笔记 id 一律打码成 `note#N`；
打码之前先判分（`hits_display` 才是给人看的那份），所以打码不会影响数字。

## 4. 表怎么读

### 4.1 指标（口径写死在 `bench/scorer.mjs`，别处不要另立）

| 指标 | 定义 | 阈值 |
| --- | --- | --- |
| `recall@5` | 有来源的题上，gold 笔记是否**全部**进 top-5（多金标题要全中）的平均。拒答题不进分母 | **≥ 0.80** |
| `correct_refusal_rate` | **只在拒答题上算**：干净拒答（说了「没有记录」且没把编造值端出来）的比例 | **≥ 0.75** |
| `refusal_calibration` | 文档口径（该答的答 + 该拒的拒，分母=全部题）的参照值 | 参照 |
| `match_rate` / `answer_accuracy` | 答案逐字命中期望串的比例；拒答题干净拒答也算 match。回答器是 `llm` 时它就是**答对率** | 参照 |
| `expect_hit_rate` | 期望串出现在**注入上下文**里的比例（信息有没有进上下文） | 参照 |
| `injected_tokens` / `_mean` | 每题注入的 token；CLI 报了 `tokens` 就用它的，没报才按 CJK≈0.6 token/字估 | 均值 **≤ 500** |
| `token_efficiency` | **检索层代理**：期望串命中题数 ÷（注入 token/1000），与 02 §4.5 的 `Δaccuracy` 口径不同，别拿它宣判判据 2 | 越大越好 |
| `answer_token_efficiency` | **02 §4.5 的判据 2 口径**：`(acc(new) − acc(none)) ÷ (new.injected_tokens_mean/1000)` | **≥ 2.0** |
| `hit_but_unused_rate` | gold 进了上下文却**没进答案**的比例（分母=进了上下文的题） | 越小越好 |
| `answered_rate` | 没拒答的比例（拒答可能是好事也可能是坏事，配合上面两行看） | 参照 |
| 调用失败数 / 缺题数 | CLI 非零退出、输出不是 JSON、某题没记录 | 必须 0 |

判分默认用确定性的字符串/集合规则；拒答用 `looksRefused`（空答案 / `refused` 标志 / 固定措辞正则），两者都不调 LLM。**「拒绝」绝不用 LLM 裁判判**。

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

### 5.1 判据 2/3（回答层，必须显式开模型）

三条缺一不可：`--answerer llm`、`--arms none,new,oracle`、无 blocker。缺臂（`--dry`、只跑 `none`、oracle 没配 llm）→ **算不出来**，不是「不成立」。

1. `answer_token_efficiency = (acc(new) − acc(none)) ÷ (new.injected_tokens_mean/1000) ≥ 2.0` —— 判据 2 的准确率/成本口径。
2. `injected_tokens_mean ≤ 545` —— 判据 2 的旧账本预算上限（判据 1 更严，是 500）。
3. `negative_transfer = acc(none) − acc(new) ≤ 0.02` —— 判据 3 的**窄口径**（记忆净收益/净伤害）；正值=记忆让回答变差。完整判据 3 还要求陷阱题 `trap_fall_rate ≤ 25%`，当前题集没有 `negative_transfer_probe`，所以这一项只能写「窄口径达标」。

判据 1 用零模型默认口径单独判；回答层成立不自动等于判据 1 成立，反之亦然。报告里两段结论分开印。

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
`token_efficiency = 2.037` 是**检索层代理**（期望串命中数 ÷ 注入千 token），不是 `02-evaluation.md §4.5` 判据 2 的 `Δaccuracy ÷ 注入千 token`。
用真模型回答器按判据 2 口径实测是 **1.408 < 2.0，判据 2 不成立**（§6.3）。判据 1 的结论不受影响，但
此前把 2.037 当成判据 2 达标是**口径混用**，这次一并改掉。检索层值得看的仍然是「注入量随题集变化」这一点：
M2 的 32 题是 310.0，M3 的 52 题是 254.9，变的不是系统而是题目组合。

`new` 臂仍然答错（该拒没拒）的 4 题：`r03` / `r07` / `r11` / `r12`，全是假命中
（跨词碎片或话题相关笔记把 coverage 顶到 0.6 以上）。它们**故意留在题集里当负例**。

## 6.1 判据 3 怎么跑（M3 新增，与判据 1 无关的一套装置）

`node bench/replay.mjs`（`--json` 出机器可读；`--seed N` 固定随机种子；`--traps` 打开对抗档）。
它用**合成时钟**模拟 4 周使用，语料是**另造**的 12 个虚构服务（不与 `core-30-v1` 重叠）。
输出 `staleness_rate` 与 `negative_transfer` 两个量与判定；同种子两次结果逐字一致。

读的时候记住三件事：① 它是**装置**不是真实库的预测（见 `06-architecture.md §6.1` 的口径偏离）；
② 报告里的消融臂（把旧值改回「看起来还有效」）是**灵敏度对照** —— 35/35 全部把旧值排到第一，
证明全 0 不是测不出来；③ 这里的 `negative_transfer` 仍是**窄口径**（没有旧值被当成答案）。
三档准确率口径（closed_book / oracle_gold / real）已经在 `core-30-v1` 上跑通，见 §6.3；
时间回放 168 次召回的窄口径与三档口径仍是两套装置，别把 §6.3 的数搬到回放表上。

## 6.2 常量扫描怎么跑（M3 新增）

`node bench/sweep.mjs`（`--docs 50,200,500` 收窄档位；`--json` 出机器可读；约 20 秒跑全五档）。
它扫 `MIN_COVERAGE` 与 `INFORMATIVE_DF_RATIO` / `INFORMATIVE_MIN_DOCS` 在 **50–2000 篇**合成语料上的
「可答题 recall@5 / 不可答题拒答率」曲线。**它不判任何判据**（不设通过/不通过），
只输出曲线与一个「在召回 ≥ 0.95 约束下有没有可行解」的建议。
当前结论见 `06-architecture.md §5.5`：证据性闸门在刚过 200 篇的语料上是坏的，建议把启用阈值抬到 1000 篇、df 比收到 0.02 —— M3 **没有动生产常量**。

## 6.3 回答层三档怎么跑（M4 新增；判据 2 主口径 + 判据 3 窄口径）

判据 2 的 `token_efficiency` 与判据 3 的 `negative_transfer` 定义里都有 `accuracy`，所以回答层必须显式开模型；默认零模型口径只能报检索层代理值。
三档就是 `02-evaluation.md §4.5` 的 `closed_book` / `oracle_gold` / `real`，对应本装置的 `none` / `oracle` / `new`：

- `none`：空上下文（closed_book）。
- `new`：CLI 检索出的 top-5 注入（real）。
- `oracle`：题集 `source` 声明的 gold 笔记正文直接读进来（oracle_gold，检索上限，`source` 是旧 schema `gold_notes` 的现名）；**只允许配 `--answerer llm`**，
  否则回显 gold 正文会得出假准确率。

```bash
EVAL_LLM_API_KEY=... node bench/run-eval.mjs --arms none,new,oracle \
  --answerer llm --runs 3 --concurrency 4 \
  --out bench/core-30-v1/runs/2026-10-17-answer.md
```

2026-10-17 实测（`core-30-v1` 52 题 / deepseek-flash / 温度 0 / max_tokens 256 / 3 轮并发 4）：

| 臂 | acc（逐字判分） | 单题注入 token | API 调用 | 输入/输出 token | 成本 USD | 平均延迟 ms |
| --- | --- | --- | --- | --- | --- | --- |
| `none` | 0.385（20/52） | 0 | 156 | 22,833 / 2,086 | 0.0047 | 687 |
| `new` | 0.744（逐轮 0.750 / 0.750 / 0.731） | 254.9 | 96 | 39,999 / 2,836 | 0.0077 | 847 |
| `oracle` | 0.846（44/52，三轮一致） | 39.9 | 156 | 28,953 / 3,291 | 0.0063 | 772 |

由此算出的判据 2/3 回答层：

- `negative_transfer = acc(none) − acc(new) = 0.385 − 0.744 = −0.359`，**窄口径达标**（阈值 ≤ 0.02，正值=记忆有害）。
  记忆不但没害人，还把答对率抬了 35.9 个百分点。**但这只是窄口径**：它测的是「加记忆的净收益」，不是「被错记忆带偏的损失」；
  完整判据 3 的 `trap_fall_rate` 需要陷阱题，当前题集没有，不能写「判据 3 成立」。
- `answer_token_efficiency = (0.744 − 0.385) ÷ (254.9/1000) = 1.408`，**不达标**（阈值 ≥ 2.0），
  即每 1K 注入 token 只换回 1.4 个百分点准确率，离 2.0 还差 30%。**判据 2 不成立。**
- `oracle_gap = 0.846 − 0.744 = 0.103`，参照值；差额一半以上不是检索的锅，见下。
- 成本：三臂各 3 轮共 468 次调用，**$0.0187 / 约 2 分钟**（deepseek-flash 2026-10 非高峰价）。

**这个 0.744 / 1.408 是下界，原因在判分器而不在回答器**：判分用 `expect` 逐字子串（`bench/scorer.mjs`），
模型答「400 行」而 `expect` 是「不超过 400 行」、答「5 次」而 `expect` 是「重试 5 次」都算错。
oracle 的 8 道错题里 7 道是这类同义改写（p01/p02/p05/p07/p08/c01/k04），语义都对；
第 8 道 k06 是**题集 bug**——题面问「用哪个包管理器」、`expect` 却是「pnpm-lock.yaml」，gold 笔记正文两者都有。
`new` 的 14 道错题 = oracle 的 8 道 + 5 道检索没给够（p03/c03/c04/c07/k05，均被模型按无记录拒答）+ 1 道 p06（三轮里只有一轮答出完整 `expect`，另两轮答「2 次」被多数轮压成 false）。
所以当前严格判分下，`oracle_gap` 高估了检索损失、`answer_token_efficiency` 低估了真实效率；**但在修判分口径之前，
按 deny-by-default 只能记「判据 2 不成立」**，不能把「补上同义答案后可能过线」当成结论。
下一刀应当是 `answer_aliases` / 判分器对抗集（`02-evaluation.md §6.2` 本来就要求先评测判分器），而不是改题面迁就模型。

逐轮稳定性：`new` 三轮 0.750 / 0.750 / 0.731，单题一致率 0.962；`oracle` 三轮完全一致；`none` 三轮一致。
温度 0 下波动来自推理链与上下文长度，重跑 3 轮取均值是这条口径的最低要求（单轮会差 1~2 题）。
注意：deepseek-flash 的 thinking 默认开启，thinking 模式下温度参数不生效，所以「温度 0」不等于确定性；波动主要来自推理链长度。


## 7. 已知局限（读数字时要扣掉的部分）

- **`hit_but_unused_rate` 在默认口径下结构性为 0**：`echo` 回答器回显全部上下文，进了上下文的必然进答案。
  要测漏用必须 `--answerer llm`（本次 `new` 0.309、`oracle` 0.25）或 `first-hit`。默认表的 0 不代表「模型都会用」。
- **判分器还是逐字子串，不是语义判分**：`--answerer llm` 的准确率是**下界**，同义改写会被判错（§6.3 的 7/8 例）。
  这也意味着 `oracle_gap` 与 `answer_token_efficiency` 当前不是纯净的检索/成本信号。`02-evaluation.md §6.2` 要求判分器
  先用对抗答案评测、再做 20% 人工抽检（Cohen's κ），这一刀**还没有做**；在那之前，回答层数字只能当方向。
- **判据 1 与回答层是两套口径**：判据 1 只要求集合运算，默认 `echo` 零模型成本；判据 2/3 的回答层要显式开模型，
  不进 CI（见 §8）。两者的 `new` 臂召回相同，但 `correct_refusal_rate` 会不同：`echo` 是 0.800，模型回答器是 1.000
  （模型对 20 道拒答题全拒），不要拿一张表的这一格去对另一张表。
- **防泄漏是两道网，不是证明**：题面与 gold 笔记的 8-gram 重叠按**正文（不含 H1 标题）**算 ≤ 30%，
  含标题的宽松口径有 75% 兜底。题集纪律用例会把这两条都跑一遍。
- **legacy 臂是复刻不是原样**：旧插件本体是 dsh 里的 recall 钩子，这里复用的是它的
  `store.js` + `bm25.js`（同一个 BM25、同一个库），没跑它的 prompt 拼装。旧仓库只读。
- **模型成本与价格表**：`bench/llm-answerer.mjs` 内置 deepseek-flash 的 2026-10 价格（$0.15/1M 输入、$0.60/1M 输出），
  换模型或调价要同步改；报告里的成本是 API 返回 usage 算出来的，不含网络失败重试的隐藏开销。
- **`--json` 的输出契约**：stdout 必须是**一条完整 JSON**（进程末尾设 `exitCode` 而不是 `process.exit()`，
  否则管道会被截断）。`test/eval-scorer.test.mjs` 里有一条专门守这个。

## 8. CI 怎么接

```bash
# 每次 push：判据 1 的子集（单跳 6 + 拒答 4）+ 判分器单测，秒级、零模型成本
node --test
node bench/run-eval.mjs --dry

# nightly：全量三臂（echo）+ 成本曲线，留档，零模型成本
node bench/run-eval.mjs --same-corpus --out bench/core-30-v1/runs/$(date +%F).md
```

**回答层（`--answerer llm`）不进 CI**：它要 API key、要花钱、依赖外部模型版本，只手动跑、结果留档。
判据 2/3 的结论可以引用手动跑的报告，但 CI 红绿只对判据 1 与判分器单测负责。

结论可追溯需要三样一起记：题集版本（`core-30-v1`）、被测代码的 git hash、判据阈值所在文档的版本。
手动跑回答层时把 `git rev-parse --short HEAD` 与模型名写进报告备注（报告已经带模型名、轮次、温度、max_tokens）。
