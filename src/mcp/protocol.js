/**
 * Core JSON-RPC / MCP 协议处理（**与传输无关**）。
 *
 * 传输（stdio 行帧、将来的 Streamable HTTP）只负责把一行喂进来、把返回的行写出去。
 * 协议与工具语义全在这里，所以 `node --test` 可以直接驱动它，不需要起进程。
 *
 * ## 双时代（Dual-era）兼容
 *
 * `03-hosts-and-interfaces.md §1.5` 那张表是硬约束：
 *
 * | 客户端 \ 服务器 | 只有 initialize | 只有 server/discover | 双 |
 * |---|---|---|---|
 * | Legacy（≤2025-11-25） | OK | **失败** | OK |
 * | Modern（2026-07-28） | **失败** | OK | OK |
 *
 * 所以两个入口都必须有：`initialize`（legacy）与 `server/discover`（modern）。
 * 一个只有 `server/discover` 的服务器会让 Claude Code/Cursor 全线连不上；
 * 一个只有 `initialize` 的服务器会让新客户端直接判失败（legacy 客户端没有向上兼容机制，
 * 因此给 `initialize` 的版本错误里**必须列出**自己支持的版本）。
 *
 * ## 写权限
 *
 * `remember` / `capture` 默认**不在工具面里**（默认只读是 §6.3 的三条之一）。只有
 * `--allow-write` 才把它们挂上去——「工具在但写不进去」是最糟的失败形态，宁可不暴露。
 * `remember` 直接写正式记忆，仍过同一道闸门（`gate/`）；`capture` 只写候选，
 * 不重建主索引，等人在 CLI `inbox` 里批准后才可能进正式记忆。
 * `recall` 是只读的预算感知读接口：一次返回正文，证据不足时拒答（不是错误）。
 */
import { openStore, status, search, read, remember, addCandidate, recallQuery, INDEX_CAPS } from '../api.js';
import { VERSION } from '../version.js';

/** 我们同时会说的协议版本（顺序 = 优先度，第一个是最新）。 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25']);
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
/** 产品名（`serverInfo.name`）。宿主面板里显示的就是它，所以是产品名而不是仓库名。 */
export const SERVER_NAME = 'tabellio';
export const SERVER_VERSION = VERSION;

/** JSON-RPC 错误码（协议层；工具执行错误走 `result.isError`，见 §1.6）。 */
export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNSUPPORTED_PROTOCOL_VERSION: -32002,
});

/** 工具面：`recall` / `search` / `read` / `list` / `status`（+ 可选 `remember` / `capture`）。5±2 条（§6.3）。 */
export const READ_TOOLS = Object.freeze(['recall', 'search', 'read', 'list', 'status']);
export const WRITE_TOOL = 'remember';
/** 只写候选、不写正式记忆的写工具；和 `remember` 一起受 `--allow-write` 控制。 */
export const CAPTURE_TOOL = 'capture';
export const WRITE_TOOLS = Object.freeze([WRITE_TOOL, CAPTURE_TOOL]);

const RECALL_INPUT = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '想回忆的问题或关键词' },
    budget_tokens: { type: 'integer', minimum: 1, description: '本次返回正文的 token 预算（默认 500）' },
    kinds: { type: 'array', items: { type: 'string', enum: ['core', 'semantic', 'episodic', 'procedural'] } },
    trusts: { type: 'array', items: { type: 'string', enum: ['user_stated', 'system_derived', 'external'] } },
    apply_feedback: { type: 'boolean', description: '按历史反馈/纠正调整顺序（只影响顺序，不增删）' },
    decay_days: { type: 'integer', minimum: 1, maximum: 3650, description: '遗忘衰减半衰期（天）；不传则关闭' },
  },
  required: ['query'],
  additionalProperties: false,
};

const SEARCH_INPUT = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '检索词；中文按单字 + 相邻二元切分' },
    budget_tokens: { type: 'integer', minimum: 1, description: '本次返回的 token 预算（默认 500）' },
    kinds: { type: 'array', items: { type: 'string', enum: ['core', 'semantic', 'episodic', 'procedural'] } },
    trusts: { type: 'array', items: { type: 'string', enum: ['user_stated', 'system_derived', 'external'] } },
    max_notes: { type: 'integer', minimum: 1 },
  },
  required: ['query'],
  additionalProperties: false,
};

