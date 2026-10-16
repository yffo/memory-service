---
schema: memory.note/1
id: project-orchid-db-port
scope: project:orchid
kind: semantic
trust: user_stated
status: active
valid_from: 2026-02-02
supersedes: [archive-orchid-db-port-old]
provenance:
  written_by: user
  source_ref: null
name: project-orchid-db-port
description: Orchid 应用连接数据库走的端口（连接池）
type: project
scope: project:orchid
created: 2026-02-02
updated: 2026-07-08
aliases: 数据库端口, 连接池端口
---

# Orchid 数据库的连接端口

连接池端口是 6432，应用只连连接池，不再直连数据库。

连接串里端口写错会表现成"连上了但查询超时"，排查时先确认端口。
