# 03 · 宿主与接口：一个通用记忆服务怎么同时被各种 agent 宿主使用

> 调研日期 2026-10-17（Asia/Shanghai）。覆盖：MCP 协议现状、11 个宿主的接入方式、主流「记忆」接口形态、分发渠道、进程模型。
> 纪律：每条论断附来源；抓不到的一手来源写「未找到公开资料」。技巧：Mintlify 系文档站 URL 加 `.md` 可拿纯 markdown（modelcontextprotocol.io / code.claude.com / code.visualstudio.com / docs.cline.bot 都有效；Continue 站无效，见 §3.8）。

## 0. 结论先行

1. **对外只暴露一个 MCP 服务器 + 一个 CLI**，不写宿主专属适配器；宿主差异全部收敛为「一段配置片段 + 一篇安装说明」。
2. **协议层必须双时代兼容（Dual-era）**：最新是 2026-07-28（无状态、无 initialize），但 Zed 等仍按 2025-11-25 说话；而「Modern 客户端 × Legacy 服务器」和「Legacy 客户端 × Modern 服务器」都是直接失败（§1.5）。
3. **进程模型走混合**：常驻本地核心（唯一写入者，管并发/嵌入/模型调用）+ 每宿主一个 stdio 薄壳（连得上核心就用核心，连不上退化为本地只读）。理由与代价见 §5。
4. **工具面小而稳（5±2 个）且默认只读**；大输出必须分页或落盘——Claude Code 默认就有 25k token / 50k 字符 / 单响应 16MiB 三道上限（§3.1）。
5. **写入并发是架构问题**：官方 memory server 已经证明「每客户端一进程、共用一份文件」必须自己做锁（15s 刷新 / 30s 判死 / 60s 抢不到即报错 / 网络文件系统不安全，§2.1）。
6. **作用域 = 一个库 + scope 字段**：项目级默认隔离、用户级显式声明，不按宿主分库（对照 dsh-engram 的 user + per-git-origin 双作用域，§5.4）。
7. **密钥只走引用不走明文**：宿主侧只写 `${VAR}` / env 插值 / `!!js process.env`；Codex 连内联 `bearer_token` 都直接拒载（§3.9）。
8. **分发主线 = npm 包（stdio MCP）+ MCP registry 元数据**；插件市场（Claude Code / DSH）与 IDE 市场是增量渠道；registry 只存元数据，不托管代码、不审核行为（§4）。

## 1. MCP 能力/限制速查

### 1.1 版本与形态

- 当前 latest = **2026-07-28**，上一版 2025-11-25。核心协议被描述为「JSON-RPC 消息格式 / 无状态、自包含请求 / 每请求能力协商」。来源：https://modelcontextprotocol.io/specification/latest
- 服务器特性 = Resources / Prompts / Tools；客户端特性 = Elicitation；官方扩展 = **Tasks**、**Skills over MCP**、**MCP Apps**（内联 UI）。同上。
- 版本时代模型：**Modern**（2026-07-28 起，版本/身份/能力走每请求元数据）/ **Legacy**（2025-11-25 及更早，用 initialize 建会话）/ **Dual-era**（同一进程同一端点同时服务两个时代）。来源：https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning

### 1.2 2026-07-28 相对上一版的破坏性变更（逐条有 SEP）

| 变更 | 说明 |
| --- | --- |
| 移除协议级 session | Streamable HTTP 的 `Mcp-Session-Id` 没了；list 类端点不再随连接变化（SEP-2567） |
| 移除 `initialize` 握手 | 每个请求在 `_meta` 带 `protocolVersion`/`clientCapabilities`/`clientInfo`；服务器在结果 `_meta` 带 `serverInfo`（SEP-2575） |
| 新增 `server/discover` | 服务器 **MUST** 实现；客户端可在任意请求前调用做版本选择，STDIO 上还当向后兼容探针（SEP-2575） |
| `subscriptions/listen` | 取代 HTTP GET 端点与 `resources/subscribe`/`unsubscribe`；客户端按类型 opt-in |
| 删除 ping / `logging/setLevel` / `notifications/roots/list_changed` | 日志级别改为每请求 `_meta.logLevel`；没带该字段的请求，服务器 **MUST NOT** 发 `notifications/message` |
| Tasks 移出核心 | 归入官方扩展 `io.modelcontextprotocol/tasks`；`tasks/get` 轮询 + `tasks/update`（SEP-2663） |
| MRTR（多轮往返） | 服务器不再主动发请求，改为返回 `InputRequiredResult`（`resultType:"input_required"` + `inputRequests`），客户端带 `inputResponses` 重试（SEP-2322） |
| 结果新增强制字段 `resultType` | `"complete"` / `"input_required"`；旧服务器缺该字段时客户端 **MUST** 当 `"complete"` |
| 移除 SSE 可恢复性 | `Last-Event-ID` 与 event id 没了；流断=在途请求丢，必须用新 id 重发（SEP-2575） |
| Streamable HTTP 强制标准头 | POST 必带 `Mcp-Method`/`Mcp-Name`，并支持从工具参数镜像自定义头 `x-mcp-header`（SEP-2243） |

