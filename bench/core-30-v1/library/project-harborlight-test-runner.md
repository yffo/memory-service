---
schema: memory.note/1
id: project-harborlight-test-runner
scope: project:harborlight
kind: semantic
trust: user_stated
status: active
valid_from: 2026-03-30
supersedes: [archive-harborlight-test-runner-old]
provenance:
  written_by: user
  source_ref: null
name: project-harborlight-test-runner
description: Harborlight 单测跑在哪个框架上
type: project
scope: project:harborlight
created: 2026-03-30
updated: 2026-08-01
aliases: 单测框架, test runner
---

# Harborlight 的单测跑在哪个框架

单测框架迁到 vitest，跑 pnpm test 就够，配置跟着 vite.config.ts 走。

迁移的原因是原来的框架和构建工具各有一套 transform，出错时要同时看两边。
