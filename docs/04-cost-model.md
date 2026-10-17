# 04 · 成本模型与模型选型

> 调研日期：**2026-10-17**（Asia/Shanghai）。所有单价均标注来源 URL 与查询日期。
> 汇率口径：**1 USD = 6.69 CNY**（Frankfurter/ECB 快照 `date: 2026-10-16`，https://api.frankfurter.app/latest?from=USD&to=CNY ，2026-10-17 查询）。全文人民币换算均用此单一汇率，不随时间浮动。
> 纪律：查不到的写「未找到公开报价」，**绝不用看起来合理的数字冒充事实**；所有推算显式标注「估算」并列出假设。

## 0. 结论先行

1. **默认档 = 全本地零 API 成本**：纯词法（BM25/ripgrep）打底 + 可选本地向量（`bge-m3` 或 `Qwen3-Embedding-0.6B`）。月成本 **¥0**（只吃本地 CPU/内存，不吃 API）。
2. **个人档（推荐给作者自己）月成本 ¥0.1 ~ ¥3**：本地词法 + 云语义检索 + 便宜模型巩固；其中大部分成本落在 **rerank**，而不是 embedding。
3. 三个场景的 API 成本区间（估算，见 §2）：轻量个人 **¥0.1 ~ ¥0.5/月**；每天 20 写 + 200 召回 **¥1 ~ ¥10/月**；每天 200 写 + 2000 召回 **¥23 ~ ¥72/月**。
4. **便宜到可以忽略的部分**：embedding。600 次写入 + 6000 次召回的向量化成本只有 **¥0.06 ~ ¥0.17/月**（智谱/百炼 0.5 元/百万 token 档）。省钱重点不在 embedding。
5. **真正的成本杠杆是 rerank**：智谱 Rerank 0.8 元/百万 token，若每次召回无条件对 20 篇候选重排，场景 C 单月 **¥69**，占全案 95%。对策：候选池收到 10、只对语义型查询重排、本地小模型先筛。
6. **巩固用「免费档」小模型可以真的零花钱**：智谱 `GLM-4.7-Flash` 与 `GLM-4-Flash-250414` 在官方定价页标 **免费**；百炼 `qwen-flash` 0.15/1.5 元每百万 token，100 万 token 免费额度够跑很久。
7. 插件市场（次用户）必须能「装上就跑」：**不能让 `onnxruntime-node`（解包 301 MB）或随包模型文件成为默认依赖**。本地向量做成「检测到 Ollama/外部端点就用，没有就退回词法」，插件本体不带二进制与权重。
8. 配置里必须有一等公民的 **月预算 + 超限自动降级到词法**，且每项花钱能力独立可关。

## 1. 单价表

### 1.1 Embedding

单位：每 100 万 input token。`$` 为官方标价，`¥` 为按 6.69 换算的**换算值**（非官方人民币报价）；标「¥ 官方」的是官方直接以人民币报价。

