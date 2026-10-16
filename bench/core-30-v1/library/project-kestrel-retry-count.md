---
schema: memory.note/1
id: project-kestrel-retry-count
scope: project:kestrel
kind: semantic
trust: user_stated
status: active
valid_from: 2026-04-03
supersedes: [archive-kestrel-retry-count-old]
provenance:
  written_by: user
  source_ref: null
name: project-kestrel-retry-count
description: Kestrel 同步失败后的重试次数（当前）
type: project
scope: project:kestrel
created: 2026-04-03
updated: 2026-08-12
aliases: 重试次数, 退避
---

# 同步失败的重试次数

同步失败后重试 5 次，间隔按指数退避；五次都失败就写一条 error，并停掉当天的同步。

次数调高是因为夜里网络抖动的时段比原先估计的长。
