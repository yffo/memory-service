# 一致性自检与评测门控调参

两件事放在一起，是因为它们回答同一个问题：**换宿主、换参数之后，核心还守不守得住原来的承诺？**

- 一致性自检（conformance）：适配器必须满足的不变量，做成可执行的检查。
- 评测门控调参（tuning）：阈值可以调，但只能在冻结题集上证明「不退化」之后调，且由人批准。

## 1. 一致性自检

```bash
node tools/conformance.mjs          # 22 项检查，临时库，不联网
node tools/conformance.mjs --json   # 机器可读，CI 用
```

检查只碰 `/tmp` 下的临时库，不读写真实记忆库。覆盖的九组不变量：

| 组 | 不变量 |
| --- | --- |
| 空库 | 空库可读、`status` 自洽 |
| 写入闸 | 过短内容、真实凭据值被拒 |
| 写入 | `remember` 后 `search` 与 `recall` 都能看到 |
| 生命周期 | `draft` 笔记 `read` 可见、自动召回不可见 |
| 候选 | 候选不直接成为笔记；批准后才落库 |
| 归档 | `archived` 笔记可读、召回排除、语义索引不收录、语义合并不复活 |
| 反馈 | 反馈只重排，不增删条目 |
| 回执 | `recall --receipt` 保存后能离线校验 |
| 多入口 | CLI 与 MCP 看到同一个库；MCP stdout 只有 JSON-RPC |

为什么不做「适配器自动注册」：契约检查的价值在于**能被任意宿主独立运行**。DSH 插件、Claude Code hooks、MCP 客户端都可以把这条命令放进自己的 CI，而核心不需要知道宿主的形状。

适配器契约的文字版见 `docs/03-hosts-and-interfaces.md` §7；本检查是它的可执行版本。

## 2. 评测门控调参

```bash
node tools/tune-recall.mjs                 # 默认 bench/core-30-v1 题集，临时库
node tools/tune-recall.mjs --json          # 机器可读
node tools/tune-recall.mjs --store <dir>   # 显式指定库（会读真实库时请只读）
```

做法：在冻结题集上扫「阈值网格」×每道题跑一次召回，得到每个点的
`hit`（正例的 gold 是否进 top-k）与 `false-inject`（拒答题被注入了内容）。
候选点必须满足：

1. `hit` 不低于基线；
2. `false-inject` 不高于基线；
3. 至少一项严格更好。

满足条件的点里按「命中最多 → 误注入最少 → coverage 更保守」排序取第一个。
没有合格点就保持基线（退出码 0）；有建议点退出码 3，需要人批准后手动改配置，回滚就是把旧值写回去。

`src/core/tuning.js` 只导出纯函数（`gridPoints` / `chooseCandidate` / `scoreRun`），
CLI 负责跑库。这样判据本身可以被单测钉住。

### 实测（2026-10-21，`bench/core-30-v1`）

```
tasks 56 · k=5 · store 临时副本(50 篇)
baseline   hit 31/36  false-inject 5/20  (minRelevance=0.15 minScore=0.18 minCoverage=0.6)
candidate  none（没有不退化且更优的点，保持基线）
```

结论按「不能外推」的纪律写：**这是合成题集上的结果**，说明默认阈值在这套题上没有可被网格搜索
白拿的提升，不说明它在真实库里已最优。真实库的调参应换用冻结的真实问题集，并保留同一套门控规则。

## 3. 已知边界

- conformance 不验证 embedding 服务质量，只验证「索引/合并/生命周期过滤」的管道行为（用确定性假向量）。
- tuning 的题集必须**冻结**；在评测集上反复选点得到的改进不是独立估计，报告里要写明。
- 当前没有自动落盘：`tune-recall` 只产出建议。这是刻意的——参数会影响所有召回，批准权在人。
