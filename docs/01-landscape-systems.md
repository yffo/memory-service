# 01 · AI 记忆系统：架构与工程取舍调研

> 调研日期 2026-10-17。所有 star 数 / 许可 / 版本取自当日 GitHub REST API 与官方文档实测。
> **事实** = 我在源码、LICENSE、官方文档或论文里亲眼看到的；**厂商宣称** = 官方页面/README 自己说的、我无法独立复现的。

---

## 结论先行

1. **全行业的事实标准是 pull**：mem0 的 `search()`、Letta 的工具调用、Claude memory tool、MCP memory、Basic Memory、dsh-mneme 全是「模型/应用主动调一次检索」。**没有一家严肃实现把记忆库无条件 push 进每一轮上下文**——这正是旧 engramory-recall 的路子（131 轮注入 655 条指针、打开率 2.4%），它是行业里的少数派，且已被自己的数据证伪。
2. **always-on 的只有「极小核心」**：Claude Code 的 auto memory 硬限制在**首 200 行 / 25KB**，超出不注入；`CLAUDE.md` 官方建议 **<200 行**，理由是「更长的文件消耗更多上下文且降低遵循度」。**200 行这个数是有出处的，不是我们拍的**——该抄。
3. **真相源几乎都选错了**：绝大多数系统把真相源放在向量库 / 图库 / 托管 DB 里（mem0 默认向量库、Zep 用 Neo4j/FalkorDB、Basic Memory 用 SQLite 索引）。**只有 Claude 的 memory tool 明确把真相源放在客户端的纯文件目录里**，让宿主自己实现 view/create/str_replace——这是最彻底的「文件即真相源」设计，也是我们该抄的形状。
4. **写入管线正在从「智能」退回「便宜」**：mem0 在 2026-04 把算法换成了**单次 LLM 调用、只 ADD、不 UPDATE/DELETE**（见下），这说明两阶段的「提取+冲突决策」在生产上性价比不够。**该避开**：把冲突解决放在热路径上。
5. **该避开的最大坑是「自己当裁判的评测」**：所有厂商的榜首数字都是自测。arXiv 2605.24060 已证明——**只换「给哪个存储形态记分」这一个设计选择，就能在 83.4–94.0% 的共享 query 上改变 nDCG，并让 Mem0 与 MemoryOS 的名次翻转**。任何「我们比 X 强 20 个点」都要先问：谁跑的？和谁比？给谁记分？
6. **基准本身有天花板**：LoCoMo 官方只有 **10 段对话 / 1,982 个 gold span**，且全部 10 段在开发期就可见（arXiv 2610.09348 原文指出），"every LoCoMo number measures stability across conversations rather than generalization"。拿它当唯一验收指标会自欺。
7. **零模型是可选项而非缺陷**：Cognee 明确支持无 LLM key 运行（本地 GLiNER 抽取 + 本地 embedding），dsh-mneme 默认离线本地语义检索。**记忆服务不该强制依赖模型**——这条比任何基准分都重要。

---

## 对比表

