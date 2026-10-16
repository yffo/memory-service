---
schema: memory.note/1
id: archive-kestrel-ci-runners-old
scope: project:kestrel
kind: semantic
trust: user_stated
status: superseded
valid_from: 2026-02-06
valid_to: 2026-08-14
superseded_by: project-kestrel-ci-runners
provenance:
  written_by: user
  source_ref: null
name: archive-kestrel-ci-runners-old
description: 已失效——Kestrel 早先的 CI 机器
type: project
scope: project:kestrel
created: 2026-02-06
updated: 2026-08-14
---

# （已失效）Kestrel 早先的 CI 机器

这条在 2026-08 之前有效：CI 跑在托管 runner 上，每次冷启动都要重新拉一遍依赖。

换掉的原因是构建时间随依赖增长越来越长。
