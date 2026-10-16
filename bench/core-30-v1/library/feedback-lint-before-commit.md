---
schema: memory.note/1
id: feedback-lint-before-commit
scope: user
kind: core
trust: user_stated
status: active
valid_from: 2026-03-01
provenance:
  written_by: user
  source_ref: null
name: feedback-lint-before-commit
description: 提交前必须先过 lint
type: feedback
scope: user
created: 2026-03-01
updated: 2026-06-18
---

# 提交前先过 lint

改完代码先跑 pnpm lint:fix，再提交；lint 报错不许绕过，也不要用注释把规则关掉。

如果规则本身不合理，先提出来改配置，别在代码里留例外。
