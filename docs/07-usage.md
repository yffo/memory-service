# 07 · 用法

`tabellio` 当前（M1 + M2：读取回执 / 巩固 / 撤销 / 候选闭环）是**命令行 + MCP**，没有后台进程、没有数据库、没有网络调用。
零运行时依赖：`node bin/memory` 直接就能跑，不需要 `npm install`。

- 要求：Node ≥ 20.11（实测 Node 25.8）。
- 库（store）就是一个目录：笔记是普通 `.md` 文件，`index/` 全是生成物、可删可重建。
- 默认库路径：`$MEMORY_STORE` / `$TABELLIO_STORE`，否则 `~/memory/tabellio`（改名前的 `~/memory/memory-service` 若已存在则继续沿用，stderr 会提一句）。

```bash
git clone <repo> memory-service && cd memory-service   # 仓库目录名，产品名是 tabellio
node bin/memory status                 # 建库 + 看一眼
node --test 'test/**/*.test.mjs'       # 全绿才继续（447 条）
```

## 一条事实一个文件

```markdown
---
kind: semantic          # core | semantic | episodic | procedural
trust: user_stated      # user_stated | system_derived | external
tags: [preference, tooling]
aliases: [acme-editor, 编辑器]  # 可选：作者给的同义说法，只参与身份核对
---

# 编辑器偏好

偏好用 acme-editor 写代码，缩进统一 2 空格。
```

`kind` / `trust` / `tags` / `aliases` 都可以不写（默认 `semantic` / `user_stated` / 无标签 / 无别名）。`aliases` 只参与身份核对（共现），**不是**检索的同义词扩展，不进 BM25 postings、不改打分。
正文上限 **400 字 / 200 token** —— 超了闸门会拒，并且告诉你超了多少。
超过一条事实该有的量，说明该拆成多条（`tabellio import` 会自动切）。

## 十四个命令

`setup` / `status` / `index` / `search` / `recall` / `explain` / `verify` / `consolidate` / `read` / `remember` / `capture` / `inbox` / `hook` / `import`（另有 `paths` 查路径）。

`setup` 只写宿主的 MCP 配置，不碰记忆库；`hook` 把 Claude Code 的会话结束事件接到候选箱（默认不装）；`capture` / `inbox` 是候选的**写入与批准**两端。`explain` / `verify` 是**回执（receipt）的读取端**：`recall` 可以把一次判断落成可核验的回执，之后再解释或复核，不需要重跑检索、不需要模型。`consolidate` 是**批量改元数据的入口**：默认只出计划，`--apply` 才动元数据，`--undo` 可撤销；`--merge` / `--summarize` / `--promote` 目前只出**内容类提案**，不写库。

`search` 与 `recall` 的分工：前者给**指针**（pull，读哪条由调用方决定），后者一步给出
**可直接进上下文**的正文（按 token 预算裁剪、带拒答）；两者都零模型调用。

### 1. `status` —— 先看账，再看库

```bash
$ node bin/memory status
库：/Users/you/memory/tabellio
笔记：1321 条（core 0）  |  索引：80 行 / 7529 字节（上限 200 行 / 25600 字节）
单条上限：400 字 / 200 token  |  库上限：20000 条
候选（notes/candidates）：0  |  账本：1325 条事件
解析失败：0  |  超长：11 条超 400 字、0 条超 200 token
⚠️  11 条笔记超过 400 字（检索按 400 字切桶）
```

`--json` 给机器读（冻结字段 `{store, notes, indexLines, caps}`，其余全是账）：

```bash
$ node bin/memory status --json
{"ok":true,"store":"<库路径>","notes":1321,"indexLines":80,
 "caps":{"notes":20000,"noteBytes":524288,"noteChars":400,"noteTokens":200,"indexLines":200,"indexBytes":25600},
 "indexBytes":7529,"indexExists":true,"indexTruncated":false,"indexHidden":0, ... ,"warnings":[...]}
```

**这里最重要的两个字段是 `indexTruncated` / `indexHidden`。** M1 时代索引是一屏平铺的清单，
200 行 / 25KB 装不下 1321 条 —— 实测只列得出 **127 条**，`indexHidden: 1194`。也就是说
「读索引」这条路**九成是瞎的**：翻开 `MEMORY.md` 的人会以为库里只有 127 篇。

M2 把索引改成**分层**（路由 `index/MEMORY.md` + 清单 `index/groups/*.md`），
一行从「一条笔记」变成「一个主题组」，于是同样 1321 条全部列得下：

```bash
$ node bin/memory index
库：<库路径>
索引：80 行 / 7529 字节（上限 200 行 / 25600 字节）  |  层级 2（路由 + 清单）
路由：72 组  |  清单文件：72 个  |  笔记：1321 条
列出的条数：1321/1321（走得到 1321）
```

无论哪一层，账都必须**如实报**：列不出来就报 `indexHidden` / `unreachable`，
不许静默截断（旧项目为此付过代价）。

`status` 默认只读。`--rebuild-index` 才会写 `index/`（且要过索引闸门）。
`--rebuild-index --json` 会额外给出 `indexWrite:{listed,hidden,truncated,reason}`。

### 2. `index` —— 索引这条路还瞎不瞎（M2 新增）

```bash
$ node bin/memory index --json
{"ok":true,"notes":1321,"exists":true,"lines":80,"bytes":7529,
 "caps":{"lines":200,"bytes":25600,"listLines":400},
 "levels":2,"groups":72,
 "routes":[{"name":"<组名>","rel":"groups/001-<组名>.md","count":200}, ...],
 "listFiles":[{"name":"001-<组名>.md","count":200,"bytes":58343}, ...],
 "listed":1321,"hidden":0,"reachable":1321,"unreachable":[],"unreachableCount":0,
 "missingFiles":[],"stale":false, "warnings":[]}
```

字段就三组账：

- **列了多少** —— `listed`（被列进清单的条数）/ `hidden`（没列进去的）。
- **走得到多少** —— `reachable`（能从 `MEMORY.md` 顺着走到正文的条数）/
  `unreachable[]`（走不到的 id，最多列 50 个）/ `unreachableCount`。
  `listed` 说的是「写进文件了吗」，`reachable` 说的是「路通吗」—— 路由层指向的清单文件
  被删掉时 `listed` 仍然好看而 `reachable` 才是真相，所以两个都要看。
