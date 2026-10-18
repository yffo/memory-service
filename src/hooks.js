/**
 * Claude Code 会话结束钩子：安装/卸载 + 从 transcript 里提取候选。
 *
 * 口径：
 * 1. 只支持 Claude Code。它给了稳定的 SessionEnd 事件和 transcript_path；
 *    Cursor / Codex 目前没有等价的会话结束契约，不伪造。
 * 2. 钩子只写 notes/candidates/，不写正式笔记、不重建主索引；批准仍走 tabellio inbox。
 * 3. 只抓**显式记忆线索**（记住、以后…、偏好、决定、改口），并过滤密钥。
 *    宁可漏，不可把整段对话倒进候选箱——候选箱是人工闸门，不是垃圾场。
 * 4. 安装默认 dry-run：写的是 ~/.claude/settings.json，里面可能有用户凭据。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_HOSTS = Object.freeze(['claude']);
export const HOOK_TIMEOUT_SECONDS = 15;
export const MAX_CANDIDATES_PER_SESSION = 3;
export const MAX_CANDIDATE_SENTENCE_CHARS = 240;

const MIN_SENTENCE_CHARS = 8;
const CANDIDATE_TITLE_PREFIX = '会话记忆：';
const TITLE_BODY_CHARS = 28;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stampOf(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '');
}

function sameArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((item, i) => item === b[i]);
}

function invalidPlan(host, path, code, message, extra = {}) {
  return {
    ok: false,
    host,
    path,
    action: 'invalid',
    reason: 'invalid_config',
    error: { code, message },
    would_write: false,
    ...extra,
  };
}

/** Claude Code 的全局设置文件；钩子挂在这里的 hooks.SessionEnd。 */
export function claudeSettingsPath(home = homedir()) {
  return join(home, '.claude', 'settings.json');
}

function readSettings(path) {
  if (!existsSync(path)) return { ok: true, exists: false, data: {} };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, code: 'E_CONFIG_UNREADABLE', message: String(e?.message ?? e) };
  }
  if (text.trim() === '') return { ok: true, exists: true, data: {} };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'E_CONFIG_INVALID', message: 'JSON 解析失败：' + String(e?.message ?? e) };
  }
  if (!isPlainObject(data)) return { ok: false, code: 'E_CONFIG_INVALID', message: '顶层必须是对象' };
  return { ok: true, exists: true, data };
}

function hookTokens(hook) {
  const tokens = [];
  if (typeof hook?.command === 'string') tokens.push(...hook.command.split(/\s+/).filter(Boolean));
  if (Array.isArray(hook?.args)) tokens.push(...hook.args.map(String));
  return tokens;
}

/** 只认带 hook + claude-session-end 两个词的那条；不碰用户自己的 SessionEnd 钩子。 */
function isTabellioHook(hook) {
  if (!isPlainObject(hook) || hook.type !== 'command') return false;
  const tokens = hookTokens(hook);
  return tokens.includes('hook') && tokens.includes('claude-session-end');
}

function sameCommandArgs(current, desired) {
  return (
    current?.type === 'command' &&
    current?.command === desired.command &&
    sameArray(current?.args, desired.args)
  );
}

function sameHook(current, desired) {
  return sameCommandArgs(current, desired) && current?.timeout === desired.timeout;
}

function desiredHook({ command, bin, store }) {
  return {
    type: 'command',
    command,
    args: [bin, 'hook', 'claude-session-end', '--store', store],
    timeout: HOOK_TIMEOUT_SECONDS,
  };
}

function collectOurs(sessionEnd) {
  const ours = [];
  for (let groupIndex = 0; groupIndex < sessionEnd.length; groupIndex += 1) {
    const group = sessionEnd[groupIndex];
    for (const hook of group.hooks) {
      if (isTabellioHook(hook)) ours.push({ groupIndex, hook });
    }
  }
  return ours;
}

function withoutOurs(sessionEnd) {
  const out = [];
  for (const group of sessionEnd) {
    const hooks = group.hooks.filter((hook) => !isTabellioHook(hook));
    if (hooks.length === 0) continue;
    out.push({ ...group, hooks });
  }
  return out;
}

