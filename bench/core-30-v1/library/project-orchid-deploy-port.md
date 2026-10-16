---
schema: memory.note/1
id: project-orchid-deploy-port
scope: project:orchid
kind: semantic
trust: user_stated
status: active
valid_from: 2026-03-19
provenance:
  written_by: user
  source_ref: null
name: project-orchid-deploy-port
description: Orchid 生产环境的监听端口
type: project
scope: project:orchid
created: 2026-03-19
updated: 2026-06-02
aliases: 上线端口, 部署端口
---

# Orchid 生产环境的端口

生产环境监听 8443，由边缘机上的反向代理转进来；容器只暴露这一个端口。

改端口要同时改代理配置和健康检查，三处漏一处就会出现"部署成功但打不开"。