- **索引是不是旧的** —— `stale`：`true` 表示路由层记的条数和库里的对不上（真相源改过没重建）。

退出码：**`stale` 或 `unreachableCount > 0` 时退出 1**，干净时 0。CI 里直接
`tabellio index --json > /dev/null` 就能当门禁用（索引健康是可机检的，
不该靠人记得去跑 `status`）。

`--rebuild` 重建索引并顺带报出写入账；默认只读。
索引是 `notes/` 的纯函数，删掉 `index/` 只损失时间不损失事实 —— 真出问题就重建。
**重建幂等**是可机检的不变量：删掉 `index/` 重建两次，结果必须一致（组按
`条数 desc, 组名 asc` 显式排序，不依赖 `Map` 插入序）。

### 3. `search` —— 检索（永远只读）

```bash
$ node bin/memory search --query "索引上限是多少行" --json
{"hits":[{"id":"reference-index-cap-lesson#150","title":"**教训第四十一条 · 「砍了多少」不等于「砍得疼不疼」** …","score":0.7128},
         {"id":"reference-index-cap-lesson#192","title":"**教训第七十四条 · 上限类护栏要三档 …","score":0.708}],
 "tokens":448,"refused":false,"reason":null}
```

- `hits[].id` 就是**笔记文件名**（`read --id` 直接吃；评测的 `source`（旧 schema 叫 `gold_notes`）也是这个名字）。
- `hits` 只有指针（id / title / score），正文要用 `read` 取 —— 这是「pull 优先」：
  召回不替你决定要看什么。
- `tokens` 是这次结果**实际占的预算**；`refused` 是正常结果不是错误：
  `{"hits":[],"tokens":0,"refused":true,"reason":"top_score_below_threshold"}` 表示
  「库里没有能支撑回答的东西」，此时**不要**退化成「列几条最像的」。
  另外五个 `reason`：`only_external_low_trust`（只有外部资料）/ `all_hits_expired`
  （都过期了，试 `--as-of`）/ `no_index` / `no_informative_term`（整条查询全是常用词，
  见下）/ `cooccurrence_required_pair_missing`（命中的近邻**只写了被问的一半** ——
  比如问了「Kestrel 的重试次数」，库里只有「同步失败重试 5 次」而 Kestrel 是另一家的，
  被问的那两样从没写在**同一篇**里；见 `06-architecture.md §5.5.3`）。
- 常用开关：`--budget-tokens N`（默认 500）/ `--kinds core,semantic` / `--trusts user_stated`
  / `--min-relevance F` / `--min-score F` / `--min-coverage F` / `--as-of YYYY-MM-DD` / `--ledger`。
  阈值可调是**评测纪律**要求的：不许在计分集上调参，所以要能把参数摆到命令行上。
  这些阈值传 `null`/空值一律**退回默认**，不会把闸门悄悄关掉（fail-closed）。

#### 为什么拒答能拦得住「沾边但不答」的问题

只靠 BM25 分拦不住这类问题：问「代理节点的数据库连接池上限是多少」，库里那篇
讲代理节点端口的笔记会因为 `代理 / 节点` 命中而拿到很高的分（实测 relevance 0.93），
于是系统一本正经地给出一条**答非所问**的「最像的」。真正拦住它的是**覆盖率**：

> 覆盖率 = 这句查询的信息量（按 idf × 词权重算）里，这篇笔记的某一个段落覆盖了多少。

实测 50 篇语料上：8 条拒答题覆盖率 0.34–0.64（均值 0.50），32 条可答题 0.48–1.00（均值 0.72），
默认闸门 `--min-coverage 0.6` 落在两组之间。两个设计细节：

- **分母取全库的 idf**，不取过滤后的语料。否则「库里恰好有一批笔记今天过期」就会
  改变同一句查询的结论 —— 表现是「昨天答得出来，今天同一句说没证据」。
- 语料不足 20 篇时改用保底闸 `0.25`：5 篇的库上 idf 没有统计意义，
  一个通用词就占 1/5 的 df，拿它判死会变成「小库什么都搜不到」。
- `search` / `read` 默认**什么都不写**（只读挂载、别人的库、评测跑批都必须无副作用）。
  想把这次检索记进账本（`index/ledger.jsonl`）就加 `--ledger`。

#### 覆盖率闸门有一个洞，M2 把它堵在**切词层**

覆盖率闸门假定「整条查询里至少有真词」。当查询里**一个真词都没有**时这个假定就塌了：
分母里活下来的只有常用词，于是「命中了任何一个常用词」就能把覆盖率顶到 1.0。真实库上
（1321 篇）的实测：

```bash
$ node bin/memory search --query "量子色动力学里的胶子禁闭" --json
# 切词：量子 子色 色动 动力 力学 学里 [里的] 的胶 胶子 子禁 禁闭
# 只有「里的」存在于语料（df 96/1321）⇒ 所有含「里的」的笔记 coverage = 1.000
# 结果：92 条命中、refused:false —— 库里没有任何一条与量子色动力学有关
```

根因在**切词器**：它把相邻二字一律生成，跨词边界就会拼出并不存在的词
（「闸门」+「的」→ `门的`；「闸门」+「的默认值」→ `的默`）。这些碎片是高频的，
存在感反而很强。M2 的修法是把它们**从源头掐掉**，不是事后打折：

- 结构助词（`CJK_BOUNDARY_CHARS = {的, 了, 是, 在, 和, 与}`）处把 CJK 串断开再取二元组 ——
  `门的` / `里的` / `的数` 这类碎片**根本不生成**（不是事后过滤，是不生成）。
  实测：`闸门的默认值是什么` 改前切出 `[闸门, 门的, 的默, 默认, 认值, 是什, 什么]`，
  改后是 `[闸门, 默认, 认值, 什么]`。

外加一道**证据性闸门**（`no_informative_term`）：整条查询的词项全都太常见
（每个词项的 df/语料条数都 > `INFORMATIVE_DF_RATIO = 0.05`）就拒答。
语料小于 `INFORMATIVE_MIN_DOCS = 200` 条时这道闸门**关闭** —— df/n 在 51 篇语料上
没有统计意义（一个普通词轻松占 1/5），拿它判死会变成「小库什么都搜不到」；
而拒答是破坏性的（「它说不知道，可我明明记过」）。所以它只在真实量级的库上生效。