| 系统 | 数据模型 / 真相源 | 写入管线（谁决定记什么） | 召回策略 | 模型依赖 | 可迁移性 | 许可 | 评测（谁跑的） |
|---|---|---|---|---|---|---|---|
| **mem0** | 记忆条目（fact）+ 向量库；User/Session/Agent 三级；v3 加实体链接 | 应用调 `add()`；**2026-04 起单次 LLM 调用、只 ADD**，不再 UPDATE/DELETE | pull（`search()`）；语义+BM25+实体三路融合打分 | 写入必调 LLM；检索可纯向量 | 弱：默认向量库+云平台，导出需自己写 | Apache-2.0 | 自测：LoCoMo 92.5 / LongMemEval 94.4 / BEAM(1M) 64.1，7.0K tokens、p50 0.88s |
| **Letta / MemGPT** | memory blocks（core memory，可直接编辑）+ archival / recall；**stateful agent 是主体** | 模型自己调用记忆编辑工具；可选 sleep-time compute 后台预计算 | 混合：块常驻 + 工具检索归档；记忆管理是 agent 的一等能力 | 强依赖（记忆操作即工具调用） | 中：Postgres/SQLite 后端，有导出；v1 API 已 retired | Apache-2.0 | 自测（论文）：sleep-time compute 省 ~5× 测试期算力、准确率 +13~18%、多 query 摊销后每 query 成本 2.5× ↓ |
| **Zep / Graphiti** | **双时态时序知识图谱**：episodes（原始流，ground truth）→ entities / facts(edges 带 validity window) / communities；边被 invalidate 而非删除 | episode 入库后自动抽取实体与事实；矛盾时**自动失效旧边并保留历史** | pull + 混合（语义+BM25+图遍历）；Zep 云是自研 Context Graph Engine | 摄取必调 LLM（抽取）+ embedding | 中：OSS 版跑在 Neo4j / FalkorDB / Neptune 上，图可导出但 schema 复杂 | Apache-2.0（Graphiti）；Zep 云闭源 | 自测：DMR 94.8% vs MemGPT 93.4%；LongMemEval 相对 baseline 最高 +18.5%、延迟 −90% |
| **Cognee** | 自托管知识图谱 + 向量 + 关系库三件套；文本→实体/关系/chunk，代码→符号依赖图 | `remember`/`cognify` 建图；`improve` 把会话知识桥接回图 | pull（`recall`）：按问题自动路由到 graph / vector / code 检索，返回证据 | **可零模型**：无 key 时用本地 GLiNER 抽取 + 本地 embedding；有 key 时走 OpenAI | 中：自托管，图与向量库可换 | Apache-2.0 | 论文 arXiv 2505.24478（作者自研，非第三方复现） |
| **LangMem** | 语义 / 情景 / 程序性三分；**存储后端由你定**（原生接 LangGraph BaseStore） | 两条路都给了：hot-path 工具（agent 自己调 `create_manage_memory_tool`）+ background manager 自动抽取/合并 | pull（`create_search_memory_tool`） | 写入/抽取需 LLM；需 embedding（示例 OpenAI text-embedding-3-small） | 强：primitive 与存储解耦 | MIT | 未找到公开评测数字 |
| **Claude memory tool** | **纯文件目录**（`/memories`），客户端持有并实现存储——**真相源在客户端** | 模型显式调用工具；Anthropic 官方提供 6 个命令：view / create / str_replace / insert / delete / rename | **纯 pull 工具**：模型决定何时读写；不注入 | 无需额外模型（工具调用即主模型） | 最强：文件就是全部，随时拿走 | 文档（闭源产品） | 未找到公开评测数字 |
| **Claude Code：CLAUDE.md / auto memory** | 人写 = CLAUDE.md；Claude 写 = auto memory（4 类笔记带 frontmatter type），存 `~/.claude/projects/<project>/memory/` | 人：`/init`、`#`、手写；Claude：从「纠正与偏好」中自己记下 | **push，但有硬上限**：auto memory 只注入首 200 行或 25KB；CLAUDE.md 官方建议 <200 行 | 主模型顺带完成 | 强：纯 markdown，可手改可删 | 闭源（Apache-2.0 不适用） | 未找到公开评测数字 |
| **ChatGPT 记忆** | 已保存记忆 + 引用聊天历史（本报告**未取到官方原文**：help.openai.com 与 openai.com 均以 Cloudflare 403 拦截） | 未验证 | 未验证 | — | 未验证 | 专有 | 未验证 —— 见文末「未找到公开资料」清单 |
| **官方 MCP memory server** | 知识图谱三件套：`Entity{name,entityType,observations[]}` / `Relation{from,to,relationType}` / `KnowledgeGraph`；**真相源 = 一个本地 JSONL 文件**（`memory.jsonl`，可用 `MEMORY_FILE_PATH` 改） | 模型调工具：`create_entities` / `create_relations` / `add_observations` / `delete_*`；**无去重、无合并、无衰减**（由模型自觉） | pull：`searchNodes`（子串）/ `openNodes` / `read_graph` | 零模型（纯 JS，服务端不算） | 最强：一个 JSONL，随便带走 | 仓库 LICENSE 为 NOASSERTION（`modelcontextprotocol/servers` 整体） | 无 |
| **supermemory** | 记忆 + 用户画像 + RAG 统一结构（官方称「single memory structure and ontology」）；云为主，另有本地单二进制 | 自动从对话抽事实、处理时间变化/矛盾/自动遗忘 | 混合检索（RAG + memory 一次查询）；用户画像一次调用 ~50ms 直接塞 system prompt | 云 API 为主；本地版可接 Ollama 全离线 | 中：自托管版可跑，插件开源 | MIT（主仓）；插件各仓独立 | 自测：宣称 LongMemEval / LoCoMo / ConvoMem 全部 #1、95% Recall@15、99.4% context reduction |
| **Basic Memory** | **markdown 文件是真相源**，SQLite 只是索引；observations + wikilinks 构成知识图谱 | 人和 AI 双向写同一批文件，sync 保持一致 | pull，MCP 工具集；核心叙事是「你和 AI 读同一份文件」 | 零模型必需；有可选语义检索（默认关，因增加延迟） | 最强：明文 markdown，自带「导出到本地 markdown」承诺 | **AGPL-3.0** | 未找到公开评测数字 |
| **dsh-mneme**（DSH 生态，同赛道） | 本地记忆库 + 面板；L1 traces / L2 policies / L3 分层 | autoDream 后台巩固：去重/合并/归档/修正/冲突冻结（类型化 keep/merge/archive/conflict/update + sha256 审计链） | pull 六件套 MCP 工具 + 混合召回（BM25 + 图谱 + 热记忆 + 本地 embedding/rerank） | **默认离线**，本地 embedding 不需要 API key | 强：自带 stdio MCP server（`mneme-memory`），Claude Code/Cursor/Codex/OpenCode/OpenClaw 都能挂 | MIT | 未找到公开评测数字 |
| **MemOS**（DSH 生态，最直接竞品） | MemCube 抽象；L1 traces / L2 policies / L3 world models + 结晶化 Skills；本地 SQLite | 后台捕获（成功后写入）+ MemScheduler 异步摄取；smart dedup | pull/混合：FTS5 + 向量混合检索；DSH 插件**在首个模型步之前**召回 | 本地版可零云依赖；云版托管 | 强：本地插件 100% 离线、SQLite 存储 | Apache-2.0 | 自测：LoCoMo 88.83、LongMemEval 89.20；OpenClaw 任务完成率 36.63%→50.87%；云插件宣称 token 用量 −72% |
| **A-MEM** | Zettelkasten 风格笔记（结构化属性 + 标签 + 链接），索引在 ChromaDB | 每来一条新记忆：生成笔记 → 分析历史找关联 → 建链 → **触发旧记忆演化更新** | pull 检索，靠链接网络做多跳 | 强依赖 LLM（建笔记+建链+演化） | 中：向量库可换，但结构是研究代码 | MIT | 论文 arXiv 2502.12110 自测（6 个基础模型上优于基线） |
| **HippoRAG / HippoRAG 2** | OpenIE 抽取的实体-关系图 + passage 向量；索引落盘在 `--save_dir`，带 `index_manifest.json` 绑定模型指纹 | 离线索引（OpenIE + 图构建），可增量 `index`；重复 passage 自动跳过 | pull：dense 检索种子 → **Personalized PageRank** 图上扩散 → 返回 passage | 需 LLM 做 OpenIE（可用本地 vLLM）；embedding 必需 | 中：索引与模型绑定（换模型 = 换索引），MCP 可暴露 | MIT（NeurIPS'24 / ICML'25 论文） | 论文自测：多跳 MuSiQue / 2Wiki / HotpotQA 提升；无第三方复现 |
| **FluctlightDB**（研究，2026-07） | 主张「长期记忆应是一种独立数据模型」：写语义 = 编码/分离/巩固/溯源，读语义 = 沿链接图的 cue 激活；嵌入式引擎，API 为 `experience()` / `activate()` | 作者自己声明**不宣称优于** Mem0/Zep/HippoRAG 层，只做它们底下的引擎契约 | cue-driven activation（激活式，不是 top-k 相似） | 研究实现 | 嵌入式 | 未核实（论文，未查许可） | **作者自测且自己标注协议不同**：LoCoMo k=150 证据召回 96.8%、k=5 为 72.6%；LongMemEval-S session_recall@8 97.6%、端到端 QA 97.4% |

