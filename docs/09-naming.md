# 09 · 命名调研：候选清单与判据

> **已定名 `tabellio`（2026-10-17，杨总拍板）** —— npm 包名 / CLI 命令用 `tabellio`，MCP 注册名 `io.github.yffo/tabellio`；本文其余内容为定名前的一手实测记录，保留不删。

这份文档只回答四件事：**哪些名字能用**、**推荐哪三个**、**哪些被砍了为什么**、**我到底查了什么**。
名字的气质要对得上产品：文件是唯一真相源、写入过闸门、成本可审计 —— 也就是「**谁对这条记忆的真实性负责**」。

- 调研日：2026-10-17。表里每个占用结论都是当日**实测**的原始返回，命令见 §6，没实测过的名字不进表。
- 候选来源：先定语义域（罗马文书 / 封印 / 档案登记 / 校勘代号 / 自造复合词），再逐名实测四道占用。
- 全文「未核」= 我没有渠道核实，不许当已核实用。

## 0. 结论速览

- 四道占用（npm / `.dev`+`.io` 域名 / MCP Registry / GitHub 同赛道同名）**全空**的只剩小众词：**tabellio、sigillum、accession**。
- 最该避开的一类：**「记忆-真相」通用词 + 档案账本类拉丁/英文词**。前者（engram / mnemos / memex / keep / ledger / scribe / vellum）早被占满；后者（repertory / diarium / plainmem / registrum / tabularium / cartulary / memoranda）正被同赛道按周抢注，其中 `memoranda.dev` 的标语已经是 *"memory that carries its receipt"* —— 和我们的主张一字不差。
- 命名窗口在关：2026-04 至 10 月，本赛道至少 9 个名字被占用或**预留**（§5）。定名当天就要占位。

## 1. 候选表（12 个，占用全部为 2026-10-17 实测）

