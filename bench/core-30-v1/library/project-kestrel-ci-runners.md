---
schema: memory.note/1
id: project-kestrel-ci-runners
scope: project:kestrel
kind: semantic
trust: user_stated
status: active
valid_from: 2026-04-01
supersedes: [archive-kestrel-ci-runners-old]
provenance:
  written_by: user
  source_ref: null
name: project-kestrel-ci-runners
description: Kestrel 的 CI 跑在哪种机器上
type: project
scope: project:kestrel
created: 2026-04-01
updated: 2026-08-14
aliases: CI 机器, runner
---

# Kestrel 的 CI 跑在哪种机器上

CI 全部跑在自建 runner 上，镜像里预装了构建缓存，冷启动比从前快一截。

runner 的标签按用途分，别把发布任务排到只跑单测的那组上去。