| 模型 | 官方标价 | ¥ 换算 | 官方页是否有现价 | 来源（查询日 2026-10-17） |
|---|---|---|---|---|
| OpenAI `text-embedding-3-small` | $0.02 | ≈ ¥0.13 | ❌ 官方定价页已不列 embedding | 二手：https://cloudzero.com/blog/openai-pricing （2026-09-04）、https://embeddingcost.com/openai 。官方页 https://developers.openai.com/api/docs/pricing 已无 `text-embedding-*` 条目；https://platform.openai.com/docs/guides/embeddings 无价格 |
| OpenAI `text-embedding-3-large` | $0.13（Batch $0.065） | ≈ ¥0.87 | ❌ 同上 | 二手 + 官方社区帖 https://community.openai.com/t/…/1338277 （2025-08-08） |
| Gemini `gemini-embedding-2`（文本） | $0.20 | ≈ ¥1.34 | ✅ | https://ai.google.dev/gemini-api/docs/pricing?hl=zh-cn ；同页：图片 $0.45/1M、音频 $6.50/1M、视频 $12.00/1M；有免费层级 |
| Gemini `text-embedding-004` / `-005` | 未提供 | — | ❌ **当前定价页已无这两个模型**，未找到公开现价 | https://ai.google.dev/gemini-api/docs/pricing?hl=zh-cn |
| Gemini `gemini-embedding-001` | $0.15（**非官方页**） | ≈ ¥1.00 | ❌ 仅见二手/发布博文 | https://openrouter.ai/google/gemini-embedding-001 、https://developers.googleblog.com （2025-07-14） |
| Voyage `voyage-4-large` | $0.12 | ≈ ¥0.80 | ✅ | https://docs.voyageai.com/docs/pricing |
| Voyage `voyage-4` | $0.06 | ≈ ¥0.40 | ✅ | 同上 |
| Voyage `voyage-4-lite` | $0.02 | ≈ ¥0.13 | ✅ | 同上；**每个账号 voyage-4* 前 200M token 免费** |
| Voyage `voyage-3.5` / `voyage-3` | $0.06 | ≈ ¥0.40 | ✅ | 同上 |
| Voyage `voyage-multilingual-2` | $0.12 | ≈ ¥0.80 | ✅ | 同上 |
| Voyage `voyage-3-large` / `context-3` / `code-3` | $0.18 | ≈ ¥1.20 | ✅ | 同上 |
| Cohere `embed-v3` | $0.10（**二手**） | ≈ ¥0.67 | ❌ 官方页正文 JS 截断，未取到 | 二手：https://aipricing.guru/cohere-pricing ；计费口径见 https://docs.cohere.com/docs/how-does-cohere-pricing-work ；价格页 https://cohere.com/pricing |
| Cohere `embed-v4`（AWS Bedrock） | ≈ $0.12（**二手**） | ≈ ¥0.80 | ❌ | 二手：https://eesel.ai/blog/cohere-ai-pricing （2026-06-09） |
| Jina `jina-embeddings-v3` | $0.05（**二手**） | ≈ ¥0.33 | ❌ **未找到官方公开报价**（官网登录墙；`jina.ai` 本机 DNS 解析到非公网 IP，fetch 被拒） | 二手：https://aihubmix.com/model/jina-embeddings-v3 ；官网 https://jina.ai/embeddings/ |
| 智谱 `Embedding-3`（V3，8K 上下文） | — | **¥0.5 官方**（Batch ¥0.25） | ✅ | https://docs.bigmodel.cn/cn/guide/start/pricing |
| 智谱 `Embedding-2`（V2，8K） | — | **¥0.5 官方**（Batch ¥0.25） | ✅ | 同上 |
| 阿里百炼 `qwen3.7-text-embedding` | — | **¥0.5 官方**（送 100 万 token/90 天） | ✅ | https://help.aliyun.com/zh/model-studio/model-pricing |
| 阿里百炼 `qwen3.7-text-embedding-flash` | — | **¥0.125 官方** | ✅ | 同上 |
| 阿里百炼 `text-embedding-v4` / `-v3` / `-v2` | — | **¥0.5 官方** | ✅ | 同上 |
| DeepSeek | **未提供** | — | ❌ 官方定价页只有对话模型 + Search/Fetch | https://api-docs.deepseek.com/quick_start/pricing/ |

### 1.2 Rerank

| 服务 | 官方标价 | ¥ 换算 | 来源（2026-10-17） |
|---|---|---|---|
| Voyage `rerank-3` | $0.05 / 1M token（前 200M 免费）；官方举例：100 文档/请求 ≈ $0.0025/请求 | ≈ ¥0.33 | https://docs.voyageai.com/docs/pricing |
| Voyage `rerank-3-lite` | $0.02 / 1M（前 200M 免费）；≈ $0.001/请求 | ≈ ¥0.13 | 同上 |
| Cohere `Rerank 3.5` | 按次 **$0.001**（v3.5，**二手**）；另有 `Rerank v3` $2.00/1M search token（二手） | ≈ ¥0.0067/次 | 二手：https://eesel.ai/blog/cohere-ai-pricing （2026-06-09）、https://aipricing.guru/cohere-pricing ；官方计费口径 https://docs.cohere.com/docs/how-does-cohere-pricing-work 。搜索摘要另见「Rerank 3.5 Medium $5.00 / $3,250」片段，**含义不明，未采信** |
| Jina `jina-reranker-v2-base-multilingual` | $0.05 / 1M input（**二手**） | ≈ ¥0.33 | 二手：https://getmaxim.ai （2026-10-02 成本计算器）；官网未取到报价 |
| 智谱 `Rerank`（4K 上下文） | — | **¥0.8 官方** | https://docs.bigmodel.cn/cn/guide/start/pricing |
| 阿里百炼 `qwen3.7-text-rerank` / `qwen3-rerank` | — | **¥0.5 官方**（各送 100 万免费额度） | https://help.aliyun.com/zh/model-studio/model-pricing |
| 阿里百炼 `gte-rerank-v2` | — | **¥0.8 官方** | 同上 |
| `bge-reranker-v2-m3`（自托管） | **¥0 API 费**；成本 = 本地算力 | — | 见 §3 本地方案 |

> Voyage 计费口径（官方页）：`(query token 数 × 文档数) + 全部文档 token 数`。
> 百炼 rerank 计费口径：按**输入 token**（query + 文档）。

### 1.3 便宜 LLM（用于提取要点 / 巩固 / 判分）

单位：元 / 百万 token（输入 / 输出）。`$` 官方美元价已换算为 ¥。

