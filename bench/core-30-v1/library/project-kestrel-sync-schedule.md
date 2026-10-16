---
schema: memory.note/1
id: project-kestrel-sync-schedule
scope: project:kestrel
kind: semantic
trust: user_stated
status: active
valid_from: 2026-04-02
provenance:
  written_by: user
  source_ref: null
name: project-kestrel-sync-schedule
description: Kestrel 自动同步的触发时间
type: project
scope: project:kestrel
created: 2026-04-02
updated: 2026-07-19
---

# Kestrel 的自动同步时间

自动同步每天 03:30 触发一次，跑完写一条摘要进日志；失败会在 05:00 补跑一次。

手动触发不受这张时间表限制，但会走同一套重试规则。
