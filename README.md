# tabellio

> 罗马的**契约代书人**：公开立契，且必须留存副本以备日后核验。
>
> 一个通用记忆服务，让 agent 记住该记的事 —— 并且答得出「这条记忆谁写的、依据什么」。

`tabellio` 给 agent 用的**长期记忆**：本地优先、纯文本落盘、成本可控、可审计、可带走。
一次落盘，任何 CLI / IDE / 自研 agent 通过 **MCP** 共用同一份记忆。

```bash
npm i -g tabellio
tabellio setup --write --verify          # 写 MCP 配置，再用宿主自己的命令验证（默认 dry-run）
tabellio hook install --host claude      # 可选：装 Claude Code 会话结束钩子（默认 dry-run）
tabellio hook install --host claude --write
tabellio hook install --host claude --session-start --write  # 再加「待批准候选」提示
tabellio schedule install --write         # 可选：macOS launchd 每 6 小时自动发现近似重复（只产提案）
tabellio schedule status                  # 看定时任务在不在、launchd 里有没有加载
tabellio status                          # 建库 + 看一眼
tabellio recall --query "编辑器偏好"      # 按预算取回记忆
printf '%s\n' '# 发布流程' '' '发版前跑 npm test 和 node bench/run-eval.mjs。' \
  | tabellio capture --file -             # 先收成候选，不静默入库
tabellio inbox --accept <候选 id>         # 人看过、批准后才进主库
tabellio consolidate --auto --write          # 自动发现近似重复，只写待批准提案（不改笔记）
tabellio inbox --accept <提案 id>             # 批准后才合并；可 --undo 撤销
tabellio-mcp                             # 给宿主用的 MCP stdio 服务器
```

零运行时依赖，Node ≥ 20.11，不需要 `npm install`。

`tabellio-mcp` 默认只读，工具面是 `recall` / `search` / `read` / `list` / `status`；`recall` 一次返回预算内的记忆正文，`search` 只给指针。加 `--allow-write` 才挂两个写工具：`remember` 直接写正式记忆，`capture` 只写候选、由人在 CLI 批准。

`setup` 只认 Claude Code / Cursor / Codex 三家，写前备份、默认只预览，已有的不同配置要显式 `--force`；
`--verify` 会调用宿主自己的 CLI：Claude Code 报 `Connected` 才算连上；Codex 只接受配置、不做连接检查；
Cursor 没有无头检查，需要 GUI 确认。找不到宿主 CLI 不会误报成配置失败。
DSH 的 YAML loader patch 还不敢让程序改。`capture` / `inbox` 是「自动记忆」的诚实版本：
默认**不会从对话里自动抽取**；只有你显式装 Claude Code 的 SessionEnd 钩子
（`tabellio hook install --host claude --write`），会话结束时才会从**用户发言**里抓显式线索
（「以后都用…」「记住…」「我偏好…」），生成候选，**不写主库**。候选仍要在 `inbox` 里由人批准，
批准时才走与 `remember` 同一条写入闸门。加 `--session-start` 后，下次会话开始会提示待批准候选数与自动巩固提案数
（只读，不写库）。钩子只支持 Claude Code、默认不装、不联网、最多 3 条/会话；
它可能漏、也可能误，也不常驻后台、不会自动改笔记。macOS 上可以再装一个可选的 launchd 定时任务
（`tabellio schedule install --write`），每 6 小时跑一次自动发现；它同样只产提案，执行仍要人批准。

## 它到底是什么

一条事实一个 `.md` 文件，frontmatter 记着 `kind` / `trust` / `tags` / 来源与有效期；
`index/` 全是生成物，删掉能重建。当前（M1 + M2：读取回执 / 巩固 / 撤销 / 自动发现提案 / 可选定时发现）没有数据库、没有常驻后台进程、没有网络调用；可选的 macOS launchd 定时任务只是到点跑一次扫描、只产提案；常驻核心与自动执行仍在路线图里（`docs/06` §2/§8）。

- **默认 pull，push 例外**：agent 要什么就问什么；always-on 的只有极小核心档。
- **文件是唯一真相源**：任何时刻可 `cat`、可 git、可带走；索引可以丢，事实不能丢。
- **写入过闸门**：去重、长度、信任分级、破坏性改写，全部 fail-closed；拒绝是正常结果。
- **预算感知**：调用方给 token 预算，服务端裁剪并说明裁掉了什么。
- **可解释（M1 + M2：回执 / 巩固 / 撤销）**：`recall` 返回分数拆解、来源与 `budget.dropped`；加 `--receipt` / `--save-receipt` 会把这次判断落成可核验回执（不含正文，只记 `noteSha256`），`explain` 逐条解释纳入 / 未纳入 / 预算丢弃，`verify` 核对回执是否被改、库是否漂移。`consolidate` 默认只出计划，`--apply` 才写元数据并留巩固回执，`--undo` 可整单撤销；当前支持 `invalidate`（按 `supersedes` 失效）与显式 `archive`（只改 `status`，不写有效期），两者都只动元数据。`--merge` / `--summarize` / `--promote` 默认只出内容类提案；加 `--apply` 会写目标，merge/summarize 还会把源写成 `valid_to` + `superseded_by`（正文不动），promote 只写候选、不关源；内容类 run 有独立回执与 `--undo`。自动发现（`consolidate --auto`、Claude 钩子或 macOS launchd 定时任务）只产待批准提案，不直接改笔记；写入回执、自动执行与常驻后台巩固仍未做。