| 模型 | 官方价（¥/1M in · out） | 来源（2026-10-17） |
|---|---|---|
| 智谱 `GLM-4.7-Flash` | **免费 / 免费** | https://docs.bigmodel.cn/cn/guide/start/pricing |
| 智谱 `GLM-4-Flash-250414` | **免费 / 免费** | 同上 |
| 智谱 `GLM-Z1-Flash` | **免费 / 免费** | 同上 |
| 智谱 `GLM-4.7-FlashX` | 0.5 / 3（缓存命中 0.1） | 同上 |
| 智谱 `GLM-4.7`（[0,32K)） | 2 / 8（缓存命中 0.4） | 同上 |
| 智谱 `GLM-5.3-Flash` | 0.8 / 2.8（缓存命中 0.23） | 同上 |
| 阿里百炼 `qwen-flash`（[0,128K]） | 0.15 / 1.5 | https://help.aliyun.com/zh/model-studio/model-pricing |
| 阿里百炼 `qwen3.7-flash`（[0,32K]） | 0.2 / 0.8 | 同上 |
| 阿里百炼 `qwen3.5-flash`（[0,128K]） | 0.2 / 2 | 同上 |
| DeepSeek `deepseek-flash`（V4.1-Flash）**off-peak** | $0.15 in / $0.6 out → **¥1.00 / ¥4.01** | https://api-docs.deepseek.com/quick_start/pricing/ |
| DeepSeek `deepseek-flash` **peak** | $0.30 / $1.2 → ¥2.01 / ¥8.03（cache miss） | 同上 |
| DeepSeek `deepseek-v4-pro` off-peak | $0.66 / $1.98 → ¥4.42 / ¥13.25 | 同上 |
| OpenAI `gpt-6-luna` | $0.10 / $0.50 → ¥0.67 / ¥3.35 | https://developers.openai.com/api/docs/pricing |
| OpenAI `gpt-6.1-sol` | $2 / $10 → ¥13.38 / ¥66.9 | 同上 |
| OpenAI `gpt-4o-mini` / `gpt-4.1-mini` | **未提供** | ❌ 当前官方定价页未列这两个模型，未找到公开现价 |
| Anthropic Claude Haiku 类 | **未找到公开报价** | 本次调研未取到 Anthropic 官方定价页（未抓取成功） |

> DeepSeek **off-peak = peak 半价**：peak 为周一至周五 01:00–04:00 与 06:00–10:00 UTC，其余（含周末与中国法定假日全天）为 off-peak。巩固/压缩这类批量任务放 off-peak 直接省 50%。DeepSeek 另收 Search/Fetch $0.75 / 1000 次成功请求。
> 智谱 Batch API = 标准价 **5 折**；百炼 Batch 半价 + 上下文缓存折扣。批量巩固走 Batch 再省一半。

## 2. 成本模型（三场景估算）

### 2.1 公式与假设

设每月写入 `W` 次、每月召回 `R` 次。**全部数值均为估算**，依据是旧插件实测账本（3 天 131 轮注入 / 655 条指针 / 72 篇 646KB）与本机实测（`qwen3-embedding:0.6b` 1024 维 / 174 条卷子）。

```
月 embedding 成本 = 单价 × [ W × Tw × (1 - cacheHit)          # 写入侧增量向量化
                          + R × Tq × semRatio ]                # 召回侧 query 向量化
月 rerank 成本    = 单价 × R × semRatio × pool × Tcand         # 只对语义型召回重排
月 LLM 成本       = 单价in × W × Lin + 单价out × W × Lout      # 每次写入做一次巩固
```

| 变量 | 取值 | 依据 / 备注 |
|---|---|---|
| `Tw` 写入侧被向量化的 token | **250** | 一条事实型笔记 ~150 token（旧库 646KB/72 篇 ≈ 9KB/篇，去除 frontmatter/格式后正文估算）+ 索引/标题指针 ~60，另计 40 余量。**估算** |
| `Tq` 每次召回的 query token | **30** | 检索词 + 任务上下文一行。**估算** |
| `Lcand` 参与重排的候选篇数（`pool`） | **20**（默认）/ **10**（优化后） | 旧库语义档实测配置 `semanticPool 10~20`（`~/memory/engramory/reference-local-embedding-endpoint.md`） |
| `Tcand` 每篇候选进 rerank 的 token | **120** | 重排只喂笔记摘要/首段而非全文。**这是本模型里最敏感的假设**（详见 2.4 敏感性） |
| `semRatio` 召回中走语义的比例 | **0.6** | 其余走纯词法，零 API。**估算** |
| `cacheHit` embedding 缓存命中率 | **0.3** | 笔记修订后重算 + 跨查询复用。**估算** |
| `Lin` / `Lout` 每次巩固的小模型调用 | **1.5k in / 0.3k out** | 按题目给定假设：1 次 1.5k input + 0.3k output |
| LLM 调用次数 | **= W（每次写入 1 次）** | 合并/去重在同一 prompt 内完成，不重复调用 |
| 免费额度 | Voyage voyage-4* 前 200M token 免费；百炼每模型 100 万 token 免费；智谱 3 个 Flash 模型免费 | 见 §1 来源 |

### 2.2 场景定义

