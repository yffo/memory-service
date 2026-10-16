/**
 * `src/mcp/protocol.js` 的单元测试：**不起进程、不走 stdio**，直接喂消息。
 *
 * 分工：本文件管协议语义（握手、版本、工具面、错误码、通知）；
 * `test/mcp-conformance.test.mjs`（另一个子代理的文件）管「官方客户端真连一次」。
 * 两个都要在，因为前者能精确断言错误码，后者能抓住「我们自说自话」的偏差。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHandler,
  listTools,
  callTool,
  initializeResult,
  discoverResult,
  requestedVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  RPC,
  READ_TOOLS,
  WRITE_TOOL,
} from '../src/mcp/protocol.js';
import { openStore, status, search, read, remember } from '../src/api.js';
import { tempDir, rm, write, noteMarkdown } from './helpers.mjs';
import { join } from 'node:path';

/** 起一个只在内存里用的处理器：临时库 + 两条虚构笔记。 */
function makeHandler(options = {}) {
  const dir = options.dir ?? tempDir('memory-mcp-');
  const ctx = openStore(dir);
  ctx.ensure();
  const texts = [
    noteMarkdown({
      id: '01M5MCP0000000000000000AA',
      title: '虚构项目 acme-widget 的构建命令',
      body: 'acme-widget 的构建命令是 `pnpm run build`，产物落在 `dist/`。',
      tags: ['convention', 'build'],
    }),
    noteMarkdown({
      id: '01M5MCP0000000000000000AB',
      title: '虚构项目 acme-widget 的部署步骤',
      body: '部署三步：先构建、再同步 staging、最后跑冒烟脚本。回滚就是把上一次产物同步回去。',
    }),
  ];
  for (const text of texts) {
    const r = remember(ctx, { text }, { writtenBy: 'test:mcp' });
    if (!r.ok) throw new Error(`夹具写入被拒：${r.reason}`);
  }
  const handler = createHandler({ ctx, allowWrite: options.allowWrite });
  return { dir, ctx, handler, dispose: () => rm(dir) };
}

const init = (id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

test('协议版本表：两个时代都要会，且第一个是最新', () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2026-07-28', '2025-11-25']);
  assert.equal(LATEST_PROTOCOL_VERSION, '2026-07-28');
});

test('legacy：initialize 建会话并把 serverInfo 给出去', () => {
  const { handler, dispose } = makeHandler();
  try {
    const res = handler.handle(init());
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, '2025-11-25', '回客户端声明的版本，不是我们的最新版');
    assert.equal(res.result.serverInfo.name, 'memory-service');
    assert.equal(typeof res.result.serverInfo.version, 'string');
    assert.ok(res.result.capabilities.tools, '必须声明 tools 能力，否则客户端不会让我们列工具');
    assert.equal(res.result.resultType, 'complete', 'Modern 时代要求 resultType（legacy 多一个字段无害）');
    assert.equal(handler.state.initialized, true);
  } finally {
    dispose();
  }
});

test('modern：server/discover 不需要任何会话状态', () => {
  const { handler, dispose } = makeHandler();
  try {
    const res = handler.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    });
    assert.equal(res.id, 7);
    assert.deepEqual(res.result.protocolVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);
    assert.equal(handler.state.initialized, false, 'discover 不该建会话（无状态是 Modern 的要点）');
    assert.equal(handler.state.protocol, '2026-07-28');
  } finally {
    dispose();
  }
});

test('版本不认时不静默降级：报 -32002 并列出自己支持的版本', () => {
  const { handler, dispose } = makeHandler();
  try {
    const legacy = handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    assert.equal(legacy.error.code, RPC.UNSUPPORTED_PROTOCOL_VERSION);
    assert.deepEqual(legacy.error.data.supported, [...SUPPORTED_PROTOCOL_VERSIONS]);
    assert.equal(legacy.error.data.latest, LATEST_PROTOCOL_VERSION);
    assert.equal(handler.state.initialized, false, '版本对不上就不能算握手成功');

    const modern = handler.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } },
    });
    assert.equal(modern.error.code, RPC.UNSUPPORTED_PROTOCOL_VERSION);
  } finally {
    dispose();
  }
});