用法、命令清单、`--json` 的冻结形状、库布局：[docs/07-usage.md](docs/07-usage.md)。

## 为什么要新起一个项目

前作 [`dsh-engramory-recall`](../dsh-engramory-recall)（Engramory 格式 DSH 插件）工程上完成度不低（839 测试、已发布、有面板与 MCP 只读视图），但它回答的是一个错的问题：把「每轮往上下文里塞几条指针」当成记忆的主要形态。它自己的账本给出了证据：

| 指标 | 实测 |
|---|---|
| 注入 | 131 轮、655 条指针 |
| 基础打开率（代理指标） | **2.4%** |
| 携带 ≥8 次、一次没被翻开 | **23 条** |
| 能不能证明「让回答变好」 | **不能**（指标只到「后来被打开」） |

结论：push 式注入的信息密度太低，而且没有评测就没有方向。tabellio 当前已落地的不同：**默认 pull**、**评测先行**、**索引分层**、**可核验回执**；巩固已开工（显式 `consolidate`：invalidate + archive + 回执 + 撤销；merge / summarize / promote 默认提案、`--apply` 执行且有内容类回执与撤销；`--auto` 自动发现近似重复、只产待批准提案；可选 macOS launchd 定时任务只是定期触发这条发现），**自动执行/自动巩固**仍是 M2 计划。

**但这不是替代关系**（2026-10-16 的项目决定：旧插件不许冻结 —— 「一个不变的项目没有任何意义」）：旧插件继续迭代，新能力优先在它身上验证；通用化与跨宿主的部分进本项目。两条线共享一个 `memory-core` 内核。

## 文档导航

| 文件 | 内容 | 状态 |
|---|---|---|
| [docs/00-brief.md](docs/00-brief.md) | 立项书：目标、非目标、判据、里程碑、风险 | 已定稿 |
| [docs/01-landscape-systems.md](docs/01-landscape-systems.md) | 竞品架构调研（mem0 / Letta / Zep / Cognee / …） | 已完成 |
| [docs/02-evaluation.md](docs/02-evaluation.md) | 评测方法与自建评测集方案 | 已完成 |
| [docs/03-hosts-and-interfaces.md](docs/03-hosts-and-interfaces.md) | 宿主支持、MCP 现状、分发渠道、进程模型 | 已完成 |
| [docs/04-cost-model.md](docs/04-cost-model.md) | 模型选型与月成本模型（三档方案） | 已完成 |
| [docs/05-agi-direction.md](docs/05-agi-direction.md) | 记忆在 AGI 方向的前沿与可下注之处 | 已完成 |
| [docs/06-architecture.md](docs/06-architecture.md) | 架构设计（分层、闸门、账本、检索） | 草案（M1 + M2 读取回执/巩固已实现） |
| [docs/07-usage.md](docs/07-usage.md) | 用法：十五个命令、MCP、候选闭环、自动巩固提案、会话钩子、定时任务、回执、巩固、库布局、退出码 | 已定稿 |
| [docs/08-eval-runbook.md](docs/08-eval-runbook.md) | 评测跑法与判据 | 已完成 |
| [docs/09-naming.md](docs/09-naming.md) | 命名调研（为什么叫 tabellio） | 已完成 |

> 状态口径（2026-10-18）：**M1**（CLI + MCP + 检索闸门 + 导入 + 判据 1 评测）已完成；**M2** 已开工（读取回执 / `explain` / `verify` / 显式巩固 `consolidate`（invalidate / archive）/ `undo` 已实现；合并、摘要、提升的**提案层与执行层**（`--apply` + 内容类回执 + `undo`）已实现；`setup` + `capture` / `inbox` 上手闭环已实现；Claude Code SessionEnd 钩子已实现、默认不装、只生成候选；`--session-start` 可在会话开始提示待批准候选（只读）；自动发现（`consolidate --auto` / 钩子）只产合并提案、仍要 `inbox` 批准；macOS launchd 定时任务（`schedule`）只是定期触发发现、默认不装、只产提案；自动执行、自动衰减、写入回执与常驻后台巩固未做）；**M3** 分发侧完成（npm 包 + MCP registry），Claude Code 已实测 `connected`、Codex 只到 `configured`、Cursor 仍 `unverified`，三宿主录屏/日志未齐。调研文档截至 2026-10；2026 H2 的模型原生记忆与托管服务尚未纳入。

## 纪律（一开始就定下来，免得重蹈覆辙）

1. **判据先行**：三条必须满足的判据没定稿、没跑出基线之前，不写产品代码。
2. **评测是产品的一部分**：每个里程碑都必须能跑一次端到端评测，并留下结果；没有数字的功能等于没做。
3. **旧插件是同伴不是遗产**：两条线并行、共享 `memory-core`；它的库（72 篇）与账本（`.engramory-recall.jsonl`）直接当迁移样本与评测输入。新系统要在评测上赢过它 —— 赢的是长板，不是把它判死。
4. **数据可带走**：纯文本（或可导出为纯文本）永远是真相源。
5. **成本是约束不是事后优化**：默认档必须便宜到「不心疼」，贵的档必须可关。

## License

MIT © [Yang Fu](https://github.com/yffo)