> 表中所有百分比均为**厂商/作者自测**，无一为第三方独立复现。基准可信度详见下文「基准怎么读」。

---

## 逐系统要点

### 1. mem0（OSS + 云）· [github](https://github.com/mem0ai/mem0) · [docs](https://docs.mem0.ai/open-source/overview)
- 事实：Apache-2.0，67.3k star（2026-10-17 API），Python；云平台闭源。
- 事实：2026-04 换算法，四项改动写进 README——**单次 LLM 调用的 ADD-only 提取（不再 UPDATE/DELETE）**、agent 生成的事实同等权重、实体链接、语义+BM25+实体三路融合检索、时间感知排序。
- 事实：README 明确标注分数「reflect Mem0's managed platform, which includes proprietary optimizations」——**OSS 自托管拿不到同样的分**。
- 事实：评测框架开源在 `mem0ai/memory-benchmarks`（Apache-2.0，126 star），可复现。这是它比多数竞品诚实的一点。
- 厂商宣称：LoCoMo 71.4→92.5、LongMemEval 67.8→94.4、BEAM(1M) 64.1，7.0K tokens、p50 ≈0.9–1.1s。
- 对我们：**「只增不改」是重要的生产信号**——冲突解决挪出热路径；但它把真相源押在向量库+云平台上，不符合我们的可迁移要求。