**为什么不在打分层打折**：M1 试过按 idf 给高频词项打折，结果是真答案被一起压掉 ——
`recall@5` 从 0.844 掉到 0.563，已回退。教训是「这个词项是不是证据」是二值的、属于切词与
词表；「这个词项有多重要」才是权重。混成一个连续折扣，两者一起坏。

实测（`node bench/run-eval.mjs --same-corpus`，同一语料前后对比）：
`recall@5` 0.844 → **0.844**（真答案一条没掉）、`correct_refusal_rate` 0.125 → **0.750**
（刚好达标）、`injected_tokens_mean` 299.9 → **310.0**（阈值 500）。

### 4. `read` —— 取正文

```bash
$ node bin/memory read --id reference-index-cap-lesson#150 --json
{"id":"reference-index-cap-lesson#150","title":"**教训第四十一条 · …","body":"…"}
```

`{"id","title","body"}` 是冻结形状；后面还跟着 `ok`、`note`（完整 frontmatter）、
`warnings`、`path`。`--with-text` 会给原始文件全文。
找不到 / id 越界（`../../etc/passwd`、`notes/../index/MEMORY.md`）都是 `ok:false` + 非零退出码，
不会去读库外的东西。

### 5. `remember` —— 写入（过闸门）

```bash
$ node bin/memory remember --file /tmp/pref.md --json
{"ok":true,"verdict":"allow","reason":"ok","id":"01M5347ZHE2VPG2J95TZVV5BN8",
 "gate":"allow","status":"stored","path":"<库路径>/notes/01M5347ZHE2VPG2J95TZVV5BN8.md",
 "details":{"chars":39,"tokens":14,"mode":"create","fingerprint":"0923b399caa13f94"}}

$ node bin/memory remember --file /tmp/pref.md --dry --json
{"ok":false,"verdict":"deny","reason":"duplicate", ...,"details":{"existing_id":"01M5347ZHE2VPG2J95TZVV5BN8"}}
```

`--dry` 走**同一条判定**，只是不落盘（否则「先 dry 看看」就是骗人的）。
拒绝是正常结果（`ok:false` + 退出码 1），可能的 `reason`：

| reason | 含义 | 怎么办 |
| --- | --- | --- |
| `duplicate` | 同 scope 下已有几乎一样的笔记（8-gram 重叠） | 用 `details.existing_id` 去更新那条 |
| `too_long` / `too_many_tokens` | 超 400 字 / 200 token | 拆成多条；或改成**更短**的重写（缩小的重写永远放行） |
| `scope_forbidden` | 跨 scope 改写别人的笔记 | 换 id 或换 scope |
| `trust_violation` / `would_promote_external_to_instruction` | 外部资料想当事实/当规则 | 补本地验证，或改 `trust` |
| `destructive_rewrite` | 重写把一条事实改成了别的东西 | 新建一条 + `supersedes`，别覆盖 |
| `skip: too_short` / `chitchat` / `no_durable_content` | 不值得记 | 正常，接着干 |

**「缩小的重写永远放行」** 是闸门的第一条规则：只要新正文不比旧的字节数多，
长度/破坏性判定全部跳过。理由不是开后门 —— 一旦库超限，如果连「改小一点」都被拒，
就再也没有任何一次写入能把它降回来，闸门会把自己锁死。

### 6. `import` —— 从旧 Engramory 库导入

```bash
$ node bin/memory import --from ~/memory/engramory --dry --json
{"ok":false,"planned":1322,"sourceFiles":72,"imported":0,"updated":0,"skipped":0,
 "denied":0,"failures":1,"fragmentsDropped":8,"fragmentsChars":12,
 "not_imported":[{"file":"reference-some-note.md","code":"E_FRONTMATTER_MISSING"}]}
```

- 先 `--dry`：**一个字都不写**，只报计划。
- 旧库是「一个主题一大篇」，这里是「一条事实一个文件」：超过 400 字的长文按
  空行 → 行 → 句末标点自动切片，一篇变多条（实测 72 篇 → 1322 条）。
- **单向只读**：永远不写源库（旧插件可能还在跑）。
- **可重入**：`legacy.source_file` + `legacy.rev` 记着来源与内容指纹，
  重跑时没变就 `skipped`、变了就 `updated`，不会把同一条事实变成两份。
- **不猜**：没有 frontmatter 的旧文件不收（给它套默认元数据等于替用户认领一句
  他没说过的话），记进 `not_imported` 让人看一眼。
- 碎片（< 8 字的行）不送闸门（否则 `denied` 里全是本来就没打算要的东西），
  但**有账**：`fragmentsDropped` / `fragmentsChars`。

### 7. `recall` —— 一步取回可用上下文

```bash
$ node bin/memory recall --query "索引上限是多少行" --budget-tokens 500
```

`search` 返回指针（id / title / score），正文还要再 `read` 一次；`recall` 是**给回答层
用的那一步**：候选过滤 → BM25 → 拒答判定 → 预算裁剪，一次返回可直接拼进上下文的正文。
四步全确定性、零模型调用。

```bash
$ node bin/memory recall --query "索引上限是多少行" --budget-tokens 500 --json
{"ok":true,"status":"ok","refused":false,"reason":null,
 "items":[{"id":"...","title":"...","content":"<正文>","kind":"semantic","trust":"user_stated",
           "scope":"user","score":{"total":0.71,"relevance":0.79,"coverage":0.29,...},
           "why":"词法命中 …"}],
 "nearest":null,"tokens":341,"chars":767,
 "budget":{"requested":500,"used":341,"maxNotes":8,"dropped":[...]},
 "split":{"pull":2,"push":0},"truncated":true,"dropped":[…],"droppedCount":1,
 "skipped":{...},"candidates":137,"thresholds":{...},"scores":[...],"diagnostics":{...}}
```

- **`refused:true` 是正常回答，不是错误**：此时 `items` 为空、`reason` 说明为什么拒
  （`top_score_below_threshold` / `only_external_low_trust` / `all_hits_expired` /
  `no_index` / `no_informative_term` / `cooccurrence_required_pair_missing`），
  `nearest` 给几条「最接近但不作为证据」的候选，供人放宽阈值，**不许自动塞进上下文**。