来源：https://modelcontextprotocol.io/specification/2026-07-28/changelog
另有两条对我们影响很大的细节：**`tools/list` 应返回确定性顺序**（利于提示/前缀缓存命中）、list/read/templates 结果必须带 `CacheableResult` 的 `ttlMs` 与 `cacheScope`（SEP-2549）。错误码分区：`-32000`~`-32019` 实现自定义，`-32020`~`-32099` 规范保留（`HeaderMismatch`=-32020、`MissingRequiredClientCapability`=-32021、`UnsupportedProtocolVersion`=-32022）；resource not found 从 `-32002` 改为 `-32602`。同上。

### 1.3 弃用清单（决定我们「不要押注什么」）

- **Roots / Sampling / Logging 于 2026-07-28 弃用（SEP-2577），最早移除时间是 2027-07-28 或之后发布的第一个修订版**；迁移路径分别是「改用工具参数/资源 URI/服务器配置传目录」「直接对接 LLM 厂商 API」「stdio 打到 stderr 或用 OpenTelemetry」。
- Dynamic Client Registration (RFC 7591) 弃用，改用 **Client ID Metadata Documents**；HTTP+SSE 传输自 2025-03-26 起弃用（SEP-2596 正式归类，最早移除 = SEP-2596 Final 后三个月）。官方弃用策略：Active/Deprecated/Removed 三态，**最少 12 个月弃用窗口**；目前实际已移除项：无。
- 来源：https://modelcontextprotocol.io/specification/2026-07-28/deprecated

### 1.4 两个传输（都必须是我们的第一公民）

- **stdio**：客户端把服务器当子进程启动；每行一条 JSON-RPC 消息、消息内 **MUST NOT** 含换行；服务器 **MAY** 往 stderr 写日志，客户端 **SHOULD NOT** 把 stderr 当错误；**服务器 MUST NOT 往 stdout 写任何非合法 MCP 消息**；请求元数据内联在 body 的 `_meta`（stdio 没有 header 层）；关闭语义是「客户端关闭 stdin → 等退出 → 超时强杀」，**服务器 SHOULD 在 stdin EOF 时尽快退出**（唯一可移植的优雅关闭信号）；异常退出后客户端 **SHOULD** 重启（协议无状态，在途请求直接丢，重试即可）。来源：https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
- **Streamable HTTP**：单个端点同时支持 POST 与 GET，POST 强制标准头（§1.2）；无 session、无 SSE 续传。来源：https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
- 授权：OAuth 2.1 + PKCE，响应 SHOULD 带 `iss`（RFC 9207）且客户端 MUST 校验，客户端凭据 MUST 按 issuer 绑定；本地传输通常无认证，靠进程边界。来源：https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

### 1.5 兼容矩阵（这是最容易踩死的地方）

| 客户端 \ 服务器 | Modern（只有 2026-07-28） | Legacy（只有 initialize） | Dual-era |
| --- | --- | --- | --- |
| Modern | OK | **失败** | OK |
| Legacy | **失败** | OK | OK |

- Legacy 客户端没有向上兼容机制，所以只支持 modern 的服务器 SHOULD 在给 `initialize` 的错误里列出自己支持的版本。
- 双时代客户端探针顺序：先 `server/discover` → 拿到 `DiscoverResult` 就是现代；拿到 `UnsupportedProtocolVersionError` 也是现代（用它 `supported` 里的版本重试，**不要**回退 initialize）；其它错误或超时才算 legacy，再回退 initialize。回退判据 MUST NOT 绑定单一错误码。
- 来源：https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning

### 1.6 限制：规范不设数值，全由客户端实现

- 规范层面只给了「SHOULD/MUST」：服务器 **MUST** 校验输入、做访问控制、**rate limit 工具调用**、sanitize 输出；客户端 **SHOULD** 对工具调用**实现超时**、对敏感操作要用户确认、校验结果后再喂给模型。来源：https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- 工具错误分两类：协议错误（JSON-RPC error，如 `Unknown tool`，`-32602`）和工具执行错误（`result.isError: true` + 可用来自纠的文本）；客户端 SHOULD 把后者给模型。同上。
- 因此**没有任何「通用超时值」可抄**：每个宿主自己定（Claude Code 的数值见 §3.1，DSH 默认 60s 见 §3.11，Gemini CLI 默认 600s 见 §3.10）。

## 2. 主流「记忆」的接口形态

### 2.1 官方 MCP memory server（知识图谱型）

- 9 个工具：`create_entities`、`create_relations`、`add_observations`、`delete_entities`、`delete_observations`、`delete_relations`、`read_graph`、`search_nodes`、`open_nodes`；外加资源 `memory://knowledge-graph`。数据模型 = Entity（name/entityType/observations）/ Relation（from/to/relationType）/ Observation。来源：https://github.com/modelcontextprotocol/servers/blob/main/src/memory/README.md
- 存储：单个 JSONL 文件（`MEMORY_FILE_PATH`，默认 `memory.jsonl`）。**并发方案值得抄**：每个 MCP 客户端起自己的服务器进程，两个客户端共用一个文件 = 两个进程写一个文件，所以每个写工具在读写期间持有独占锁文件 `<memory file>.lock`；服务器每 15s 刷新锁，进程确认退出则立刻清理、否则 30s 无刷新判死；等待方 60s 抢不到锁就返回工具错误而不是覆盖；**该锁依赖「独占创建」，网络文件系统不保证，因此不能这样共享**。同上。
- 对接口设计的启示：工具粒度是「实体/关系/观察」而不是「记忆条目」，写入立即生效、没有「会话结束整理」的概念；没有作用域（项目/用户）概念，也没有去重/衰减。

