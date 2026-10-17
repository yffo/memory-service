/**
 * bench/llm-answerer.mjs 的单元测试。
 *
 * 全部用本地 http.Server 打桩（127.0.0.1:0 随机端口）：CI 零成本、不联网、
 * 也不读 ~/.dsh 里的任何凭据。server 在 t.after 里 close，不留 handle。
 *
 * 覆盖：正常解析 / prompt 拼装 / 非 2xx（不泄 key、只带前 300 字）/
 *       超时（完全不响应 / 响应头后挂住）/ 429 与 503 重试 / 缺 apiKey /
 *       成本估算 / 空 context。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  answerQuestion,
  buildMessages,
  chatCompletion,
  estimateCostUsd,
  resolveConfig,
} from '../bench/llm-answerer.mjs';

/** 假的 apiKey：既用来断言「鉴权头带上了」，也用来断言「错误信息里绝不出现」。 */
const API_KEY = 'sk-test-not-a-real-key-123456';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? null : JSON.parse(text);
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function chatResponse(content, { usage, model = DEFAULT_MODEL } = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: usage ?? { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
  };
}

/** 起一个只监听回环地址的 mock server，并记录每次请求的 method/url/headers/body。 */
async function startMock(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    readJson(req)
      .then((body) => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        return handler(req, res, body);
      })
      .catch((err) => {
        if (!res.headersSent) json(res, 400, { error: String(err) });
      });
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { server, requests, baseUrl: 'http://127.0.0.1:' + port };
}

function configFor(baseUrl, extra = {}) {
  return { ...resolveConfig({}), baseUrl, apiKey: API_KEY, ...extra };
}

/** 超时依赖客户端自己的定时器；测试再握一个 ref'd handle，防 CI 上空闲事件循环先排空。 */
async function withLiveLoop(ms, body) {
  const keep = setTimeout(() => {}, ms);
  try {
    return await body();
  } finally {
    clearTimeout(keep);
  }
}

test('chatCompletion：正常解析 text / usage / model，请求契约正确', async (t) => {
  const { baseUrl, requests } = await startMock(t, (req, res) => {
    json(res, 200, chatResponse('500 元/月', {
      usage: { prompt_tokens: 123, completion_tokens: 8, total_tokens: 131 },
    }));
  });
  const result = await chatCompletion({
    messages: buildMessages({ prompt: '预算上限是多少？', context: '[project-foo.md] 预算上限 500 元/月' }),
    config: configFor(baseUrl),
  });
  assert.equal(result.text, '500 元/月');
  assert.deepEqual(result.usage, { prompt_tokens: 123, completion_tokens: 8, total_tokens: 131 });
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(typeof result.latencyMs, 'number');
  assert.ok(result.latencyMs >= 0);

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer ' + API_KEY);
  assert.equal(request.body.model, DEFAULT_MODEL);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.max_tokens, 256);
  assert.equal(request.body.temperature, 0);
  assert.equal(request.body.messages[0].role, 'system');
  assert.equal(request.body.messages[0].content, SYSTEM_PROMPT);
  assert.match(request.body.messages[1].content, /预算上限是多少/);
  assert.match(request.body.messages[1].content, /500 元\/月/);
});

test('buildMessages：system 约束 + 问题与笔记都进 user', () => {
  const messages = buildMessages({ prompt: '我的预算是多少？', context: '[project-foo.md] 预算 500 元/月' });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: 'system', content: SYSTEM_PROMPT });
  for (const needle of ['只依据', '<notes>', '60', '没有记录']) {
    assert.ok(SYSTEM_PROMPT.includes(needle), 'system 应包含「' + needle + '」');
  }
  const user = messages[1].content;
  assert.equal(messages[1].role, 'user');
  assert.match(user, /我的预算是多少/);
  assert.match(user, /\[project-foo\.md\] 预算 500 元\/月/);
  assert.match(user, /<notes>\n[\s\S]*\n<\/notes>/);
});