| 场景 | 写入/天 | 召回/天 | `W`/月 | `R`/月 | 对应旧库实测 |
|---|---|---|---|---|---|
| **A 轻量个人** | ~1 | ~5 | 30 | 150 | 低于旧库（3 天 14/14/7 篇）|
| **B 中等** | 20 | 200 | 600 | 6,000 | 略高于旧库观察到的日增上限（14 篇/天）|
| **C 重度** | 200 | 2,000 | 6,000 | 60,000 | 远超旧库；对应「推广后重度外部用户」|

### 2.3 成本估算表

**场景 A（30 写 + 150 召回/月）**

| 项 | token 量/月 | 智谱（0.5 元/1M） | 百炼 flash（0.125 元/1M） | OpenAI 3-small（¥0.13/1M） | Voyage-4-lite（¥0.13/1M） |
|---|---|---|---|---|---|
| embedding | 5.25k + 2.7k = **7.95k** | ¥0.004 | ¥0.001 | ¥0.001 | ¥0.001（**免费额度内 → ¥0**）|
| rerank（90 次 × 20 × 120 = 216k tok） | **216k** | ¥0.17 | ¥0.11（0.5 元档） | — | ¥0.03（rerank-3-lite，免费额度内 ¥0）|
| LLM 巩固 | 45k in / 9k out | **¥0**（GLM-4.7-Flash 免费） | ¥0.02（qwen-flash） | — | — |
| **合计** | | **≈ ¥0.17** | **≈ ¥0.13** | **≈ ¥0.13**（不含 rerank） | **≈ ¥0**（免费额度内） |

**场景 B（600 写 + 6,000 召回/月）**

| 项 | token 量/月 | 智谱 | 百炼 | OpenAI 3-small | Voyage-4-lite |
|---|---|---|---|---|---|
| embedding（写入 600×250×0.7=105k；query 6000×30×0.6=108k） | **213k** | ¥0.11 | ¥0.027 | ¥0.028 | **¥0**（<200M 免费额度）|
| rerank（3,600 次 × 20 × 120） | **8.64M** | ¥6.91 | ¥4.32（0.5 元档） | — | ¥2.85 → **¥0**（免费额度内）|
| LLM 巩固（600 × 1.5k / 0.3k） | 0.9M in / 0.18M out | **¥0**（免费档） | ¥0.41（qwen-flash） | — | — |
| **合计** | | **≈ ¥7.0** → 候选池收到 10 = **¥3.6** | **≈ ¥4.8** → 池 10 = **¥2.6** | — | **≈ ¥0**（免费额度内）|
| DeepSeek 选项（仅 LLM 部分，off-peak） | 0.9M / 0.18M | — | — | **$0.243 = ¥1.63** | — |

**场景 C（6,000 写 + 60,000 召回/月）**

| 项 | token 量/月 | 智谱 | 百炼 | 备注 |
|---|---|---|---|---|
| embedding（写入 6000×250×0.7=1.05M；query 60000×30×0.6=1.08M） | **2.13M** | ¥1.07 | ¥0.27 | 依然是最便宜的一块 |
| rerank（36,000 次 × 20 × 120） | **86.4M** | **¥69.1** | ¥43.2 | **占全案 ~95%** |
| ↳ 候选池收到 10 | 43.2M | **¥34.6** | ¥21.6 | 最有效的单点优化 |
| LLM 巩固 | 9M in / 1.8M out | ¥0（免费档）/ ¥7.2（降到 GLM-4.7 2/8 档） | ¥4.05（qwen-flash） | qwen3.7-flash(0.2/0.8) = ¥3.24 |
| **合计** | | **¥70.2**（池 10：**¥35.7**） | **¥47.5**（池 10：**¥25.9**） | |
| DeepSeek 仅 LLM 部分（off-peak） | 9M / 1.8M | — | — | $2.43 = **¥16.3** |

> 场景 C 混合最优解（**估算**）：百炼 `text-embedding-v4`（¥0.5）+ 百炼 `qwen3-rerank` 池 10（¥21.6）+ 智谱 `GLM-4.7-Flash` 免费巩固 = **≈ ¥22.7/月**。

### 2.4 敏感性：三个假设决定一切

1. **`Tcand` = 120 token/候选是分母最大的假设**。若真把整篇笔记（~1.5k token）喂 rerank，场景 B 的 rerank 从 ¥6.91 涨到 ¥86、场景 C 从 ¥69 涨到 **¥864**。**因此「rerank 只喂摘要」必须是硬性工程约束，不是优化项。**
2. **`semRatio`**：把所有召回都做成语义（=1.0）会让场景 B/C 的 rerank 成本 ×1.67。词法能答的查询（人名、路径、日期、专有名词）本来就不该走向量。
3. **`cacheHit`**：embedding 缓存把成本打到 0.7 倍——但 embedding 本来就只占全案 1.5%，**优化 embedding 缓存是为了延迟与配额，不是为了钱**。别把工程预算花错地方。

### 2.5 汇率与口径声明

- 人民币金额中，智谱/百炼为**官方人民币报价**，其余为美元官方价 × 6.69 的**换算值**。
- USD→CNY = 6.69 取自 ECB 口径快照（`date: 2026-10-16`）。汇率波动 ±5% 会等比例影响换算列，不影响人民币官方列。