### 2.2 Claude 的 memory tool（客户端工具 + 文件型）

- 形态：**客户端实现**的 `memory` 工具，`type: "memory_20250818"`（工具名 `memory`），文件系统在 `/memories` 目录；命令集 `view` / `create` / `str_replace` / `insert` / `delete` / `rename`（`{"command":"create","path":"/memories/notes.md","file_text":"..."}` 这种形状）。来源：https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/memory_tool_20250818_param.py 、https://github.com/anthropics/claude-cookbooks/blob/main/tool_use/memory_cookbook.ipynb
- 同页还给了配套的 context editing 策略 `clear_tool_uses_20250919`（上下文长了就清旧工具结果）。启示：**「记忆存储」和「模型可见的记忆工具」是两层**，客户端可以只实现其中一层；我们的服务如果暴露文件语义（`view/create/str_replace`），迁移成本最低。
- 注：官方文档页 `platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool` 在 2026-10-17 实测被跳转到 claude.com 且正文由 JS 渲染，未能取到一手文本；上面的事实取自官方 cookbook 与官方 SDK 类型定义。

### 2.3 Letta：archival memory + 自编辑核心记忆 + 后台「做梦」

- 归档记忆 = passages + **语义检索**，工具 `archival_memory_insert` / `archival_memory_search`；核心记忆块走自编辑工具；配置层有 Memory & dreaming（离线整理）。来源：https://docs.letta.com/v1-sdk/memory/archival-memory 、https://docs.letta.com/configuration/memory
- 它还直接提供一个**托管 MCP 端点** `https://api.letta.com/mcp`：任意 MCP 客户端（官方举例 Claude Code / Cursor）可以用 API key 当 bearer token 连上去创建/驱动它的有状态 agent；Cursor 示例写 `.cursor/mcp.json`，VS Code 示例写 `.vscode/mcp.json` 且用 `inputs`+`promptString` 收集密钥。来源：https://docs.letta.com/platform/hosted-mcp
- 启示：**「记忆服务」可以只做存储与检索，把推理留给请求方**；也可以反向作为 MCP 服务器被别的 agent 驱动——我们选前者。

### 2.4 Basic Memory（本地优先，最接近我们要做的形态）

- 卖点：Markdown 明文落盘、人和 AI 双向读写、知识图谱 + 语义检索（可选 cross-encoder 重排）、MCP-native、云同步可选不必需；AGPL-3.0、Python 3.12+、PyPI 分发。来源：https://github.com/basicmachines-co/basic-memory
- 两个可抄的细节：**每个工具都带行为提示（read-only / destructive / idempotent）做「渐进式工具发现」**，让 agent 按需挑工具而不是试错；README 顶部有 `<!-- mcp-name: io.github.basicmachines-co/basic-memory -->` 注释，用于 MCP registry 校验包归属（§4.2）。

### 2.5 OpenAI 一侧

- ChatGPT 桌面/连接器的官方文档在 2026-10-17 实测均不可直连：`help.openai.com` 连接超时、`openai.com/index/memory-and-new-controls-for-chatgpt/` 403、`developers.openai.com` 403。**未找到可核实的一手资料**（只有二手报道提到 ChatGPT 开发者模式支持 MCP，例如 https://www.infoq.cn/article/sakj62a0esrrx5oirsse ，仅作线索）。
- 可核实的是 Codex CLI 侧的 MCP 客户机行为，见 §3.9。

### 2.6 可以直接抄的 6 条

1. 工具少而正交：检索 / 读 / 写 / 列 / 状态（官方 memory server 是 9 个但都是 CRUD 粒度；我们按「记忆」语义收敛到 5 个）。
2. 资源（resources）是加分项不是主线：Zed 明确只支持 Tools 与 Prompts（§3.4）。
3. 大输出分页/落盘：宿主普遍有硬上限（§3.1）。
4. 写入串行化 + 明确锁语义（§2.1）。
5. 一切写操作可审计、可撤销（官方 server 直接给 delete_*；Basic Memory 给 provenance）。
6. 语义检索要有，但**默认关键词/BM25 也能用**（旧项目实测 103ms/71 篇，见 `dsh-engramory-recall/docs/release.md`），模型调用只用在整理与重排。

## 3. 宿主支持对比表