- `tokens` 是这次实际占用的预算，不是请求值；`budget.dropped[]` 逐条记谁被裁、
  为什么（`low_trust` / `expired` / `maxTokens` 等），`truncated` 说的是有没有裁过。
- `items[].content` 已经是正文（不是指针）；`scores[]` 保留全部候选分数，便于归因
  「是没召回，还是召回了被裁」。
- 阈值可用 `--min-relevance` / `--min-score` / `--min-coverage` 覆盖；**调参是评测纪律问题**，
  默认值不允许在跑分集上动（见 `02-evaluation.md §6`）。

#### 回执：这次判断能不能被复核

`recall` 默认只返回结果；加 `--receipt` 会把这次的完整判断过程做成一张**回执**挂到返回值的 `receipt` 字段里（不写盘），加 `--save-receipt` 则同时原子写到 `<store>/runs/<receiptId>.json`（已存在同 id 时拒绝覆盖）。

回执里**没有正文**，每一条只记 `noteSha256`（正文含标题的 sha256 前 16 位）、元数据、分数与 `why`；查询原文、阈值、`coverageGate`、拒答决定、预算裁掉了谁、被忽略的候选及原因都在。整张回执的 `hash` 覆盖除自己以外的全部字段。所以回执可以贴进 issue / 日志 / 交接件，不复制笔记正文，但能证明「当时库是这个样子、检索是这样判的」。

> 回执里还有库的绝对路径（`verify` 用它提示「库不一致」）和查询原文；贴到 issue 前先看一眼。
>
> `hash` 是**防误改**，不是签名：能写这个文件的人可以改完重算 hash。要防伪造得等签名/密钥那一层。

```bash
$ node bin/memory recall --query "索引上限是多少行" --save-receipt --json
{..., "receipt": {"schema":"tabellio.receipt/1","receiptId":"rcp_...", ...},
 "receiptPath":"/path/to/store/runs/rcp_....json"}
```

回执是**读取回执**：它证明某次 recall 的输入与判断，不改库。巩固操作的 receipt 见下一节：`--apply` 落 `runs/<run>.json`，`--undo` 落 `.undo.json`。

### 8. `explain` —— 为什么给了它 / 为什么没给

两种用法，都只读：

```bash
node bin/memory explain --query "索引上限是多少行"        # 现场跑一次 recall，解释完就丢
node bin/memory explain --receipt rcp_...                # 读已保存的回执，不重跑检索
```

`--query` 模式会现场做一次 recall（不落盘，账本也不写），返回 `mode:"query"`、`explanation` 与 `verification`；`--receipt` 模式返回 `mode:"receipt"`、该回执的解释与核验结果。`--json` 的 `explanation` 形状：

- `summary`：纳入 / 未纳入 / 预算丢弃 / 最近候选 / 被忽略候选各多少条；
- `recalled`：纳入的条目，带分数拆解与 `why`；
- `notRecalled`：未纳入的候选，`reason` 是 `below_min_relevance` / `below_min_score` / `below_min_coverage` / `cooccurrence_missing` / `unknown` 之一；
- `dropped`：进了候选但被 token 预算裁掉的条目与原因；
- `nearest`：拒答时给人类看的最近候选（不是证据，不许自动进上下文）；
- `skipped` / `coverageGate` / `thresholds`：这次判断用的闸门参数。

`explain` 不调用模型，也不重新计算分数：它解释的是回执里已经记下的那次判断。若回执被改过，`verification.status` 会是 `tampered`；若笔记正文或元数据在回执之后变了，会是 `drifted`。

### 9. `verify` —— 回执有没有被改、库有没有漂

```bash
node bin/memory verify --receipt rcp_...
node bin/memory verify --receipt runs/rcp_....json --json
```

`verify` 做两层核对：

1. **回执自身**：按 `hash` 重算，确认字段没被改过；
2. **回执与当前库**：逐条比对 `noteSha256` 与元数据（`kind` / `trust` / `scope` / `status` / `valid_from` / `valid_to` / `superseded_by`）。

`status` 有四种：

| status | 含义 | 退出码 |
|---|---|---|
| `verified` | 回执未被改，引用到的笔记正文与元数据全部一致 | 0 |
| `drifted` | 回执本身没被改，但库变了（笔记被改 / 元数据变了 / 笔记被删） | 1 |
| `tampered` | 回执文件被改过，`hash` 对不上 | 1 |
| `invalid` / `unreadable` | JSON 坏了 / schema 不认识 / 文件读不到 | 1 |

`--json` 返回 `{ok,status,receiptId,checked,itemsChecked,nearestChecked,matched,changed[],missing[],problems[]}`。`changed[]` 里带 `fields` 与 `expected` / `actual`；`missing[]` 是回执引用了、但库里已经找不到的 id。`verify` 同 `explain` 一样不重跑检索、不调模型。

### 10. `consolidate` —— 巩固：默认只出计划，改了账，能撤销

巩固是**唯一的「改」入口**，但热路径永远不调用它。当前实现两种**元数据**操作，正文一个字不改；另有三种内容类操作（merge / summarize / promote）只到提案层，见本节末尾。

- `invalidate`：B 的 frontmatter 里有 `supersedes: [A]`，A 还 `active`、没有 `valid_to`、没有 `superseded_by`、
  且在 now 之前已生效 → 把 A 的 `valid_to` 写成当前时间、`superseded_by` 写成 B 的 id。**正文一个字不改**；
  历史 `as_of` 查询仍能查到 A，所以既可追溯也可撤销。
- `archive`：显式点名 `--archive <id>`（可重复，也可用逗号分隔，自动去重），把一条仍然 `active`、
  没有 `valid_to`、没有 `superseded_by`、且在 now 有效的笔记的 `status` 改成 `archived`。
  **不写 `valid_to` / `superseded_by`**，正文也一个字不改。它不依赖 `supersedes`，不是自动衰减；
  默认检索面会排除 `archived`，`as_of` 也不会把它翻回来（这一点与 invalidate 不同），
  只能用 `--undo` 恢复，或按 id 读回。