| 名字 | npm 占用（实测） | MCP Registry / 域名占用（实测） | 含义与记忆点 | 风险 |
|---|---|---|---|---|
| **tabellio** | `FREE`（registry 返回 404） | MCP 搜 `tabellio` 0 命中；`tabellio.dev` / `.io` / `.sh` 三个都 404 可注册；GitHub 同名 17 个，最高 1★（`Samuelbcl/tabellio` 0★ TS 空仓） | 罗马的**契约代书人**：在公开场合替人立契、且必须留存副本以备核验 —— 这个职业本身就是「谁对真实性负责」 | 4 音节；双 `l` 易错拼；商标未核（web3 圈另有同名项目，需限类） |
| **sigillum** | `FREE`（404） | MCP 搜 `sigillum` 0 命中；`sigillum.dev` / `.io` / `.sh` 全 404；GitHub 同名 45 个，最高 `piuma/sigillum`（10★，文档签名/时间戳桌面应用） | 拉丁语**火漆封印**：谁盖印谁负责；与架构里的 sha256 receipt 同构（每笔改动留一道印） | 语义张力：封印=封起来不给看，而我们的卖点是明文可 `cat`、可 git；另有同名签名工具分流搜索 |
| **accession** | `FREE`（404） | MCP 搜 `accession` 0 命中；`accession.dev` / `.io` / `.sh` 全 404；GitHub 296 个但几乎全是生物信息（`abedra/accession` 42★ 2011 Clojure） | 博物馆/档案馆的**入藏登记**：每件藏品给一个 accession number 并记来源，日后任何调取都答得出「谁、何时、依据什么」 | **ACCESSION 是活商标（WIPO 1698035，LIVE；美国另有申请 79356181，Accession Healthcare Consulting）→ 商用前必须补全类检索**；双 `c` + 双 `s` 拼写坑 |
| **memproof** | `FREE`（404） | MCP 搜 `memproof` 0 命中；`memproof.dev` / `.io` 404；GitHub 仅 2 个同名仓（0★，`sonoflawal/memproof`） | mem + proof：把核心主张直接写进名字（凭据/回执是架构里已有的一等对象） | mem- 前缀拥挤（`mem0`/`memini`/`memvault`…）；像功能名不像品牌，显著性低 |
| **notarius** | `FREE`（404） | MCP 搜 `notarius` 0 命中；`notarius.dev` / `.io` 404；GitHub 125 个（`openalgz/notarius` 4★） | 罗马**公证人/书记**：真实性的具名责任人（`notarius` 是 `notary` 的拉丁原形） | 与 notary 家族（Docker Notary、Sigstore Notation）易被当成签名工具；4 音节 |
| **titulus** | `FREE`（404） | MCP 搜 `titulus` 0 命中；`titulus.io` 404，但 **`titulus.dev` 已被注册（2026-01-16，Porkbun LLC）**；GitHub 27 个（`titulus/test.it` 46★） | 罗马贴在物品上的**题铭标签**：写明「这是什么、属于谁」= provenance 的最小单位 | 主用域名之一已被占；含义只覆盖「标注」，不含闸门与检索 |
| **mingke**（铭刻） | `FREE`（404） | MCP 搜 `mingke` 0 命中；`mingke.dev` / `.io` 404；GitHub 41 个同名仓全是无关（输入法/名客） | 拼音路线：中文用户一眼懂（**铭刻**进记忆），英文也念得出 ming-ke | 英文受众零共鸣、看不出是记忆服务；拼音品牌基本无法出海 |
| **stead** | `FREE`（404） | MCP 搜 `stead` 命中 `app.steadywrk/mcp-dispatch` 等（不同名、不同赛道）；**`stead.dev` 已被注册（2019-02-28，Squarespace）**；GitHub 4442 个（STEAD 缩写 + steadfast 满天飞） | 「替它的位置 / 顶住」= a steady place for memory | 与 steady / STEAD 家族混淆严重；域名被占 7 年 |
| **siglum** | `FREE`（404） | **MCP 命中 `com.siglume/mcp-gateway`**（品牌 Siglume，GitHub `taihei-05/siglume-api-sdk` 8★）；**`siglum.dev` 已被注册（2026-07-07，Dynadot LLC）**；`siglum.io` 404 | 校勘学里给每份抄本的**专属代号**：证据可被引用、可被核对 | 域名 + 近似品牌双撞，且撞的是 MCP 相关品牌 |
| **chancery** | `FREE`（404） | MCP 命中 `io.github.thechancerylaneproject/tclp-mcp`；**`chancery.dev` 已被注册（2026-08-23，Namecheap）**；**GitHub `chanceryhq/chancery`（26★，Go，2026-07）= "identity provider for AI agents — registry, scoped delegation, in-path MCP enforcement"** | 文书院：签发并验证官方文书的机构，制度化的真实性担保 | **同赛道（agent 身份 + MCP 强制）已有同名产品**，搜索与心智都撞；英文习语 "in chancery" 另有歧义 |
| **memtruth** | `FREE`（404） | MCP 搜 `memtruth` 0 命中；`memtruth.dev` / `.io` 404；但 **GitHub `doctruthhq/memtruth`（3★，Java，2026-05-07）= "Memtruth SDK: evidence, parse, corpus contracts, chunking, projection… for AI applications"** | 记忆 + 真相：与核心主张字面同构 | **同赛道同名产品已存在 → 按纪律一票否决**（npm 空也没用） |
| **pinakes** | `FREE`（404） | MCP 搜 `pinakes` 0 命中；但 **`pinakes.dev` 是活产品**（页面 title：`Pinakes - the tech infra behind aalsa.ai`）；GitHub 96 个（`fabiodalez-dev/Pinakes` 92★、`ansible/pinakes` 20★、`futurGH/pinakes` 41★ = 本地 sqlite 索引） | 卡利马科斯的《皮纳克斯》= 亚历山大图书馆目录，呼应「索引是纯函数、可重建」 | 名字已在实际使用，其中一个还是「本地索引」，撞得正着 |

> 已占用的名字也没白测：`keep`（npm `TAKEN v2.5.3`，2012-02-15 首发，16 版，维护者 `iannuttall`）的描述是 *"Save anything as Markdown, then search, read, and update it from the terminal or an AI agent"* —— 这就是我们，且它已经占了 14 年。这类「已被同赛道占据的英文好词」见 §3。

## 2. 推荐前三

### ① tabellio —— 记忆的公证人

- **为什么配得上**：罗马的 `tabellio` 不是「记录员」，是**在公开场合替人立契、必须留存副本以备日后核验**的职业人 —— 写入过闸门（不合法就不立）、留存副本（markdown 是唯一真相源）、日后核验（receipt/来源）三个动作与产品一一对应，而且它天生回答「谁负责」。
- **定位怎么念**：`npm i -g tabellio` 好敲；`tabellio recall "上周定的命名口径"`。中文念「塔贝利奥」，一句话定位：**「你的记忆的公证人」**。
- **最大的风险**：4 音节 + 双 `l`，英文用户第一次可能拼成 `tabellio`/`tabelio`；商标未核，且 web3 圈已有同名项目 —— 建议商标限类（软件/数据库类），产品名统一写作 `tabellio memory` 以便检索区分。

