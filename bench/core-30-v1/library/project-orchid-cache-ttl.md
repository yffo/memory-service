---
schema: memory.note/1
id: project-orchid-cache-ttl
scope: project:orchid
kind: semantic
trust: user_stated
status: active
valid_from: 2026-03-22
provenance:
  written_by: user
  source_ref: null
name: project-orchid-cache-ttl
description: 生产环境图鉴缓存的过期时间
type: project
scope: project:orchid
created: 2026-03-22
updated: 2026-07-11
---

# 图鉴缓存的过期时间

生产环境的图鉴缓存 TTL 是 90 分钟，过期后回源一次，再把结果写回缓存。

缓存键里带了语言的两位码，所以中英文各占一份，不要试图把它们合并。