来源键（下表用 `[键]` 引用）：
`[CC]` https://code.claude.com/docs/en/mcp.md ｜ `[CU]` https://cursor.com/docs/mcp ｜ `[CL]` https://docs.cline.bot/mcp/mcp-overview.md ｜ `[ZD]` https://zed.dev/docs/ai/mcp ｜ `[VS]` https://code.visualstudio.com/docs/agents/reference/mcp-configuration.md ｜ `[WS]` https://docs.windsurf.com/windsurf/cascade/mcp ｜ `[CT]` https://docs.continue.dev/customize/deep-dives/mcp ｜ `[GM]` https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md ｜ `[CX]` https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_edit.rs ｜ `[CX2]` https://github.com/openai/codex/blob/main/codex-rs/stdio-to-uds/README.md ｜ `[DSH]` 本机 app.asar 解包出的 `@deepseek-ai/dsh-mcp-client` README（2026-10-17） ｜ `[LT]` https://docs.letta.com/platform/hosted-mcp

| 宿主 | MCP | 传输 | 认证 | 配置位置 | 主要坑 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 是 `[CC]` | http（推荐）/ sse / stdio / **ws** `[CC]` | 远程 OAuth（`/mcp` 交互登录）、`--header` bearer、stdio env 插值 | local/user：`~/.claude.json`；project：项目根 `.mcp.json` `[CC]` | 输出 25k token 默认上限；`.mcp.json` 需批准 + 工作区信任；`url` 无 `type` 会被当 stdio 而跳过 |
| Cursor | 是 `[CU]` | stdio / SSE / Streamable HTTP `[CU]` | stdio 手动；远程 OAuth（“Add to Cursor”） `[CU]` | 全局 `~/.cursor/mcp.json` + 项目 `.cursor/mcp.json` + Customize UI `[CU]` | 配置里不能写注释；工具数量上限**未找到公开资料** |
| Cline | 是 `[CL]` | stdio / SSE(Legacy) / Streamable HTTP（推荐） `[CL]` | 环境变量/凭据字段，无内建 OAuth | CLI：`~/.cline/data/settings/cline_mcp_settings.json`（可被 `CLINE_MCP_SETTINGS_PATH` 覆盖）；IDE：MCP Servers 面板 → Configure `[CL]` | 面板里改 JSON 与 Remote Servers 标签是两条路径，容易只改一处 |
| Zed | 是 `[ZD]` | 本地 + 远程（自定义服务器）；无 ws | 远程可用 `headers.Authorization`，否则弹出标准 MCP OAuth 流程 `[ZD]` | 设置文件里的 `context_servers`（Settings → AI → MCP Servers / `zed: open settings file`） `[ZD]` | **只支持 Tools 与 Prompts**（清点不到 Resources/Sampling/Elicitation）；文档仍指向 2025-11-25 规范 |
| VS Code (Copilot) | 是 `[VS]` | stdio / HTTP / SSE；还支持 `unix:///path.sock` 与 Windows 命名管道 `[VS]` | `headers`（常配 `${input:...}`）、`oauth`（clientId，企业 SSO 走 ID-JAG） `[VS]` | 工作区/配置文件 `.vscode/mcp.json`（`servers` 对象）；便携格式 `.mcp.json`（`mcpServers`） `[VS]` | HTTP 先试 Streamable 再退 SSE；需交互输入的服务器不会被转发给 Copilot harness 会话；沙箱（仅 macOS/Linux）开启后工具确认自动批准 |
| Windsurf | 是 `[WS]` | 本地 + 远程 HTTP MCP；含 MCP Registry/Allowlist（Teams） `[WS]` | 配置插值 + 企业 admin 管控 `[WS]` | `~/.codeium/windsurf/mcp_config.json`（早期文档；现文档站已并入 docs.devin.ai） `[WS]` | 文档站点迁移（Windsurf → Devin/Cognition），老链接会跨域跳转 |
| Continue | 是 `[CT]` | stdio / sse / **streamable-http** `[CT]` | `${{ secrets.NAME }}` 注入 env；也可直接吃 Claude/Cursor/Cline 的 JSON 片段 `[CT]` | 工作区 `.continue/mcpServers/*.yaml`；另有 `config.yaml`（旧 `config.json` 已弃用） `[CT]` | **只在 agent 模式生效**；文档站不支持 `.md` 后缀（`/customize/mcp` 404，正确路径是 `/customize/deep-dives/mcp`） |
| Gemini CLI | 是 `[GM]` | stdio（`command`/`args`）/ `httpUrl`（HTTP streaming）/ `url`（SSE） `[GM]` | OAuth 2.0 自动发现（远程）；env 变量；`targetAudience` 指定 OAuth Client ID `[GM]` | `settings.json` 的 `mcpServers` + `mcp` 全局块 `[GM]` | 每服务器 `timeout` 默认 **600000ms = 10 分钟**；`trust:true` 会绕过所有工具确认；`includeTools`/`excludeTools` 里 exclude 优先；`mcp.allowed` 白名单 |
| Codex CLI | 是 `[CX]` | stdio / Streamable HTTP；第三方可加 **UDS** 适配器 `[CX2]` | 只认 `bearer_token_env_var`（**内联 `bearer_token` 直接报错拒载**） `[CX]` | `$CODEX_HOME/config.toml` 的 `[mcp_servers.<name>]`；也可 `codex --config mcp_servers.x={command="...",args=[...]}` `[CX][CX2]` | 沙箱里 HTTP 可能不通 → 官方给了 `codex-stdio-to-uds`（UDS 还能用文件权限做访问控制） |
| ChatGPT 桌面 / 连接器 | 有（二手）| 未核实 | 未核实 | 未核实 | 官方文档全部不可直连（§2.5）→ **未找到公开资料** |
| DSH | 是（原生 MCP 客户端插件）`[DSH]` | `stdio` / `streamable-http` `[DSH]` | `headers`（可用 `!!js` 引用 env）、stdio env 合并（环境已清洗） `[DSH]` | 以「配置型插件 bundle」注册：`cordis.patch.yml` 里插 `@deepseek-ai/dsh-mcp-client`，字段 `serverName`/`transport`/`url`/`command`/`args`/`env`/`cwd`/`toolCallTimeoutMs`/`failOnStartupError` `[DSH]` | 工具名固定 `mcp__<serverName>__<rawName>`；`serverName` 限 `[A-Za-z0-9_-]{1,32}`；stdio 子进程环境会丢掉匹配 `/KEY\|PASSWORD\|SECRET\|TOKEN/i` 与 `DSH_*` 的变量 |

