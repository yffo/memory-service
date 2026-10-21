# core-30-v1 评测报告（实跑）

- 时间：2026-10-21T18:12:26.345Z
- 题集：/Users/yangfu/yffto/tabellio/bench/core-30-v1/tasks.json（56 题：fact_recall 13、preference 8、procedure 7、correction 8、refusal 20）
- 能力分布：single_hop 20、multi_hop 2、temporal 2、knowledge_update 8、abstention 20、negative_transfer 4（按题集 capability；陷阱题才有陷阱率）
- 语料库：/Users/yangfu/yffto/tabellio/bench/core-30-v1/library（50 篇，虚构）
- new 臂 CLI：/Users/yangfu/yffto/tabellio/bin/memory
- new 臂库：语料库临时副本（50 篇 → notes/） → /var/folders/s4/bjz__1hn1vbc5tlfl2zk_dgr0000gn/T/core30-eval-5tTvBA/store
- 预检：status → notes 50，parseFailures 0，index 有
- legacy：~/yffto/dsh-engramory-recall（库 /Users/yangfu/memory/engramory）
- 回答器：echo（回显全部注入上下文，非模型，零成本）；recall@5（命中判定：gold 笔记进没进 top-5）；实际注入 top-5
- 臂：none（无记忆（closed_book）） / new（tabellio（real））

## 指标 × 臂

| 指标 | none | new | 判据 |
| --- | --- | --- | --- |
| recall@5（有来源的题） | 0 | 0.861 | ≥ 0.8 |
| correct_refusal_rate（拒答题） | 1 | 0.75 | ≥ 0.75 |
| refusal_calibration（文档口径） | 0.357 | 0.804 | 参照 |
| match_rate（答案逐字命中） | 0.357 | 0.768 | 参照 |
| expect_hit_rate（信息进了上下文） | 0 | 0.554 | 参照 |
| injected_tokens（合计） | 0 | 5793 | — |
| injected_tokens_mean（单题均值） | 0 | 103.5 | ≤ 500 |
| token_efficiency（命中/千 token） | — | 5.351 | 越大越好 |
| hit_but_unused_rate（漏用率） | — | 0 | 越小越好 |
| answered_rate（没拒答的比例） | 0 | 0.625 | 参照 |
| trap_fall_rate（陷阱题落入率） | 0 | 0.25 | 规则口径，越小越好 |
| 调用失败数 / 缺题数 | 0 / 0 | 0 / 0 | 0 |

## 判据 1（core-30-v1）

- recall@5：new 臂 0.861 → 达标（阈值 0.8）
- correct_refusal_rate：new 臂 0.75 → 达标（阈值 0.75）
- 单题注入 token 均值：new 臂 103.45 → 达标（阈值 500）
- 三条指标都在阈值内。
- 参照：none 臂 recall@5 = 0（该臂什么都看不到，是退化基线）

**结论：判据 1 成立（三件都达标）**

## 按题型

| 题型 | 臂 | 题数 | recall@5 | correct_refusal | match_rate | 漏用率 |
| --- | --- | --- | --- | --- | --- | --- |
| fact_recall | none | 13 | 0 | — | 0 | — |
| fact_recall | new | 13 | 1 | — | 0.846 | 0 |
| preference | none | 8 | 0 | — | 0 | — |
| preference | new | 8 | 0.875 | — | 0.75 | 0 |
| procedure | none | 7 | 0 | — | 0 | — |
| procedure | new | 7 | 0.571 | — | 0.571 | 0 |
| correction | none | 8 | 0 | — | 0 | — |
| correction | new | 8 | 0.875 | — | 0.875 | 0 |
| refusal | none | 20 | — | 1 | 1 | — |
| refusal | new | 20 | — | 0.75 | 0.75 | — |

## 按能力