const READ_INPUT = {
  type: 'object',
  properties: { id: { type: 'string', description: 'ULID（可带 notes/ 前缀与 .md 后缀）' } },
  required: ['id'],
  additionalProperties: false,
};

const LIST_INPUT = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', description: '上次返回的 next_cursor；不传从头发' },
  },
  additionalProperties: false,
};

const STATUS_INPUT = { type: 'object', properties: {}, additionalProperties: false };

const CAPTURE_INPUT = {
  type: 'object',
  properties: {
    content: { type: 'string', description: '想记下的内容（markdown）；只会进候选，不会直接进正式记忆' },
    source: { type: 'string', description: '来源标识，例如 session:2026-10-18 或 claude-code；默认 mcp:capture' },
    kind: { type: 'string', enum: ['core', 'semantic', 'episodic', 'procedural'] },
    tags: { type: 'array', items: { type: 'string' } },
    id: { type: 'string', description: '重试时复用同一个 id；不传则自动生成 ULID' },
  },
  required: ['content'],
  additionalProperties: false,
};

const REMEMBER_INPUT = {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'markdown 正文；可自带 --- frontmatter' },
    id: { type: 'string', description: '更新既有笔记时给它的 ULID；新建可省' },
    kind: { type: 'string', enum: ['core', 'semantic', 'episodic', 'procedural'] },
    trust: { type: 'string', enum: ['user_stated', 'system_derived', 'external'] },
    scope: { type: 'string', enum: ['user', 'project'] },
    scope_detail: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    dry: { type: 'boolean', description: '只判定不落盘（判定与真写完全同一套）' },
  },
  required: ['content'],
  additionalProperties: false,
};

function tool(name, description, inputSchema, annotations) {
  return { name, description, inputSchema, annotations };
}

/** 工具清单。`allowWrite=false` 时只有只读五件套；为 true 才挂 `remember` / `capture`。 */
export function listTools({ allowWrite = false } = {}) {
  const tools = [
    tool(
      'recall',
      '按查询召回可直接使用的记忆正文（受 token 预算约束），一次调用就能拿到内容而不是指针。证据不足时 refused=true 且 items 为空——这是正常返回，不是错误。需要逐条审计时再用 search + read。',
      RECALL_INPUT,
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    ),
    tool('search', '按词法检索记忆，返回命中的笔记 id/标题/分数与 token 估算。没有证据时 refused=true（正常返回，不是错误）。', SEARCH_INPUT, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    tool('read', '按 id 读取一条笔记的完整正文。永远只读。', READ_INPUT, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    tool('list', '列出库里的笔记（分页）。用来在不知道 id 时先看看有什么。', LIST_INPUT, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    tool('status', '库的健康与预算：笔记数、索引行数、上限、解析失败数、被截断的账。', STATUS_INPUT, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  ];
  if (allowWrite) {
    tools.push(
      tool('remember', '写入一条记忆。必须过写入闸门：超限/越界/破坏性改动会被拒并给出原因。', REMEMBER_INPUT, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      }),
      tool(
        'capture',
        '把一段内容提交为待确认候选。不会进入正式记忆，也不参与检索；人在 CLI 里用 tabellio inbox 批准后才可能入库。',
        CAPTURE_INPUT,
        {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      ),
    );
  }
  return tools;
}

/** 工具结果：文本 + `structuredContent`（Modern 客户端可直接用结构化字段）。 */
function ok(text, structured) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured ?? null,
    isError: false,
  };
}

function fail(text, structured) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured ?? null,
    isError: true,
  };
}

/**
 * 工具实现。**每个工具都吃同一个 `ctx`（库上下文）**，不自己开库——
 * 否则「同一个进程里两个工具看到两份状态」这种 bug 迟早出现。
 */
