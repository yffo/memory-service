---
schema: memory.note/1
id: archive-harborlight-test-runner-old
scope: project:harborlight
kind: semantic
trust: user_stated
status: superseded
valid_from: 2026-02-10
valid_to: 2026-08-01
superseded_by: project-harborlight-test-runner
provenance:
  written_by: user
  source_ref: null
name: archive-harborlight-test-runner-old
description: 已失效——Harborlight 早先的单测框架
type: project
scope: project:harborlight
created: 2026-02-10
updated: 2026-08-01
---

# （已失效）Harborlight 早先的单测框架

这条在 2026-06 之前有效：单测跑在 jest 上，配置散在好几个文件里。

迁走的原因是它和构建工具的 transform 各管一段，出错时很难定位。
