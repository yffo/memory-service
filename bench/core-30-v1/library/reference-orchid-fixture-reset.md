---
schema: memory.note/1
id: reference-orchid-fixture-reset
scope: project:orchid
kind: procedural
trust: user_stated
status: active
valid_from: 2026-04-19
provenance:
  written_by: user
  source_ref: null
name: reference-orchid-fixture-reset
description: 测试夹具乱了之后的重置做法
type: reference
scope: project:orchid
created: 2026-04-19
updated: 2026-06-30
aliases: 夹具重置, fixtures
---

# 测试夹具的重置

夹具乱了就跑 `pnpm fixtures:reset --seed 42`，种子固定是为了让失败用例可复现。

改夹具脚本时要同步更新夹具说明，别让下一个人靠猜。