export function callTool(name, args, { ctx, allowWrite = false, ledger = false } = {}) {
  const a = args ?? {};
  switch (name) {
    case 'recall': {
      if (typeof a.query !== 'string' || a.query.trim() === '') {
        return fail('recall 需要非空的 query', { error: 'invalid_params' });
      }
      const r = recallQuery(ctx, a.query, {
        budgetTokens: a.budget_tokens,
        kinds: a.kinds,
        trusts: a.trusts,
        applyFeedback: a.apply_feedback === true,
        decay: a.decay_days ? { halfLifeDays: a.decay_days } : null,
        ledger,
      });
      const full = r.items ?? [];
      const requested =
        r.budget?.requested ??
        (Number.isFinite(Number(a.budget_tokens)) && Number(a.budget_tokens) > 0 ? Number(a.budget_tokens) : 500);
      const items = full.map((item) => ({
        id: item.id,
        title: item.title,
        chars: [...String(item.content ?? '')].length,
        kind: item.kind,
        trust: item.trust,
        confidence: item.confidence,
        scope: item.scope,
        valid_from: item.valid_from,
        valid_to: item.valid_to,
        via: item.via,
        cost: item.cost,
        score: item.score?.total ?? (typeof item.score === 'number' ? item.score : null),
        relevance: item.relevance,
        why: item.why,
      }));
      const structured = {
        ok: true,
        status: r.status,
        refused: Boolean(r.refused),
        reason: r.reason ?? null,
        query: r.query,
        tokens: r.tokens ?? 0,
        budget: { requested, used: r.tokens ?? 0, max_notes: r.budget?.maxNotes ?? null },
        items,
        dropped_count: r.droppedCount ?? 0,
        truncated: Boolean(r.truncated),
      };
      if (r.refused) {
        return ok(
          `没有足够证据（${r.reason ?? 'insufficient_evidence'}：${recallReasonText(r.reason)}）——拒答是正常结果，不是错误。这次没有注入任何记忆正文。`,
          structured,
        );
      }
      const header = `召回 ${full.length} 条，约 ${r.tokens ?? 0} / ${requested} token${r.truncated ? '（有截断）' : ''}。`;
      const blocks = full.map((item) => {
        const meta = `[${item.id}] ${item.kind ?? '?'} / ${item.trust ?? '?'} · ${item.cost ?? '?'} token`;
        return `${meta}\n${item.content ?? ''}`;
      });
      return ok(`${header}\n\n${blocks.join('\n\n---\n\n')}`, structured);
    }
    case 'search': {
      if (typeof a.query !== 'string' || a.query.trim() === '') {
        return fail('search 需要非空的 query', { error: 'invalid_params' });
      }
      const r = search(ctx, a.query, {
        budgetTokens: a.budget_tokens,
        maxNotes: a.max_notes,
        kinds: a.kinds,
        trusts: a.trusts,
        ledger,
      });
      const lines = r.hits.length
        ? r.hits.map((h, i) => `${i + 1}. [${h.id}] ${h.title ?? ''} score=${h.score.toFixed(3)}`).join('\n')
        : `没有命中（${r.reason ?? 'no_evidence'}）——这是正常返回，不是错误。`;
      return ok(`${lines}\n\n（约 ${r.tokens} token，refused=${r.refused}）`, {
        hits: r.hits,
        tokens: r.tokens,
        refused: r.refused,
        reason: r.reason,
      });
    }
    case 'read': {
      if (typeof a.id !== 'string' || a.id === '') {
        return fail('read 需要 id', { error: 'invalid_params' });
      }
      const r = read(ctx, a.id);
      if (!r.ok) {
        return fail(`读不到 ${r.id}：${r.reason}`, { id: r.id, reason: r.reason, errors: r.errors });
      }
      if (ledger) ctx.ledger({ kind: 'opened', id: r.id, title: r.title, via: 'mcp:read' });
      return ok(`# ${r.title}\n\n${r.body}`, { id: r.id, title: r.title, body: r.body });
    }
    case 'list': {
      const scan = ctx.scan();
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 200);
      const all = scan.notes.slice().sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1));
      const filtered = a.kind ? all.filter((n) => n.note.kind === a.kind) : all;
      const start = a.cursor ? Math.max(0, filtered.findIndex((n) => String(n.id) === String(a.cursor))) : 0;
      const page = filtered.slice(start, start + limit);
      const next = start + limit < filtered.length ? String(filtered[start + limit].id) : null;
      const items = page.map((n) => ({ id: String(n.id), title: n.title, kind: n.note.kind, trust: n.note.trust, chars: [...String(n.body)].length }));
      const text = items.length
        ? items.map((i) => `- [${i.id}] ${i.title} (${i.kind}/${i.trust}, ${i.chars} 字)`).join('\n')
        : '（空）';
      return ok(`${text}\n\n共 ${filtered.length} 条，本次 ${items.length} 条${next ? `，下一页 cursor=${next}` : '，没有更多'}\n\n任何返回都可能被宿主截断，所以这里只给指针，正文用 read 取。`, {
        items,
        total: filtered.length,
        next_cursor: next,
      });
    }
    case 'status': {
      const s = status(ctx);
      const text = [
        `库：${s.store}`,
        `笔记 ${s.notes} 条，索引 ${s.indexLines} 行（上限 ${s.caps.indexLines} 行 / ${s.caps.indexBytes} 字节）`,
        `解析失败 ${s.parseFailures} 条，超长 ${s.oversizeChars} 条`,
        ...s.warnings.map((w) => `⚠️  ${w}`),
      ].join('\n');
      return ok(text, s);
    }
    case 'remember': {
      if (!allowWrite) {
        return fail('这个服务器以只读模式启动，remember 未启用（要用写入请在启动参数里加 --allow-write）', {
          error: 'write_disabled',
        });
      }
      if (typeof a.content !== 'string' || a.content.trim() === '') {
        return fail('remember 需要非空的 content', { error: 'invalid_params' });
      }
      const r = remember(ctx, { text: a.content }, {
        dry: Boolean(a.dry),
        id: a.id,
        kind: a.kind,
        trust: a.trust,
        scope: a.scope,
        scopeDetail: a.scope_detail,
        tags: a.tags,
        writtenBy: 'mcp:remember',
      });
      const body = JSON.stringify({ ok: r.ok, verdict: r.verdict, reason: r.reason, id: r.id, status: r.status });
      const structured = { ok: r.ok, verdict: r.verdict, reason: r.reason, id: r.id, status: r.status };
      // `isError` 只留给**真的出错了**（库写不进去、schema 不认识）。
      // `skip`（闲聊/太短）和 `duplicate`（同一条事实又写了一遍）是闸门的
      // **正常判定结果**（`§9.2` 明写这两者是 `ok:false` 的正常返回）。
      // 把它们标成 isError 的后果很具体：宿主会把「用户刚说了句『好的』」
      // 渲染成一条红色的工具失败，然后按错误策略重试 —— 一次正常的静默跳过
      // 变成三次带报错的写入尝试。
      const toolError = r.status === 'error' || r.reason === 'store_write_failed';
      return toolError ? fail(body, structured) : ok(body, structured);
    }
    case 'capture': {
      if (!allowWrite) {
        return fail('这个服务器以只读模式启动，capture 未启用（要用候选请在启动参数里加 --allow-write）', {
          error: 'write_disabled',
        });
      }
      if (typeof a.content !== 'string' || a.content.trim() === '') {
        return fail('capture 需要非空的 content', { error: 'invalid_params' });
      }
      const source = typeof a.source === 'string' && a.source.trim() !== '' ? a.source.trim() : 'mcp:capture';
      const r = addCandidate(
        ctx,
        { text: a.content, source, kind: a.kind, tags: a.tags },
        { id: a.id, writtenBy: 'capture:mcp' },
      );
      const structured = {
        ok: r.ok,
        reason: r.reason ?? null,
        id: r.id ?? null,
        title: r.title ?? null,
        chars: r.chars ?? null,
        source: r.source ?? source,
        path: r.path ?? null,
        duplicate_of: r.duplicate_of ?? null,
      };
      const text = r.ok
        ? `已收为候选 [${r.id}]「${r.title}」（${r.chars} 字，source=${r.source}）。未进正式记忆；请运行 tabellio inbox 批准。`
        : `未收为候选：${captureReasonText(r)}`;
      // 只有真出错 / 调用方给了非法输入才标 isError。重复、超长、id 冲突都是
      // 候选层的**正常判定**：宿主不该把它们渲染成红色失败并自动重试。
      const toolError = r.reason === 'store_write_failed' || r.reason === 'invalid_id' || r.reason === 'empty';
      return toolError ? fail(text, structured) : ok(text, structured);
    }
    default:
      return null; // 调用方转成 JSON-RPC -32601
  }
}

