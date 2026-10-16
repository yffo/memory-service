---
schema: memory.note/1
id: reference-harborlight-cache-clear
scope: project:harborlight
kind: procedural
trust: user_stated
status: active
valid_from: 2026-04-15
provenance:
  written_by: user
  source_ref: null
name: reference-harborlight-cache-clear
description: 构建结果与源码不一致时的处理办法
type: reference
scope: project:harborlight
created: 2026-04-15
updated: 2026-08-01
aliases: 缓存坏了, 改了不生效
---

# 构建缓存坏了怎么办

症状是构建结果和源码不一致，或者改了模板完全不生效。

处理办法是删掉 node_modules/.cache/harborlight 再重新构建；删完记得重启 dev server，否则内存里那份缓存还在。