### 2. Letta / MemGPT · [github](https://github.com/letta-ai/letta) · [docs](https://docs.letta.com) · [sleep-time 论文](https://arxiv.org/abs/2504.13171)
- 事实：旧仓 `letta-ai/letta` 的 v1 API 已退役，代码移到 `letta-ai/letta-code`（Apache-2.0，3.6k star）；旧仓 archive 分支只作复现用。
- 事实：核心抽象是 **memory blocks（core memory）+ archival/recall**，模型通过工具直接编辑自己的记忆块——记忆管理是 agent 能力的一部分，而非外挂服务。
- 事实（论文）：sleep-time compute 在 Stateful GSM-Symbolic / AIME 上把达到同等准确率所需的测试期算力降 ~5×，扩大离线计算可再涨 13% / 18%；多 query 摊销后每 query 成本降 2.5×；**有效性用户查询的可预测性强相关**。
- 对我们：离线巩固值得做，但触发条件应是「查询可预测性高」而非「定时到了」。

### 3. Zep / Graphiti · [github](https://github.com/getzep/graphiti) · [Zep 论文](https://arxiv.org/abs/2501.13956)
- 事实：Graphiti 是 Apache-2.0 的 OSS 框架；Zep 云是闭源商业产品，底层是自研 Context Graph Engine。
- 事实：数据模型分三层——**episodes（原始数据流，明确定义为 ground truth）、entities/facts(edges)、communities**；事实边带 validity window，**矛盾时 invalidate 而非 delete**，因此可查「现在为真」也可查「当时为真」。
- 事实：需要 Neo4j 5.26+ / FalkorDB 1.1.2+ / Neptune；有 `SEMAPHORE_LIMIT` 控制摄取吞吐。
- 厂商宣称（论文自测）：DMR 94.8% vs MemGPT 93.4%；LongMemEval 准确率最高 +18.5%、响应延迟 −90%。
- 对我们：**双时态 + invalidate 不 delete 是本题最优雅的一个设计**——「旧不等于没用」有形式化表达；但强制图数据库违背「无常驻进程」约束。

### 4. Cognee · [github](https://github.com/topoteretes/cognee) · [论文](https://arxiv.org/abs/2505.24478)
- 事实：Apache-2.0，32.4k star。官方卖点第一句就是 **"Runs locally for free — no API key required"**，靠 CPU 上的小模型（GLiNER 抽取 + 本地 embedding）。
- 事实：README 写明「Text ingestion, retrieval, and session storage work without an LLM. LLM-dependent improvement stages skip automatically.」——**降级路径是设计的一部分**。
- 事实：操作面 `remember` / `recall` / `improve`；检索按问题自动路由到 graph / vector / code。
- 对我们：本地小模型兜底 + 显式降级，是「零模型基线可复现」的现成范例。

### 5. LangMem · [github](https://github.com/langchain-ai/langmem) · [文档](https://langchain-ai.github.io/langmem/)
- 事实：MIT，1.7k star；提供语义/情景/程序性记忆的 primitive，**与存储解耦**（"functional primitives you can use with any storage system"）。
- 事实：同时给 hot-path（agent 自己存）与 background（自动抽取+合并）两条路，且明说「The agent gets to decide what and when to store the memory」。
- 事实：示例依赖 OpenAI embedding（`text-embedding-3-small`, 1536 dims）；默认 `InMemoryStore` 重启即丢（文档自己警告）——生产需换后端。
- 对我们：**primitive 与存储解耦**这一条直接对应我们希望跨宿主通用的诉求。

