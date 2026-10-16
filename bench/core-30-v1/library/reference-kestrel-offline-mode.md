---
schema: memory.note/1
id: reference-kestrel-offline-mode
scope: project:kestrel
kind: procedural
trust: user_stated
status: active
valid_from: 2026-04-28
provenance:
  written_by: user
  source_ref: null
name: reference-kestrel-offline-mode
description: 断网时同步的做法
type: reference
scope: project:kestrel
created: 2026-04-28
updated: 2026-08-12
aliases: 断网同步, offline
---

# 断网时的同步

没网的时候用 `ksl sync --offline`，它只比对本地索引、不发起任何请求，回到有网的环境后再跑一次正常同步。

别用 `--force` 硬跑，那会把待同步队列直接清空。