test('requestedVersion：modern 走 _meta、legacy 走 params，都没有就 null', () => {
  assert.equal(requestedVersion({ params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }), '2026-07-28');
  assert.equal(requestedVersion({ params: { _meta: { protocolVersion: '2026-07-28' } } }), '2026-07-28');
  assert.equal(requestedVersion({ params: { protocolVersion: '2025-11-25' } }), '2025-11-25');
  assert.equal(requestedVersion({ params: {} }), null);
  assert.equal(requestedVersion({}), null);
});

test('工具面：默认只读 4 条，--allow-write 才多出 remember（5 条仍在 5±2 内）', () => {
  const readOnly = listTools().map((t) => t.name);
  assert.deepEqual(readOnly, [...READ_TOOLS]);
  assert.ok(!readOnly.includes(WRITE_TOOL), '默认只读：不该挂写工具');

  const withWrite = listTools({ allowWrite: true }).map((t) => t.name);
  assert.deepEqual(withWrite, [...READ_TOOLS, WRITE_TOOL]);
  assert.ok(withWrite.length <= 7, '工具面要守住 5±2');

  for (const tool of listTools({ allowWrite: true })) {
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} 必须有 object 型 inputSchema`);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} 要带行为提示`);
    assert.equal(
      tool.annotations.readOnlyHint,
      !(tool.name === WRITE_TOOL),
      `${tool.name} 的 readOnlyHint 必须如实`,
    );
  }
  // 工具顺序必须确定（两次调用逐字相同），否则宿主的工具缓存会一直失效
  assert.equal(JSON.stringify(listTools()), JSON.stringify(listTools()));
});

test('tools/list 的形状：只给 tools 数组，且顺序稳定', () => {
  const { handler, dispose } = makeHandler();
  try {
    const res = handler.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    assert.ok(Array.isArray(res.result.tools));
    assert.deepEqual(res.result.tools.map((t) => t.name), [...READ_TOOLS]);
    assert.equal(JSON.stringify(res.result.tools), JSON.stringify(listTools()));
  } finally {
    dispose();
  }
});

test('search 工具：命中给指针（不给整篇正文）、没命中是正常返回不是错误', () => {
  const { ctx, dispose } = makeHandler();
  try {
    const hit = callTool('search', { query: 'acme-widget 的构建命令' }, { ctx });
    assert.equal(hit.isError, false);
    assert.ok(hit.structuredContent.hits.length >= 1);
    const first = hit.structuredContent.hits[0];
    assert.equal(typeof first.id, 'string');
    assert.equal(typeof first.title, 'string');
    assert.ok(!('body' in first), 'search 只给指针，正文必须用 read 取');
    assert.ok(hit.content[0].text.includes(first.id));

    const miss = callTool('search', { query: '量子色动力学里的胶子禁闭' }, { ctx });
    assert.equal(miss.isError, false, '没证据是正常返回；报错会诱使调用方重试或编造');
    assert.equal(miss.structuredContent.refused, true);
    assert.equal(miss.structuredContent.hits.length, 0);
  } finally {
    dispose();
  }
});

test('search 缺 query 走 isError 而不是抛异常', () => {
  const { ctx, dispose } = makeHandler();
  try {
    const r = callTool('search', { query: '   ' }, { ctx });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error, 'invalid_params');
  } finally {
    dispose();
  }
});

