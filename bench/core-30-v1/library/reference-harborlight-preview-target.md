---
schema: memory.note/1
id: reference-harborlight-preview-target
scope: project:harborlight
kind: procedural
trust: user_stated
status: active
valid_from: 2026-05-09
provenance:
  written_by: user
  source_ref: null
name: reference-harborlight-preview-target
description: Harborlight 预览构建的输出目录
type: reference
scope: project:harborlight
created: 2026-05-09
updated: 2026-07-06
---

# 预览构建输出到哪

预览构建写到 .preview/site，和正式构建分开，方便同机对比两版。

预览目录会被定期清理，别把需要长期留存的东西放进去。