### 3.1 Claude Code（最完整，也最会在细节上咬人）

- 配置：三种作用域 —— Local（默认，存 `~/.claude.json` 该项目路径下，不共享）/ Project（项目根 `.mcp.json`，可入 git 共享，需批准）/ User（`~/.claude.json`，所有项目）。来源：https://code.claude.com/docs/en/mcp.md#mcp-installation-scopes
- 传输四种：`claude mcp add --transport http <name> <url>`（推荐，`streamable-http` 是别名）、`--transport sse`、stdio、以及 **WebSocket（`type:"ws"`，只能写 JSON，不支持 OAuth 与 `--transport`）**。同上。
- 坑：`.mcp.json` 里 `url` 但没 `type` 的条目会被当 stdio 而跳过并报 `has a "url" but no "type"`；项目作用域服务器在未信任工作区永远停在 `⏸ Pending approval`；`headersHelper` 是任意 shell 命令，未信任目录不执行。同上。
- 超时与上限（照抄可避坑）：启动超时用 `MCP_TIMEOUT`（文档例子 `MCP_TIMEOUT=10000` = 10s，**默认值未找到公开资料**）；每服务器 `timeout`（ms，<1000 忽略）是硬墙钟上限，`MCP_TOOL_TIMEOUT` 默认约 28 小时；空闲超时 HTTP/SSE/WS/connector 5 分钟、stdio 30 分钟，可用 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` 调整；输出超过 10k token 警告、默认上限 25k token（`MAX_MCP_OUTPUT_TOKENS`），HTTP/SSE 单个响应体/事件超 16MiB 直接失败，文本结果超 50,000 字符也落盘。同上（`#mcp-output-limits-and-warnings`）。
- 作为「被连」的一方：`claude mcp serve` 把 Claude Code 本体变成 stdio MCP 服务器（只暴露它的工具，确认逻辑由客户端负责）。同上。
- 停止 stdio 子进程的顺序（写服务器时必须实现）：macOS/Linux 先 `SIGINT`，100ms 后 `SIGTERM`，再 400ms 后 `SIGKILL`；Windows 先关 stdin，300ms 后杀进程树。同上。

### 3.2 Claude Code 插件与市场

- 插件市场 = 一个 git 目录/仓库，含 `.claude-plugin/marketplace.json`（必填 `name`、`owner`、`plugins` 数组）+ 各插件自己的 `plugin.json`；注册命令 `/plugin marketplace add <repo|./dir>`；本地校验 `claude plugin validate`。来源：https://code.claude.com/docs/en/plugins/create-marketplace
- **没有中心审核**：自建 git 仓库即可分发，用户显式注册；官方市场（`anthropics/claude-plugins-official`）需要先 `add` 再装。来源同上 + `[CC]` 故障提示文本。

### 3.3 Cursor

- 三种传输的能力矩阵官方给了表：`stdio`（本地、Cursor 代管、单用户、手动认证）/ `SSE`、`Streamable HTTP`（本地或远端、多用户、OAuth）。协议支持列表里明确勾了 Tools/Prompts/Resources/Roots/Elicitation + MCP Apps 扩展。来源：https://cursor.com/docs/mcp
- 配置：全局 `~/.cursor/mcp.json` + 项目级 `.cursor/mcp.json`，或 Customize 页面一键装；支持在 `command`/`args`/`env`/`url`/`headers` 上做变量插值。同上。

### 3.4 Zed

- 只支持 **Tools 与 Prompts**，官方明说欢迎社区补 Discovery/Sampling/Elicitation；文档里的规范链接仍指 2025-11-25。来源：https://zed.dev/docs/ai/mcp
- 两条安装路径：扩展（`zed: extensions` / Settings → AI → MCP Servers → Add Server → Install from Extensions，官方扩展列表含 Context7、GitHub、Puppeteer 等）与自定义服务器（`context_servers` 写进 settings）；远程服务器没有配 `Authorization` 头时会走标准 MCP OAuth 流程。同上。

