/**
 * MCP 一致性测试：用**官方 SDK 的客户端**连 `node bin/memory-mcp`，走一遍真实协议。
 *
 * 为什么要它：`docs/02-evaluation.md §4.6` 把「宿主看到的接口」当交付面之一，
 * 协议对不对不能靠读代码，得让官方客户端真连一次——initialize、tools/list、
 * 再逐个调 recall / search / read / status / list，最后拿一个越界的 id 去读，必须被拒。
 *
 * ── 依赖从哪来 ────────────────────────────────────────────────────
 * 本仓库**不装依赖**（离线裸跑），SDK 从宿主进程已有的 node_modules 里借：
 *   1. `@modelcontextprotocol/sdk`（v1 域名）—— 裸 import 能解析就用它；
 *   2. `$MCP_SDK_ROOT` 指向的目录（里面有 @modelcontextprotocol/*）；
 *   3. `~/.dsh/profiles/node_modules`（DSH 的插件依赖面）；
 *   4. `/Applications/Minke.app/Contents/Resources/host/node_modules`
 *      （桌面宿主自带的依赖面，实测这里是 `@modelcontextprotocol/client` v2）。
 * 全都不在场就 **skip**，并把「为什么 skip、到哪去找」写进测试名里，
 * 而不是把测试删掉或让它假装通过。
 *
 * 注意：SDK 缺失是**环境**问题，不是被测代码的问题，所以只能 skip；
 * server 缺失/bin/memory-mcp 起不来，则是真失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'bin', 'memory-mcp');
const LIBRARY = path.join(ROOT, 'bench', 'core-30-v1', 'library');
const HOME = os.homedir();

/** SDK 候选路径：每个候选是 @modelcontextprotocol 的**父目录**。 */
const SDK_PARENT_CANDIDATES = [
  process.env.MCP_SDK_ROOT,
  path.join(HOME, '.dsh', 'profiles', 'node_modules'),
  '/Applications/Minke.app/Contents/Resources/host/node_modules',
  path.join(ROOT, 'node_modules'),
].filter(Boolean);

/** 找到第一个真实存在（符号链接不悬空）的 SDK 安装，返回 {clientEntry, stdioEntry, label}。 */
function findSdk() {
  for (const parent of SDK_PARENT_CANDIDATES) {
    for (const pkg of ['@modelcontextprotocol/sdk', '@modelcontextprotocol/client']) {
      const dir = path.join(parent, pkg);
      let real;
      try {
        real = fs.realpathSync(dir); // 悬空链接会在这里抛
      } catch {
        continue;
      }
      if (!fs.existsSync(real)) continue;
      const dist = path.join(real, 'dist');
      const probe = (rel) => path.join(dist, rel);
      const esm = (rel) => (fs.existsSync(probe(rel)) ? pathToFileURL(probe(rel)).href : null);
      // v1：dist/esm/...；v2：dist/index.mjs + dist/stdio.mjs
      const clientEntry =
        esm('esm/client/index.js') ?? esm('index.mjs') ?? esm('esm/index.js') ?? null;
      const stdioEntry =
        esm('esm/client/stdio.js') ??
        esm('stdio.mjs') ??
        esm('esm/client/stdio/index.js') ??
        null;
      if (clientEntry && stdioEntry) return { clientEntry, stdioEntry, label: `${pkg} @ ${real}` };
    }
  }
  return null;
}

const sdk = findSdk();
const sdkSkip = sdk
  ? false
  : `找不到官方 SDK：候选 ${SDK_PARENT_CANDIDATES.join(' / ')} 下都没有可解析的 @modelcontextprotocol/{sdk,client}（本仓库不装依赖）。装法：npm i -D @modelcontextprotocol/sdk，或把 MCP_SDK_ROOT 指到已有的 node_modules。`;

/** 把语料库复制成一个临时库（MCP 服务器要 notes/ 布局，且不该写脏仓库里的语料）。 */
function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core30-mcp-'));
  const notes = path.join(dir, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(LIBRARY)) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
    fs.copyFileSync(path.join(LIBRARY, name), path.join(notes, name));
    copied += 1;
  }
  return { dir, copied };
}

