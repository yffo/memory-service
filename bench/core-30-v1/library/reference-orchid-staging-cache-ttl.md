---
schema: memory.note/1
id: reference-orchid-staging-cache-ttl
scope: project:orchid
kind: procedural
trust: user_stated
status: active
valid_from: 2026-03-23
provenance:
  written_by: user
  source_ref: null
name: reference-orchid-staging-cache-ttl
description: 预发环境图鉴缓存的过期时间
type: reference
scope: project:orchid
created: 2026-03-23
updated: 2026-07-11
---

# 图鉴缓存的预发配置

预发环境为了看清回源过程，把图鉴缓存 TTL 压到 60 分钟，其他缓存不动。

这份配置只服务于预发，不要抄回生产。