test('read 工具：正文以 `# 标题` 开头，越界 id 必须被拒且不泄漏内容', () => {
  const { ctx, handler, dispose } = makeHandler();
  try {
    const found = callTool('search', { query: 'acme-widget 的构建命令' }, { ctx });
    const id = found.structuredContent.hits[0].id;

    const full = callTool('read', { id }, { ctx });
    assert.equal(full.isError, false);
    assert.match(full.content[0].text, /^# /);
    assert.ok(full.structuredContent.body.length > 0);

    for (const bad of ['../../../../etc/passwd', '/etc/passwd', 'notes/../index/MEMORY.md', 'nope']) {
      const r = callTool('read', { id: bad }, { ctx });
      assert.equal(r.isError, true, `越界/不存在的 id 必须被拒：${bad}`);
      const text = String(r.content?.[0]?.text ?? '');
      assert.ok(!/root:x?:/.test(text), `不许把 /etc/passwd 读出来：${bad}`);
      // 越界 id 的错误文案里可能出现「索引」字样，所以这里卡的是**索引文件的内容**，
      // 不是「消息里出现过 MEMORY」：前者才是泄漏，后者会把正常报错也判红。
      assert.ok(!text.includes('# Memory Index'), '不许顺着 ../ 读到索引文件的内容');
      assert.ok(!/^- \[/m.test(text), '不许把索引的指针行当正文吐出来');
      // 同时用协议层再验一遍：越界读不能返回 result
      const viaHandler = handler.handle({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'read', arguments: { id: bad } },
      });
      assert.equal(viaHandler.result.isError, true, '工具错误用 result.isError，不用 JSON-RPC error（§1.6）');
    }
  } finally {
    dispose();
  }
});

test('list 工具：分页指针可用、总数对得上、越界 limit 被夹住', () => {
  const { ctx, dispose } = makeHandler();
  try {
    const page = callTool('list', { limit: 1 }, { ctx });
    assert.equal(page.isError, false);
    assert.equal(page.structuredContent.items.length, 1);
    assert.equal(page.structuredContent.total, 2);
    assert.equal(typeof page.structuredContent.next_cursor, 'string');

    const next = callTool('list', { limit: 1, cursor: page.structuredContent.next_cursor }, { ctx });
    assert.notEqual(next.structuredContent.items[0].id, page.structuredContent.items[0].id);

    const huge = callTool('list', { limit: 10 ** 9 }, { ctx });
    assert.equal(huge.structuredContent.items.length, 2, 'limit 要被夹到库里实际的条数');

    const filtered = callTool('list', { kind: 'semantic' }, { ctx });
    assert.ok(filtered.structuredContent.items.every((i) => i.kind === 'semantic'));
  } finally {
    dispose();
  }
});

test('status 工具：形状与 CLI 的 status 必须一致（同一条事实不能有两套读法）', () => {
  const { ctx, dispose } = makeHandler();
  try {
    const r = callTool('status', {}, { ctx });
    const direct = status(ctx);
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.notes, direct.notes);
    assert.equal(r.structuredContent.indexLines, direct.indexLines);
    assert.deepEqual(r.structuredContent.caps, direct.caps);
    assert.ok(r.content[0].text.includes(String(direct.notes)));
  } finally {
    dispose();
  }
});

test('remember：默认只读时明确拒绝（不是假装成功），--allow-write 时才真的写', () => {
  const readOnly = makeHandler();
  try {
    const r = callTool('remember', { content: 'acme-widget 的构建命令是 pnpm run build。' }, { ctx: readOnly.ctx });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error, 'write_disabled');
    assert.equal(readOnly.ctx.scan().notes.length, 2, '被拒的写入不能留下任何痕迹');
  } finally {
    readOnly.dispose();
  }

  const writable = makeHandler({ allowWrite: true });
  try {
    const before = writable.ctx.scan().notes.length;
    const r = callTool(
      'remember',
      { content: 'acme-widget 的发布渠道是内部 npm，不发公网。' },
      { ctx: writable.ctx, allowWrite: true },
    );
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.ok, true);
    assert.equal(r.structuredContent.verdict, 'allow');
    assert.equal(writable.ctx.scan().notes.length, before + 1);

    // 空内容不进库
    const empty = callTool('remember', { content: '  ' }, { ctx: writable.ctx, allowWrite: true });
    assert.equal(empty.isError, true);
    assert.equal(writable.ctx.scan().notes.length, before + 1);
  } finally {
    writable.dispose();
  }
});