```bash
node bin/memory consolidate                       # 默认 dry-run：只打计划，不写文件、不改库
node bin/memory consolidate --json                # 计划 JSON
node bin/memory consolidate --apply               # 真改：先写计划，再改元数据，最后写回执
node bin/memory consolidate --apply --max-change-ratio 0.1
node bin/memory consolidate --scope project:... --kinds semantic,procedural
node bin/memory consolidate --archive <id>        # 只归档指定笔记，默认仍是 dry-run
node bin/memory consolidate --archive a,b --apply # 可逗号分隔；重复 --archive 会去重
node bin/memory consolidate --undo run_...        # 撤销某个 run
```

**5% 保险丝**：`allowed = max(1, floor(扫描条数 × max_change_ratio))`，默认 0.05。
invalidate 与 archive 共用这个上限，一起算；超过就整单中止，一条都不动
（小库至少允许 1 条，否则 10 条库上永远改不动）。
`--dry-run` 与 `--apply` 互斥；`--undo` 也不能和它们或 `--archive` 同用。

同一条笔记同时被 `supersedes` 和 `--archive` 点名时，invalidate 优先，archive 报 `already_planned`。
目标不存在、解析失败、非 `active`、已有 `valid_to` / `superseded_by`、在 now 尚无效，
或已被 `--scope` / `--kinds` 过滤掉（`target_out_of_scope`），都会跳过并在 `skipped[]` 里报原因。

`--json` 的主要字段：

- dry-run / aborted：`{ok,status,run_id,dry_run,operations[],skipped[],stats:{scanned,planned,invalidate,archive,allowed,change_ratio,est_tokens},options}`；
- apply 成功：`{ok,status:"applied",run_id,plan_path,receipt_path,applied,skipped,reversible:true,operations[],receipt,stats}`；
- 保险丝中止：`{ok:false,status:"aborted",reason:"change_ratio_exceeded"|"plan_write_failed"|"receipt_write_failed",...}`；
  `receipt_write_failed` 会把已经改掉的元数据回滚，并报 `rolled_back`。

每次 `--apply` 在 `runs/` 下留两个文件：`<run>.plan.json`（决策）与 `<run>.json`（巩固回执，
含前后元数据与正文 hash，**不含正文**）；撤销成功后再多一个 `<run>.undo.json`。
回执写不进去时本次 apply 视为失败并回滚 —— 「改了但没账」是不允许的状态。

`--undo` 先全量预检再动手：只要有一条笔记的正文 hash 对不上，或当前字段既不是回执里的 `before`
也不是 `after`，就整单拒绝，不做部分撤销。状态：

| status | 含义 | 退出码 |
|---|---|---|
| `undone` | 全部恢复，并写撤销记录 | 0 |
| `already_undone` | 之前撤过，本次什么都不做 | 0 |
| `conflict` | 库在 apply 之后又被改过，整单不恢复 | 1 |
| `tampered` | 回执被改过，拒绝执行 | 1 |
| `partial` / `undo_record_write_failed` | 恢复中途写失败，如实报已恢复的条目 | 1 |
| `unreadable` | run 找不到 / JSON 坏 / schema 不认识 | 1 |

archive 的 undo 只把 `status` 恢复成 `active`；它本来就没写过 `valid_to` / `superseded_by`，
所以不需要（也不应该）动这两个字段。

#### 内容类提案：`--merge` / `--summarize` / `--promote`

这三种操作会新增或压缩事实，所以执行层还没开。当前只做**显式源 id 的提案**：读库、出草稿，
**不写任何文件**——没有 run 文件、没有回执、没有候选落盘。源必须由人点名，不做自动发现。

```bash
node bin/memory consolidate --merge <id>,<id>          # 至少 2 条；同 scope、同 kind
node bin/memory consolidate --summarize <id>           # 恰好 1 条；正文至少 200 字
node bin/memory consolidate --promote <id>,<id>,<id>   # 至少 3 条；同一 scope，valid_from 跨至少 2 个日期
node bin/memory consolidate --merge <id>,<id> --json   # 提案 JSON，默认就是 dry-run
```

- **merge**：把各源正文按段落去重后拼接，标题是 `# 合并提案：...`，末尾注释带源 id；
  目标路径是 `notes/<新 id>.md`。
- **summarize**：按段落取首句（每句最多 160 字），标题是 `# 摘要提案：...`；
  目标路径是 `notes/<新 id>.md`。如果源本来就是一句一段，草稿不会更短，会报 `draft_not_shorter`。
- **promote**：产出「候选规则」脚手架（`## 观察` + `## 待人工归纳`），**不是规则**；
  目标路径是 `notes/candidates/<新 id>.md`，默认检索面不会包含它。

三种目标都带 `status: draft`、`requires_review: true`、`apply_supported: false`；merge / summarize 的
`supersedes` 指回源 id，promote 的 `supersedes` 为空。任一源缺失、解析失败、非 `active`、已有
`valid_to` / `superseded_by`，或在 now 尚无效，整单 `source_invalid`，不会静默丢掉坏源。

`--json` 成功返回：
`{ok:true,status:"proposed",proposal_id,mode,dry_run:true,apply_supported:false,would_write:false,target_id,source_ids,sources,skipped,target,warnings,stats,next_action}`；
拒绝返回 `{ok:false,status:"rejected",reason,...}`。`stats` 里有源/目标的字数与 token、预计省下多少、
`estimated_write_ops` 与 `estimated_change_ratio`；`warnings` 会报源之间重叠过低、草稿超过 400 字、
草稿没变短、预计改动率超过 5% 等。

**边界**：`--apply` 对内容类操作直接退 2（明说「执行层未实现」）；它不能和 `--archive` / `--undo` /
其他内容模式同用，也不接受 `--max-change-ratio` / `--scope` / `--kinds`。当前没有自动发现、
没有 LLM 摘要、没有真正写 note、没有归档源，也没有内容类回执。

**还没做**：`merge` / `summarize` / `promote` 的**执行层**（真正写新 note、归档源、写内容类回执）、
replay、forget、写入回执、后台自动巩固、`diff.jsonl`。已实现的写操作只碰元数据；
内容类只出提案，不新增/压缩事实。

### 11. `setup` —— 一条命令给宿主写 MCP 配置

```bash
$ node bin/memory setup                          # 默认 dry-run：只打印会改哪些文件
$ node bin/memory setup --write                  # 真写；写前备份
$ node bin/memory setup --write --verify         # 写完用宿主自己的命令验证
$ node bin/memory setup --verify                 # 只验证现状，不改配置
$ node bin/memory setup --host cursor --read-only --write
```