### 6. Claude memory tool 与 CLAUDE.md / auto memory · [官方文档](https://code.claude.com/docs/en/memory)
- 事实：CLAUDE.md 分层加载（managed policy → user → project → 上级目录），**全部拼接进上下文而非互相覆盖**；子目录 CLAUDE.md 惰性加载（Claude 读到那里才加载）；`@path` 导入可递归，最大 5 跳。
- 事实：官方尺寸建议 **"target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence."**
- 事实：**auto memory** 是 Claude 自己写的笔记，按 4 类记录（type 写在 frontmatter），存 `~/.claude/projects/<project>/memory/`；**每次会话只注入首 200 行或 25KB**；machine-local，不跨机器共享；子 agent 不继承主会话的 auto memory。
- 事实：auto memory 默认开启（本地会话），可 `/memory` 切换；环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`autoMemoryDirectory` 可改位置。
- 事实：block-level HTML 注释在注入前被剥离——**给人类留的注释不烧 token**，这个小设计很值得抄。
- 未取到官方原文：memory tool（`memory_20250818`）的完整参数表（platform.claude.com 对本站返回区域限制页）。

### 7. ChatGPT 记忆 · [help.openai.com](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)
- **未找到公开资料**：help.openai.com、openai.com、help-lb.openai.com 三个入口对本次调研均返回 Cloudflare 403；官方博客 403。因此本报告不对 ChatGPT 记忆的写入规则、注入时机、训练数据使用做任何论断。若需这一节，请在浏览器里人工打开该页并粘贴正文。

### 8. 官方 MCP memory server · [仓库](https://github.com/modelcontextprotocol/servers) · [子目录](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
- 事实（读源码 `src/memory/index.ts`）：`Entity{name, entityType, observations[]}`、`Relation{from, to, relationType}`、`KnowledgeGraph{entities, relations}`；工具为 `create_entities` / `create_relations` / `add_observations` / `delete_entities` / `delete_observations` / `delete_relations` / `read_graph` / `searchNodes` / `openNodes`。
- 事实：真相源是**单个 JSONL 文件**，默认 `memory.jsonl`，`MEMORY_FILE_PATH` 可改（支持 `~` 展开）。
- 事实：每个写入工具持排他锁文件 `<memory file>.lock`，多进程写同一文件不会丢——**用文件锁解决并发，而不是上数据库**，这个工程取舍对我们很有参考价值。
- 事实：`searchNodes` 只是子串匹配；没有去重、合并、衰减、时间维度——全部留给模型自觉。
- 对我们：「一个 JSONL + 文件锁」证明了**极简存储可以撑起跨宿主共享**；它缺的（去重/衰减/时间）正是我们可以补的差异点。

### 9. supermemory · [github](https://github.com/supermemoryai/supermemory) · [docs](https://supermemory.ai/docs)
- 事实：MIT，31.3k star，TypeScript；架构是「记忆 + 用户画像 + RAG 统一结构」，混合检索一次查询同时打知识库与个人上下文。
- 事实：提供本地版（`curl -fsSL https://supermemory.ai/install | bash`，单二进制，可接 Ollama 全离线），以及 Claude Code / Cursor / Codex / OpenCode / OpenClaw / Hermes 的**开源插件**（各自独立仓库）。
- 厂商宣称：LongMemEval / LoCoMo / ConvoMem 三项 #1，95% Recall@15，99.4% context reduction，用户画像 ~50ms。
- 对我们：插件矩阵的铺法值得学（每个宿主一个薄插件 + 一个统一 API），但它的默认形态是云 API。

### 10. Basic Memory · [github](https://github.com/basicmachines-co/basic-memory) · [docs](https://docs.basicmemory.com)
- 事实：**AGPL-3.0**（4.2k star，Python）；markdown 文件是真相源，SQLite 只做索引；MCP-native，Obsidian 可直接读写同一批文件。
- 事实：官方承诺「No lock-in. Your notes are plain Markdown. Export to local Markdown any time.」云版 $15/月（beta 锁价），但同样以 markdown 为准，可双向同步回本地。
- 事实：语义检索默认关闭，理由是「adds inference latency」——**为了延迟主动关掉语义检索**，和我们「零模型基线」的取舍同源。
- 对我们：AGPL-3.0 是**发布时最需要注意的许可**：一旦被同事/客户当作服务使用，AGPL 的网络条款会传染；我们要么选 MIT/Apache，要么自研。（见「对我们意味着什么」第 4 条）