### 3.5 VS Code / Copilot

- 两套格式并存：VS Code 原生 `.vscode/mcp.json`（顶层 `servers`，支持 `inputs` 敏感输入、`sandbox`、`envFile`）与「便携 Copilot 格式」`.mcp.json`（顶层 `mcpServers`）/ `~/.copilot/mcp-config.json`。能力差异官方给了表：`.mcp.json` 只支持 stdio 与 HTTP，且**没有 envFile**。来源：https://code.visualstudio.com/docs/agents/reference/mcp-configuration.md
- 特有：stdio 服务器可 `sandboxEnabled`（仅 macOS/Linux，能限制文件与网络；开启后工具确认自动批准）；HTTP 支持 Unix socket / Windows 命名管道（`unix:///path#/mcp/subpath`）；Docker 场景禁止 `-d` 分离模式。同上。

### 3.6 Windsurf

- 配置 `~/.codeium/windsurf/mcp_config.json`，支持远端 HTTP MCP、配置插值、Teams/企业侧的 MCP Registry、Allowlist 与服务器匹配规则。来源：https://docs.windsurf.com/windsurf/cascade/mcp
- 站点已并入 Devin Docs（`docs.devin.ai`），页面标题与导航都变成 “Devin Docs / Cascade MCP”；内容仍在原域名可达。同上（2026-10-17 实测）。

### 3.7 Cline

- 配置：CLI 在 `~/.cline/data/settings/cline_mcp_settings.json`（`CLINE_MCP_SETTINGS_PATH` 可覆盖），IDE 在 MCP Servers 面板 → Configure 打开同一份 JSON；远程端点走 Remote Servers 标签（Streamable HTTP 推荐 / SSE 遗留）。来源：https://docs.cline.bot/mcp/mcp-overview.md

### 3.8 Continue

- 工作区 `.continue/mcpServers/*.yaml`（一个服务器一个文件），字段 `name`/`type`(`sse|stdio|streamable-http`)/`command`/`args`/`env`；密钥用 `${{ secrets.NAME }}`；**只能在 agent 模式使用**；旧 `config.json` 已弃用，改 YAML。来源：https://docs.continue.dev/customize/deep-dives/mcp

### 3.9 Codex CLI

- 配置在 `$CODEX_HOME/config.toml` 的 `mcp_servers` 段；内联 `bearer_token` 会被拒绝并提示改成 `bearer_token_env_var`：`mcp_servers.<name> uses unsupported \`bearer_token\`; set \`bearer_token_env_var\`.` 来源：https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_edit.rs
- 第三条传输：`codex-stdio-to-uds` 把 UDS 适配成 stdio，用法 `codex --config mcp_servers.example={command="codex-stdio-to-uds",args=["/tmp/mcp.sock"]}`；优点是可挂长驻进程 + 用文件权限限制访问，Windows 上靠 `uds_windows` 兼容。来源：https://github.com/openai/codex/blob/main/codex-rs/stdio-to-uds/README.md

### 3.10 Gemini CLI

- `settings.json` 的 `mcpServers`，两种写法（`command`+`args` 本地，或 `httpUrl`/`url` 远程）；每服务器字段：`timeout`（默认 600000ms）、`trust`（true 绕过确认）、`includeTools`/`excludeTools`、`targetAudience`、`headers`、`env`；全局 `mcp.allowed` 白名单；远程 OAuth 2.0 自动发现。来源：https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md

### 3.11 DSH（DeepSeek Harness）

- 原生 MCP 客户端插件 `@deepseek-ai/dsh-mcp-client`（本机 app.asar 内的 README，2026-10-17）：`transport` 只支持 `stdio` 与 `streamable-http`；`toolCallTimeoutMs` 默认 60,000；`failOnStartupError` 默认 false（初始连接失败只是没工具 + 记日志，不阻塞启动）；stdio 会先用一个临时探针进程协商；每次 sync 串行化，工具集合要么整体替换要么拒绝。
- 工具命名 `mcp__<serverName>__<rawName>`（和 Claude Code / Codex 同形），规范化后附 12 位 SHA-256 哈希防撞；`serverName` 必须 `[A-Za-z0-9_-]{1,32}` 且在一个注册作用域内唯一。
- stdio 子进程环境清洗：丢掉父进程里匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量与所有 `DSH_*` 变量，配置里的 `env` 再合并上去；HTTP 侧用 `headers` 配 `Authorization`（可用 `!!js` 表达式从 env 取，避免把密钥写进对话或配置文本）。
- 连接方式是把配置写进一个「配置型插件 bundle」（`cordis.patch.yml` 插 `dsh-mcp-client`），再用 `plugin_manager` 安装；另有 `@deepseek-ai/dsh-mcp-resources` 处理资源。

## 4. 分发渠道对比表

