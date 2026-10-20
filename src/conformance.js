/**
 * 适配器契约声明（adapter contract declaration）。
 *
 * 契约回答一个问题：一个宿主适配器「至少要做什么」才算接对了 tabellio。
 * 这里不检查行为（行为在 `tools/conformance.mjs` 里跑），只声明**这份核心实现了哪些能力**，
 * 让适配器、CI 和人都能引用同一份版本号与能力表，而不是靠文档描述猜。
 *
 * 版本规则：能力表只增不删；删除或改变语义必须升 minor（0.x 阶段允许 breaking 时在
 * CHANGELOG 里明说）。`CONTRACT_VERSION` 与 `docs/03-hosts-and-interfaces.md` §7 对齐。
 */

export const CONTRACT_NAME = 'tabellio-adapter-contract';
export const CONTRACT_VERSION = '0.1';

/** 能力表：值是 `true`、短字符串（实现方式）或数组（枚举）。 */
export const CAPABILITIES = Object.freeze({
  // 读路径
  recall: true,
  search: true,
  read: true,
  explain: true,
  receipts: true,
  asOf: true,
  // 写路径
  writeGate: true,
  candidates: true,
  lifecycle: ['active', 'draft', 'archived', 'superseded'],
  consolidate: ['invalidate', 'archive', 'merge', 'summarize'],
  undo: true,
  // 排序与个性化
  feedback: true,
  decay: true,
  // 语义：核心只接受宿主注入的 embedding，自己不联网、不存 endpoint/Key
  semantic: 'host-provided-embedding',
  // 接口面
  cli: true,
  mcp: { readTools: 5, writeTools: 2, protocolVersions: ['2026-07-28', '2025-11-25'] },
});

/** 契约视图：`conformance --contract` 与文档引用的同一份数据。 */
export function contractView() {
  return {
    name: CONTRACT_NAME,
    version: CONTRACT_VERSION,
    capabilities: CAPABILITIES,
  };
}