### 11. dsh-mneme（本机生态内同赛道）· [github](https://github.com/slow-stack/mneme) · [npm](https://www.npmjs.com/package/@lanbaolu/dsh-mneme)
- 事实：MIT，153 star，2026-10-16 仍在更新；DSH 插件 + 自带零依赖 stdio MCP server（`mneme-memory`，bin `mneme-mcp`），可挂 Claude Code / Cursor / Codex / OpenCode / OpenClaw / Hermes。
- 事实：`autoDream` 离线巩固做去重/合并/归档/修正/冲突冻结，类型化决策（keep / merge / archive / conflict / update）+ sha256 可回放审计链（`dream_runs` / `receipt_chain`）；**冲突进人工裁决队列，不自动删**。
- 事实：召回是混合的（BM25 + 图谱 + 热记忆），默认本地 embedding + rerank，不需要 API key；另有作用域隔离（agent × workspace）。
- 对我们：这是**功能上最接近我们要做的事的实现**，且已跨宿主。差异化只能在「通用服务 + 数据模型 + 可迁移性」上找，不能在「有没有 autoDream」上找。

### 12. MemOS（DSH 生态，最直接竞品）· [github](https://github.com/MemTensor/MemOS)
- 事实：Apache-2.0，11.9k star；已提供 DeepSeek Harness 插件（`npx @deepseek-ai/dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest`，另有本地插件）。
- 事实：本地插件形态是 **hybrid retrieval (FTS5 + vector) + smart dedup + 分层演化（L1 traces / L2 policies / L3 world model）+ 结晶化 Skills**，SQLite 本地优先。
- 事实：DSH 插件工作方式写在 README：**每个用户请求的首个模型步之前召回，成功 turn 之后保存**——即「每轮都尝试注入」，与我们的 pull 倾向相反，值得警惕。
- 厂商宣称：LoCoMo 88.83、LongMemEval 89.20；OpenClaw 五任务平均完成率 36.63%→50.87%；云插件 token 用量 −72%。
- 对我们：**明确的最强竞品**，且已进入 DSH 生态。我们要么在数据可迁移/零注入上明确切分，要么承认重叠。