### ② sigillum —— 记忆的印

- **为什么配得上**：`sigillum` 是**火漆封印**：盖上去就代表「我认这条」，与架构里「每次写入留一道可验证的 sha256 印记」在机制上同构；它也是四道占用全空的三个名字里最有画面感的一个（logo 现成）。
- **定位怎么念**：`sigillum recall …`；英文 si-GIL-lum（三音节，重音在第二），中文「西吉鲁姆」，一句话定位：**「给记忆盖印，而不是往仓库里丢」**。
- **最大的风险**：语义张力 —— 「封印」暗示密封不可读，而产品的招牌恰恰是明文可读、可 git、可带走；另外 GitHub 上已有一个同名文档签名工具（10★），搜索前两页会被它占掉。

### ③ accession —— 入藏登记

- **为什么配得上**：档案馆的 accession 是**机制**而不是比喻：入藏时登记来源、给号，之后任何一次调取都能回溯「谁、何时、依据什么」。它直接对上「文件是唯一真相源 + 写入有闸门 + 成本可审计」这条主线，而且 `.dev`/`.io`/`.sh` + npm + MCP 四道全空。
- **定位怎么念**：`accession recall …`；英文 ac-CES-sion，中文「入藏」，一句话定位：**「把记忆入藏，而不是把它堆进一个仓库」**。
- **最大的风险**：**ACCESSION 已有活商标（WIPO 1698035 + 同族美国申请）**，我没做全类检索 —— 自用/开源通常无碍，一旦商业发布必须先做商标检索；拼写上有双 `c` + 双 `s` 两个坑。

> 备选（若要「零撞名」优先）：**memproof** —— npm / `.dev` / `.io` / MCP / GitHub 五处全干净，代价是它读起来像功能名而非品牌。

## 3. 淘汰理由一句话小结

- `engram` / `mnemos` / `memex` / `anamnesis` / `mneme`：经典记忆词全在 npm 上（engram `v0.0.1` 2014 "Persistent storage for local modules"；mnemos `v0.0.1` 2025 "Autonomous codebase investigation framework with persistent memory" ← 已是我们赛道；memex `v1.0.1` 2016），且 engram 家族会跟旧项目 `engramory` 自我撞车。
- `notary` / `ledger` / `scribe` / `vellum` / `receipt` / `folio` / `codex`：英文实物与职业词 100% 被占（`notary v1.0.0` "Give your files a license"；`ledger v0.1.0` 2012 日志库；`scribe v0.0.9` 2011；`vellum v0.12.6` 已发 1800 版；`receipt v1.4.0`），占了也拿不到干净搜索。
- `keep` / `repertory` / `diarium` / `plainmem` / `memini` / `tabularium` / `registrum` / `memvault`：**同赛道占用或预留** → 一票否决（keep 见上；repertory `v0.9.0` 2026-09-13 *"One shared memory for your whole company — plain Markdown in git"*；diarium `v0.2.27` *"Agent memory as a verifiable UST stream"*；memini `v0.4.0` *"persistent project memory for AI coding agents"*；plainmem `v0.0.1` 2026-10-08 *"Reserved by Hallohuman for a plain-Markdown agent memory package"*）。
- `touchstone` / `memento` / `canon` / `anchor` / `lore` / `witness` / `curator` / `steward` / `archivist` / `chronicler`：通用英文词，同名产品与仓库太多（一个词动辄上千仓库），搜索必然被淹没。
- `memoranda` / `exemplum` / `notaria`：语义不错但域名已被抢（**`memoranda.dev` 2026-09-06 已注册，标语就是 "memory that carries its receipt"**；`exemplum.dev` 2026-04-11；`notaria.dev` 2024-07-30 被西班牙公司持有），说明这个语义域已有人排队。
- `sexton` / `scheda` / `fimbria` / `editio` / `kleos`：空是空的，但要么生僻、要么发音多解（`scheda` 至少三种读法）、要么与产品主张不咬合。
- mem- 自造复合词（`memkeep` / `keepmem` / `truekeep` / `verimem` / `filemem` / `memgate` / `truestore`…）：npm 基本全空、零风险，但拥挤且像功能名 —— 只有 `memproof` 值得留作备胎。

