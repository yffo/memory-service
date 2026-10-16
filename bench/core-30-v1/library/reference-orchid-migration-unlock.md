---
schema: memory.note/1
id: reference-orchid-migration-unlock
scope: project:orchid
kind: procedural
trust: user_stated
status: active
valid_from: 2026-04-08
provenance:
  written_by: user
  source_ref: null
name: reference-orchid-migration-unlock
description: 迁移卡住时的恢复流程
type: reference
scope: project:orchid
created: 2026-04-08
updated: 2026-07-15
aliases: 迁移卡住, migrate 卡住
---

# 迁移卡住时的恢复流程

1. 先跑 `orchid migrate --status` 看卡在哪一步；
2. 确认没有别的迁移进程还在跑，再执行 `orchid migrate --unlock`；
3. 解锁后把迁移重跑一遍，成功之前不要手工改数据库结构。

失败两次以上就别再重跑，先看迁移日志里最后一条 SQL。