### 13. 研究前沿：A-MEM / HippoRAG / FluctlightDB
- **A-MEM**（MIT，1.2k star，[论文](https://arxiv.org/abs/2502.12110)）：Zettelkasten 式笔记 + ChromaDB 索引 + 建链 + **记忆演化**（新记忆触发旧记忆更新）。是「一条记忆应该被链接而不是被存起来」的最完整实现。
- **HippoRAG 2**（MIT，4.1k star，[arXiv 2405.14831](https://arxiv.org/abs/2405.14831) / [2502.14802](https://arxiv.org/abs/2502.14802)）：OpenIE 建图 + **Personalized PageRank** 做多跳检索；2026 版已提供 **MCP server**（`retrieve` / `rag_qa` / `index` / `list_documents` / `index_stats`，Streamable HTTP 无鉴权，须锁 loopback）。索引落 `--save_dir` 并写 `index_manifest.json` 绑定模型指纹——**换模型 = 换索引**，这个坑我们要提前设计。
- **FluctlightDB**（[arXiv 2608.12365](https://arxiv.org/abs/2608.12365)，2026-07）：主张把长期记忆当**独立数据模型**（写语义：编码/分离/巩固/溯源；读语义：cue 驱动的图激活），作者明确不宣称优于 Mem0/Zep/HippoRAG，只做底下的嵌入引擎契约。

### 14. 基准怎么读（这一节比任何分数都重要）
- **LoCoMo**（[snap-research/locomo](https://github.com/snap-research/locomo)，1.2k star）：官方规模仅 **10 段对话 / 1,982 个 gold span**；arXiv 2610.09348 原文指出这 10 段在开发期全部可见，因此 **LoCoMo 的分主要衡量「跨对话稳定性」，不是泛化能力**。
- **LongMemEval**（[xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval)，MIT，1.2k star，ICLR 2025）：LongMemEval-S 为 500 题，是当前更能反映多会话/时间推理的公开集。
- **计分目标不变量失效**（[arXiv 2605.24060](https://arxiv.org/abs/2605.24060)，2026-05/08）：只改变「给 raw / source-linked / canonical 哪一个记分」，**在 83.4–94.0% 的共享 query 上改变 nDCG**，并在 Mem0 与 MemoryOS 的迁移实验里**翻转名次**；1,902 例语义审计显示「放宽的 source-linked 记分」只有 29.2% 站得住。结论：任何记忆论文/厂商页都应显式声明计分目标，否则数字不可比。
- **相关性 ≠ 充分性**（[arXiv 2610.09348](https://arxiv.org/abs/2610.09348)，2026-10）：top-k 每条都相关，合起来仍可能缺一个关键事实；应把检索目标改为「构造充分集合」，作者用 Gold Hit / Turn Hit 做证据覆盖代理指标（Budgeted Flat Reconstruction）。
- **协议不同就不可比**（[arXiv 2608.12365](https://arxiv.org/abs/2608.12365) 作者自己声明）：该文明确写「different protocols from vendor leaderboard figures we cite for context only」——厂商 leaderboard 数字只能当背景，不能当基线。
- **自测 vs 第三方**：本报告覆盖的全部系统，**没有任何一个数字来自独立的第三方复现**。

### 未找到公开资料（不编）
- ChatGPT 记忆机制的官方细节（写入规则、注入时机、是否用于训练）——三个官方入口均 403。
- Anthropic memory tool（`memory_20250818`）的完整参数表与客户端实现要求原文。
- supermemory / MemOS / Basic Memory / dsh-mneme 的第三方复现评测。
- Zep 云的商用条款细节、MemOS 云插件定价页原文（本次未取到）。
- `dsh-mneme` 的许可证：已核对仓库 `LICENSE` 文件正文首行「MIT License / Copyright (c) 2026 Modusensus」，确认为 **MIT**（不是「未找到」）。

---

## 对我们意味着什么

1. **默认 pull + 极小 always-on，是行业共识，不是我们的怪癖。** 唯一常驻的应当是「首 200 行 / 25KB」量级的核心索引——这个数字有官方出处（Claude Code auto memory 的注入上限、CLAUDE.md 的 <200 行建议）。旧项目的 655 条指针 / 2.4% 打开率是反例，不要复现。
2. **真相源必须是纯文本文件，索引必须可重建。** 抄 Claude memory tool 的形状（客户端持有文件 + 固定 6 个操作原语），而不是 mem0/Zep 的形状（真相源在向量库/图库）。同时抄 MCP memory server 的工程取舍：**一个文件 + 一把文件锁**就能安全跨进程；SQLite/向量库只能是派生物，删掉必须能重建。
3. **写入管线走「只增不改 + 离线巩固」。** mem0 退回单次调用 ADD-only、Letta 用 sleep-time 摊销、dsh-mneme 把冲突冻结进人工队列——三条独立证据指向同一结论：**热路径上不做 UPDATE/DELETE/冲突解决**；离线巩固要有可回放审计（dsh-mneme 的 `receipt_chain` 已证明可行），且「旧不等于没用」要像 Graphiti 那样用失效而非删除来表达。
4. **许可先选 MIT/Apache-2.0，避开 AGPL 与「OSS 但默认上云」。** Basic Memory（AGPL-3.0）与 mem0/Zep/supermemory 的「云才有最佳形态」都是我们要绕开的形态；我们自己发布时，若走服务化，AGPL 会传染。另外注意：`modelcontextprotocol/servers` 整仓 LICENSE 为 NOASSERTION，逐目录许可需自行确认。
5. **验收指标必须自建且写明口径。** 现有公开基准（LoCoMo 10 段对话、计分目标可翻转名次）不足以支撑架构决策。我们应复用自己已有的「打开率 / 零命中率 / 地表句保住率」账本口径，但要在文档里明确它是**代理指标而非因果证明**；验收判据建议直接采用 arXiv 2610.09348 的思路：不看 top-k 相关性，看**证据覆盖是否充分**（每道题需要的信息是否被检索集合覆盖）。