| 渠道 | 提交要求 | 审核 | 更新机制 | 限制/备注 |
| --- | --- | --- | --- | --- |
| npm | `package.json` + 2FA 或 **Trusted Publisher（GitHub OIDC）** | 无人工审核（自动扫描） | `npm publish`（版本号即更新） | 旧项目经验：走 Trusted Publisher 就不用长期 token；注意 `registry-url` 会写假 token 破坏 OIDC（见 `dsh-engramory-recall/docs/release.md`）。**npm 不适合塞大二进制/模型权重**（未找到官方硬上限，实践上别这么干） |
| MCP 官方 Registry | `server.json`（名称如 `io.github.user/server-name`、包定位、启动参数）+ **反向 DNS 命名空间验证**（GitHub / DNS / HTTP 挑战） | 无内容审核；有字符/正则校验 + 人工下架（Moderation Policy） | 重发元数据；下游聚合器「大约每小时」拉一次 | 仍是 **preview**（可能 breaking / 数据重置）；**只存元数据**，代码仍在 npm/PyPI/Docker；**不支持私有服务器**；官方明说不是给宿主直接消费的，是给聚合器用的。来源：https://modelcontextprotocol.io/registry/about |
| Smithery | URL 发布：公网 HTTPS + **Streamable HTTP** + （需要认证时）OAuth；或本地 **MCPB bundle**。不需要客户端注册（用 Client ID Metadata Documents） | 自动扫描你服务器抽工具/提示/资源元数据；扫不动就提供 `/.well-known/mcp/server-card.json` 静态卡片 | 平台代理（Gateway）指向你的上游；你在自己服务器上更新 | 站点现在属于 Arcade.dev；`smithery.ai/new` 提交流程。来源：https://smithery.ai/docs/build/publish |
| Claude Code 插件市场 | git 仓库 + `.claude-plugin/marketplace.json`（`name`/`owner`/`plugins`）+ 每个插件 `plugin.json`，`claude plugin validate` 通过 | 无中心审核；用户 `/plugin marketplace add` 自己注册 | 推 git 即更新；官方市场 `anthropics/claude-plugins-official` 需先 add | 插件可带 MCP 服务器；相对路径必须从市场根写起，entry `name` 必须与 manifest `name` 一致 |
| DSH 插件（黄页 + 扫描器） | `dsh plugin add <npm 包 \| tarball URL \| git 仓库>` 装得上 + 声明 `dsh.bundle` manifest；黄页条目按「一行描述是否属实」逐条核对源码 | `awesome-dsh-plugin` 是 PR 收录、人工核对；`unStone/dsh-xray` 提供能力卡/风险分级安全扫描 | 推 npm/tarball 新版本即更新；黄页条目随时可能被下架 | 生态量级：dsh 插件仓库一个月内从约 200 涨到 10,900+；插件能改系统提示、拦截 API、patch 运行时，`manifest.bundle.patch` 是重点审查面。来源：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 、https://github.com/unStone/dsh-xray |
| VS Code 扩展市场 | 建 publisher + `vsce publish`；认证：PAT（Azure DevOps 全局 PAT **2026-12-01 退役**）→ 改用 Entra ID + workload identity（`vsce publish --azure-credential`） | 无人工审核；有包内容约束（图标/徽章不能是 SVG，README/CHANGELOG 图片必须 https） | `vsce publish`（可 `major/minor/patch` 自增；支持 `--pre-release`） | 支持平台特定 VSIX（`--target win32-x64` 等）→ **可以带原生二进制**；扩展名唯一，删除后名称永久保留；keywords ≤30。来源：https://code.visualstudio.com/api/working-with-extensions/publishing-extension.md |
| PyPI（备选） | 打包 + 上传（可信发布同理） | 无人工审核 | 发新版本 | 若核心用 Python（对照 Basic Memory），这是最省事的分发；未审核代码 |

## 5. 进程模型对比 + 推荐

| 方案 | 进程/连接 | 多宿主并发写 | 密钥 | 冷启动/首字延迟 | 跨宿主一致体验 | 主要代价 |
| --- | --- | --- | --- | --- | --- | --- |
| A. 每宿主一个 stdio 子进程 | N 个宿主 = N 个进程，各自持库 | 必须跨进程锁（官方 memory server 那套：独占锁文件 + 刷新/判死/超时） | 全在宿主配置里 | 每次启动都要重建索引/加载嵌入（旧项目冷启动 40ms 是纯 BM25 的量级，带向量就重） | 容易分叉：每个宿主的进程各有一份内存态 | 重复内存、重复模型调用、索引重复构建；锁一坏就丢写 |
| B. 常驻本地 HTTP 服务 | 1 个常驻进程 + N 个薄客户端 | 单写者，天然串行 | 只放客户端的 URL + token | 一次冷启动，之后请求级 | 一份数据、一份缓存、一份限流 | 谁负责拉起/保活（launchd/systemd/pm2）；老壳连新核的版本漂移；本地端口要 127.0.0.1 + token；**沙箱/容器里 HTTP 可能不通**（Codex 沙箱、VS Code 沙箱） |
| C. 混合（推荐） | 常驻核心 + 每宿主 stdio 薄壳（壳优先连核心，失败则退化为 in-process 只读） | 核心串行写；壳从不直接写文件，写请求转交核心 | 核心持密钥；壳只持「怎么找到核心」 | 常规请求走已热的核心；退化路径按 A 的代价 | 一份数据；不同宿主只是入口不同 | 多一层进程与故障模式（核心不在 → 退化为只读，需要清晰的 UI/日志提示）；要写两遍入口（MCP stdio + `serve`） |

