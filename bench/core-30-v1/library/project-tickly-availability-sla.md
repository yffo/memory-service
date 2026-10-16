---
schema: memory.note/1
id: project-tickly-availability-sla
scope: project:tickly
kind: semantic
trust: user_stated
status: active
valid_from: 2026-05-20
provenance:
  written_by: user
  source_ref: null
name: project-tickly-availability-sla
description: Tickly 对外接口的可用性目标
type: project
scope: project:tickly
created: 2026-05-20
updated: 2026-08-03
---

# Tickly 对外接口的可用性目标

对外接口按自然月统计可用性，目标是 99.5%，低于目标就要在下一个迭代里写复盘。

统计口径只算 5xx 与超时，计划内维护窗口不计入；命中率、延迟这类指标另算，不放进这张表里。