支持三家，路径固定：

| host | 文件 | 写法 |
| --- | --- | --- |
| `claude` | `~/.claude.json` | 顶层 `mcpServers.tabellio` |
| `cursor` | `~/.cursor/mcp.json` | 顶层 `mcpServers.tabellio` |
| `codex` | `~/.codex/config.toml` | `[mcp_servers.tabellio]` 段 |

- `--host` 可重复/逗号分隔，默认 `all`。`all` 只处理**已安装**的宿主（配置文件或父目录存在）；显式点名可以创建不存在的文件。一个都没检测到返回 `no_host_detected`，退 1。
- 生成的 server 是 `{command: <当前 node>, args: [<bin/memory-mcp 绝对路径>, "--store", <库路径>, "--allow-write"]}`；不依赖 PATH，宿主从任意目录都能起。`--read-only` 去掉 `--allow-write`。
- **默认 dry-run**；`--write` 才落盘。JSON 原子写，TOML 只替换 `[mcp_servers.tabellio]` 及其子表，其他段和注释保留。
- 写入前备份成 `<文件>.tabellio-backup-<紧凑 ISO 时间戳>`；已经是同一份配置则 `unchanged`，不重复备份。
- 已有**不同**的 `tabellio` 配置：默认整单 `conflict`、一份都不写；`--force` 才覆盖。JSON/TOML 解析失败也是整单 `invalid_config`，不写半份。
- 退出码：成功/已存在 0；冲突、无宿主、解析失败、写失败、`--verify` 明确失败 1；参数缺值 2。

`--json` 的计划里有 `{ok, reason, dry_run:true, hosts:[{host,label,path,kind,action,ok,exists,current,desired,read_only,would_write,backup,preview}], server, store, mcp_bin, command}`；`action` 是 `create|append|update|unchanged|conflict|invalid`。`--write` 后额外有 `{dry_run:false, applied:[{host,path,action,written,backup}], failed:[]}`。

**`--verify`：让宿主自己回答「连上了吗」**

配置写对不等于宿主连上。

- Claude Code：跑 `claude mcp list`，只有宿主输出 `✓ Connected` 才是 `connected`；报 `Failed to connect` 是 `failed`。
- Codex：跑 `codex mcp list`，看到 `tabellio ... enabled` 只算 `configured`——这条命令不 spawn server，不能冒充「已连接」。
- Cursor：没有无头 MCP 健康检查，固定报 `unverified`，请到 Cursor 的 MCP 设置里确认。
- 宿主 CLI 没装/不在 PATH：`unavailable`，**不算配置失败**，退出码仍是 0。
- `failed` / `missing` 才让退出码变 1；`--verify` 失败**不会回滚**已经写入的配置。
- 验证时用配置文件的临时副本（Claude Code 的 `mcp list` 会写备份），不碰用户的真实配置。

JSON 里额外多出：

```json
{
  "verification": {
    "ok": true,
    "checked": 1,
    "hosts": [
      {
        "host": "claude",
        "label": "Claude Code",
        "config_path": "~/.claude.json",
        "level": "connected",
        "ok": true,
        "detail": "claude mcp list：✓ Connected",
        "binary": "/opt/homebrew/bin/claude",
        "connection_checked": true
      }
    ]
  }
}
```

`level` 取值：`connected` / `configured` / `unverified` / `unavailable` / `failed` / `missing`。

> DSH 的 `~/.dsh/cordis.patch.yml` 是 YAML loader patch，零依赖改写的风险高于收益，`setup` 不碰它；要接 DSH 请按 `docs/03` 手工加片段。

### 12. `capture` —— 把线索收成候选（不静默入库）

```bash
$ printf '%s\n' '# 发布流程' '' '发版前跑 npm test 和 node bench/run-eval.mjs。' \
  | node bin/memory capture --file - --source "session:2026-10-18" --json
{"ok":true,"id":"01M...","title":"发布流程","created":"2026-10-18T...","source":"session:2026-10-18",
 "chars":38,"kind":"semantic","trust":"system_derived","scope":"user",
 "path":"<库>/notes/candidates/01M....md","written":true}
```

- `--file <path|->` 必填，`-` 从 stdin 读。`--source` 记进 `provenance.source_ref`，`--kind` / `--tags` / `--id` 可覆盖默认值；`--dry` 走同一套检查但不落盘；`--force` 跳过重复检查。
- 候选强制 `status:draft`、`trust:system_derived`、`provenance.written_by:capture:cli`——输入里写 `active` / `user_stated` 也不会改变这个身份。**不重建主索引**，默认检索面看不到它。
- 正文上限 **8KB**；空文本、非法 id、主库或候选里已有同 id、内容指纹重复都会拒（重复可用 `--force` 绕过；`id_exists` 不行）。拒绝是正常结果，`ok:false` + 退 1；参数缺值退 2。
- `reason` 固定为 `empty|too_large|invalid_id|id_exists|duplicate|store_write_failed`；重复时附 `duplicate_of:{id,kind}`。
- **它本身不监听会话**：`capture` 是显式原语，宿主或脚本要自己调用。自动候选来自下一节的 `hook install`——只支持 Claude Code、默认不装、只抓用户发言里的显式线索，且只写候选。

### 13. `inbox` —— 人批准后才进主库

```bash
$ node bin/memory inbox                          # 只读列表
候选 2 条（notes/candidates，默认不进检索面）：
  [01M...] 发布流程 — session:2026-10-18 / 38 字 / 2026-10-18T...
批准：tabellio inbox --accept <id>   拒绝：--reject <id>

$ node bin/memory inbox --accept 01M... --json   # 走 remember 同一条闸门
$ node bin/memory inbox --reject 01N... --dry    # 只预览
```