test('chatCompletion：非 2xx 报错含 status、不含 apiKey、响应体只留前 300 字', async (t) => {
  const head = 'ERROR-BODY-HEAD ';
  const tail = ' ERROR-BODY-TAIL';
  const body = head + 'x'.repeat(400) + tail;
  const { baseUrl } = await startMock(t, (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(body);
  });
  await assert.rejects(
    () => chatCompletion({ messages: [{ role: 'user', content: 'q' }], config: configFor(baseUrl) }),
    (err) => {
      assert.match(err.message, /500/);
      assert.ok(err.message.includes(head));
      assert.ok(!err.message.includes('ERROR-BODY-TAIL'), '响应体只保留前 300 字符');
      assert.ok(!err.message.includes(API_KEY), '错误信息绝不能带 apiKey');
      return true;
    },
  );
});

test('chatCompletion：mock 不响应时按 timeoutMs 超时抛错', async (t) => {
  const { baseUrl } = await startMock(t, () => {
    // 故意不响应：让客户端自己的 AbortController 超时生效。
  });
  const config = configFor(baseUrl, { timeoutMs: 60 });
  await withLiveLoop(2_000, async () => {
    await assert.rejects(
      () => chatCompletion({ messages: [{ role: 'user', content: 'q' }], config }),
      (err) => {
        assert.match(err.message, /超时/);
        assert.match(err.message, /60ms/);
        assert.ok(!err.message.includes(API_KEY));
        return true;
      },
    );
  });
});

test('chatCompletion：响应头已到但响应体挂住，超时仍然生效', async (t) => {
  const { baseUrl } = await startMock(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    // 故意不 end：只发头不发体，验证超时覆盖「读完响应体」而不只是「拿到响应头」。
  });
  const config = configFor(baseUrl, { timeoutMs: 200 });
  await withLiveLoop(3_000, async () => {
    await assert.rejects(
      () => chatCompletion({ messages: [{ role: 'user', content: 'q' }], config }),
      (err) => {
        assert.match(err.message, /超时/);
        assert.match(err.message, /200ms/);
        assert.ok(!err.message.includes(API_KEY));
        return true;
      },
    );
  });
});

