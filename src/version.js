/**
 * 版本的唯一真相源。
 *
 * 之前 CLI 的 `VERSION` 与 MCP 的 `SERVER_VERSION` 各硬编码一份，发 0.1.2 时两处都忘了抬，
 * 结果包是 0.1.2、`tabellio --version` 和 MCP `serverInfo.version` 都还报 0.1.1。版本号只应该
 * 在 `package.json` 里写一次；这里读它，CLI 与 MCP 共用。
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 与 `package.json` 的 `version` 始终一致。 */
export const VERSION = pkg.version;
