# 07 · 用法

`tabellio` 的 M1 是**命令行 + MCP**，没有后台进程、没有数据库、没有网络调用。
零运行时依赖：`node bin/memory` 直接就能跑，不需要 `npm install`。

- 要求：Node ≥ 20.11（实测 Node 25.8）。
- 库（store）就是一个目录：笔记是普通 `.md` 文件，`index/` 全是生成物、可删可重建。
- 默认库路径：`$MEMORY_STORE` / `$TABELLIO_STORE`，否则 `~/memory/tabellio`（改名前的 `~/memory/memory-service` 若已存在则继续沿用，stderr 会提一句）。

```bash
git clone <repo> memory-service && cd memory-service   # 仓库目录名，产品名是 tabellio
node bin/memory status                 # 建库 + 看一眼
node --test 'test/**/*.test.mjs'       # 全绿才继续（241 条）
```

## 一条事实一个文件

```markdown
---
kind: semantic          # core | semantic | episodic | procedural
trust: user_stated      # user_stated | system_derived | external
tags: [preference, tooling]
---

# 编辑器偏好

偏好用 acme-editor 写代码，缩进统一 2 空格。
```

`kind` / `trust` / `tags` 都可以不写（默认 `semantic` / `user_stated` / 无标签）。
正文上限 **400 字 / 200 token** —— 超了闸门会拒，并且告诉你超了多少。
超过一条事实该有的量，说明该拆成多条（`tabellio import` 会自动切）。

## 六个命令

`status` / `index` / `search` / `read` / `remember` / `import`（另有 `paths` 查路径）。

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

- `hits[].id` 就是**笔记文件名**（`read --id` 直接吃；评测的 `gold_notes` 也是这个名字）。
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
  `annotations.readOnlyHint:true`）；加 `--allow-write` 才多出 `remember`。
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
  runs/                      # 固化（consolidate）的收据，M2 用
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
| 0 | 成功（拒绝也是成功的回答 —— `search` 的 `refused` 和 `remember` 的 `deny` 都算） |
| 1 | 判定拒绝 / 库不健康（`read` 找不到、`remember` deny、`index` 有笔记走不到或 `stale`） |
| 2 | 用法错误（缺参数、命令不认识） |

`remember --json` 的 `ok` 与退出码一致：脚本里既可以读 JSON，也可以直接 `if`。
`index` 是**唯一**「状态正常但退出码可能非 0」的命令：`ok:true` 说的是「这次查询本身
成功了」，退出码说的是「索引健康吗」—— 这两件事分开表达是有意的，不然 CI 会把
一个瞎掉的索引当绿的。
