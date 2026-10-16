---
schema: memory.note/1
id: project-kestrel-env-var
scope: project:kestrel
kind: semantic
trust: user_stated
status: active
valid_from: 2026-04-09
supersedes: [archive-kestrel-env-var-old]
provenance:
  written_by: user
  source_ref: null
name: project-kestrel-env-var
description: Kestrel 指定根目录的环境变量（当前）
type: project
scope: project:kestrel
created: 2026-04-09
updated: 2026-08-05
aliases: 根目录变量, KSL_HOME
---

# Kestrel 的根目录环境变量

根目录环境变量叫 KSL_HOME，它同时决定配置目录和数据目录的位置。

部署脚本、文档、容器镜像都要跟着换，只改一处会出现"配置读不到但不报错"。