## 4. 命名纪律（我实际执行的检查与判据）

1. **实测不猜**：npm 一律打 `https://registry.npmjs.org/<name>` —— `200` 就把 `version` / 首次发布时间 / 版本数 / 维护者 / 描述抄进表，`404` 才写 `FREE`；本轮共实测 100+ 个名字。
2. **域名用 RDAP 实测**（`https://rdap.org/domain/<name>.<tld>`，取 `registration` 事件与注册商）：只把 `.dev` / `.io` / `.sh` 当判据 —— `.com` 对任何英文词都早已被占，不构成可行动信息。**区分「被抢注」与「有人在用」**：拉一次页面看 title（`pinakes.dev`、`memoranda.dev` 就是这样暴露的）。
3. **MCP Registry 实测**：`https://registry.modelcontextprotocol.io/v0/servers?search=<name>`。**注册名与产品名可以不同** —— GitHub 认证的命名空间是 `io.github.<user>/<server>`，域名认证用反域名（注册表里实际存在 `com.siglume/mcp-gateway`、`app.steadywrk/mcp-dispatch`）。所以产品可以叫 `tabellio`，注册名是 `io.github.<user>/memory`，两者不必同名。
4. **GitHub 同名扫描**：`api.github.com/search/repositories?q=<name>+in:name`，专挑同赛道项目 —— 这一条干掉了 `memtruth`（`doctruthhq/memtruth`）和 `pinakes`（`futurGH/pinakes`）。
5. **商标只做了能做的**：网页/WIPO 检索命中 ACCESSION 的活商标；**其余一律标「未核」**，我没有做全类检索 —— 商业发布前必须补，别把「未核」当「干净」。
6. **一票否决**：同赛道（agent 记忆 / 上下文 / 文档抽取 / agent 身份）已有同名产品 → 直接出局，不管 npm 空不空。不同赛道同名只记录、不否决。
7. **不做变体拼写绕道**：npm 会拒绝与既有包只差标点/大小写/单复数的名字（社区称之为 "too similar" 拒绝），所以 `cartulary → chartulary` 这类改写不是解法，只会得到敲错的名字。
8. **合格线**：无连字符、命令行好敲、中文念得出、英文不拗口（≤3 音节为佳，4 音节要语义足够强）；宁可选一个有故事的小众词，也不选一个必然撞车的通用词。

## 5. 一条战略发现：命名窗口正在关闭

2026-04 至 2026-10，本赛道至少 9 个名字被占用或**预留**（描述里直接写 "Reserved for…"，不是有人在用，是先占位）：

`plainmem`（2026-10-08 预留，"plain-Markdown agent memory package"）、`tabularium`（2026-10-12 预留）、`repertory`（2026-09-13）、`registrum`（2026-09-07 预留）、`urtext`（2026-08-27）、`cartulary`（2026-08-14，"receipt chain"）、`diarium`（2026-07-25）、`memini`（2026-07-03）、`memvault`（2026-04-01）。

**动作建议**：定名当天一次性占掉 —— npm 包名 + GitHub org + `<name>.dev` 与 `<name>.io` + MCP Registry 的 `io.github.<user>/<name>`。域名年成本百元级，比日后重命名全套文档 + 换 CLI 命令便宜得多。

> 已定 `tabellio`（2026-10-17）。npm 包名 `tabellio` 已核实可用；GitHub 同名组织被 2022 年建的组织占用，故命名空间沿用既有的 `yffo`，MCP 注册名 `io.github.yffo/tabellio`（**注册名与产品名可以不同**，见 §4.3）。

## 6. 复现命令（任何人可当场验证）

```bash
curl -s https://registry.npmjs.org/tabellio | head -c 120            # npm：404 = 空闲
curl -sL -w "\nhttp=%{http_code}\n" -H "Accept: application/rdap+json" \
     https://rdap.org/domain/tabellio.dev                            # 域名：404 = 可注册
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=tabellio&limit=3"
curl -s -H "Accept: application/vnd.github+json" \
     "https://api.github.com/search/repositories?q=tabellio+in:name&per_page=3"
```

- 本文其余条目保留**定名前**的候选与实测记录。改名动作已落地：`package.json` 的 `name` / `bin`（`tabellio`、`tabellio-mcp`）、README 标题与首段、运行期文案、默认库路径 `~/memory/tabellio`；**只剩 MCP Registry 的 `io.github.yffo/tabellio` 尚未注册**（发布后才做）。