## 3. 本地模型方案（零 API 成本档）

### 3.1 体积与内存（权重文件字节数取自 HuggingFace 仓库元数据，非估算）

| 模型 | 维度 / 上下文 | 权重文件实际体积 | 运行时内存/显存 | 质量（官方榜） | 许可 |
|---|---|---|---|---|---|
| `BAAI/bge-m3` | 1024 / 8192 | fp32 `pytorch_model.bin` **2271 MB**；ONNX 导出 `model.onnx` + `model.onnx_data` = 0.7 + **2267 MB** | ~2.3–3 GB（fp32） | MTEB Multilingual Mean(Task) **59.56** | MIT |
| `BAAI/bge-reranker-v2-m3` | 交叉编码器 / 8192 | `model.safetensors` **2271 MB**；ONNX int8/uint8 量化版 **570.7 MB**；ONNX fp16 **1136 MB** | int8 ~0.6–1.2 GB | MTEB-R 57.03 / CMTEB-R 72.16 / MMTEB-R 58.36 / MTEB-Code 41.38 / FollowIR **−0.01** | Apache-2.0 |
| `Qwen/Qwen3-Embedding-0.6B` | 1024（MRL 可降维）/ 32K | `model.safetensors` **1191.6 MB**；GGUF Q8_0 **639.2 MB**（= 本机 Ollama 实测 639 MB，二者互证）；ONNX int8/uint8 **613.5 MB**、q4f16 **567.5 MB** | Q8 ~0.7–1.5 GB；本机实测占约 **5.5 GB 显存**（含运行时开销） | MTEB Multi **64.33**、MTEB Eng v2 **70.70**、C-MTEB Mean(Task) **66.33**、C-MTEB Retr **71.03**；作 rerank 用 MTEB-R 61.82 | Apache-2.0 |
| `Qwen/Qwen3-Embedding-4B` | 2560 / 32K | safetensors **4965.8 + 3077.8 = 8043.6 MB**；GGUF Q4_K_M **2496.7 MB**、Q8_0 **4279.7 MB** | Q4 ~2.5–4 GB；Q8 ~4.3–6 GB | MTEB Multi **69.45**、C-MTEB Mean(Task) **72.27**、C-MTEB Retr **77.03** | Apache-2.0 |
| `Qwen3-Reranker-0.6B` | 交叉编码器 | （本次未取到权重体积） | — | MTEB-R **65.80** / CMTEB-R 71.31 / MTEB-Code 73.42 | Apache-2.0 |
| `nomic-ai/nomic-embed-text-v1.5` | 768（Matryoshka）/ 8192 | `model.safetensors` **546.9 MB**；ONNX int8 **137.3 MB**、q4f16 **111.1 MB** | int8 ~0.2–0.4 GB | 未见权威 C-MTEB 分数（**中文能力未验证**） | Apache-2.0 |
| `BAAI/bge-small-zh-v1.5` | 512 / 512 | `model.safetensors` **95.8 MB** | ~0.15–0.3 GB | 官方称「同尺寸最佳」，**具体 C-MTEB 数字未取到** | MIT |
| `BAAI/bge-base-zh-v1.5` | 768 / 512 | `pytorch_model.bin` **409.1 MB** | ~0.5–1 GB | 官方称接近 bge-large-zh，**具体分数未取到** | MIT |

来源：各模型 HuggingFace 仓库文件元数据（经 `hf-mirror.com/api/models/<id>?blobs=true` 读取，2026-10-17；huggingface.co 本机不可达）；质量分来自 https://huggingface.co/Qwen/Qwen3-Embedding-0.6B 官方评测表与 https://arxiv.org/pdf/2506.05176 、https://github.com/QwenLM/Qwen3-Embedding 、https://modelscope.cn/models/BAAI/bge-reranker-v2-m3 。
折算口径提示：**fp32 权重的字节数 ÷ 2 ≈ 参数量的百万分之一**（如 2271 MB → 0.6B、1191 MB → 0.6B）。

### 3.2 CPU 速度（真实实测，不是估算）

| 操作 | 实测值 | 硬件/条件 | 来源 |
|---|---|---|---|
| `bge-m3` embed 一篇长文档 | **857 ms**（ONNX Runtime CPU）vs 1091 ms（PyTorch eager） | x86，fp32，**长真实文档**，同线程数；作者自述 1.27× 提升 | https://hf-mirror.com/a-ivanovitch/bge-m3-onnx |
| `bge-reranker-v2-m3` 重排 1 query × 10 文档 | **8.9 s**（ONNX CPU）vs 11.8 s（PyTorch） | x86，fp32，文档截断到 1024 token；**短 pair 会快得多**（原文明确说明） | https://hf-mirror.com/a-ivanovitch/bge-reranker-v2-m3-onnx |
| `qwen3-embedding:0.6b` query 延迟 | **132 ms**（常驻） | 本机 Apple M1 Max / 32GB / 10 核（本次勘察确认），Ollama 端点 | `~/memory/engramory/reference-local-embedding-endpoint.md`（2026-10-15 本机实测） |
| 同上，云端对照 | 273 ms（智谱 embedding-3） | 同机同卷子 | 同上 |

