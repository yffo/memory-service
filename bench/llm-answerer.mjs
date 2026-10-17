/**
 * bench/llm-answerer.mjs —— 回答层三臂（closed_book / real / oracle_gold）的真实回答器。
 *
 * 为什么是「零依赖 OpenAI 兼容客户端」而不是直接调 SDK：
 *   1. 本仓库运行时依赖是 0（package.json 的 dependencies 为空），评测装置也不能破例；
 *   2. 只要服务端兼容 POST {baseUrl}/chat/completions，就能换成任何一家；
 *   3. 网络调用全部收口在本文件，run-eval 只拿 { text, usage, model, latencyMs }。
 *
 * ── 接口（run-eval.mjs 直接依赖，改签名等于改契约）─────────────────
 *   DEFAULT_BASE_URL / DEFAULT_MODEL / SYSTEM_PROMPT
 *   resolveConfig(env)                                读环境变量 → 配置对象
 *   buildMessages({ prompt, context })                → [{role:'system'}, {role:'user'}]
 *   chatCompletion({ messages, config, fetchImpl })   → { text, usage, model, latencyMs }
 *   answerQuestion({ prompt, context, config })       → 同上（内部拼 messages）
 *   estimateCostUsd(usage, model)                     → 美元或 null（未知模型）
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 *   1. **绝不打印、绝不回显 apiKey**：错误信息只拼 status 与响应体前 300 字符，
 *      请求头不进任何日志。缺 key 时抛中文错误，不静默降级成「无记忆」。
 *   2. **超时用 AbortController**：每次 HTTP 请求各自计时（默认 30s），
 *      超时抛「LLM 请求超时（Nms）」，不把 DOMException 原样漏给上层。
 *   3. **429/503 重试 1 次**，约 1s 固定退避；其他非 2xx 一次就抛。
 *
 * 测试：test/bench-llm.test.mjs 用本地 http.Server 打桩，CI 零成本、不联网。
 */

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';

/**
 * 回答器的 system 约束（中文，判分口径依赖它）：
 * 只依据 <notes>、答案 ≤ 60 字符、只输出答案本身、笔记没写就输出「没有记录」。
 */
export const SYSTEM_PROMPT = [
  '你是记忆问答助手，只回答用户提出的问题。',
  '规则：',
  '1. 只依据用户消息里 <notes>…</notes> 内的笔记内容回答；笔记没写的信息一律不许编造。',
  '2. 答案不超过 60 个字符，只输出答案本身：不要解释、不要复述问题、不要加「答案：」之类前缀。',
  '3. 如果笔记里没有记录答案，只输出「没有记录」。',
].join('\n');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TEMPERATURE = 0;
/** 可重试状态 → 退避后再试一次（总共最多 2 次请求）。 */
const RETRYABLE_STATUS = new Set([429, 503]);
const RETRY_BACKOFF_MS = 1_000;
const MAX_ATTEMPTS = 2;
/** 错误信息里最多带多少响应体：够排障，又不至于把整页 HTML 灌进终端。 */
const ERROR_BODY_LIMIT = 300;

/**
 * 2026-10 DeepSeek **非高峰（off-peak）价**，单位：美元 / 百万 token。
 * 只收录评测真正会用的模型；未知模型让 estimateCostUsd 返回 null，
 * 宁可报告里显示「—」，也不拿别的模型价格硬套。
 */
const PRICE_PER_MILLION = Object.freeze({
  'deepseek-flash': Object.freeze({ input: 0.15, output: 0.6 }),
});

/** env 变量可能是 undefined / 空串 / 带空格；统一成 trim 后的字符串，数字也接受。 */
function readText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** 读数值型 env：非法、越界、空串一律回默认值（0 是合法值，不能用 falsy 判断）。 */
function readNumber(value, fallback, { integer = false, positive = false } = {}) {
  const raw = readText(value);
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (positive ? n <= 0 : n < 0) return fallback;
  return integer ? Math.floor(n) : n;
}

/**
 * 读配置。优先级：EVAL_LLM_API_KEY > DEEPSEEK_API_KEY（缺省回退）。
 * 返回的 baseUrl 去掉末尾斜杠，拼 /chat/completions 时不会出现双斜杠。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveConfig(env = process.env) {
  const e = env ?? {};
  const baseUrl = readText(e.EVAL_LLM_BASE_URL) || DEFAULT_BASE_URL;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: readText(e.EVAL_LLM_API_KEY) || readText(e.DEEPSEEK_API_KEY),
    model: readText(e.EVAL_LLM_MODEL) || DEFAULT_MODEL,
    timeoutMs: readNumber(e.EVAL_LLM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, { integer: true, positive: true }),
    maxTokens: readNumber(e.EVAL_LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS, { integer: true, positive: true }),
    temperature: readNumber(e.EVAL_LLM_TEMPERATURE, DEFAULT_TEMPERATURE),
  };
}

/**
 * 拼 Chat Completions 的 messages。
 * context 是已拼好的笔记文本（可能为空串）；空 context 时也必须明确告诉模型
 * 「没有可用笔记」，否则模型会拿自己的常识答，closed_book 臂就失去意义。
 * @param {{ prompt?: string, context?: string }} [input]
 */
