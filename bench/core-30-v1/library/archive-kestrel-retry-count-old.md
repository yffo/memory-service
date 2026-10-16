---
schema: memory.note/1
id: archive-kestrel-retry-count-old
scope: project:kestrel
kind: semantic
trust: user_stated
status: superseded
valid_from: 2026-02-14
valid_to: 2026-08-12
superseded_by: project-kestrel-retry-count
provenance:
  written_by: user
  source_ref: null
name: archive-kestrel-retry-count-old
description: 已失效——Kestrel 早先的重试次数
type: project
scope: project:kestrel
created: 2026-02-14
updated: 2026-08-12
---

# （已失效）同步失败的重试次数

这条在 2026-06 之前有效：失败后重试 3 次，间隔固定一分钟。

当时用固定间隔是因为日志里看不出退避曲线。