function recallReasonText(reason) {
  switch (reason) {
    case 'no_informative_term':
      return '查询里没有可检索的实词';
    case 'only_external_low_trust':
      return '只有低信任的外部来源，不能当证据';
    case 'cooccurrence_required_pair_missing':
      return '候选各缺一部分，没有一条同时覆盖';
    case 'top_score_below_threshold':
      return '最高分低于阈值';
    case 'all_hits_expired':
      return '命中的记忆都已过期';
    case 'insufficient_evidence':
      return '证据不足';
    default:
      return '低于拒答阈值';
  }
}

function captureReasonText(r) {
  switch (r.reason) {
    case 'empty':
      return '内容为空';
    case 'too_large':
      return `超过上限（${r.bytes} 字节 > ${r.limit} 字节）`;
    case 'duplicate':
      return `已有相同内容（${r.duplicate_of?.kind ?? 'note'}: ${r.duplicate_of?.id ?? '?'}）`;
    case 'id_exists':
      return `id 已存在（${r.existing ?? 'note'}: ${r.id}）`;
    case 'invalid_id':
      return `id 不合法：${r.id}`;
    case 'store_write_failed':
      return `写候选失败：${r.error?.message ?? r.error ?? 'unknown'}`;
    default:
      return String(r.reason ?? 'unknown');
  }
}