export function buildMessages({ prompt, context } = {}) {
  const question = String(prompt ?? '').trim();
  const notes = String(context ?? '').trim();
  const user = notes === ''
    ? `没有可用笔记（<notes> 为空）。\n\n问题：${question}`
    : `以下是可用笔记：\n<notes>\n${notes}\n</notes>\n\n问题：${question}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 带超时的单次请求：计时器同时覆盖「拿到响应头」和「读完响应体」。
 * 只包 fetch 的话，服务端发完响应头再挂住连接，就会一直等下去。
 * 抛出的错误保证不带 apiKey。
 */
async function requestOnce(url, body, config, fetchImpl) {
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    return { response, raw };
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`LLM 请求超时（${timeoutMs}ms）：${url}`);
      timeoutError.cause = err;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI 口径的 usage；服务端没给就记 0（总比 NaN 写进报告强）。 */
function normalizeUsage(usage) {
  const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  };
  const promptTokens = count(usage?.prompt_tokens);
  const completionTokens = count(usage?.completion_tokens);
  const totalTokens = usage?.total_tokens === undefined
    ? promptTokens + completionTokens
    : count(usage.total_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

/** 解析 2xx 响应；延迟从第一次请求前开始算（含重试退避，报告里是用户真实等待）。 */
function parseCompletion(raw, { status, config, startedAt }) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`LLM 响应不是合法 JSON（HTTP ${status}）：${raw.slice(0, ERROR_BODY_LIMIT)}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(
      `LLM 响应缺少 choices[0].message.content（HTTP ${status}）：${raw.slice(0, ERROR_BODY_LIMIT)}`,
    );
  }
  return {
    text: content.trim(),
    usage: normalizeUsage(payload.usage),
    model: typeof payload.model === 'string' && payload.model !== ''
      ? payload.model
      : (config.model || DEFAULT_MODEL),
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * 调一次 Chat Completions。429/503 各重试一次（约 1s 退避）。
 * @param {{ messages: Array, config?: object, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ text: string, usage: {prompt_tokens:number, completion_tokens:number, total_tokens:number}, model: string, latencyMs: number }>}
 */
export async function chatCompletion({ messages, config = resolveConfig(), fetchImpl = fetch } = {}) {
  // 配置允许只传一部分：缺的字段回落到环境变量 / 默认值（Lead 的集成传的是完整对象）。
  const cfg = { ...resolveConfig(), ...(config ?? {}) };
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chatCompletion：messages 不能为空');
  }
  if (!cfg.apiKey) {
    throw new Error('缺少 LLM API key：请设置环境变量 EVAL_LLM_API_KEY（或 DEEPSEEK_API_KEY）');
  }
  const baseUrl = String(cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model: cfg.model || DEFAULT_MODEL,
    messages,
    temperature: cfg.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
  });
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { response, raw } = await requestOnce(url, body, cfg, fetchImpl);
    if (response.ok) {
      return parseCompletion(raw, {
        status: response.status,
        config: cfg,
        startedAt,
      });
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    const snippet = String(raw ?? '').slice(0, ERROR_BODY_LIMIT) || '（无响应体）';
    throw new Error(`LLM 请求失败（HTTP ${response.status}）：${snippet}`);
  }
  // MAX_ATTEMPTS 次都拿到可重试状态才会走到这里（正常流程不会）。
  throw new Error('LLM 请求失败：重试后仍未拿到响应');
}

/**
 * 评测用的高层入口：问题 + 已拼好的笔记上下文 → 模型答案。
 * @param {{ prompt: string, context?: string, config?: object, fetchImpl?: typeof fetch }} input
 */
export async function answerQuestion({ prompt, context, config = resolveConfig(), fetchImpl = fetch } = {}) {
  const messages = buildMessages({ prompt, context });
  return chatCompletion({ messages, config, fetchImpl });
}

/**
 * 按 token 数折算美元成本。
 * 价格表见 PRICE_PER_MILLION（2026-10 非高峰价）；未知模型返回 null。
 * @param {{prompt_tokens?: number, completion_tokens?: number}|null} usage
 * @param {string} model
 * @returns {number|null}
 */
export function estimateCostUsd(usage, model) {
  const price = PRICE_PER_MILLION[String(model ?? '').trim().toLowerCase()];
  if (!price) return null;
  const input = Number(usage?.prompt_tokens);
  const output = Number(usage?.completion_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return (input / 1e6) * price.input + (output / 1e6) * price.output;
}
