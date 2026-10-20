# 语义召回（核心能力）

> 目标：让「换了说法也能想起」这件事**只有一套实现**，DSH 插件、CLI、MCP 都走同一份索引与合并规则；
> embedding 服务属于**部署环境**，核心只要求一个 `embed(texts) -> vectors` 的函数。

## 为什么在核心

词面检索（BM25 + 共现）是基础，天花板也清楚：换个说法就找不到。语义召回补这一刀，但过去它只长在
DSH 插件里，于是：

- 同一份「哪些笔记该进索引」的规则在宿主之间复制；
- 合并结果时是否跳过 archived / superseded / external 全凭各处自觉；
- 换宿主（Claude Code hooks、MCP）就没有语义能力。

现在核心负责**索引格式、可索引条件、相似度排序、与词面结果的合并**；宿主只负责调自家 embedding 服务。

## 接口

```js
import { indexSemantic, semanticRecall, mergeSemanticItems } from 'tabellio';

// 1) 建/刷新索引：embed 是注入的
await indexSemantic(ctx, { embed: async (texts) => texts.map(embedOne), model: 'qwen3-embedding-0.6b' });
// => { ok, size, changed, removed, model, index }

// 2) 拿语义候选
const { hits } = await semanticRecall(ctx, '发版流程怎么走', {
  embed, model: 'qwen3-embedding-0.6b', top: 8, minSimilarity: 0.55,
});
// => hits: [{ id, similarity }]

// 3) 并回词面结果（纯函数，不联网）
const merged = mergeSemanticItems(result, {
  hits, readNote: (id) => read(ctx, id), maxNotes: 6, allowedTrusts: ['user_stated', 'system_derived'],
});
```

`embed` 由宿主实现：本地 llama-swap、Ollama、OpenAI 兼容网关都行；核心不存 endpoint、API Key，
也不发任何网络请求。

## 规则

1. **只索引自动召回可见的笔记**：`status` 为 `archived`/`draft`、`superseded_by` 或 `valid_to` 非空的，
   一律不进索引；正文取前 900 字（`maxChars` 可调）。
2. **索引是派生物**：`runs/semantic-index.json`，模型名写在文件里，换模型自动失效（读回空索引）；
   文件坏掉按空索引处理，下次重建。
3. **增量**：按正文 sha1 比对，只对新增/变化的笔记调 `embed`；被删/不可召回的从索引移除。
4. **只追加**：合并时保留词面顺序，语义只补词面没命中的条目，并按 `maxNotes` 截断。
5. **合并时再验一次生命周期与信任**：索引可能比库旧；archived / superseded / 过期 / 不在
   `allowedTrusts` 的命中直接丢弃。
6. **失败不动词面**：embedding 服务不可达时，宿主 catch 后继续用词面结果（`indexSemantic` 会抛，
   由调用方决定是否记日志）。

## 非目标

- 不替你选模型、不自动扫描端口（那是宿主的产品决策）；
- 不做混合打分（BM25 分与余弦分不同量纲，只做候选补全，不做加权融合）；
- 不写回执、不改变 `recall()` 的拒答语义（合并后只是 `refused:false`）。

## 可验证性

- `test/semantic.test.mjs`：增量计划（保留/新增/删除）、不可召回的排除、排序与阈值、合并时的
  trust/生命周期过滤、索引落盘与模型失效、round-trip（假 embedder，不联网）。
- DSH 插件侧另有 `tools/judge-eval.mjs`、`tools/recall-bench.mjs` 做真机评测：1411 篇笔记下
  词面 p95≈225ms、叠加语义 p95≈312ms。
