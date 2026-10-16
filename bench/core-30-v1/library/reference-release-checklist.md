---
schema: memory.note/1
id: reference-release-checklist
scope: project:orchid
kind: procedural
trust: user_stated
status: active
valid_from: 2026-04-22
provenance:
  written_by: user
  source_ref: null
name: reference-release-checklist
description: 发版前的检查清单
type: reference
scope: project:orchid
created: 2026-04-22
updated: 2026-08-09
aliases: 发版前, 发布检查
---

# 发版前的检查清单

1. 跑 `pnpm verify:release`，它会把单测、类型检查和构建串一遍；
2. 确认变更日志里每一条都能追到对应的 PR；
3. 打 tag 用 v 加三个数字的形式，打之前再确认一次版本号已经手工改过。

清单里任何一条没过就不要开 tag。
