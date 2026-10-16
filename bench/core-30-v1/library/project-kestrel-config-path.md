---
schema: memory.note/1
id: project-kestrel-config-path
scope: project:kestrel
kind: semantic
trust: user_stated
status: active
valid_from: 2026-04-06
provenance:
  written_by: user
  source_ref: null
name: project-kestrel-config-path
description: Kestrel 配置文件的读取路径
type: project
scope: project:kestrel
created: 2026-04-06
updated: 2026-07-19
---

# Kestrel 的配置文件位置

配置读 ~/.config/kestrel/config.toml，文件不存在时按内置默认值跑，不报错。

项目里那份示例配置只是给人抄的，改它不会影响本机行为。
