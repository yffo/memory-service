---
schema: memory.note/1
id: project-harborlight-node-version
scope: project:harborlight
kind: semantic
trust: user_stated
status: active
valid_from: 2026-03-28
supersedes: [archive-harborlight-node-version-old]
provenance:
  written_by: user
  source_ref: null
name: project-harborlight-node-version
description: Harborlight 构建机锁定的运行时版本
type: project
scope: project:harborlight
created: 2026-03-28
updated: 2026-08-02
aliases: 运行时版本, 构建机
---

# Harborlight 构建机锁定的运行时

构建机固定用 Node 22.11，本地开发也建议对齐，免得模板渲染结果不一致。

升级运行时属于要单独开的 PR，不要夹在功能改动里。
