# 02 · 评测：AI 记忆系统怎么被证明有用

> 调研范围：公开基准的能力覆盖与判分机制、现有系统的评测可信度、长上下文 vs 检索之争、以及本项目可落地的自建评测方案。
> 每条论断带来源 URL；查不到的写「未找到公开资料」。本文档**不含产品代码**，schema 与脚本接口是设计草案。
> 调研时间：2026-10-17。

---

## 0. 结论先行

1. **公开基准整体不可直接采信。** LoCoMo 的 golden answer 有 6.4% 是错的（理论满分 93.6%），判分用的 LLM 裁判会把 62.81% 的「沾边但含糊」错答判对；EverMemOS 宣称 92.32%，第三方复现 38.38%。[locomo-audit](https://github.com/dial481/locomo-audit)
2. **最有说服力的单条证据是「满分上下文基线追平记忆系统」**：同一 CoT prompt，GPT-4.1-mini 直接读全文 92.62%，反超 EverMemOS 的 92.32%。记忆系统带来的增益在统计上不存在。[fc-baseline](https://github.com/dial481/locomo-audit/blob/main/fc-baseline/README.md)
3. **厂商数字的问题不是造假，而是「不可归因」**：prompt 形状能造成 10.67 分差（81.95% vs 92.62%），答案长度与得分 Spearman ρ=0.64。[STATISTICAL_VALIDITY](https://github.com/dial481/locomo-audit/blob/main/results-audit/STATISTICAL_VALIDITY.md)
4. **长上下文没有杀死检索，但杀死了「为了答对而检索」的论证**：真正站得住的理由是成本、延迟、成本曲线可控。Chroma 实测 18 个模型，输入变长时性能**非均匀衰减**（context rot），NIAH 近满分是假象。[context-rot](https://www.trychroma.com/research/context-rot)
5. **小项目能落地的只有自建小评测**：20~50 条手工任务 + 确定性判分 + 账本回放，成本 < $1/轮，能回答公开基准答不了的问题——**在你自己 60 条笔记的真实分布上**。
6. **四条必须测的能力**：召回正确率、注入预算（上下文成本曲线）、长期不腐烂、负迁移。前两条证明「有用」，后两条证明「不害人」。
7. **旧账本已是现成基线**：344 行、141 次注入、705 次注入口、注入后打开率 **8.1%**（去重口径 11.7%），平均每轮注入 545 tokens / 中位 554（n=65）。这个数字必须先被新系统击败。
8. **判据要能证伪**。推荐三条硬判据，其中第一条（召回压力测试）是**最小可实现**且当天能跑完的。

---

## 1. 公开基准对比表

| 基准 | 测什么能力 | 数据怎么构造 | 判分方式 | 规模 | API 成本量级 | 已知问题 |
|---|---|---|---|---|---|---|
| **Needle-in-a-Haystack (NIAH)** | 单点事实检索 | 在无关长文中埋一句「针」，问它 | 字符串精确匹配 | 合成，长度任意 | 极低（1 次调用/点） | **已饱和**：几乎所有长上下文模型接近满分，失去区分度；本质只是字面检索 [RULER](https://arxiv.org/abs/2404.06654) |
| **NIAH 多针变体 / 多跳追踪** | 多针同时检索、链式追踪 | 埋多根针、要求追踪变量赋值链 | 精确匹配 | 合成 | 低 | 仍是检索类，未覆盖推理与更新 |
| **RULER** | 13 类任务：多针检索、**多跳追踪**、**聚合** | 在 NIAH 上扩展针的类型/数量，序列长度与复杂度可配 | 任务相关（匹配/聚合结果） | 13 tasks × 17 models | 低 | 合成数据，无「用户长期偏好」这类语义；结论：宣称 32K 以上的模型里**只有一半**在 32K 还能维持可用表现 [RULER](https://arxiv.org/abs/2404.06654) |
| **∞Bench** | 超长文本理解（含检索/排序/摘要类） | 真实长文（书、代码库、论文） | 任务相关，多数可确定性判分 | 多个子集 | 中（长输入 token 大） | 未找到公开资料说明其 2024-2025 的饱和情况（本次调研未定位到权威审计） |
| **BABILong** | 长上下文里的 **reasoning-in-a-haystack** | 把 bAbI 推理任务的事实分布进长噪音 | 精确匹配 | 长度可扩到 10M+ | 中 | 合成、事实型推理，不代表真实记忆更新场景 |
| **LongMemEval** | **五项能力**：信息抽取、多会话推理、**时间推理**、**知识更新**、**拒答(abstention)** | 500 条人工精选 QA 嵌在可伸缩的 user-assistant 聊天史里（S 版 ~115K tokens/题，M 版 ~1.5M） | **LLM 裁判**（GPT-4o，70B 开源判定对齐率 >97%） | 500 题 | 中。note：M 版 1.5M tokens/题，成本高到多数人只跑 S 版 | 有 abstention 题是对的；但 500 题量小、单次运行噪声大；Zep 博客的「18.5% 提升」是**逐题型平均**且含负项 [LongMemEval](https://arxiv.org/abs/2410.10813) · [Zep](https://blog.getzep.com/state-of-the-art-agent-memory/) |
| **LoCoMo** | 单跳事实、**多跳**、时间推理、开放域、对抗(拒答) | 10 段超长多会话对话，每段 ~600 轮 / ~26K tokens，平均 200 题 | LLM-as-Judge（对比生成答案与 golden answer **文本**） | 1,986 题（实际只用 1,540） | 低-中 | **审计结论**：99/1,540 (6.4%) golden answer 错误，满分上限 93.6%；多跳类错误率 9.9%；446 道对抗题（22.5%）**从未被任何已发表结果评测**（444 题没有 golden answer 字段） [LoCoMo](https://arxiv.org/abs/2404.18021) · [audit](https://github.com/dial481/locomo-audit/blob/main/AUDIT_REPORT.md) |
| **MemoryAgentBench** | **四能力**：精确检索(AR)、**测试时学习(TTL)**、长程理解(LRU ≥100k)、**选择性遗忘(SF)** | 把现成长上下文数据集**改写为多轮增量形式**，另建新数据集 | 任务相关 + LLM-as-Judge（论文附有效性验证） | 多数据集 | 中 | 明确指出现有方法**四项能力无一全部掌握**；SF（更新/覆盖/遗忘）是最弱环节 [arXiv:2507.05257](https://arxiv.org/abs/2507.05257) |
| **MemBench** | 事实记忆(FM) vs **反思记忆(RM)**；参与 vs 观察场景；含知识更新、时间推理 | 用户关系图采样（MovieLens/Food/Goodreads 抽取高层偏好），用 GPT-4o-mini 生成对话；可注入噪音把历史推到 ~100K | **全部多选题**（作者明确理由是「避免表达灵活造成的误判」）+ **Recall@10** 检索命中 + capacity + 读/写耗时 | PS-FM 51K 会话/39K 题；PS-RM 3.5K；OS-FM 8.5K；OS-RM 2K | 中（题量巨大，但 MCQ 判分零模型成本） | 用 Qwen2.5-7B 跑，**与主流闭源模型结果不可直接比较**；合成对话的真实性存疑 [arXiv:2506.21605](https://arxiv.org/abs/2506.21605) |
| **mem0 / Zep 自建评测** | 各自定位的能力子集 | 复用 LoCoMo / LongMemEval | LLM-as-Judge | 同上游 | 低 | 见 §2 |
| **CrossBench**（2026） | 跨对话与编码工作负载的可复现记忆评测 | — | — | — | — | 论文标题即「Reproducible」，说明**可复现性已成为该领域的公认缺陷**；本次调研只拿到摘要级信息 [ACM](https://dl.acm.org/doi/abs/10.1145/3812836.3814760) |

**读表要点**：真正区分「记忆系统」与「长上下文」的题面只有三类——**跨会话整合**、**知识更新/失效**、**拒答**。其余题型（单跳、多针检索）长上下文基线本身就能做，用它来证明记忆系统的价值是无效论证。

---

## 2. 「哪些数字值得信」清单

### 2.1 具体案例（都是可核验的一手来源）

**mem0 的「+26%」**
- 原文：「Mem0 achieves **26% relative improvements in the LLM-as-a-Judge metric** over OpenAI」——注意这是**相对提升**，且 baseline 是 OpenAI ChatGPT 记忆功能，且 mem0 自己承认「intentionally granting the OpenAI approach privileged access to all memories rather than only question-relevant ones」（这反而对 baseline 有利，是加分项）。[arXiv:2504.19413](https://arxiv.org/abs/2504.19413)
- mem0 值得肯定的做法：**跑了 10 次独立评测并报 mean ± 1σ**，因为 J 指标有随机性；并明确排除了对抗类（理由：无 golden answer）。这在同领域里属于少数。
- 但复现失败：平台版复现 J≈0.20（~20%），根因是 **platform 用「当前日期」而不是数据集时间戳存记忆**，导致时间类记忆全错（问「7 May 2023」答成「January 2026」）。[mem0#3944](https://github.com/mem0ai/mem0/issues/3944)
- 另有 A-Mem baseline 数值与 A-Mem 原论文对不上的 open issue（F1/BLEU-1 具体题型不符）。[mem0#4003](https://github.com/mem0ai/mem0/issues/4003)

**Zep 的「up to 18.5%」与「90% lower latency」**
- 原文：「aggregate accuracy improvements of **up to 18.5%**」+「less than **2% of the baseline tokens**」+ latency 从 28.9s → 2.58s (GPT-4o)。[Zep blog](https://blog.getzep.com/state-of-the-art-agent-memory/)
- **拆开看才是真相**：18.5% 是 GPT-4o 下逐题型增量，同一张表里有**负项**——single-session-assistant `−17.7%`（GPT-4o）/ `−9.06%`（GPT-4o-mini），knowledge-update 也小幅下降。「up to」把负项藏在了平均值里。
- token 对比不对称：Zep 1.6k vs full-context 115k，但 full-context 拿到的是**全部历史**，Zep 拿到的是**检索子集**——这是检索 vs 全量的定义差异，不是效率差异。
- Zep 的 LoCoMo 成绩曾被 Mem0 CTO 指出 **Category 5 计分 bug**（分子含对抗题、分母不含），Zep 承认并更正为 **75.14% ± 0.17%（10 次运行）**。[zep-papers#5](https://github.com/getzep/zep-papers/issues/5)
- 值得肯定的地方：Zep 是少数**主动更正并给出多次运行误差棒**的厂商。

**EverMemOS 的「92.32%」**
- 第三方复现 **38.38%**（conv 26，152 题，419 消息；gpt-4.1-mini + Qwen3-Embedding-4B + agentic search），第二人复现同样差；作者回复「我们这边正常」并指向 Discord。[EverMemOS#73](https://github.com/EverMind-AI/EverMemOS/issues/73)
- token 成本口径错误：README 说 2,298 tokens/题，**论文自己的 Table 8 显示 6,045–6,669**（2.6–2.9×）；相对全量的实际节省是 67% 而非宣称的 89%。[token_efficiency](https://github.com/dial481/locomo-audit/blob/main/methodology/token_efficiency.md)
- 分数**超过被污染的上限**（single-hop 95.96% > 95.72%，multi-hop 91.37% > 90.07%）——数学上不可能，除非裁判在错题上给了分。[RESULTS_AUDIT](https://github.com/dial481/locomo-audit/blob/main/results-audit/RESULTS_AUDIT.md)

### 2.2 通用红旗清单

| 红旗 | 为什么致命 | 怎么验 |
|---|---|---|
| **LLM 裁判用「宽松/沾边即可」prompt** | 实测接受 **62.81%** 的「含糊但切题」错答（具体但错的只接受 10.61%，6× 差距）。一个「知道所有答案但故意答错」的系统在多个类目上得分比 Mem0/MemU 还高 | 用 V2 对抗集打自己的裁判，接受率 >20% 就不合格 |
| **答案无长度限制** | 不限制长度的系统产出答案是 golden 的 10–11×，给裁判更多表面匹配面积；word count 与 accuracy **Spearman ρ=0.64** | 限制答案长度后重跑；或把长度作为协变量 |
| **baseline prompt 更弱** | 同一模型同一上下文，仅换 prompt 产生 **10.67 分**差（81.95% vs 92.62%） | 要求给出 baseline 的完整 prompt，或自己重跑 baseline |
| **只报单次运行的点估计** | 6.4% GT 错误 + 62.81% 裁判误收，2–3 分的差异完全在噪声内。五篇论文**无一报告显著性检验** | 至少 3–10 次运行报 mean ± σ（mem0 与更正后的 Zep 做到了） |
| **per-category 比较** | LoCoMo 各类目 n 从 96 到 841（8.8×）。Open-domain (n=96) 的 95% CI 宽度 **17.9 分**——要 15+ 分差距才能区分两个系统。**多跑几次也修不好**：10 次均匀重跑后 Open-domain 精度仍比 Single-hop 差 3.0× | 用 Wilson 区间；n<200 的类目不做系统间比较 |
| **总成本口径混用** | 「Avg. Tokens」列里混着「只算检索上下文」和「2–3 次 LLM 调用 + 729-token CoT prompt + agentic 检索」 | 要求分列：retrieval context tokens / total tokens / LLM calls / 墙钟延迟 |
| **baseline 数值抄错** | Mem0 论文 Table 1 里 A-Mem 的数字与原论文不符（open issue） | 抽查一个 baseline 数字回到其原始出处 |
| **「up to」** | 把负项藏在最大值里（Zep −17.7% 的类目） | 要逐题型全表，不要 headline |
| **厂商自评** | 全部上述厂商评测都是自评；第三方复现率在这一领域极低 | 只信：第三方复现过的、或你自己跑出来的 |

**一句话**：这个领域**没有一个可以直接采信的公开数字**。公开基准的用途是**设计思路参考**（LongMemEval 的五能力、MemoryAgentBench 的四能力、MemBench 的 MCQ+Recall@10 双指标），不是拿来当基线对比的。

---

## 3. 长上下文 vs 检索：窗口到 1M~10M 之后检索还有必要吗

**结论：必要性来自成本与可靠性，不来自「模型放不下」。**

支持「检索仍必要」的证据：
1. **NIAH 饱和但context rot 真实**。Chroma 评测 18 个模型（含 GPT-4.1、Claude 4、Gemini 2.5、Qwen3），结论是模型**非均匀使用上下文**：即使简单任务，输入越长性能越不可靠；NIAH 近满分是因为它只是「已知句子检索」。[context-rot](https://www.trychroma.com/research/context-rot)
2. **多针/多跳/聚合任务上衰减剧烈**。RULER 说几乎所有模型在 vanilla NIAH 近满分，但**宣称 32K+ 的模型只有一半**在 32K 长度还能维持可用表现。[RULER](https://arxiv.org/abs/2404.06654)
3. **成本与延迟是硬约束**。Zep 实测 full-context GPT-4o 中位延迟 **28.9s**、**115k** context tokens；Zep 2.58s / **1.6k**。即使准确率打平，延迟差一个数量级。[Zep blog](https://blog.getzep.com/state-of-the-art-agent-memory/)
4. **LongMemEval 的原始动机就是放不下**：commercial assistants 与长上下文 LLM 在持续交互中**准确率掉 30%**；且 M 版 **1.5M tokens/题**，连 GPT-4o 的 128K 都装不下，Zep 只能退而用 S 版（115K）。[LongMemEval](https://arxiv.org/abs/2410.10813)

**反方（必须诚实记录）**：
5. **在放得下的范围内，全量上下文可能直接追平甚至超过记忆系统**。GPT-4.1-mini + full context + CoT prompt = **92.62%**，超过 EverMemOS 的 92.32%。也就是说，LoCoMo 这个量级（~26K tokens/对话）**根本不需要记忆系统**。[fc-baseline](https://github.com/dial481/locomo-audit/blob/main/fc-baseline/README.md)

**对项目的含义**：只有当「历史总长 × 每轮调用次数」超过成本或延迟可接受范围时，检索才有价值。所以**我们必须测量成本曲线，而不是只测准确率**——这正是 §4 的「注入预算」指标。这也解释了为什么「上下文成本曲线」应该是一等指标。

---

## 4. 自建评测方案（重点）

### 4.1 设计原则：先承认我们要回答的问题是什么

公开基准回答的是「你的系统在别人的数据上排第几」。我们要回答的是三个**自己的**问题：
- 该找到的记忆，找到了吗？（召回正确率）
- 找到的代价，值得吗？（注入预算 / 成本曲线）
- 它会不会随着时间变坏、会不会害人？（腐烂 / 负迁移）

### 4.2 20~50 条任务的构造方法

**构造单位是三元组**：`任务` × `已知需要哪条记忆（gold_notes）` × `可判分的期望`。

**四步法**：
1. **从真实账本取样**（见 §4.7）。旧的 `.engramory-recall.jsonl` 里有 141 次真实注入、60 条被注入过的笔记 ID、以及**注入后真被打开的 18 次事件**——这 18 次就是天然的正样本：我们知道「这条笔记确实被需要了」。
2. **反向构题**：不是「先写题再找记忆」，而是「**先选定一条记忆，再写一道只有它能回答的题**」。这样 gold_notes 是构造时就确定的，不用事后标注。
3. **能力配额**（30 条的最小集建议配比）：
   | 能力 | 条数 | 说明 |
   |---|---|---|
   | 单跳事实（single-hop） | 6 | 基线，必须接近 100%，低于 90% 说明索引坏了 |
   | 多跳整合（multi-hop） | 6 | 需要 2+ 条记忆联合 |
   | **时间推理** | 4 | 「上次」「三个月前」这类相对时间 |
   | **知识更新/失效** | 6 | 同一条记忆后来被推翻，必须用新的；**测遗忘** |
   | **拒答**（abstention） | 4 | 记忆库里根本没有，正确行为是说不知道 |
   | **负迁移陷阱** | 4 | 库里有一条「看起来相关但错误/过期」的记忆，考它会不会被带偏 |
**当前落地（2026-10-17）**：`core-30-v1` 扩到 56 题 —— 可答 36（`single_hop` 20 / `knowledge_update` 8 / `negative_transfer` 4 / `multi_hop` 2 / `temporal` 2）+ 拒答 20。`capability` 已在每题显式标注，缺省仍按 `kind` 回退；但 `multi_hop` / `temporal` 各只有 2 题、`negative_transfer` 4 题，分层数字只当方向。

4. **写期望答案时用「判分三选一」**：能确定性判分的优先（数值/日期/ID/枚举），其次关键词集合，最后才允许 LLM 裁判（配额 ≤ 20%）。

### 4.3 怎么避免自欺（防泄漏五条）

1. **任务文本不得包含答案串**。构造后用 n-gram 检查：把期望答案与 gold_notes 正文做字符 8-gram 重叠，重叠率 >30% 的题**退回重写**。这一条能挡掉「模型其实是从题面里抄的」这类假阳性。
2. **生成与判分不能是同一个模型**。若必须用 LLM 裁判，则：裁决模型 ≠ 生成模型；且对 LLM 裁判的题**按 20% 抽检人工复核**，把人工与裁判的一致率（Cohen's κ）作为裁判本身的质量指标记录在报告里。κ < 0.6 则该裁判的分数不采信。
3. **题目集与调参集分离**。禁止在跑分集上调 BM25 权重/阈值。做法：把 30 条随机切成 `dev`(12) / `test`(18)，dev 随便调，test **每改一次系统只准跑一次并归档**；跑分记录里带上系统 git hash 与配置 hash。
4. **防「裁判偏爱长答案」**。所有答案**限长**（如 ≤60 字），并额外记录答案长度与得分的相关系数；若 ρ > 0.4，说明判分被长度污染，必须换判分。
5. **防重复计分/子串漏判**。同一答案命中多条 gold_notes 时只算一次；关键词判分必须做大小写/全半角/中英文数字归一化，并把「命中但没被用上」单独统计（不要算成命中）。

### 4.4 便宜的判分方案与成本

判分优先级（从便宜到贵，能用便宜的就不用贵的）：

| 判分器 | 适用 | 单条成本 | 什么时候用 |
|---|---|---|---|
| `substring` / `regex` / 归一化匹配 | 日期、数字、ID、枚举 | **0** | 首选，尽量把题设计成这种 |
| `set_match`（关键词集合，含权重） | 多跳整合 | **0** | 次选 |
| `refusal_match`（是否拒答） | 拒答类 | **0** | 必用，别让裁判判「拒绝」 |
| `cheap_judge`（小模型 + 严格 rubric） | 自由文本但语义单点 | ~1 次短调用 | 配额 ≤ 20% |
| `human_spot_check` | 全部 | 人工 | 抽检 20% + 全部争议条目 |

**成本估算（以 30 条任务、30 轮对话为一轮评测为单位）**：
- 判分：24 条确定性（0）+ 6 条小模型裁判（每题 <1K tokens 输入）≈ **< 10K tokens**
- 生成/回答：30 题 × (检索上下文 ~1.5K + 题面 + 答案) ≈ **50~80K tokens**
- 检索侧写入成本：取决于系统，建议单独列账不摊进判分
- **单轮评测总量级 ≈ 10^5 tokens 以内**；按主流小模型价位是**分级（cents 级）**。
- 换算成钱时用公式，不要硬编码单价：`cost = Σ(tokens_in × p_in + tokens_out × p_out)`，单价从厂商官方定价页读取并记录**取价日期**。本次调研**未找到可稳定引用的官方定价页快照**，故此处不写具体 $ 数值——避免出现过期或编造的价格。

### 4.5 四个必须测的能力（指标定义）

设一轮评测有 N 条任务，第 i 条的 gold_notes 为 $G_i$，系统注入的记忆集合为 $I_i$，被后续读取/使用的为 $U_i$。

**(1) 召回正确率**
- `recall@k = |G_i ∩ top-k(I_i)| / |G_i|`，报告 mean 与分能力拆解。
- `hit_but_unused_rate = |(G_i ∩ I_i) \ U_i| / |G_i ∩ I_i|`——**命中了但没被用上**。这个指标专门抓「检索对了、注入对了、模型还是没用」，是旧插件 8.1% 打开率问题的真正诊断口。
- 拒答题单独看 `correct_refusal_rate`（不能算进 recall）。

**(2) 注入预算（上下文成本曲线）**
- 每轮记录 `injected_tokens`（本次 push 进上下文的总 token）。
- `token_efficiency = Δaccuracy / (injected_tokens/1000)`——每 1K 注入 token 换来多少准确率。
- **画成本曲线**：横轴 = 允许的注入预算（如 200/500/1000/2000 tokens），纵轴 = 准确率。曲线拐点之前的预算是「赚的」。
- `retrieval_overhead_ratio = injected_tokens / full_context_tokens`（对照全量基线，Zep 报的是 <2%，我们自己的基线是 545/未知）。
- 旧账本实测基线：`spent` 均值 **545.1**、中位 **554**、min 450 / max 599（n=65）。**新系统必须在同等或更少 token 下赢过这个数。**

**(3) 长期不腐烂**
- 设计成**时间回放**：同一批任务在 t0 跑一次，在 t0+2 周、t0+4 周各跑一次，期间正常使用、不断写入新记忆。
- 指标：`staleness_rate` = 答案与「当时已失效的旧记忆」一致的条数 / 总条数；`contradiction_flag_rate` = 同一个问题两次运行答案互相矛盾的比率。
- 关键：必须有**知识更新类题目**（同一条记忆后被推翻），否则这个指标恒为 0 无意义。

**(4) 负迁移（错误的记忆是否会伤害回答）**
- 对照组设计：`无记忆`(closed-book) / `正确记忆`(oracle) / `系统记忆`(real)。
- `negative_transfer = acc(no_memory) − acc(real_memory)`，**正值即为伤害**。
- 陷阱题设置：在库里放一条**语义高相似但内容错误/过期**的记忆，看系统是否被它带偏（`trap_fall_rate`）。
- 这条是四条里**最容易被忽略、也最可能致命的一条**：记忆系统的失败模式不是「没想起来」，而是「想起来了错的」。

### 4.6 评测集 JSON schema 草案

> **实现现状（2026-10-17）**：下面这份 schema 仍是**目标设计**，尚未整体落地。当前 `bench/core-30-v1/tasks.json` 只有顶层 `version` 和 `tasks`；每题字段为 `id / kind / prompt / expect[] / forbid[] / source[] / answer_aliases[]`。其中 `answer_aliases` 已实现，其余差异与迁移顺序见 §4.6.1。

```jsonc
{
  "schema": "yffto.eval.suite/1",
  "suite_id": "core-30-v1",
  "created_at": "2026-10-17T02:33:08+08:00",
  "notes": "人工构造；gold_notes 在构题时即确定，不做事后标注",
  "corpus_ref": {                       // 评测时用的记忆库快照
    "kind": "engramory_dir",
    "path": "~/memory/engramory",
    "snapshot_id": "2026-10-17T02:00:00+08:00",
    "note_count": 60
  },
  "cases": [
    {
      "id": "c001",
      "capability": "single_hop",       // single_hop|multi_hop|temporal|knowledge_update|abstention|negative_transfer
      "difficulty": 1,                  // 1..3，人工标注，用于分层报告
      "setup": {                        // 可选：评测前对该条做的记忆库操作（测更新/腐烂用）
        "ops": [
          { "op": "assert_note", "id": "project-foo.md", "content_sha256": "..." },
          { "op": "invalidate_note", "id": "project-foo-old.md", "reason": "被 c001 更新" }
        ]
      },
      "query": "我上次说记忆服务的预算上限是多少？",
      "gold_notes": ["project-memory-system-choice.md"],   // 已知需要哪条记忆
      "expected": {
        "answer": "500 元/月",
        "answer_aliases": ["500元/月", "每月500"],
        "must_not_contain": ["2000", "不限"],              // 反向约束，抓幻觉
        "judge": "substring",           // substring|set_match|refusal_match|cheap_judge|human
        "judge_args": { "normalize": ["case", "fullwidth", "cjk_number"] }
      },
      "negative_transfer_probe": {       // 仅 capability=negative_transfer 时填
        "distractor_note": "reference-next-proxy-authed-path-404.md",
        "why_wrong": "该笔记描述的是另一个项目的路径，与本题无关但语义相似",
        "fall_patterns": ["404", "authed-path"]
      },
      "leak_check": {                    // §4.3 防泄漏自检，由构造脚本写入
        "max_ngram_overlap_with_gold": 0.11,
        "passed": true
      },
      "tags": ["budget", "personal"]
    }
  ],
  "budgets": [200, 500, 1000, 2000],     // 成本曲线要扫的注入预算档位（tokens）
  "baselines": ["closed_book", "oracle_gold", "ledger_replay"],
  "scoring": {
    "primary_metric": "capability_weighted_accuracy",
    "report": ["recall@k", "hit_but_unused_rate", "injected_tokens",
               "token_efficiency", "staleness_rate", "negative_transfer",
               "correct_refusal_rate", "trap_fall_rate"],
    "judge_model_policy": "judge_model != generator_model; human_spot_check_ratio=0.2"
  }
}
```

#### 4.6.1 目标 schema 与当前题集的差异（2026-10-17）

| 目标字段 | 当前实际 | 后果 |
|---|---|---|
| `capability` | 顶层 `capability`（六类之一），缺省从 `kind` 回退 | **已实现（2026-10-17）**：56 题全部显式标注；`single_hop` 20 / `multi_hop` 2 / `temporal` 2 / `knowledge_update` 8 / `abstention` 20 / `negative_transfer` 4。可按能力分层报告。边界：`multi_hop` / `temporal` 各只有 2 题，`negative_transfer` 4 题，分母太小，只当方向；`temporal` 测的是时间点/时长对齐，不是 `as_of` 历史回放。 |
| `gold_notes[]` | `source[]`（笔记 id） | 有等价物；oracle 臂读它。 |
| `expected.answer` | `expect[]`（逐字子串） | 判分仍是 substring；`expect` 之外的正确改述要靠 `answer_aliases` 兜，语义判分未做。 |
| `expected.answer_aliases` | 顶层 `answer_aliases[]`（不是 `expected` 内） | **已实现（2026-10-17）**：32 道可答题各补 1–4 条，判分改判 `expect[] || answer_aliases[]`；`forbid[]` 优先级不变，别名不能绕过反向约束。仍是人工白名单，不是语义判分；白名单没覆盖的改述仍会误判。 |
| `expected.must_not_contain` | `forbid[]` | 已用于反向约束。 |
| `expected.judge` / `judge_args` | 无（只有硬编码 substring + 拒答规则） | 没有 `set_match` / `cheap_judge` / 人工抽检；拒答用「空答案 / `refused` 标志 / 固定措辞正则」判（`bench/scorer.mjs` 的 `looksRefused`），不是独立的 `refusal_match` 字段。 |
| `negative_transfer_probe` | 顶层 `negative_transfer_probe`（4 道 `negative_transfer` 题） | **已实现（2026-10-17）**：`distractor_note` + `why_wrong` + `fall_patterns`，探针值必须能在 distractor 正文追到且不进 `source`。当前 `trap_tasks=4`；零模型 `echo` 口径 `trap_falls=1`、`trap_fall_rate=0.25`（f01 回显预发端口 9443），真模型回答层是 0/4。n 太小，不能据此写「判据 3 成立」。 |
| `setup.ops` | 无 | 不能在题级构造失效/更新场景；目前靠 `bench/replay.mjs` 的时间回放单独测。 |
| `difficulty` / `leak_check` / `tags` | 无 | 不能按难度分层报告，也没有自动 8-gram 防泄漏自检。 |
| 顶层 `budgets` / `baselines` / `scoring` | 无 | 预算曲线、基线与权重在 CLI/脚本层表达，不在题集 schema 里。 |

**迁移顺序**：① **已完成（2026-10-17）**：`kind` → 显式 `capability`、原 32 道可答题补 `answer_aliases`；② **部分完成**：`negative_transfer_probe` 已落地 4 道题，`setup.ops` 仍未做；③ `difficulty` / `leak_check` / `tags` 未做，改由测试里的 8-gram / 标题重叠检查兜底。分层、陷阱现在有数，但 `multi_hop` / `temporal` 各 2 题、`negative_transfer` 4 题，只当方向，不是统计结论；别名只证明「白名单内的改述能被接住」，不证明语义判分。

**同目录放最小语料快照**：只放被 gold_notes 引用到的笔记 + 陷阱笔记（约 20~30 条），其余从真实库里按快照 ID 引用，避免评测集里囤一份会腐烂的副本。

#### 4.6.2 判分器对抗集（已实现，2026-10-17）

判分器自己也会错：宽松的判分器会把「含糊但切题」的错答案收下，严格的逐字判分器会把正确改述判错。两种错误都会污染后续所有数字，所以先打裁判、再信分数。

- **题集**：`bench/core-30-v1/adversarial.json`，106 条用例，仍挂在 `core-30-v1` 原有 52 道题上（新加的 4 道多跳/时间题暂未进对抗集）。
  - 应接受 52 条：32 条正确改述 + 20 条干净拒答。
  - 应拒绝 54 条：32 条「含糊但切题」（`ambiguous_wrong`）+ 20 条编造答案（`hallucinated`）+ 2 条「先拒答再补编造值」的 `hedged_hallucination`。
- **跑法**：`node bench/judge-adversarial.mjs`（`--json` 出机器可读，`--verbose` 列全部用例，`--tasks` / `--suite` 换题集）。零依赖、零模型调用，失败退 1，参数/文件错误退 2。
- **判据**：误收率 = 实际接受的应拒绝用例 / 应拒绝用例总数，必须 **< 0.20**；正确接受率必须 **≥ 0.95**（正确改述被拒也是判分器 bug）。两条同时满足才 `pass`。
- **2026-10-17 实测**：106 条全部符合预期；应拒绝 54 条**一条没被收**（误收率 0.0000），应接受 52 条**全部接住**（正确接受率 1.0000）。按 label：`correct` 32/32、`correct_refusal` 20/20、`ambiguous_wrong` 32 全拒、`hallucinated` 20 全拒、`hedged_hallucination` 2 全拒。
- **边界**：这打的是**规则判分器**（substring + 别名 + 拒答正则），不是 LLM 裁判；20% 人工抽检与 Cohen's κ **仍未做**。别名是人工白名单，可能对题集过拟合；它只说明「这批改述能接住」，不说明「任意语义等价都能接住」。`negative_transfer_probe` 已落地 4 道题，但对抗集没有覆盖新加的多跳/时间题；`trap_fall_rate` 现有 4 题分母（零模型 1/4，真模型 0/4），只能当方向。

### 4.7 跑分脚本接口（设计 vs 现状）

> **实现现状（2026-10-17）**：脚本不是 `run_eval.py`，而是零依赖的 `node bench/run-eval.mjs`。下面是早期设计稿；实际参数与输出字段以 `node bench/run-eval.mjs --help` / `--json` 为准。

```bash
# 零成本（CI 默认）：检索臂 + echo 回答器
node bench/run-eval.mjs --same-corpus --arms none,new,legacy --json

# 回答层三档（真实模型；需要 EVAL_LLM_API_KEY 或 DEEPSEEK_API_KEY）
node bench/run-eval.mjs --same-corpus --arms none,new,oracle \
  --answerer llm --runs 3 --concurrency 4 --json --out bench/core-30-v1/runs/answer.md
```

常用参数：`--arms`（`none` / `new` / `legacy` / `oracle`）、`--answerer`（`echo` / `first-hit` / `llm`）、`--runs`、`--concurrency`、`--json`、`--dry`、`--same-corpus`、`--out`，以及 `--tasks` / `--library` / `--cli` / `--store` / `--timeout` / `--keep-scratch`；题集默认 `bench/core-30-v1`。完整列表见脚本头注释。`--budget` / `--seed` 尚未实现。

**输入（早期设计稿，未全部实现）**
| 参数 | 含义 |
|---|---|
| `--suite` | §4.6 的评测集 JSON |
| `--system` | 被测系统适配器：`none`(closed-book) / `ledger_replay`(旧账本回放) / `engramory`(旧插件) / `new`(新服务) |
| `--budget` | 单轮注入 token 上限（扫描成本曲线时逐档调用） |
| `--runs` | 重复次数，用于报 mean ± σ（对齐 mem0/Zep 的做法，≥3） |
| `--seed` | 随机种子，写入结果以便复现 |

**输出（早期设计稿；实际字段以 `--json` 为准）**（`results/<suite>__<system>__<budget>__<hash>.json`）
```jsonc
{
  "run": { "suite_id": "core-30-v1", "system": "new", "budget": 500,
           "runs": 3, "seed": 42, "system_git": "abc1234", "config_hash": "d41d8",
           "started_at": "...", "duration_s": 61.2 },
  "aggregate": {
    "accuracy": 0.833, "accuracy_sigma": 0.021,
    "by_capability": { "single_hop": 1.0, "multi_hop": 0.667,
                       "temporal": 0.75, "knowledge_update": 0.833,
                       "abstention": 0.75, "negative_transfer": 0.75 },
    "recall@5": 0.90, "hit_but_unused_rate": 0.18,
    "injected_tokens_mean": 486, "token_efficiency": 1.71,
    "correct_refusal_rate": 0.75, "trap_fall_rate": 0.25,
    "staleness_rate": null, "negative_transfer": -0.033
  },
  "per_case": [
    { "id": "c001", "correct": true, "judged_by": "substring",
      "gold_hit": true, "gold_used": true,
      "injected": ["project-memory-system-choice.md"], "injected_tokens": 412,
      "answer": "500 元/月", "latency_ms": 1830 }
  ],
  "cost": { "judge_tokens_in": 4210, "judge_tokens_out": 320,
            "answer_tokens_in": 61230, "answer_tokens_out": 3100 },
  "human_spot_check": { "n": 6, "agree": 5, "kappa": 0.71 }
}
```

**指标定义（脚本内唯一权威）**
| 指标 | 公式 |
|---|---|
| `accuracy` | 判对条数 / N（拒答题按拒答规则判） |
| `recall@k` | `mean_i( |G_i ∩ top-k(I_i)| / |G_i| )` |
| `hit_but_unused_rate` | `mean_i( |(G_i∩I_i) \ U_i| / |G_i∩I_i| )`，分母为 0 的题目排除并单列计数 |
| `injected_tokens_mean` | `mean_i(injected_tokens_i)` |
| `token_efficiency` | `Δaccuracy / (injected_tokens_mean/1000)`，Δ 相对 `closed_book` 基线 |
| `negative_transfer` | `acc(closed_book) − acc(real)`，**正值=有害** |
| `trap_fall_rate` | 落入 `fall_patterns` 的陷阱题比例 |
| `staleness_rate` | 答案与「已失效记忆」一致的条数 / N |

### 4.8 把旧账本当评测输入 / 基线

账本路径：`~/memory/engramory/.engramory-recall.jsonl`（**只读**，本调研未修改、也未复制其内容）。

**实测结构**（344 行，112 KB）：
| kind | n | 字段 | 含义 |
|---|---|---|---|
| `hit` | 141 | `ts, kind, query, ids[], injected, collapsed, dropped, scores[], scope, depth, budget, spent, collapsedIds[], topScore, noteChars, demoted, gate` | 一轮 BM25 推送：注入了哪些笔记、花了多少 token |
| `used` | 78 | `id, via, lagMs, ts` | 某条笔记被实际使用 |
| `opened` | 78 | `id, via, ts` | 某条笔记被打开（`via`: read 92 / edit 55 / write 5 / grep 4） |
| `skip` | 46 | `query, reason, depth, ids[], scores[], scope` | 未推送（reason: duplicate 21 / chitchat 13 / too-short 9） |
| `deny` | 1 | `ids[], query, reason` | 写入被守卫拒绝 |

**从账本能算出的基线（本次实测）**：
- 注入总口数 **705**（141 轮），涉及**去重 60 条笔记**。
- `opened` 事件 78 次，其中落在「曾被注入过的笔记」上的占 8.1%（按注入槽位计）；**去重口径：60 条被注入过的笔记里只有 7 条后来被打开 = 11.7%**。
  - ⚠️ 口径不一致提示：任务书里提到「基础打开率 2.4%」，本次用「opened 事件 / 注入槽位」算出 8.1%、用去重口径算出 11.7%，**两个都对不上 2.4%**。2.4% 很可能用了不同分母（例如按全部 344 行或按所有笔记总数）。**新项目必须先把这个指标的口径定死并写进 schema**，否则历史基线不可比。
- `spent`（每轮推送消耗 token）：n=65, mean **545.1**, median **554**, min 450, max 599。
- 折叠/丢弃：`(collapsed, dropped)` 分布 `(0,0)`×117 / `(1,0)`×24 —— 推送层几乎没有做预算裁剪。

**用法一：回放当基线。** 实现 `--system ledger_replay`：对每条评测任务的 query，回到账本里找对应的 `hit` 记录，把当时注入的 `ids` 当作系统的检索结果。这样就得到一个**无需重跑旧系统**的检索侧基线（`recall@k` 与 `injected_tokens` 都能算），可与新系统逐条对比。

**用法二：挖正样本。** `opened`/`used` 事件里 `id` 与时间戳齐全，配合 `hit` 的 `query` 就能重建「哪个 query 需要哪条笔记」——这是 §4.2 第 1 步的样本来源，**比人工凭空想题更贴近真实分布**。

**用法三：`skip.reason` 当负样本分布。** 46 条 skip（duplicate/chitchat/too-short）告诉我们真实的「不该推送」场景长什么样——用它来构造拒答题与「安静不打扰」的评测项。

**注意**：账本缺少「推送后模型是否**用了**这条记忆」的直接证据，`used` 只有 78 条且无法区分「恰好也读了」与「因为推送才读」。所以账本只能做**检索侧**基线，**不能**替代端到端判分。

---

## 5. 三条必须满足的判据（候选，可量化、能证伪）

> 三条都是 deny-by-default：**跑不出通过的结果就是没通过**，不允许「趋势向好」这种说法。

**判据 1 · 召回压力测试（最小可实现，推荐第一个做）**
> 在 `core-30-v1` 评测集上，`recall@5 ≥ 0.80` 且 `correct_refusal_rate ≥ 0.75`。
- 证伪条件：召回 < 0.80，或把拒答题答成幻觉（拒答率 < 0.75）。
- 为什么第一：不依赖 LLM 裁判（纯集合运算），当天可跑完，且它失败时后面三个指标都没有讨论价值。

**判据 2 · 成本不劣化**
> 在同等准确率下，`injected_tokens_mean ≤ 545`（旧账本基线）**且** `token_efficiency ≥ 2.0`（每 1K 注入 token 至少换 2 个百分点的准确率增益）。
- 证伪条件：注入 token 比旧方案多但准确率没涨；或成本曲线上不存在「拐点之前」的预算档位。
- **当前实测（2026-10-18，56 题，deepseek-flash，3 轮，top-5 实际注入）**：`injected_tokens_mean = 166.2` 过 ≤545，`token_efficiency = (0.786−0.357) ÷ 0.1662 = 2.579`，**达标**。此前记的 266 / 1.611 是把 CLI search 的 top-8 候选预算当成 top-5 实际注入成本的计量错误，同一批回答按实际注入重算即为 2.579，旧数作废。top-2 裁剪实验（new 0.792 / 70.3 token）效率 **6.182**、成本更低，但默认仍按 top-5 注入；是否改成产品默认需另一次真实使用验证。
- 为什么：这是唯一能反驳「直接用全量上下文算了」的判据。参考 §3：如果我们的注入成本逼近 full-context，那检索层就没有存在理由。

**判据 3 · 不腐烂、不害人**
> 4 周回放后 `staleness_rate ≤ 0.05`，且 `negative_transfer ≤ 0.02`（正值=有害，即记忆不得让准确率下降超过 2 个百分点）。
- 证伪条件：同一个问题跨周答案自相矛盾；或加入记忆后比 closed-book 更差；或陷阱题落入率 > 25%。
- **当前实测（2026-10-18，56 题）**：真模型 top-5 回答层 `trap_fall_rate = 0/4`（none/new/oracle 均为 0），`negative_transfer = −0.429`；top-2 为 −0.435。回放 `staleness_rate = 0/168`。三项数值都过线，但陷阱分母只有 4；零模型 `echo` 口径仍是 1/4 = 0.25（f01 回显 9443）。因此写「窄口径数值过线」，不写「判据 3 成立」。
- 为什么：记忆系统的失败模式不是「没想起来」而是「想起了错的」，而这一条恰恰是所有公开基准（LoCoMo 完全没测、LongMemEval 有 abstention 但无时间回放）覆盖最弱的。

---

## 6. 对我们意味着什么

1. **不要复现公开基准，要复现「受控对照」这个方法论**。LoCoMo 的教训是：只要 prompt/裁判/baseline 任一不对称，10 分的差距可以凭空产生。我们做任何对比，必须同时报出 `closed_book` / `oracle_gold` / `real` 三条线，缺一条就不下结论。
2. **评测先行 = 先写 schema 和 baseline 采集，再写检索代码**。旧插件的账本已经提供了检索侧基线和真实正样本；在新服务写第一行代码前，先把 `ledger_replay` 适配器做出来，把 8.1%（或厘清口径后的真实值）钉死为必须击败的数字。
3. **一等指标是「注入 token」，不是「准确率」**。因为准确率的天花板被 full-context 基线压着（§3 证据 5），而我们真正的优势只可能来自「同等答案、更少上下文」。所以 `token_efficiency` 与成本曲线必须进 CI，每次改动都重画。
4. **判分器本身要被评测**。用 V2 式「含糊但切题」的对抗答案先打自己的裁判（目标：接受率 < 20%），并记录人工抽检的一致性 κ。一个未经对抗测试的 LLM 裁判会让所有后续数字失去意义（LoCoMo 上它的误收率是 62.81%）。本仓库已落地规则判分器的对抗集（`bench/judge-adversarial.mjs`，106 条，见 §4.6.2）；人工抽检 κ 仍未做。
5. **`hit_but_unused_rate` 是旧项目真正的尸检报告**。旧方案只知道「后来被打开」（8.1%），不知道「推送了、也检索对了、但模型没用」。新评测必须把「命中」「注入」「使用」拆成三个独立事件记录，否则下一个 2.4% 还是查不出原因。

---

## 附录 · 未能核实的项（不编数据）

- **∞Bench** 的规模、判分细节与饱和情况：本次调研未定位到权威审计或官方统计页，表格中相应单元格已标注「未找到公开资料」。论文本身存在（arXiv:2402.13718），但未取得可引用的数据点。
- **厂商 API 单价**：未取得可稳定引用的官方定价页快照，故 §4.4 只给 token 量级与换算公式，不写具体 $ 数值。
- **CrossBench**（ACM 10.1145/3812836.3814760）：仅取得标题与摘要级信息，具体能力覆盖未知。
- **「打开率 2.4%」的口径**：与本次实测的 8.1%/11.7% 不一致，根因未确定（见 §4.8）。

---

文件路径：`~/yffto/tabellio/docs/02-evaluation.md` · 行数：**365** · **推荐的第一个评测**：`core-30-v1` 上的**判据 1 召回压力测试**（`ledger_replay` 基线 vs 新系统，纯集合运算判分，零模型成本，当天可完成）——先跑 `--system none` 与 `--system ledger_replay` 两条命令验证评测脚手架本身没坏。
