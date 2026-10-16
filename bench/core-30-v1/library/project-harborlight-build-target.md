---
schema: memory.note/1
id: project-harborlight-build-target
scope: project:harborlight
kind: semantic
trust: user_stated
status: active
valid_from: 2026-05-07
provenance:
  written_by: user
  source_ref: null
name: project-harborlight-build-target
description: Harborlight 正式构建的产物目录
type: project
scope: project:harborlight
created: 2026-05-07
updated: 2026-07-06
---

# Harborlight 的构建产物目录

正式构建的产物写在 dist/site，这个目录不进版本控制，也不要手工往里塞文件。

部署脚本只认这个目录，换位置要同时改两处脚本。