- 不带 `--accept` / `--reject` 时只读列候选，按创建时间倒序；JSON 是 `{ok:true,count,candidates:[{id,title,created,source,chars,kind,trust,scope,path}]}`。
- `--accept` / `--reject` 可重复或逗号分隔；同一 id 同时出现在两边时整单拒绝（`accept_reject_overlap`）。
- 批准时把候选改成 `active`，走与 `remember` **同一条写入闸门**（去重/400 字/200 token/信任分级），通过后写 `notes/<id>.md`、候选移到 `notes/candidates/decided/`；拒绝只移到 `notes/candidates/rejected/`。两边都保留审计，不删文件。
- 批量里的失败**不中断**其余项；只要有失败就 `ok:false`、退 1，并在 `failed` 里给 `{id,action,reason,details?,note_stored?}`。`note_stored:true` 表示「笔记已入库，但候选归档失败」，重试会走出覆盖更新，不会产生第二份。
- `--dry` 用同一套闸门返回 `planned`，不写 note、不移动候选。
- JSON 是 `{ok,dry_run,accepted,rejected,failed,accepted_count,rejected_count,failed_count}`；`accepted[]` 的 `status` 是 `stored|planned`，`rejected[]` 是 `rejected|planned`。
- 索引只在真有批准写入时重建一次；只拒绝不重建。`status` 的「候选」计数与「N 条候选待处理」警告读的就是这个目录。

### 14. `hook` —— Claude Code 会话结束时生成候选（默认不装）

```bash
$ node bin/memory hook install --host claude            # 默认 dry-run：只打印会改哪个文件
$ node bin/memory hook install --host claude --write    # 写入 ~/.claude/settings.json
$ node bin/memory hook uninstall --host claude --write  # 只移除 tabellio 自己的钩子
```

它解决的是「每次都要用户提醒它沉淀」：Claude Code 退出/结束时，宿主把 `SessionEnd` 事件
（含 `transcript_path`）交给 `tabellio hook claude-session-end`，后者从**本次会话的用户发言**
里找显式线索，生成候选。**不写正式库**，批准仍在 `inbox`。

- **只支持 Claude Code**（本机 2.1.142 实测）。Cursor 没有等价的无头会话结束钩子，Codex 也没有；
  不伪造支持，装其他宿主会退 1。
- **默认不装、默认 dry-run**；只改 `<home>/.claude/settings.json` 的 `hooks.SessionEnd`，
  保留用户的其他钩子、`env` 和其他字段。写前备份成
  `settings.json.tabellio-backup-<紧凑 ISO 时间戳>`；JSON 原子写；新文件 mode `0600`。
- 钩子用 exec form：`{type:"command", command:<当前 node>, args:[<bin/memory>, "hook",
  "claude-session-end", "--store", <库>], timeout:15}`。不依赖 shell 引号，也不依赖 PATH。
- 已有指向**别的 store**的 tabellio 钩子时默认 `conflict`、一份不写；确认替换加 `--force`。
  坏 JSON / 不认识的 `hooks.SessionEnd` 结构整份不写。
- `--json` 输出计划/结果；**不会输出整份 settings**（里面可能有宿主 env 凭据）。
  `action` 取值：`create|append|update|unchanged|uninstall|conflict|invalid|unsupported`。

**抓什么、不抓什么**

- 只读 `transcript_path` 指向的当前会话 JSONL；只取 `type:"user"`、`message.role:"user"`、
  非 sidechain / meta / compact-summary 的真实用户文本；跳过 `tool_result`、队列事件和
  `<system-reminder>` / 本地命令注入。
- 只抓**显式线索**：`记住/帮我记/别忘了`、`以后/今后都…`、`我/我们 + 喜欢/偏好/习惯/讨厌`、
  `我/我们 + 决定/约定/说好`、`始终/总是/一律/默认 + 用/按/不要`、`改用/别再/不要用`，
  以及英文 `remember / from now on / I prefer / we decided / please always / never`。
- 跳过问句和假设句（「要不要」「是否」「吗」）、太短的句子，以及命中密钥模式的整句
  （`sk-…`、`ghp_…`、`AKIA…`、私钥、Bearer、`password/token/密码: …` 等）。
  这是**尽力而为的过滤，不是 DLP**；候选里仍可能有敏感内容，装之前先想清楚。
- 每会话最多 **3 条**；同一句去重；候选正文带一个 `# 会话记忆：…` 标题，正文是原句。
  `source` 为 `claude:session-end:<session_id>`，`written_by` 为 `capture:hook`。
- 不调用模型、不联网、不做摘要、不自动合并；漏报和误报都会有。它只负责把候选放进
  `notes/candidates/`，不重建主索引。

**内部命令与失败语义**

`tabellio hook claude-session-end` 是给宿主调用的，不面向日常使用：

- 从 stdin 读 `SessionEnd` 事件；只有 `--json` 才输出，默认静默。
- 事件坏、没有 `transcript_path`、文件不存在/读不了：`ok:false` + `reason`，
  **始终退 0**——钩子不能阻塞宿主退出；用法错误才退 2。
- 有候选时才打开库并逐条 `addCandidate`；重复/超长是正常 `rejected`，不算命令失败。
- 安装/卸载的退出码：成功/dry-run/`unchanged` 0；冲突、坏配置、写失败、未知宿主 1；参数缺值 2。

**真实宿主证据**

`test/hook-claude-e2e.test.mjs` 用真实 `claude`（`TABELLIO_HOOK_E2E=1` 才跑）在临时
`settings.json` 上验证：钩子被调用、exec form 被接受、候选落盘、主库 `notes=0`。
本机在 Claude Code 2.1.142 的 `-p` 会话里实测通过（未登录时 API 会报错，但 `SessionEnd`
仍触发——这恰好说明钩子不依赖模型回答）。不碰真实 `~/.claude/settings.json`。

**边界**

只有 Claude Code；没有定时/后台触发，没有跨会话批量重放，没有自动巩固；它不是「自动记住一切」，
只是把「会话结束时该问用户一句要不要记」变成候选箱里的一条待审记录。卸载只移除 tabellio 的钩子，
不删候选、不删已有记忆。

## 评测（开发用，可零模型）

```bash
node bench/run-eval.mjs --same-corpus            # 判据 1：三臂同语料，零模型
node bench/run-eval.mjs --dry                    # 只验评分路径，不调 CLI
node bench/judge-adversarial.mjs                 # 判分器对抗集 106 条，零模型
```

- 判据 1 用默认的 `echo` 回答器即可；判据 2/3 的回答层必须显式加 `--answerer llm` 并提供
  `EVAL_LLM_API_KEY` 或 `DEEPSEEK_API_KEY`，结果不进 CI。
- 判分器支持题级 `answer_aliases`（原 32 道可答题已补）；对抗集用来确认它「该收的收、该拒的拒」，
  通过门槛是误收率 < 20%、正确接受率 ≥ 95%。详细口径见 `docs/02-evaluation.md §4.6.2` 与
  `docs/08-eval-runbook.md §6.4`。
