---
schema: memory.note/1
id: project-kestrel-token-budget
scope: project:kestrel
kind: semantic
trust: user_stated
status: active
valid_from: 2026-04-05
provenance:
  written_by: user
  source_ref: null
name: project-kestrel-token-budget
description: Kestrel 单次同步的数据量上限
type: project
scope: project:kestrel
created: 2026-04-05
updated: 2026-07-19
---

# 单次同步的数据上限

单次同步上限 2 GB，超了就跳过剩余部分，并在日志里留下一条 skipped 记录。

这个上限是为了别把移动网络跑爆，不是存储限制，别拿磁盘空间算它。