| 能力 | 臂 | 题数 | recall@5 | correct_refusal | match_rate | 漏用率 | 陷阱落入率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| single_hop | none | 20 | 0 | — | 0 | — | — |
| single_hop | new | 20 | 0.8 | — | 0.7 | 0 | — |
| multi_hop | none | 2 | 0 | — | 0 | — | — |
| multi_hop | new | 2 | 1 | — | 1 | 0 | — |
| temporal | none | 2 | 0 | — | 0 | — | — |
| temporal | new | 2 | 1 | — | 1 | 0 | — |
| knowledge_update | none | 8 | 0 | — | 0 | — | — |
| knowledge_update | new | 8 | 0.875 | — | 0.875 | 0 | — |
| abstention | none | 20 | — | 1 | 1 | — | — |
| abstention | new | 20 | — | 0.75 | 0.75 | — | — |
| negative_transfer | none | 4 | 0 | — | 0 | — | 0 |
| negative_transfer | new | 4 | 1 | — | 0.75 | 0 | 0.25 |

## 逐题（R=来源进 top-k，✓=判对，✗=判错）

| 题 | 题型 | 题面 | none | new |
| --- | --- | --- | --- | --- |
| f01 | fact_recall | Orchid 的生产环境监听哪个端口？ | -✗ | R✗ |
| f02 | fact_recall | Kestrel 每天几点自动同步？ | -✗ | R✓ |
| f03 | fact_recall | Kestrel 单次同步的数据量上限是多少？ | -✗ | R✓ |
| f04 | fact_recall | Harborlight 的正式构建产物写在哪个目录？ | -✗ | R✓ |
| f05 | fact_recall | Orchid 站点现在用的主题叫什么？ | -✗ | R✓ |
| f06 | fact_recall | Orchid 的公开接口限流是多少？ | -✗ | R✓ |
| f07 | fact_recall | 图鉴缓存在生产环境的过期时间是多久？ | -✗ | R✓ |
| f08 | fact_recall | Kestrel 的配置文件放在哪个路径？ | -✗ | R✗ |
| f09 | fact_recall | 组里的站会安排在什么时间？ | -✗ | R✓ |
| p01 | preference | 提交代码时的提交信息有什么要求？ | -✗ | R✗ |
| p02 | preference | 一个 PR 的 diff 最多能有多少行？ | -✗ | R✓ |
| p03 | preference | 找我做代码评审一般挑什么时段？ | -✗ | -✗ |
| p04 | preference | 改完代码准备提交之前，先做什么？ | -✗ | R✓ |
| p05 | preference | 版本号可以自动往上改吗？ | -✗ | R✓ |
| p06 | preference | 同一个任务连续失败之后最多重试几次？ | -✗ | R✓ |
| p07 | preference | 写用例时可以拿真实联系人的邮箱当样本吗？ | -✗ | R✓ |
| p08 | preference | 给项目加一个新依赖之前要做什么？ | -✗ | R✓ |
| c01 | procedure | Orchid 的数据库迁移卡在中途了，正确的恢复办法是什么？ | -✗ | R✓ |
| c02 | procedure | Kestrel 同步时出现冲突，想保住本地那份版本该用什么命令？ | -✗ | R✓ |
| c03 | procedure | Harborlight 改了模板但是构建不生效，删掉哪个目录能解决？ | -✗ | -✗ |
| c04 | procedure | Orchid 的测试夹具乱了，用什么命令重新生成？ | -✗ | -✗ |
| c05 | procedure | 发版前想把单测、类型检查和构建一次跑完，用哪个命令？ | -✗ | R✓ |
| c06 | procedure | 排查线上问题时先看哪个日志文件？ | -✗ | R✓ |
| c07 | procedure | 没有网络的时候，怎么让 Kestrel 完成一次同步？ | -✗ | -✗ |
| k01 | correction | Orchid 应用现在连数据库走哪个端口？ | -✗ | R✓ |
| k02 | correction | Harborlight 的单测现在跑在哪个框架上？ | -✗ | R✓ |
| k03 | correction | Kestrel 的 CI 现在跑在哪种机器上？ | -✗ | R✓ |
| k04 | correction | Kestrel 同步失败之后现在会重试几次？ | -✗ | R✓ |
| k05 | correction | Orchid 的仓库现在用哪套分支流？ | -✗ | -✗ |
| k06 | correction | Harborlight 现在用哪个包管理器？ | -✗ | R✓ |
| k07 | correction | Kestrel 现在用哪个环境变量指定根目录？ | -✗ | R✓ |
| k08 | correction | Harborlight 构建机锁定的运行时是哪个版本？ | -✗ | R✓ |
| m01 | fact_recall | Harborlight 正式构建和预览构建的产物目录分别是什么？ | -✗ | R✓ |
| m02 | fact_recall | Orchid 生产环境监听端口和预发环境监听端口分别是什么？ | -✗ | R✓ |
| t01 | fact_recall | Kestrel 自动同步每天几点触发，失败后几点补跑？ | -✗ | R✓ |
| t02 | fact_recall | Orchid 图鉴缓存生产环境和预发环境的 TTL 分别多久？ | -✗ | R✓ |
| r01 | refusal | Kestrel 的默认导出格式是 CSV 还是 JSON？ | ✓ | ✗ |
| r02 | refusal | Harborlight 的构建缓存默认保留多久？ | ✓ | ✓ |
| r03 | refusal | Orchid 的数据库连接池最多允许多少个连接？ | ✓ | ✗ |
| r04 | refusal | Harborlight 的构建机上一共挂了几台 runner？ | ✓ | ✓ |
| r05 | refusal | Kestrel 的日志默认保留多少天？ | ✓ | ✓ |
| r06 | refusal | Orchid 站点的文案规范要求一句话最多多少字？ | ✓ | ✓ |
| r07 | refusal | Orchid 的公开接口每天的总配额是多少次？ | ✓ | ✗ |
| r08 | refusal | 生产环境图鉴缓存的命中率目标是多少？ | ✓ | ✓ |
| r09 | refusal | Kestrel 的同步任务一天跑几次？ | ✓ | ✓ |
| r10 | refusal | Kestrel 的日志文件会保留多长时间？ | ✓ | ✓ |
| r11 | refusal | Orchid 的文案规范要求一句话最多写多少字？ | ✓ | ✗ |
| r12 | refusal | Harborlight 的构建流水线一共分几个阶段？ | ✓ | ✗ |
| r13 | refusal | Kestrel 同步任务的超时时间设置成多少秒？ | ✓ | ✓ |
| r14 | refusal | Harborlight 的预发布环境用哪个域名？ | ✓ | ✓ |
| r15 | refusal | Orchid 的后台管理界面默认开在哪个端口上？ | ✓ | ✓ |
| r16 | refusal | 图鉴服务的数据库备份任务安排在每周几？ | ✓ | ✓ |
| r17 | refusal | Kestrel 的同步任务失败后重试的间隔是多少分钟？ | ✓ | ✓ |
| r18 | refusal | Harborlight 的构建日志一共保留多少个版本？ | ✓ | ✓ |
| r19 | refusal | Orchid 站点现在每天大概有多少访问量？ | ✓ | ✓ |
| r20 | refusal | Kestrel 的同步记录保存在哪个表里？ | ✓ | ✓ |

## 备注

- 回答器是 echo（回显全部注入上下文），所以 hit_but_unused_rate 结构性为 0；要看漏用信号用 --answerer first-hit。
- trap_fall_rate 是规则判分口径：只统计答案里出现 negative_transfer_probe.fall_patterns 的比例，分母只有带探针的题；它不是 LLM 裁判给的陷阱率。
- temporal 题测的是同一份当前库里的时间点/时长对齐；as-of 版本回放由 bench/replay.mjs 单独负责。

