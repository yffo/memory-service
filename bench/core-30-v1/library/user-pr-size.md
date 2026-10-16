---
schema: memory.note/1
id: user-pr-size
scope: user
kind: core
trust: user_stated
status: active
valid_from: 2026-02-14
provenance:
  written_by: user
  source_ref: null
name: user-pr-size
description: 拆分 PR 的行数阈值
type: user
scope: user
created: 2026-02-14
updated: 2026-04-01
---

# 拆分 PR 的阈值

单个 PR 的 diff 不超过 400 行，超过就先拆成两个；宁可多开一个 PR，也不要让人一口气读五百行。

样式改动和逻辑改动尽量分成两个 PR，评审的人不一样。
