---
schema: memory.note/1
id: project-orchid-api-rate-limit
scope: project:orchid
kind: semantic
trust: user_stated
status: active
valid_from: 2026-05-14
provenance:
  written_by: user
  source_ref: null
name: project-orchid-api-rate-limit
description: Orchid 公开接口的限流阈值
type: project
scope: project:orchid
created: 2026-05-14
updated: 2026-08-03
---

# 公开接口的限流

公开接口限流每秒 12 次，按来源 IP 计；内部调用走另一条通道，不计入这个额度。

被限流时返回 429 并带上 Retry-After，客户端要照着它退避。
