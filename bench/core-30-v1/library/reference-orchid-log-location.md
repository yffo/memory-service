---
schema: memory.note/1
id: reference-orchid-log-location
scope: project:orchid
kind: procedural
trust: user_stated
status: active
valid_from: 2026-04-25
provenance:
  written_by: user
  source_ref: null
name: reference-orchid-log-location
description: 排查线上问题时先看哪个日志
type: reference
scope: project:orchid
created: 2026-04-25
updated: 2026-07-30
aliases: 线上日志, 排查入口
---

# 排查线上问题先看哪里

先看 /var/log/orchid/app.log，过滤 level=warn 以上；日志按天切割，保留 14 天。

如果应用日志里没有线索，再去看边缘机的访问日志，顺序不要颠倒。