test('不认识的方法：请求报 -32601、通知一律吞掉（规范要求，回错误会让客户端断连）', () => {
  const { handler, dispose } = makeHandler();
  try {
    const req = handler.handle({ jsonrpc: '2.0', id: 5, method: 'tools/whatever' });
    assert.equal(req.error.code, RPC.METHOD_NOT_FOUND);

    const note = handler.handle({ jsonrpc: '2.0', method: 'notifications/whatever' });
    assert.equal(note, null);
    assert.equal(handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  } finally {
    dispose();
  }
});

test('不提供的特性明说：resources/prompts 给空表，不给「方法不存在」', () => {
  const { handler, dispose } = makeHandler();
  try {
    const resources = handler.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' }).result;
    // 只断言我们关心的两个字段：result 上还挂着 Modern 时代要求的 `resultType`，
    // 用整体 deepEqual 会把它当成「多出来的字段」判红（那是协议要求，不是 bug）。
    assert.deepEqual(resources.resources, []);
    assert.deepEqual(resources.resourceTemplates, []);
    assert.deepEqual(handler.handle({ jsonrpc: '2.0', id: 7, method: 'prompts/list' }).result.prompts, []);
  } finally {
    dispose();
  }
});

test('未知工具用 -32602 而不是 isError：调用方不该靠猜重试', () => {
  const { handler, dispose } = makeHandler();
  try {
    const res = handler.handle({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'forget', arguments: {} },
    });
    assert.equal(res.error.code, RPC.INVALID_PARAMS);
    assert.deepEqual(res.error.data.tools, [...READ_TOOLS]);
  } finally {
    dispose();
  }
});

test('handleLine：坏 JSON → -32700；空行不产生任何输出；批量请求回数组', () => {
  const { handler, dispose } = makeHandler();
  try {
    const bad = handler.handleLine('{ not json');
    assert.equal(bad.error.code, RPC.PARSE_ERROR);
    assert.equal(bad.id, null);

    assert.equal(handler.handleLine(''), null);
    assert.equal(handler.handleLine('   '), null);

    const batch = handler.handleLine(
      JSON.stringify([
        { jsonrpc: '2.0', id: 10, method: 'tools/list' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      ]),
    );
    assert.ok(Array.isArray(batch));
    assert.equal(batch.length, 2, '批量里的通知要被丢掉，只回有 id 的那两条');
    assert.deepEqual(batch.map((m) => m.id), [10, 11]);

    const notificationsOnly = handler.handleLine(
      JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]),
    );
    assert.equal(notificationsOnly, null, '只有通知时不该回一个空数组（空行会污染 stdio 流）');

    assert.equal(handler.handleLine('{"jsonrpc":"2.0","id":12,"method":"ping"}').result.resultType, 'complete');
  } finally {
    dispose();
  }
});

test('非对象消息 → -32600（null / 数组元素 / 字符串都不能让处理器崩）', () => {
  const { handler, dispose } = makeHandler();
  try {
    for (const bad of [null, 'x', 42]) {
      const r = handler.handle(bad);
      assert.equal(r.error.code, RPC.INVALID_REQUEST);
    }
  } finally {
    dispose();
  }
});

test('instructions 里必须写清「没证据是正常返回」，否则宿主会教模型重试', () => {
  const ro = initializeResult({ requested: '2025-11-25', allowWrite: false });
  assert.match(ro.instructions, /refused|没有证据/);
  const rw = initializeResult({ requested: '2025-11-25', allowWrite: true });
  assert.match(rw.instructions, /可写/);
  assert.match(discoverResult({ allowWrite: false }).instructions, /只读/);
  // 版本不认识时回最新版（legacy 客户端没有向上兼容机制，只能尽量给可用的）
  assert.equal(initializeResult({ requested: '1999-01-01' }).protocolVersion, LATEST_PROTOCOL_VERSION);
});

test('同一个 ctx 被所有工具共用：写进去的东西立刻能被同一个处理器读到', () => {
  const { ctx, handler, dispose } = makeHandler({ allowWrite: true });
  try {
    const w = handler.handle({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'remember', arguments: { content: 'acme-widget 的缓存目录是 .cache/widget。' } },
    });
    assert.equal(w.result.isError, false);
    const s = handler.handle({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'acme-widget 缓存目录' } },
    });
    assert.ok(s.result.structuredContent.hits.length >= 1, '写完后立刻可召回');
    assert.equal(s.result.structuredContent.hits[0].id, w.result.structuredContent.id);
  } finally {
    dispose();
  }
});