function withSessionEnd(data, sessionEnd) {
  const next = { ...data };
  const hooks = isPlainObject(next.hooks) ? { ...next.hooks } : {};
  if (sessionEnd.length === 0) delete hooks.SessionEnd;
  else hooks.SessionEnd = sessionEnd;
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return next;
}

/**
 * 计划一次钩子安装/卸载。默认 dry-run：只算，不写。
 *
 * @returns {object} action: create|append|update|unchanged|uninstall|conflict|invalid
 */
export function planHookInstall({
  host = 'claude',
  home = homedir(),
  bin,
  store,
  command = process.execPath,
  uninstall = false,
  force = false,
  now = Date.now(),
} = {}) {
  if (!HOOK_HOSTS.includes(host)) {
    return {
      ok: false,
      host,
      path: null,
      action: 'unsupported',
      reason: 'unknown_host',
      would_write: false,
      supported: [...HOOK_HOSTS],
    };
  }
  const path = claudeSettingsPath(home);
  if (!uninstall && (typeof bin !== 'string' || !bin || typeof store !== 'string' || !store)) {
    return invalidPlan(host, path, 'E_ARGS', '缺少 bin / store', { reason: 'missing_target' });
  }

  const read = readSettings(path);
  if (!read.ok) return invalidPlan(host, path, read.code, read.message);
  const data = read.data;
  if (data.hooks !== undefined && !isPlainObject(data.hooks)) {
    return invalidPlan(host, path, 'E_CONFIG_INVALID', 'hooks 必须是对象');
  }
  const hooks = data.hooks ?? {};
  if (hooks.SessionEnd !== undefined && !Array.isArray(hooks.SessionEnd)) {
    return invalidPlan(host, path, 'E_CONFIG_INVALID', 'hooks.SessionEnd 必须是数组');
  }
  const sessionEnd = hooks.SessionEnd ?? [];
  for (const group of sessionEnd) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      return invalidPlan(host, path, 'E_CONFIG_INVALID', 'hooks.SessionEnd 里有不认识的项（需要 { hooks: [...] }）');
    }
    for (const hook of group.hooks) {
      if (!isPlainObject(hook)) {
        return invalidPlan(host, path, 'E_CONFIG_INVALID', 'hooks.SessionEnd 里有不认识的 hook（需要对象）');
      }
    }
  }

  const ours = collectOurs(sessionEnd);
  const remaining = withoutOurs(sessionEnd);

  if (uninstall) {
    if (ours.length === 0) {
      return {
        ok: true,
        host,
        path,
        action: 'unchanged',
        reason: 'not_installed',
        exists: read.exists,
        would_write: false,
        removed: 0,
      };
    }
    const next = withSessionEnd(data, remaining);
    const plan = {
      ok: true,
      host,
      path,
      action: 'uninstall',
      exists: read.exists,
      removed: ours.length,
      would_write: true,
      backup: read.exists ? path + '.tabellio-backup-' + stampOf(now) : null,
    };
    Object.defineProperty(plan, 'preview', {
      value: JSON.stringify(next, null, 2) + '\n',
      enumerable: false,
      configurable: true,
    });
    return plan;
  }

  const desired = desiredHook({ command, bin, store });
  let action;
  if (ours.length === 0) action = read.exists ? 'append' : 'create';
  else if (ours.length === 1 && sameHook(ours[0].hook, desired)) action = 'unchanged';
  else if (!force && !ours.every((item) => sameCommandArgs(item.hook, desired))) action = 'conflict';
  else action = 'update';

  if (action === 'conflict') {
    return {
      ok: false,
      host,
      path,
      action,
      reason: 'conflict',
      exists: read.exists,
      current: ours[0]?.hook ?? null,
      desired,
      would_write: false,
      hint: '已有指向别处的 tabellio 钩子；确认替换请加 --force',
    };
  }
  if (action === 'unchanged') {
    return {
      ok: true,
      host,
      path,
      action,
      exists: read.exists,
      current: ours[0]?.hook ?? null,
      desired,
      would_write: false,
    };
  }

  const next = withSessionEnd(data, [...remaining, { hooks: [desired] }]);
  const plan = {
    ok: true,
    host,
    path,
    action,
    exists: read.exists,
    desired,
    would_write: true,
    backup: read.exists ? path + '.tabellio-backup-' + stampOf(now) : null,
    ...(ours.length > 0 ? { current: ours[0].hook } : {}),
  };
  // 整个 settings 可能含 env 凭据：preview 只给 apply 用，不参与 JSON 序列化。
  Object.defineProperty(plan, 'preview', {
    value: JSON.stringify(next, null, 2) + '\n',
    enumerable: false,
    configurable: true,
  });
  return plan;
}

