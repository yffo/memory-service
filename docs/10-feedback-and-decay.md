# 10 · 反馈排序与遗忘衰减（核心的「用错了会改」）

> 状态：2026-10-21 落地于核心（`src/core/feedback.js`、`src/core/decay.js`、
> `src/store/feedback.js`、`api.recordFeedback`）。**默认不改变召回行为**：
> 宿主显式传 `applyFeedback` / `decay` 才生效。

## 10.1 为什么这两件事属于核心，而不属于某个插件

召回的结果是否被用上、用错之后有没有被纠正，这是**记忆服务自身的学习信号**；
如果只存在某个宿主插件里，换个宿主（Claude Code / Cursor / 自己的脚本）就全丢了。
所以核心只做两件最稳的事：

1. **事件与聚合**：定义信号、落盘格式、时间窗口、排序权重函数；
2. **可复现的排序**：给定同一批反馈与同一批笔记，排序结果是确定的。

核心**不做**归因判定（「用户这句话是在纠正上一轮哪条记忆」需要会话轮次状态），
也不自动删除任何东西。归因留给宿主，核心只接受已经判定好的事件。

## 10.2 事件模型

追加写入 `<store>/runs/feedback.jsonl`，一行一个事件：

```json
{"signal":"wrong","noteIds":["01M5..."],"query":"发版流程","source":"dsh:outcome","at":1792522137000}
```

| 字段 | 说明 |
|---|---|
| `signal` | `useful` / `wrong` / `stale` / `corrected`（枚举外的行读取时丢弃） |
| `noteIds` | 1–6 条笔记；也接受旧的单数 `id` |
| `query` | 触发这次反馈的查询，截断到 120 字，供以后审计 |
| `source` | 谁写的（`panel` / `cli:feedback` / `dsh:outcome` …），截断 40 字 |
| `at` | 毫秒时间戳；缺省用当前时间 |

读取时同时合并两个**历史插件文件**（库根目录的 `panel-feedback.jsonl` 与
`outcome.jsonl`），所以迁移不会丢旧反馈；新写入只进 `runs/feedback.jsonl`。

## 10.3 排序权重

```
weight = 1 + 0.03*min(useful,3) - 0.12*min(wrong+stale,4) - 0.08*min(corrected,3)
final  = score.total * weight      # score.total 仍是核心原来的三因子合成分
```

- 负权重大于正权重（一次纠错 ≈ 四次有用）：错误记忆的代价高于漏一条。
- 权重有上限，且**只影响顺序**：不新增、不删除、不越过 `minRelevance` / `minCoverage` /
  `minScore` 与拒答逻辑。一条被反复纠正的笔记只会沉底，不会消失。
- 时间窗口默认 90 天；窗口外的差评不永久压住笔记。

## 10.4 遗忘衰减

`decay` 是另一个乘数，默认关闭；开启时：

```
decay = clamp(0.5 ** (ageDays / halfLifeDays), floor, 1)
ageDays 从 valid_from（缺失时 created）算起，半衰期默认 180 天，floor 默认 0.6
```

- 只压**排序**，不归档、不删除。
- `trust: user_stated`、`evergreen: true`、`tags` 含 `evergreen` 的笔记不衰减——
  用户亲口定的偏好与规则不该因为「三周没用」被压下去。
- 它和反馈是不同的信号：反馈是「有人明确说这条错了」，衰减是「一直没人用」；
  两者相乘，可分别关闭。

## 10.5 接口

```js
import { openStore, recordFeedback, readFeedback, feedbackSummary, recallQuery } from 'tabellio';

const ctx = openStore('~/memory/tabellio');

recordFeedback(ctx, { id: '01M5...', signal: 'wrong', query: '发版流程' });
recordFeedback(ctx, { noteIds: ['01M5...', '01M5...'], signal: 'corrected' });

readFeedback(ctx);                       // 事件（含旧文件迁移）
feedbackSummary(ctx, { days: 7 });       // {total, counts, notes, file}

// 召回时显式叠加：
recallQuery(ctx, '发版流程', { applyFeedback: true, decay: { halfLifeDays: 180 } });
```

CLI：

```bash
tabellio feedback record --id <note-id> --signal wrong --query "发版流程" --json
tabellio feedback list --limit 20 --json
tabellio feedback summary --days 7 --json
```

MCP：`recall` 工具新增 `apply_feedback`（布尔）与 `decay_days`（整数，天）两个输入；
工具面仍保持 5±2（只读 5 条、`--allow-write` 7 条），反馈写入走 CLI/API。

## 10.6 非目标

- **不自动判定反馈**：核心不读会话，不猜「这句话是不是在纠错」。
- **不自动删除或降级成草稿**：衰减只排序；真要遗忘用 `consolidate --archive` 或宿主的面板动作。
- **不对反馈做模型判断**：事件是谁判定的由宿主负责，核心只信已经落盘的信号。

## 10.7 可验证性

- `test/core-feedback.test.mjs`：窗口、上限、稳定排序、衰减 floor 与 evergreen。
- `test/api-feedback.test.mjs`：落盘路径、旧文件迁移、反馈重排不丢条目、衰减顺序。
- `test/cli-feedback.test.mjs`：record/list/summary 的 JSON 契约与退出码。
