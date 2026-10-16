---
schema: memory.note/1
id: project-harborlight-package-manager
scope: project:harborlight
kind: semantic
trust: user_stated
status: active
valid_from: 2026-03-12
supersedes: [archive-harborlight-package-manager-old]
provenance:
  written_by: user
  source_ref: null
name: project-harborlight-package-manager
description: Harborlight 统一使用的包管理器
type: project
scope: project:harborlight
created: 2026-03-12
updated: 2026-07-28
aliases: 包管理器, 锁文件
---

# Harborlight 用哪个包管理器

包管理器统一成 pnpm，锁文件是 pnpm-lock.yaml，CI 按 lockfile 严格模式安装。

混用两个包管理器会生出两份锁文件，评审时看到直接打回。