test('chatCompletion：429 后退避约 1s 重试一次并成功', async (t) => {
  let calls = 0;
  const { baseUrl, requests } = await startMock(t, (req, res) => {
    calls += 1;
    if (calls === 1) {
      json(res, 429, { error: { message: 'rate limited' } });
      return;
    }
    json(res, 200, chatResponse('429 之后成功了'));
  });
  const startedAt = Date.now();
  const result = await chatCompletion({
    messages: [{ role: 'user', content: 'q' }],
    config: configFor(baseUrl),
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.text, '429 之后成功了');
  assert.equal(calls, 2);
  assert.equal(requests.length, 2);
  assert.ok(elapsed >= 900, '退避约 1s，实际耗时 ' + elapsed + 'ms');
});

test('chatCompletion：503 也是可重试状态，第二次仍失败才抛错', async (t) => {
  let calls = 0;
  const { baseUrl } = await startMock(t, (req, res) => {
    calls += 1;
    json(res, 503, { error: { message: 'unavailable-' + calls } });
  });
  await assert.rejects(
    () => chatCompletion({ messages: [{ role: 'user', content: 'q' }], config: configFor(baseUrl) }),
    (err) => {
      assert.match(err.message, /503/);
      assert.match(err.message, /unavailable-2/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('chatCompletion：缺 apiKey 抛清晰中文错误，且一个请求都不发', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    () => chatCompletion({
      messages: [{ role: 'user', content: 'q' }],
      config: { ...resolveConfig({}), apiKey: '' },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('缺 key 时不该发请求');
      },
    }),
    (err) => {
      assert.match(err.message, /缺少/);
      assert.match(err.message, /EVAL_LLM_API_KEY/);
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});

test('resolveConfig：默认值、覆盖优先级与 DEEPSEEK_API_KEY 回退', () => {
  assert.deepEqual(resolveConfig({}), {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    model: DEFAULT_MODEL,
    timeoutMs: 30_000,
    maxTokens: 256,
    temperature: 0,
  });

  const custom = resolveConfig({
    EVAL_LLM_BASE_URL: 'http://127.0.0.1:1234/v1/',
    EVAL_LLM_API_KEY: '  eval-key  ',
    DEEPSEEK_API_KEY: 'deepseek-key',
    EVAL_LLM_MODEL: 'custom-model',
    EVAL_LLM_TIMEOUT_MS: '1500',
    EVAL_LLM_MAX_TOKENS: '32',
    EVAL_LLM_TEMPERATURE: '0.7',
  });
  assert.equal(custom.baseUrl, 'http://127.0.0.1:1234/v1', '末尾斜杠要吃掉，避免拼出双斜杠');
  assert.equal(custom.apiKey, 'eval-key', 'EVAL_LLM_API_KEY 优先于 DEEPSEEK_API_KEY');
  assert.equal(custom.model, 'custom-model');
  assert.equal(custom.timeoutMs, 1500);
  assert.equal(custom.maxTokens, 32);
  assert.equal(custom.temperature, 0.7);

  assert.equal(resolveConfig({ DEEPSEEK_API_KEY: 'ds-key' }).apiKey, 'ds-key');
  assert.equal(resolveConfig({ EVAL_LLM_API_KEY: '   ', DEEPSEEK_API_KEY: 'ds-key' }).apiKey, 'ds-key');
  assert.equal(resolveConfig({ EVAL_LLM_TEMPERATURE: '0' }).temperature, 0, '0 是合法温度，不能被默认值吃掉');
  assert.equal(resolveConfig({ EVAL_LLM_TIMEOUT_MS: 'abc' }).timeoutMs, 30_000);
  assert.equal(resolveConfig({ EVAL_LLM_TIMEOUT_MS: '0' }).timeoutMs, 30_000);
  assert.equal(resolveConfig({ EVAL_LLM_MAX_TOKENS: '-5' }).maxTokens, 256);
});

test('estimateCostUsd：deepseek-flash 价格正确、未知模型返回 null', () => {
  const closeTo = (actual, expected) => {
    assert.equal(typeof actual, 'number');
    assert.ok(Math.abs(actual - expected) < 1e-12, actual + ' 应约等于 ' + expected);
  };
  // 输入 $0.15 / 1M，输出 $0.60 / 1M（2026-10 非高峰价）。
  closeTo(estimateCostUsd({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 'deepseek-flash'), 0.15);
  closeTo(estimateCostUsd({ prompt_tokens: 0, completion_tokens: 1_000_000 }, 'deepseek-flash'), 0.6);
  closeTo(estimateCostUsd({ prompt_tokens: 1_000_000, completion_tokens: 500_000 }, 'deepseek-flash'), 0.45);
  closeTo(estimateCostUsd({ prompt_tokens: 1_000, completion_tokens: 500 }, 'deepseek-flash'), 0.00045);
  assert.equal(estimateCostUsd({ prompt_tokens: 1, completion_tokens: 1 }, 'gpt-4o'), null);
  assert.equal(estimateCostUsd({ prompt_tokens: 1, completion_tokens: 1 }, 'deepseek-chat'), null);
  assert.equal(estimateCostUsd(null, 'deepseek-flash'), null);
});

test('空 context：user 消息明说「没有可用笔记」，answerQuestion 全链路可用', async (t) => {
  const messages = buildMessages({ prompt: '这件事记过吗？', context: '   ' });
  assert.match(messages[1].content, /没有可用笔记/);
  assert.match(messages[1].content, /这件事记过吗/);

  const { baseUrl, requests } = await startMock(t, (req, res) => {
    json(res, 200, chatResponse('没有记录'));
  });
  const result = await answerQuestion({
    prompt: '这件事记过吗？',
    context: '',
    config: configFor(baseUrl),
  });
  assert.equal(result.text, '没有记录');
  assert.match(requests[0].body.messages[1].content, /没有可用笔记/);
});