**重要限制**：上表 bge-m3 / bge-reranker 的绝对延迟来自 x86 CPU 且**输入是长文档**（rerank 那行尤其如此）；本机是 Apple M1 Max，两者不能直接比较。**Qwen3-Embedding 系列在 CPU 上的官方/第三方实测速度未找到公开数据**——不要引用任何「估计毫秒数」。

### 3.3 Node 侧能不能跑 + 打包代价

| 路线 | 可否 | 实际代价（实测 npm 元数据，2026-10-17） |
|---|---|---|
| **ONNX Runtime**（`onnxruntime-node`） | ✅ 官方支持 `os: win32 / darwin / linux` | **解包体积 301 MB**（43 个文件），原生二进制随包分发（因此才有这个体积）。依赖 `adm-zip`、`global-agent`、`onnxruntime-common`。**作为插件依赖不可接受** |
| **transformers.js**（`@huggingface/transformers` v4.3.1） | ✅ Node 可用 | 自身解包 **9.96 MB**，但**依赖 `onnxruntime-node@1.30.0`（301 MB）+ `sharp` + `onnxruntime-web`**，实际安装体积 ≈ 310 MB+ |
| ↳ 模型从哪来 | ⚠️ **默认从 HuggingFace Hub 运行时下载** | `env.allowRemoteModels` 默认开启；离线必须显式设 `env.allowRemoteModels = false` + `env.localModelPath = '/path/to/local/models/'`；`env.cacheDir` 可改缓存位置。`allowLocalModels` 默认「浏览器 false / Node true」。来源：https://hf-mirror.com/docs/transformers.js/api/env |
| **llama.cpp / GGUF**（`node-llama-cpp` v3.22.1） | ✅ 有官方 embedding API：`model.createEmbeddingContext()` → `context.getEmbeddingFor(text)`、`embedding.calculateCosineSimilarity()` | 自身解包 **39.6 MB**，但 optionalDependencies 带 8+ 个平台预编译包（mac-x64 / win-x64 / linux-x64 / win-arm64 / linux-arm64 / linux-armv7l / **win-x64-cuda** / linux-riscv64）。**注意：没有 `mac-arm64` 平台包** → Apple Silicon 上要么走 `mac-x64`（Rosetta）、要么从源码编译。文档：https://node-llama-cpp.withcat.ai/guide/embedding |
| **外部本地 HTTP 端点（Ollama / llama.cpp server）** | ✅ **推荐路线** | 插件零模型文件、零原生依赖；本机已装 `ollama`（`/opt/homebrew/bin/ollama`），模型由用户自己 `ollama pull` 管理；配置走 `~/.config/engramory/embed.json` 同款形态（baseUrl/model/queryPrefix/docPrefix）。取舍：引入「必须有个本地服务在跑」的部署前置条件 |

**插件市场能否带二进制/模型文件**：npm registry 对单包体积有硬上限（256 MB 量级，见 npm 官方上限讨论），而 `onnxruntime-node` 一家就 301 MB、`bge-m3` fp32 权重 2.2 GB、`Qwen3-Embedding-4B` 8 GB——**结论：权重与原生运行时不能随插件包分发**。DSH 插件市场对二进制/模型文件是否有专门豁免**未找到公开文档**。
`node-llama-cpp` 的 postinstall 下载模型/二进制的行为在离线/受限网络下会失败，这是已知的安装脆弱点（本次未取到具体 issue 链接）。

**兼容性陷阱（有据可查）**：`bge-m3` 的 ONNX int8 动态量化把 dense cosine 压到 0.985、reranker top-1 重叠掉到 **0.625**；`bge-reranker-v2-m3` 的 int8 同样把 top-1 重叠打到 **0.625**（即约 37% 的查询首选文档会变）。对记忆检索「top-1 就是全部意义」的场景，**int8 量化不能作为默认档**。

### 3.4 本地方案的质量锚点

- 本机实测（174 条卷子，真库 hit@1）：智谱 embedding-3 **74.7%** vs 本机 `qwen3-embedding:0.6b` **68.4%** —— 差 6.3pt，但延迟本机常驻 132 ms vs 云端 273 ms。
- 指令型模型**必须带 queryPrefix**（`Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: `，文档侧不加），实测真库 hit@1 **+5.5pt**。不带前缀等于白丢一半质量。
- 若中文是主战场：`Qwen3-Embedding-0.6B`（C-MTEB 66.33）明显强于 `bge-m3`（无 C-MTEB Mean，MTEB Multi 59.56）与 `nomic-embed-text-v1.5`（无中文分数）。

## 4. 省钱工程手段清单

按「省的钱 / 实现成本」排序。**带 ★ 的是必须做的**。

