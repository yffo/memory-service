---
schema: memory.note/1
id: reference-orchid-staging-port
scope: project:orchid
kind: procedural
trust: user_stated
status: active
valid_from: 2026-03-20
provenance:
  written_by: user
  source_ref: null
name: reference-orchid-staging-port
description: Orchid 预发环境的监听端口
type: reference
scope: project:orchid
created: 2026-03-20
updated: 2026-06-02
---

# Orchid 预发环境的端口

预发环境监听 9443，和生产环境分开，方便两边同时在线做对比。

预发只对内网开放，不要在预发上跑压测以外的流量。