/** 起一个连好线的官方客户端；返回 {client, dispose}。 */
async function connectClient(store) {
  const { Client } = await import(sdk.clientEntry);
  const { StdioClientTransport } = await import(sdk.stdioEntry);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, '--store', store],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'memory-service-conformance', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    dispose: async () => {
      try {
        await client.close();
      } catch {
        /* 关不干净不影响结论 */
      }
    },
  };
}

test('MCP：server 脚本存在且带 shebang', () => {
  assert.ok(fs.existsSync(SERVER), `bin/memory-mcp 不存在：${SERVER}`);
  assert.match(fs.readFileSync(SERVER, 'utf8').split('\n')[0], /^#!.*node/);
});

test('MCP 一致性：initialize → tools/list → search/read/status/list → 越界读被拒', { skip: sdkSkip }, async (t) => {
  t.diagnostic(`SDK：${sdk.label}`);
  const store = makeTempStore();
  t.diagnostic(`临时库：${store.dir}（${store.copied} 篇）`);
  const { client, dispose } = await connectClient(store.dir);
  try {
    // ── 1. initialize 真的完成了：握手后拿得到 serverInfo ──
    const info = client.getServerVersion();
    assert.ok(info, 'connect() 之后应该拿得到 serverInfo');
    assert.equal(typeof info.name, 'string');
    t.diagnostic(`serverInfo：${info.name} ${info.version ?? ''}`);

    // ── 2. tools/list：默认只读，面是 recall/search/read/list/status ──
    const listed = await client.listTools();
    const names = listed.tools.map((x) => x.name).sort();
    assert.deepEqual(names, ['list', 'read', 'recall', 'search', 'status']);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} 应该有 object 型 inputSchema`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} 应该声明 readOnlyHint`);
    }
    assert.ok(
      !names.includes('remember'),
      '默认只读：没加 --allow-write 时不该挂 remember',
    );
    assert.ok(
      !names.includes('capture'),
      '默认只读：没加 --allow-write 时不该挂 capture',
    );

    // ── 3. status：库看得见，而且和我们塞进去的篇数对得上 ──
    const status = await client.callTool({ name: 'status', arguments: {} });
    assert.equal(status.isError, false);
    assert.equal(status.structuredContent?.notes, store.copied, 'status 报的笔记数应等于语料篇数');
    assert.equal(status.structuredContent?.parseFailures, 0, '语料库不该有解析失败');

    // ── 4. recall：一次拿到正文，且预算受限；这是 agent 真正用得上的读接口 ──
    const recalled = await client.callTool({
      name: 'recall',
      arguments: { query: 'Orchid 的生产环境监听哪个端口？' },
    });
    assert.equal(recalled.isError, false);
    assert.equal(recalled.structuredContent?.refused, false);
    assert.ok(recalled.structuredContent?.items?.length > 0, '这道题应该能召回至少一条');
    assert.ok(
      recalled.structuredContent.items[0].content === undefined,
      'structuredContent 不重复正文，正文只在给模型看的 content 里',
    );
    assert.match(recalled.content[0].text, /\[/, '文本里应带可追溯的笔记 id');

    // ── 5. search：命中语料里的一篇，且返回的是指针（id/score），不是整篇正文 ──
    const found = await client.callTool({
      name: 'search',
      arguments: { query: 'Orchid 的生产环境监听哪个端口？' },
    });
    assert.equal(found.isError, false);
    const hits = found.structuredContent?.hits ?? [];
    assert.ok(hits.length > 0, '这道题应该能召回至少一条');
    const hit = hits[0];
    assert.equal(typeof hit.id, 'string');
    assert.ok(!('body' in hit), 'search 只给指针，正文要用 read 取');

    // ── 6. read：用 search 给的 id 能读到完整正文 ──
    const full = await client.callTool({ name: 'read', arguments: { id: hit.id } });
    assert.equal(full.isError, false);
    assert.match(full.content[0].text, /^# /, 'read 返回标题 + 正文');
    assert.ok(full.structuredContent.body.length > 0);

    // ── 7. list：分页指针可用 ──
    const page = await client.callTool({ name: 'list', arguments: { limit: 5 } });
    assert.equal(page.isError, false);
    assert.equal(page.structuredContent.items.length, 5);
    assert.equal(page.structuredContent.total, store.copied);

    // ── 8. 越界读必须被拒：不许顺着 id 走出库房 ──
    for (const bad of ['../../../../etc/passwd', '/etc/passwd', 'notes/../index/MEMORY.md', 'nope-does-not-exist']) {
      const r = await client.callTool({ name: 'read', arguments: { id: bad } });
      assert.equal(r.isError, true, `越界/不存在的 id 必须被拒：${bad}`);
      const text = String(r.content?.[0]?.text ?? '');
      assert.ok(!/root:x?:/.test(text), `不许把 /etc/passwd 读出来：${bad}`);
    }

    // ── 9. 参数错也不行：search 缺 query ──
    const bad = await client.callTool({ name: 'search', arguments: {} }).catch((e) => ({ thrown: e }));
    if (bad.thrown) {
      assert.ok(bad.thrown, 'SDK 侧 schema 校验直接抛错也算拒绝');
    } else {
      assert.equal(bad.isError, true, 'search 缺 query 必须报错');
    }
  } finally {
    await dispose();
    fs.rmSync(store.dir, { recursive: true, force: true });
  }
});