function versionError(requested) {
  return {
    code: RPC.UNSUPPORTED_PROTOCOL_VERSION,
    message: `不支持的协议版本：${requested}`,
    data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], latest: LATEST_PROTOCOL_VERSION },
  };
}

/** `initialize` 的返回（legacy 时代）。 */
export function initializeResult({ requested, allowWrite, instructions }) {
  const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      instructions ??
      `本地记忆库（pull 检索，默认${allowWrite ? '**可写**' : '只读'}）。用 recall 直接取回预算内的记忆正文；` +
        `要指针和逐条核对时用 search 找、read 取正文。没有证据时 recall / search 会 refused=true，` +
        `那是正常返回，不要重试同一个查询。` +
        (allowWrite ? ` 觉得值得记但不确定该不该入库时，用 capture 提交候选；人会在 tabellio inbox 里批准。` : ''),
  };
}

/** `server/discover` 的返回（modern 时代，无 initialize 建会话）。 */
export function discoverResult({ allowWrite, instructions } = {}) {
  return {
    // `protocolVersion`（单数）是**本次谈定用哪个**，`protocolVersions`（复数）是
    // 「我还会说哪些」。只给复数等于把「那这次按哪个版本说话」这个决定丢回给客户端，
    // 而客户端只能猜 —— 猜错的形态是它按 A 版本的规则解析 B 版本的回复。
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: { tools: { listChanged: false } },
    instructions:
      instructions ??
      `本地记忆库（pull 检索，默认${allowWrite ? '**可写**' : '只读'}）。工具与 legacy 时代完全一致。`,
  };
}

/** 从请求里取客户端声明的协议版本（modern 走 `_meta`，legacy 走 `initialize.params`）。 */
export function requestedVersion(message) {
  const meta = message?.params?._meta;
  const fromMeta = meta?.['io.modelcontextprotocol/protocolVersion'] ?? meta?.protocolVersion;
  if (typeof fromMeta === 'string' && fromMeta !== '') return fromMeta;
  const fromParams = message?.params?.protocolVersion;
  if (typeof fromParams === 'string' && fromParams !== '') return fromParams;
  return null;
}

/**
 * 建一个协议处理器。
 *
 * @param {object} options
 * @param {string} options.store         库路径
 * @param {boolean} [options.allowWrite] 是否挂 `remember`
 * @param {boolean} [options.ledger]     是否把 search/read 记进账本（默认否，见 `api.js`）
 * @param {object}  [options.ctx]        已有的库上下文（测试注入）
 */