- 题集 56 题已标 `capability`（六类），其中 4 道 `negative_transfer` 陷阱题带 `negative_transfer_probe`；
  `run-eval` 会按能力分表并报 `trap_fall_rate`。零模型 `echo` 口径当前 4 题里 1 题落入（0.25，压线），真模型回答层是 0/4；分母太小，只当方向。
- 2026-10-18 修正注入计量后用真实模型重测（56 题 / deepseek-flash / 3 轮，top-5）：acc closed_book **0.357** / real **0.786** / oracle **0.893**；`negative_transfer = −0.429`；实际注入 **166.2 token/题**，回答层 `token_efficiency = 2.579`，**判据 2 成立**。报告 `bench/core-30-v1/runs/2026-10-18-answer-56-k5.md`。`--inject-k 2` 裁到 top-2 后 real **0.792** / 注入 **70.3** / 效率 **6.182**，报告 `bench/core-30-v1/runs/2026-10-18-answer-56-k2.md`，是更省的运行点；默认仍 top-5。旧 1.611 是把 CLI top-8 候选预算当实际注入的计量错误，已作废；1.408 是补别名前 52 题下界。

## MCP（给 Agent 用）

```bash
node bin/memory-mcp --store ~/memory/tabellio                  # 只读
node bin/memory-mcp --store ~/memory/tabellio --allow-write
```

stdio、一行一个 JSON-RPC 消息、stdout 只有协议字节（日志走 stderr）。
同时实现两代协议：**现代** `server/discover`（2026-07-28，无握手、无会话）与
**传统** `initialize`（2025-11-25）。两代客户端都能连。

```bash
$ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"server/discover"}' \
                '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node bin/memory-mcp | python3 -c 'import json,sys
for l in sys.stdin:
    d=json.loads(l)
    if d.get("id")==2: print([t["name"] for t in d["result"]["tools"]])'
['search', 'read', 'list', 'status']
```

- 工具面：`search` / `read` / `list` / `status`（默认只读，四个都带
  `annotations.readOnlyHint:true`）；加 `--allow-write` 才多出 `remember` 与 `capture`
  （共 6 条，仍在「5±2」预算内）。
- `remember` 直接写正式记忆；`capture` **只写候选**，不重建主索引、不进检索面，
  返回候选 id 并提示人运行 `tabellio inbox` 批准。Agent 可以主动丢候选，但批准权不交给它。
- `search` 只回指针（不含 `body`），正文用 `read` 取 —— 与 CLI 同一套语义。
- `list` 用 `limit` + `cursor` 翻页，`structuredContent` 回 `{items, total, next_cursor}`，
  正文里还会写一句人话「共 N 条，本次 M 条，下一页 cursor=…」。
  **游标由服务端给**（就是「下一条的 id」）：宿主会截断大 payload，所以「还剩多少、
  下一页从哪开始」必须由我们说，不能靠客户端自己数。没有 `next_cursor` 就是到头了。
- 参数不合规（缺 `query`、id 越界）返回 `result.isError:true`，不是 JSON-RPC 错误 ——
  协议错误会让客户端重试或放弃，工具错误才是「这次调用没成功」。

## 库的布局

```
<store>/
  notes/<id>.md              # 唯一真相源（手写、git 管、备份都只针对它）
  notes/candidates/          # 待审的候选（不参与默认检索）
  index/MEMORY.md            # 生成物：路由层，一行一个主题组（受 200 行 / 25KB 限制）
  index/MEMORY.md.bak        # 上一次的索引
  index/groups/<序号>-<组名>.md  # 生成物：清单层，一组一行指针（每文件 ≤ 400 行，超过分页不截断）
  index/stats.json           # 上次扫描的统计（读不完/解析不了的东西都在这）
  index/ledger.jsonl         # 追加型事件账本（写入/跳过/拒绝/索引闸门）
  runs/                      # recall 回执 runs/rcp_....json；巩固 run 的 .plan.json / .json / .undo.json
```

`index/` 全是 `notes/` 的纯函数：删掉它只损失时间，不损失事实。

```bash
rm -rf ~/memory/tabellio/index && node bin/memory status --rebuild-index
```

**组是什么**：笔记 id 里第一个 `#` 之前的部分（`reference-x#137` → 组 `reference-x`）。
真实库 1321 篇落在 72 个组里，所以路由层 72 行就装得下 —— 一行一个组、
一行一条笔记的旧形态装不下 1321 条。为什么按 id 而不是按 `kind`/`tag`：`kind` 只有
4 个组、每组几百条，路由层装得下但清单层一个文件装不下，等于把问题往下推一层；
id 前缀是人写文件时形成的天然主题，组数与组内条数都在「人扫得动」的量级。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（拒绝也是成功的回答 —— `search` 的 `refused`、`remember` 的 `deny`、`inbox --reject` 的成功拒绝都算；`setup` 的 dry-run / `unchanged`、`hook` 的 dry-run / `unchanged`、内部 SessionEnd 命令的错误也都算） |
| 1 | 判定拒绝 / 库不健康 / 回执或巩固失败（`read` 找不到、`remember` deny、`capture` 拒收、`inbox` 有失败项、`index` 有笔记走不到或 `stale`、`verify` 不是 `verified`、`recall --save-receipt` 落盘失败、`consolidate` 中止或 `undo` 冲突/被篡改、`setup` 冲突/无宿主/解析失败、`hook install` 冲突/坏配置/未知宿主） |
| 2 | 用法错误（缺参数、命令不认识） |

`remember --json` 的 `ok` 与退出码一致：脚本里既可以读 JSON，也可以直接 `if`。
`explain` 只要回执/查询能解析就退 0（漂移写在 `verification` 里）；参数互斥或缺失才是 2。`verify` 只有 `verified` 退 0，`drifted` / `tampered` / `unreadable` 一律 1 —— 这样 CI 里 `verify` 可以直接当断言用。
`index` 是**唯一**「状态正常但退出码可能非 0」的命令：`ok:true` 说的是「这次查询本身
成功了」，退出码说的是「索引健康吗」—— 这两件事分开表达是有意的，不然 CI 会把
一个瞎掉的索引当绿的。