| # | 手段 | 省什么 | 量化效果（估算） |
|---|---|---|---|
| 1 ★ | **rerank 只喂摘要，不喂全文** | rerank 是 95% 成本所在 | 把 `Tcand` 从 1.5k 压到 120 token：场景 C 从 ¥864 → **¥69**（12×） |
| 2 ★ | **候选池限死（默认 10，上限 20）** | rerank token ∝ 池大小 | 场景 C：¥69 → ¥35；场景 B：¥6.9 → ¥3.5 |
| 3 ★ | **词法能答的不走向量** | embedding + rerank 调用次数 | 人名/路径/日期/错误码这类查询走 BM25/ripgrep；`semRatio` 降到 0.5 即再省 17% |
| 4 ★ | **本地先筛再上云**：词法（或本地 0.6B 向量）预筛 top-50 → 只把 top-10 送云 rerank | 云 rerank 的输入规模 | 与 #1/#2 是同一杠杆的三个旋钮；本地预筛本身零 API 成本 |
| 5 ★ | **增量索引：只给新笔记算向量** | 写入侧 embedding | 场景 C 写入侧每月只算 1.05M token（若每次全量重算 3000 篇 × 250 = 750k × 每日 = 22.5M，差 21×） |
| 6 ★ | **embedding 缓存**（内容 hash → 向量，落盘） | 重复/未变内容 | 命中率 0.3 时省 30%；真实库碎片化更省。**主要收益是延迟与配额，不是钱** |
| 7 ★ | **pull 而非 push**：不每轮调用模型 | 全部 | 旧库 push 的打开率 2.4%（16/655）——push 掉的 token 里有 97.6% 是纯浪费 |
| 8 ★ | **失败回退**：断网/超时/超预算 → 立即退回纯词法，不重试不降级到更贵模型 | 线上事故成本 | 旧库已量出 `timeout 15000ms` + 纯词法兜底；这是**可用性**手段，顺带省钱 |
| 9 ★ | **月预算 + 超限自动降级** | 尾部失控 | 见 §6 配置形态 |
| 10 | **用免费档模型做巩固** | LLM 部分 | 智谱 `GLM-4.7-Flash` 免费 → 场景 C 的 LLM 部分 ¥4.05 → **¥0** |
| 11 | **走 Batch API** | LLM + embedding | 智谱 5 折、百炼半价、OpenAI 半价。巩固/重算是天然批处理负载 → 直接 50% |
| 12 | **DeepSeek 放 off-peak 跑批量** | LLM 部分 | off-peak = peak 半价（周末/中国法定假日全天 off-peak） |
| 13 | **限制每条记忆的 token 上限** | 一切下游成本（embedding 输入、rerank 输入、注入上下文） | 建议每条事实 ≤ 200 token、≤ 400 字核心档（与 00-brief §6.1 一致）；超长笔记在写入时切分为多条 |
| 14 | **结果缓存**（query → 召回集合，短 TTL） | 重复查询 | 同一会话里反复问同类问题的命中率不低；TTL 建议 5–15 分钟 |
| 15 | **上下文缓存 / prompt 复用**（智谱 / DeepSeek / 百炼均有缓存价） | 巩固 prompt 的固定部分 | 智谱 GLM-5.3-Flash 缓存命中 0.23 vs 输入 0.8（约 3.5×）；DeepSeek cache hit $0.003 vs miss $0.15（**50×**） |

## 5. 三档推荐方案

### 档 ① 全本地零 API 成本

| 项 | 内容 |
|---|---|
| **月成本** | **¥0**（API）。真实成本是本地 CPU/内存：常驻 0.6B 模型约 0.7–1.5 GB 内存（本机实测含运行时约 5.5 GB 显存，走 GPU） |
| **形态** | 默认纯词法（BM25/ripgrep）；检测到 `http://127.0.0.1:11434`（Ollama）或用户配置的本地端点时自动开向量检索；重排用 `bge-reranker-v2-m3` int8（570 MB）或不做重排 |
| **质量预期** | 本机实测 hit@1 **68.4%**（qwen3-embedding:0.6b + queryPrefix）vs 云端 74.7%。**差 ~6pt，可用**。中文场景选 Qwen3-Embedding-0.6B（C-MTEB 66.33）而非 nomic（中文未验证） |
| **依赖与打包** | **零模型文件随插件分发**：靠外部本地端点（推荐）或让用户自行 `ollama pull`。绝不引入 `onnxruntime-node`（301 MB） |
| **适合谁** | **所有外部用户（插件市场默认）**、隐私敏感者、离线环境、作者的默认档 |

### 档 ② 混合（本地词法 + 云语义/巩固）—— **推荐给作者自己**