/** 应用计划；坏配置/冲突的计划不会写半份。 */
export function applyHookInstall(plan) {
  if (!plan?.ok) {
    return { ok: false, reason: plan?.reason ?? 'invalid_plan', written: false, path: plan?.path ?? null };
  }
  if (!plan.would_write) {
    return { ok: true, written: false, path: plan.path, action: plan.action };
  }
  if (typeof plan.preview !== 'string' || plan.preview === '') {
    return { ok: false, reason: 'missing_preview', written: false, path: plan.path };
  }
  const tmp = plan.path + '.tabellio-tmp-' + process.pid;
  try {
    if (plan.backup) copyFileSync(plan.path, plan.backup);
    mkdirSync(dirname(plan.path), { recursive: true });
    const mode = existsSync(plan.path) ? statSync(plan.path).mode & 0o777 : 0o600;
    writeFileSync(tmp, plan.preview, { encoding: 'utf8', mode });
    chmodSync(tmp, mode);
    renameSync(tmp, plan.path);
    return { ok: true, written: true, path: plan.path, action: plan.action, backup: plan.backup ?? null };
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* 清理失败不影响结论 */ }
    return { ok: false, reason: 'write_failed', written: false, path: plan.path, error: String(e?.message ?? e) };
  }
}

const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|密码|口令|密钥)\s*(?:是|为|[:=：])\s*[^\s，。；;]{4,}/i,
]);

const CUE_RULES = Object.freeze([
  { id: 'explicit', re: /记住|帮我记|记一下|记下来|请记下|别忘了|要记得/ },
  { id: 'future', re: /(?:以后|今后|从今以后|下次)[^。！？!?；;\n]{0,12}(?:都|要|别|不要|用|按|先|再|请|一律|必须|只)/ },
  { id: 'preference', re: /(?:我|我们)[^。！？!?；;\n]{0,6}(?:喜欢|偏好|习惯|倾向于|不喜欢|讨厌|不想|一般|通常|平时|一直)/ },
  { id: 'decision', re: /(?:我|我们)[^。！？!?；;\n]{0,8}(?:决定|确定|约定|说好|统一)/ },
  { id: 'default', re: /(?:始终|总是|一律|默认|统一)[^。！？!?；;\n]{0,6}(?:用|使用|按|走|不要|别|只|改成|换成)/ },
  { id: 'switch', re: /改用|改成|换成|别再|不要再|别用|不要用|只能/ },
  { id: 'english', re: /\b(?:remember|from now on|going forward|i prefer|we decided|we agreed|please always|please never|don't ever|always use|never use|i usually|i typically)\b/i },
]);

function cleanInjected(text) {
  return String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, ' ')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, ' ')
    .replace(/<bash-input>[\s\S]*?<\/bash-input>/gi, ' ')
    .replace(/<bash-stdout>[\s\S]*?<\/bash-stdout>/gi, ' ');
}

/**
 * 从 Claude Code 的 JSONL transcript 里只取**用户真的说过的话**。
 * 跳过 sidechain、meta、compact summary，以及 tool_result / queue 这类宿主内部行。
 */
export function parseTranscript(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(rec) || rec.type !== 'user') continue;
    if (rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true) continue;
    const msg = rec.message;
    if (!isPlainObject(msg) || msg.role !== 'user') continue;
    const parts = [];
    if (typeof msg.content === 'string') parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
    const content = cleanInjected(parts.join('\n')).trim();
    if (!content) continue;
    if (/^<(?:command-|local-command|bash-|system-reminder)/.test(content)) continue;
    const sessionId =
      typeof rec.sessionId === 'string' ? rec.sessionId : typeof rec.session_id === 'string' ? rec.session_id : null;
    out.push({ text: content, session_id: sessionId });
  }
  return out;
}

