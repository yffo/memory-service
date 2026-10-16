---
schema: memory.note/1
id: feedback-no-push-to-main
scope: user
kind: core
trust: user_stated
status: active
valid_from: 2026-03-15
provenance:
  written_by: user
  source_ref: null
name: feedback-no-push-to-main
description: 主分支不许直接推送
type: feedback
scope: user
created: 2026-03-15
updated: 2026-06-27
---

# 主分支的保护

任何情况下都不直接推 main，包括"只改一行文档"这种。

走分支加 PR，让 CI 跑一遍；紧急修复也一样。