| 项 | 内容 |
|---|---|
| **月成本** | 轻量个人 **¥0.1 ~ ¥0.5**；每天 20 写 + 200 召回 **¥2 ~ ¥7**；每天 200 写 + 2000 召回 **¥23 ~ ¥35**（估算，见 §2.3） |
| **形态** | 词法本地打底 → 语义检索走云（百炼 `text-embedding-v4` ¥0.5/1M 或 `qwen3.7-text-embedding-flash` ¥0.125/1M）→ 云 rerank 只对 top-10 **摘要** 重排（`qwen3-rerank` ¥0.5/1M）→ 巩固用智谱 `GLM-4.7-Flash`（免费）或 `qwen-flash`（0.15/1.5） |
| **质量预期** | 接近云端最优：embedding 用官方 0.5 元档≈智谱 embedding-3 同档（本机实测 74.7% hit@1）+ 云 rerank 再加一层 |
| **依赖与打包** | 插件本体零原生依赖、零模型文件；只要出网 + API key。**key 由宿主/用户提供，不随包分发** |
| **适合谁** | 作者个人（多设备、多宿主、长期）；愿意给个位数月费换 6pt 质量的用户 |

### 档 ③ 全云

| 项 | 内容 |
|---|---|
| **月成本** | 场景 B **¥5 ~ ¥10**；场景 C **¥26 ~ ¥72**（取决于候选池与是否用免费巩固档）。若 rerank 不设 token 上限（喂全文），场景 C 可到 **¥864+**——**这一档必须带硬预算闸门** |
| **形态** | 写入巩固靠云小模型（`gpt-6-luna` ¥0.67/¥3.35、DeepSeek off-peak ¥1.00/¥4.01）、embedding 走云、rerank 全云、不开本地服务 |
| **质量预期** | 最高，且可换最强模型；但**质量差异主要来自 rerank 与 prompt，不来自更贵的 embedding**（3-small 与 0.5 元档同量级） |
| **依赖与打包** | 最轻的本地部署，最重的账单与隐私暴露；必须处理出网失败回退 |
| **适合谁** | 不介意月费、机器不能常驻本地模型、或需要多设备一致质量的付费用户。**不建议作为默认档** |

## 6. 给新项目的建议

1. **默认档 = 档 ①（¥0）**，且「零 API 也能跑」是发布门槛，不是可选项（对齐 00-brief §3「成本可控」与 §6.7）。语义检索的默认档按「先探测外部本地端点，没有就纯词法」实现。
2. **作者个人的推荐档 = 档 ②**：月成本个位数人民币，质量接近云端最优。相比档 ① 的 +6pt 质量，¥3/月是划算的。
3. **必须做成可独立关闭的能力**（每项一个开关，默认值写在括号里）：
   - `semantic.enabled`（默认 auto：有本地端点才开）
   - `rerank.enabled`（默认 **false**；开了也必须受 §4 #1/#2 约束）
   - `consolidate.llm.enabled`（默认 **false**，纯确定性规则可跑）
   - `conflictDetection.llm.enabled`（默认 **false**）
   - `embedding.provider`（默认 `local-endpoint`，可选 `cloud`）
   - `capture.auto`（不自动记录一切）
4. **成本上限必须是一等配置**，形态建议（对齐 00-brief §6.7「超预算自动退回词法」）：

   ```yaml
   cost:
     monthlyBudgetCNY: 5.0          # 0 = 完全禁网，等价档①
     warnAtRatio: 0.8
     onExceed: degrade              # degrade | block | warn
     degradeTo: lexical             # 退回纯词法，不换更便宜模型重试
     perCall:
       maxRerankCandidates: 10      # 硬上限，防止 Tcand 假设被打穿
       maxRerankDocTokens: 200      # 硬上限：只喂摘要
       maxEmbeddingTokensPerWrite: 400
     accounting:
       ledgerPath: .tabellio/cost.jsonl   # 每次调用落一行，可审计
       hardStopOnFileMissing: true              # 记不了账就不许花钱
   ```

   关键设计：**`onExceed: degrade` 而不是 `block`** —— 记忆检索降级到词法仍然可用，阻塞会让服务在预算用尽后彻底不可用。同时 `maxRerankDocTokens` 必须是硬上限，因为 §2.4 已证明「喂全文」会让场景 C 成本涨 12 倍。
5. **账本与降级必须可验证**：每次模型调用落一行（时间/用途/模型/token/折算 ¥/是否降级），配一条测试：把 `monthlyBudgetCNY` 设成 0.01 后，第 N 次召回必须自动退回词法且答案仍然返回。
6. **对插件市场用户**：默认档必须不下载任何权重、不装 `onnxruntime-node`、不需要 key。任何「首次运行下载 600 MB 模型」的行为都要显式征求同意。
7. **不要在 embedding 上省钱**（它只占全案 1.5%），**要在 rerank 上省钱**（95%）。这条决定了工程的优先级排序。

---

**文件**：`~/yffto/memory-service/docs/04-cost-model.md` ｜ **行数**：306 行 ｜ **建议默认档**：档 ① 全本地零 API 成本（¥0/月）+ 个人用档 ② 混合（¥2 ~ ¥7/月，轻量个人 ¥0.1 ~ ¥0.5/月）
