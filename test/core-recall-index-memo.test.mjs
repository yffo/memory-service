/**
 * `src/core/recall.js`：索引 memo 的两条底线。
 *
 * 召回每跑一次都要把全库重新分词（1423 段实测 ~92ms，而且过滤生效时
 * `index` 与 `refIndex` 各建一份），所以 `memoIndex()` 按 docs 内容缓存结果。
 * 缓存最容易出的两个错都不是性能问题，而是**正确性**问题：
 *  1. 同样的输入两次结果不一样（那这条缓存就没法当证据用）；
 *  2. 内容改了但键没变，读到旧索引（拿 `(id, size)` 当键就会这样）。
 * 这个文件只钉这两条，不测耗时（耗时随机器变，写进用例只会变成噪声）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearIndexMemo, recall } from '../src/core/recall.js';
import { parseTime } from '../src/util/clock.js';

const NOW = parseTime('2026-10-17T12:00:00+08:00');
const entry = (id, body, noteOver = {}) => ({
  id,
  title: `标题 ${id}`,
  body,
  name: `${id}.md`,
  file: `${id}.md`,
  bytes: Buffer.byteLength(body, 'utf8'),
  note: {
    id,
    kind: 'semantic',
    trust: 'user_stated',
    scope: 'user',
    confidence: 0.9,
    valid_from: '2026-10-10T12:00:00+08:00',
    valid_to: null,
    mtime: '2026-10-10T12:00:00+08:00',
    provenance: { written_by: 'cli:remember', source_ref: null },
    ...noteOver,
  },
});

const CORPUS = [
  entry('build-cmd', 'acme-widget 的构建命令是 pnpm run build，产物在 dist 目录。'),
  entry('deploy-steps', '部署三步：先构建，再同步到 staging，最后跑冒烟脚本。回滚就是同步回上一次产物。'),
  entry('test-runner', '单测用 node --test 跑，端到端用例放在 e2e 目录下、默认不跑。'),
  entry('proxy-node', '代理节点用 hysteria2，监听 8443 端口，走 UDP。'),
  entry('garden', '园艺：番茄浇水与土壤酸碱度测量方法，见手册第七章。'),
];

const recallOf = (query, entries = CORPUS, options = {}) => recall({ entries, query, options: { nowMs: NOW, ...options } });

test('索引 memo：同样的库与查询两次结果逐字节相等（清不清缓存都一样）', () => {
  clearIndexMemo();
  const first = JSON.stringify(recallOf('构建命令是什么'));
  const second = JSON.stringify(recallOf('构建命令是什么'));
  assert.equal(first, second);

  clearIndexMemo();
  const afterClear = JSON.stringify(recallOf('构建命令是什么'));
  assert.equal(first, afterClear, 'memo 只影响耗时，不影响结果');
});

test('索引 memo 不吞内容变化：同样长度、改了字，必须立刻检索到新词', () => {
  clearIndexMemo();
  const before = recallOf('singbox02');
  assert.equal(before.items.length, 0, '改之前这个词在库里不存在');

  // 长度特意保持不变（hysteria2 → singbox02 都是 9 个字符）：
  // 拿 `(id, size)` 当缓存键的实现会在这里读到旧索引，而内容哈希不会。
  const edited = CORPUS.map((item) => (item.id === 'proxy-node'
    ? entry('proxy-node', '代理节点用 singbox02，监听 8443 端口，走 UDP。')
    : item));
  assert.equal(Buffer.byteLength(edited[3].body, 'utf8'), Buffer.byteLength(CORPUS[3].body, 'utf8'));

  const after = recallOf('singbox02', edited);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].id, 'proxy-node');
});

test('索引 memo 与过滤器共存：带过滤的召回仍按全库分母算覆盖率', () => {
  clearIndexMemo();
  // 先跑一次全库，把全库索引塞进 memo，再跑带过滤的查询 —— 后者要建自己的
  // `refIndex`，两份索引的键不能串。
  recallOf('构建命令是什么');
  const withProcedural = CORPUS.map((item) => (item.id === 'deploy-steps'
    ? entry('deploy-steps', item.body, { kind: 'procedural' })
    : item));
  const filtered = recallOf('构建命令是什么', withProcedural, { kinds: ['procedural'] });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].id, 'deploy-steps');
  // 过滤后的覆盖率仍按全库 idf 分母算（`only_external_low_trust`/拒答的判据依赖它）：
  // 只要查询还有证据，就不该因为「过滤后库变小」而漂成 1.0。
  assert.ok(filtered.items[0].relevance < 1);
});