### 5.1 推荐形态

**C：一个进程模型 + 两个入口。**

- `tabellio serve`：常驻本地核心，绑定 `127.0.0.1` + bearer token（令牌文件 0600），负责写串行化、索引/嵌入缓存、后台整理（对应 Letta 的 dreaming）。
- `tabellio mcp`：stdio 薄壳，宿主配置里默认只写这一行（`npx -y <pkg> mcp` 或本地路径）。壳启动时探测本地核心：活着→转发；不活→自己起（可选）或退化成**只读**模式并在 `initialize`/`instructions` 里明说。
- 为什么不是纯 A：宿主数量一旦 >3，「写并发 + 索引重复构建 + 每个宿主一份模型调用预算」就会变成常态成本，而官方 memory server 的锁代码一遍遍重写不划算（§2.1）。
- 为什么不是纯 B：stdio 是所有宿主的公共子集（Claude Code、Cursor、Cline、Zed、VS Code、Continue、Gemini、Codex、DSH 全支持），HTTP 则在这些宿主里配置各异且偶尔不通（沙箱）。壳是「最大公约数」，核心是「共享状态」。

### 5.2 代价（写清楚再动手）

1. 两套入口要各自测：MCP 全生命周期（stdlib 协议帧、stdin EOF 退出、取消）+ 本地 HTTP（鉴权、端口冲突、版本握手）。
2. 核心不在时的行为必须显式设计（只读退化 / 自动拉起 / 报错），否则用户看到的是「工具在但啥都写不进去」。
3. 老客户端连新核心的兼容矩阵要长期维护（§1.5 那张表），至少要留一个「legacy initialize 也能说话」的时代。
4. 本地 HTTP 是攻击面：只绑 127.0.0.1、token 文件 0600、禁止把 token 打进日志（Claude Code 文档里对错误详情都做了凭据 redact，可对照 `[CC]`）。

### 5.3 并发与数据层

- 单写者优先，其次才是跨进程锁；如果坚持 A，就把 §2.1 的锁语义照抄（独占创建 + 15s 刷新 + 30s 判死 + 60s 抢不到报错 + 明确不支持网络文件系统）。
- 「一个 MCP 客户端一个服务器进程」是宿主侧的既定行为（官方 memory server README 明写），我们不能假设只有一个进程。
- 写路径建议：追加日志（append-only）+ 周期性原子替换快照；读路径用只读快照，避免读被写阻塞。

### 5.4 作用域与一致性

- 数据模型里带 `scope`：`user`（跨项目）与 `project:<指纹>`（默认用 git origin，而非绝对路径——对照 `kenz1117/dsh-engram` 的 dual-scope：user + per-git-origin project，来源 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 的分类条目）。
- 项目级默认隔离 + 会话开始显式声明 scope（工具参数或 `instructions` 里写清），用户级写入需要显式开关——这样「在 A 项目里记住的东西」不会偷偷出现在 B 项目，而「我的偏好」又能跨项目。
- 跨宿主一致性靠**同一份库 + 同一套工具语义**，不靠同步：任何宿主看到的都是同一个核心；配置里只有「怎么连」不同。

## 6. 对我们意味着什么（5 条）

1. **只做 MCP + CLI 两个对外面**：不为任何宿主写代码适配；宿主差异最大只能影响我们「文档里的配置片段」和「首屏体验」，不能影响数据模型。
2. **协议栈必须 Dual-era**：`server/discover` 必做、legacy `initialize` 必留、2026-07-28 的新语义（`_meta` 版本协商 / `resultType` / MRTR）必须实现但不依赖客户端支持；Tools 是唯一所有宿主都认的特性，Resources/Prompts 只当加分项。
3. **工具 5±2、默认只读、输出可截断**：`search` / `read` / `remember`(写) / `list` / `status`，写工具独立且带 scope 与来源字段；任何返回都可能被宿主截断（Claude Code 25k token / 50k 字符，Gemini CLI 10 分钟超时），所以必须分页、必须给出「还有多少」。
4. **进程模型走混合，先把「写」的语义钉死**：常驻核心串行写 + stdio 薄壳；锁/并发/退化行为写进设计文档，不留给实现阶段临时决定。
5. **分发按主线+增量**：主线 = npm 包（stdio MCP）+ MCP registry 的 `server.json` 元数据（含 `mcp-name` 归属注释）；增量 = Claude Code 插件市场（自建 git，无审核）、DSH 黄页 `awesome-dsh-plugin`（PR + 逐条源码核对）、VS Code 市场（需要原生二进制时才值得做）。密钥一律走环境变量引用，永远不进配置文件明文。

---

`/Users/yangfu/yffto/memory-service/docs/03-hosts-and-interfaces.md` ｜ 行数：246 ｜ 推荐接口形态一句话：**一个 Dual-era 的 MCP 服务器（stdio 薄壳接所有宿主）+ 一个常驻本地核心（唯一写者，走 127.0.0.1 + bearer），工具面 5±2 个、默认只读、写入带 scope。**
