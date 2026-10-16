---
schema: memory.note/1
id: reference-kestrel-conflict-resolution
scope: project:kestrel
kind: procedural
trust: user_stated
status: active
valid_from: 2026-04-11
provenance:
  written_by: user
  source_ref: null
name: reference-kestrel-conflict-resolution
description: 同步冲突时保留本地版本的做法
type: reference
scope: project:kestrel
created: 2026-04-11
updated: 2026-07-21
aliases: 同步冲突, 冲突标记
---

# 同步冲突时保住本地

冲突时用 `ksl resolve --keep-local` 把本地版本标成胜出，再跑 `ksl verify` 确认没有残留的冲突标记。

如果本地那份其实已经过期，就改用 `--keep-remote`，别硬撑。