export function createHandler(options = {}) {
  const ctx = options.ctx ?? openStore(options.store);
  const allowWrite = Boolean(options.allowWrite);
  const ledger = Boolean(options.ledger);
  const state = { initialized: false, protocol: null, calls: 0 };

  const wrap = (id, result) => ({
    jsonrpc: '2.0',
    id,
    result: { resultType: 'complete', ...result },
  });
  const error = (id, code, message, data) => ({
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  });

  /**
   * 处理一条消息。
   * @returns {object|null} 要写回去的消息（通知返回 null）
   */
  function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return error(null, RPC.INVALID_REQUEST, '消息不是 JSON 对象');
    }
    const { id = null, method, params } = message;
    const isNotification = id === null || id === undefined;

    switch (method) {
      // ── modern：能力发现，无会话 ──
      case 'server/discover': {
        const requested = requestedVersion(message);
        if (requested && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
          return error(id, RPC.UNSUPPORTED_PROTOCOL_VERSION, `不支持的协议版本：${requested}`, {
            supported: [...SUPPORTED_PROTOCOL_VERSIONS],
          });
        }
        state.protocol = requested ?? LATEST_PROTOCOL_VERSION;
        return wrap(id, discoverResult({ allowWrite }));
      }
      // ── legacy：建会话 ──
      case 'initialize': {
        const requested = params?.protocolVersion ?? null;
        if (requested && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
          return error(id, RPC.UNSUPPORTED_PROTOCOL_VERSION, `不支持的协议版本：${requested}`, {
            supported: [...SUPPORTED_PROTOCOL_VERSIONS],
            latest: LATEST_PROTOCOL_VERSION,
          });
        }
        state.initialized = true;
        state.protocol = requested ?? LATEST_PROTOCOL_VERSION;
        return wrap(id, initializeResult({ requested, allowWrite }));
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return wrap(id, {});
      case 'tools/list': {
        const requested = requestedVersion(message);
        if (requested && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
          return error(id, RPC.UNSUPPORTED_PROTOCOL_VERSION, `不支持的协议版本：${requested}`, {
            supported: [...SUPPORTED_PROTOCOL_VERSIONS],
          });
        }
        return wrap(id, { tools: listTools({ allowWrite }) });
      }
      case 'tools/call': {
        const requested = requestedVersion(message);
        if (requested && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
          return error(id, RPC.UNSUPPORTED_PROTOCOL_VERSION, `不支持的协议版本：${requested}`, {
            supported: [...SUPPORTED_PROTOCOL_VERSIONS],
          });
        }
        const name = params?.name;
        if (typeof name !== 'string') return error(id, RPC.INVALID_PARAMS, 'tools/call 需要 name');
        state.calls += 1;
        const found = listTools({ allowWrite }).some((t) => t.name === name);
        if (!found) {
          // 协议错误（-32602）而不是工具错误：调用方不该靠猜重试。
          return error(id, RPC.INVALID_PARAMS, `Unknown tool: ${name}`, { tools: listTools({ allowWrite }).map((t) => t.name) });
        }
        const result = callTool(name, params?.arguments ?? {}, { ctx, allowWrite, ledger });
        return wrap(id, result);
      }
      // ── 不提供的特性：明确报「方法不存在」而不是空结果 ──
      case 'resources/list':
      case 'resources/templates/list':
        return wrap(id, { resources: [], resourceTemplates: [] });
      case 'prompts/list':
        return wrap(id, { prompts: [] });
      case 'logging/setLevel':
        return wrap(id, {});
      default: {
        if (isNotification) return null; // 不认识的通知一律吞掉，不回错误（规范要求）
        return error(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method ?? '(missing)'}`);
      }
    }
  }

  /** 处理一行文本；坏 JSON → -32700（JSON-RPC 要求即使 id 未知也要回）。 */
  function handleLine(line) {
    const text = String(line ?? '').trim();
    if (text === '') return null;
    let message;
    try {
      message = JSON.parse(text);
    } catch (e) {
      return { jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: `JSON 解析失败：${e.message}` } };
    }
    if (Array.isArray(message)) {
      // 批量请求：逐个处理，丢掉通知，返回数组（JSON-RPC 2.0 允许）。
      const out = message.map(handle).filter((m) => m !== null);
      return out.length ? out : null;
    }
    return handle(message);
  }

  return { handle, handleLine, state, ctx, allowWrite, tools: () => listTools({ allowWrite }) };
}

export { INDEX_CAPS, recallQuery };