function normalizeSentence(text) {
  return String(text)
    .replace(/^\s*(?:[-*•>]|\d+[.)])\s*/, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  const withoutFences = String(text).replace(/```[\s\S]*?```/g, ' ');
  const withoutInlineCode = withoutFences.replace(/`([^`\n]{1,160})`/g, '$1');
  const out = [];
  for (const chunk of withoutInlineCode.replace(/\r/g, '').split(/(?<=[。！？!?；;])|\n+/u)) {
    for (const piece of chunk.split(/(?<=[.!?])\s+/u)) {
      const sentence = normalizeSentence(piece);
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

function containsSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function looksLikeQuestion(text) {
  return /[?？]\s*$/.test(text) || /(?:吗|嘛|么)\s*[。！!]?$/.test(text);
}

function looksLikeHypothetical(text) {
  return /(?:要不要|是否|该不该|能不能|可不可以|会不会|有没有)/.test(text);
}

function matchCue(text) {
  for (const rule of CUE_RULES) if (rule.re.test(text)) return rule.id;
  return null;
}

function truncateChars(text, max) {
  const chars = Array.from(String(text));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('') + '…';
}

function normalizeKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]{}<>]/g, '');
}

/** 候选正文必须自带标题：note.js 的 firstHeading 决定 inbox 里显示什么。 */
export function buildCandidateBody(sentence) {
  const clean = truncateChars(normalizeSentence(sentence), MAX_CANDIDATE_SENTENCE_CHARS);
  const title = CANDIDATE_TITLE_PREFIX + truncateChars(clean, TITLE_BODY_CHARS);
  return { title, body: '# ' + title + '\n\n' + clean };
}

/**
 * 从 transcript JSONL（或已解析的 [{text, session_id}]）提取候选。
 *
 * 只抓显式线索；返回的 candidates 是纯数据，落盘由调用方决定。
 */
export function extractMemoryCandidates(input, { max = MAX_CANDIDATES_PER_SESSION } = {}) {
  const messages = Array.isArray(input) ? input : parseTranscript(input);
  const limit = Math.max(1, Math.min(10, Number(max) || MAX_CANDIDATES_PER_SESSION));
  const stats = {
    messages: messages.length,
    sentences: 0,
    captured: 0,
    no_cue: 0,
    too_short: 0,
    question: 0,
    secret: 0,
    duplicate: 0,
    truncated: 0,
  };
  const candidates = [];
  const seen = new Set();

  for (const message of messages) {
    const text = typeof message === 'string' ? message : message?.text;
    if (typeof text !== 'string') continue;
    const sessionId = isPlainObject(message) && typeof message.session_id === 'string' ? message.session_id : null;
    for (const rawSentence of splitSentences(text)) {
      stats.sentences += 1;
      const sentence = truncateChars(rawSentence, MAX_CANDIDATE_SENTENCE_CHARS);
      if (looksLikeQuestion(sentence) || looksLikeHypothetical(sentence)) {
        stats.question += 1;
        continue;
      }
      if (containsSecret(sentence)) {
        stats.secret += 1;
        continue;
      }
      if (Array.from(sentence).length < MIN_SENTENCE_CHARS) {
        stats.too_short += 1;
        continue;
      }
      const cue = matchCue(sentence);
      if (!cue) {
        stats.no_cue += 1;
        continue;
      }
      const key = normalizeKey(sentence);
      if (!key || seen.has(key)) {
        stats.duplicate += 1;
        continue;
      }
      if (candidates.length >= limit) {
        stats.truncated += 1;
        continue;
      }
      seen.add(key);
      const { title, body } = buildCandidateBody(sentence);
      stats.captured += 1;
      candidates.push({ text: sentence, title, body, cue, session_id: sessionId });
    }
  }
  return { candidates, stats, truncated: stats.truncated > 0 };
}
