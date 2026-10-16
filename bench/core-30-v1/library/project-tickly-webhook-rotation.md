---
schema: memory.note/1
id: project-tickly-webhook-rotation
scope: project:tickly
kind: semantic
trust: user_stated
status: active
valid_from: 2026-05-02
provenance:
  written_by: user
  source_ref: null
name: project-tickly-webhook-rotation
description: Tickly webhook 签名密钥的轮换周期
type: project
scope: project:tickly
created: 2026-05-02
updated: 2026-07-25
---

# Tickly 的 webhook 密钥轮换

webhook 签名密钥每 90 天轮换一次，新旧密钥并行一周再把旧的摘掉。

轮换窗口放在周四凌晨，出问题就直接回滚到旧密钥。