test('MCP 一致性：--allow-write 才挂 remember / capture，capture 不直接进主库', { skip: sdkSkip }, async (t) => {
  const store = makeTempStore();
  const { Client } = await import(sdk.clientEntry);
  const { StdioClientTransport } = await import(sdk.stdioEntry);
  const client = new Client({ name: 'memory-service-conformance-write', version: '0.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, '--store', store.dir, '--allow-write'],
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((x) => x.name).sort();
    t.diagnostic(`--allow-write 工具面：${names.join(', ')}`);
    assert.deepEqual(names, ['capture', 'list', 'read', 'recall', 'remember', 'search', 'status']);
    const write = listed.tools.find((x) => x.name === 'remember');
    assert.equal(write.annotations?.readOnlyHint, false);
    assert.equal(write.inputSchema?.type, 'object');
    const capture = listed.tools.find((x) => x.name === 'capture');
    assert.equal(capture.annotations?.readOnlyHint, false);
    assert.equal(capture.inputSchema?.type, 'object');

    // capture 真的只落候选：主检索看不到，status 能看到待处理数。
    const captured = await client.callTool({
      name: 'capture',
      arguments: { content: '# MCP 候选\n\nMCP 提交的代号是青鸟。', source: 'mcp:conformance' },
    });
    assert.equal(captured.isError, false);
    assert.equal(captured.structuredContent?.ok, true);
    const candidateId = captured.structuredContent.id;
    assert.match(candidateId, /^[0-9A-HJKMNP-TV-Z]{26}$/);

    const candidateStatus = await client.callTool({ name: 'status', arguments: {} });
    assert.equal(candidateStatus.structuredContent?.candidates, 1);
    assert.equal(candidateStatus.structuredContent?.notes, store.copied, 'capture 不能增加正式笔记');
    const invisible = await client.callTool({ name: 'search', arguments: { query: '青鸟' } });
    assert.equal(invisible.structuredContent?.refused, true, '候选不能进检索面');

    // 人仍在 CLI 批准：MCP 提交的候选必须能被 CLI inbox 接住。
    const accepted = spawnSync(
      process.execPath,
      [path.join(ROOT, 'bin', 'memory'), 'inbox', '--store', store.dir, '--accept', candidateId, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).accepted_count, 1);
    const after = spawnSync(
      process.execPath,
      [path.join(ROOT, 'bin', 'memory'), 'status', '--store', store.dir, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(after.status, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).notes, store.copied + 1);
    assert.equal(JSON.parse(after.stdout).candidates, 0);
  } finally {
    try {
      await client.close();
    } catch {
      /* 忽略 */
    }
    fs.rmSync(store.dir, { recursive: true, force: true });
  }
});
