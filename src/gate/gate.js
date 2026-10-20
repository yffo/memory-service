/**
 * 写入闸门（`06-architecture.md §9.2` 的 `remember` 判定）。
 *
 * 闸门是**纯函数**：给定（候选笔记、库的现状、限制）→ 判定。
 * 它不写文件、不读文件、不读时钟。这样它才能被穷举式单测，而
 * 「写入路径上唯一不可测的分支」正是旧项目 200 行索引膨胀的温床。
 *
 * 判定的三种结果（对应 `§9.2` 的返回形状）：
 *
 * | verdict | status | 含义 | 调用方该做什么 |
 * |---|---|---|---|
 * | `allow` | `stored` | 通过 | 落盘 |
 * | `skip`  | `skipped` | 没价值/太短/闲聊 | **不要重试**，这是正常返回 |
 * | `deny`  | `denied` / `duplicate` | 越界或不满足硬约束 | 修内容或换 id，别硬撞 |
 *
 * 为什么 `skip` 与 `deny` 分开：`§9.2` 的 "skipped 与 denied 都是正常返回" 是说
 * 它们都不是异常；但语义不同——`skipped` 是「这条不该记」，`deny` 是「这条不许记」。
 * 合成一个会让调用方没法区分「我该改内容」和「我该换个地方记」。
 *
 * **「缩小的重写永远放行」**（旧项目用血换来的规则，`00-brief.md §6` 原则）：
 * 更新一篇既有笔记时，只要新正文**不超过旧正文的长度上界**，任何拒绝理由都不成立。
 * 这条是索引/文档能在超限后自救的唯一通道；挡掉它，超限就只剩「删」一条路。
 */
import { createHash } from 'node:crypto';
import { MAX_NOTE_CHARS, MAX_NOTE_TOKENS, KINDS, TRUSTS } from '../store/note.js';
import { estimateTokens } from '../core/tokenize.js';
import { looksLikeCredential } from '../core/secrets.js';
// 存储侧归一化直接取自 `util/`（最底层）：core 里那个归一化是**检索侧**的
// （不去 BOM/CRLF），拿它来判断「这句话是不是闲聊」会在首字符是 BOM 时不匹配。
import { normalizeText } from '../util/text.js';

/** 硬约束（可被配置覆盖，但默认值就是架构文档写的那两个数）。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxChars: MAX_NOTE_CHARS,
  maxTokens: MAX_NOTE_TOKENS,
  minChars: 8,
  /** 重写既有笔记时允许的增长比例：1.0 = 只许缩小或持平。 */
  growthRatio: 1.0,
});

/** 闲聊/无持久价值的模式（确定性，不调模型）。命中 → skip。 */
const CHITCHAT = [
  /^(ok|okay|好的|好|嗯|收到|谢谢|谢|thanks|thank you|thx|got it|明白了?|收到!?)[!。.~～\s]*$/i,
  /^(hi|hello|嗨|在吗|早上好|晚上好|晚安|再见|bye)[!。.~～\s]*$/i,
  /^(哈哈+|嘿嘿+|haha+|lol|😂+|🫡+)$/,
];
/** 欠定义的内容：只有占位符，没有可执行的信息。 */
const INDEFINITE = [/^(tbd|todo|待定|以后再说|n\/a|todo!?)[\s.!]*$/i];

function digest(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * 内容指纹：**同一条事实**不管怎么写都该撞在一起，所以正文先归一化
 * （去空白差异、去大小写差异、去标点）。
 *
 * 为什么不用整篇 hash：markdown 的空白/标点改动（人手编辑最常见的行为）
 * 会让整篇 hash 完全不同，去重就形同虚设。
 */
export function contentFingerprint({ scope = 'user', kind = 'semantic', body = '', subject = null, predicate = null } = {}) {
  const norm = String(body ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'`（）()\[\]【】—\-–]/g, '');
  const key = subject && predicate ? `${subject}|${predicate}|${norm}` : norm;
  return digest(`${scope}\u0000${kind}\u0000${key}`);
}

/**
 * 闸门主判定。
 *
 * @param {object} input
 * @param {object} input.candidate   `{id, scope, kind, trust, status, body, subject, predicate,
 *                                      supersedes, provenance, confidence, valid_from}`（已归一化）
 * @param {Array}  [input.existing]  `[{id, note, body}]` 当前库内容（`scanStore().notes`）
 * @param {object} [input.limits]
 * @param {object} [input.options]   `{force:boolean}`
 * @returns {{verdict:'allow'|'skip'|'deny', status:string, reason:string, details:object,
 *            mode:'create'|'update', shrinkEscape:boolean}}
 */
/**
 * `existing` 里的每一项**允许两种形状**：扫描结果（`{id, body, note:{scope,kind,...}}`，
 * 即 `store.scanStore()` 的产物）或裸的 note 对象（frontmatter 字段在顶层）。
 *
 * 为什么容错：闸门是库内部和库外部都会调用的判定函数，调用方手上有什么就传什么
 * 最省事；强制调用方先包一层 `{note:{...}}` 只会在某一次调用里被忘掉，
 * 而忘掉的后果是 `Cannot read properties of undefined` —— 一次崩溃，
 * 不是一次「判错了」。
 */
function noteOf(entry) {
  const note = entry?.note && typeof entry.note === 'object' ? entry.note : entry ?? {};
  return {
    id: entry?.id ?? note.id ?? null,
    body: String(entry?.body ?? note.body ?? ''),
    note,
  };
}

function fingerprintOf(entry) {
  const { note, body } = noteOf(entry);
  return contentFingerprint({
    scope: note.scope,
    kind: note.kind,
    body,
    subject: note.subject,
    predicate: note.predicate,
  });
}

export function evaluateWrite({ candidate, existing = [], limits = {}, options = {} } = {}) {
  const cap = { ...DEFAULT_LIMITS, ...limits };
  const details = {};
  const body = String(candidate?.body ?? '');
  const chars = [...body].length;
  const tokens = estimateTokens(body);

  const existingById = existing.find((e) => String(e?.id) === String(candidate.id)) ?? null;
  const mode = existingById ? 'update' : 'create';
  const prevChars = existingById ? [...noteOf(existingById).body].length : null;

  // ── 0) 「缩小的重写永远放行」：先算这个逃生门，后面所有长度类拒绝都要让路。
  const shrinkEscape = mode === 'update' && prevChars !== null && chars <= prevChars;
  details.previousChars = prevChars;
  details.chars = chars;
  details.tokens = tokens;
  details.mode = mode;
  details.shrinkEscape = shrinkEscape;

  const allow = (reason, status = 'stored', extra = {}) => ({
    verdict: 'allow',
    status,
    reason,
    details: { ...details, ...extra },
    mode,
    shrinkEscape,
  });
  const skip = (reason, extra = {}) => ({
    verdict: 'skip',
    status: 'skipped',
    reason,
    details: { ...details, ...extra },
    mode,
    shrinkEscape,
  });
  const deny = (reason, extra = {}) => ({
    verdict: 'deny',
    status: reason === 'duplicate' ? 'duplicate' : 'denied',
    reason,
    details: { ...details, ...extra },
    mode,
    shrinkEscape,
  });

  // ── 1) 越界：作用域 / 类型 / 信任等级的形状必须合法（形状不合法一律拒，谈不到缩小）
  if (candidate.kind && !KINDS.includes(candidate.kind)) {
    return deny('kind_invalid', { kinds: KINDS });
  }
  if (candidate.trust && !TRUSTS.includes(candidate.trust)) {
    return deny('trust_invalid', { trusts: TRUSTS });
  }
  if (candidate.scope && !['user', 'project'].includes(candidate.scope)) {
    return deny('scope_forbidden', { scope: candidate.scope });
  }

  // ── 2) 信任分级（`§9.2` 的 trust_violation）：外部内容不许冒充用户陈述。
  //     这是最重要的一条闸门：`external` 内容进了 core/episodic 就等于让
  //     不可信来源伪装成「用户说过」或「发生过的事」，之后的检索会把它当事实用。
  if (candidate.trust === 'external' && (candidate.kind === 'core' || candidate.kind === 'episodic')) {
    return deny('trust_violation', {
      why: `external 内容不能写进 ${candidate.kind}（会伪装成用户陈述或亲身经历）`,
      allowed_kinds: ['semantic', 'procedural'],
    });
  }
  // ── 2.5) 凭据值：不许把真实密码/令牌写进真相源（策略句放行，见 core/secrets.js）。
  if (looksLikeCredential(body)) {
    return deny('credential_detected', {
      why: '内容是凭据值；请改成「凭据存在哪里」这类策略句，不要记录真实值',
    });
  }

  if (candidate.trust === 'external' && looksLikeInstruction(body)) {
    return deny('would_promote_external_to_instruction', {
      why: 'external 内容里含命令式语句，写入后会被当成对 agent 的指令',
    });
  }
  if (candidate.kind === 'core' && candidate.trust !== 'user_stated') {
    return deny('trust_violation', {
      why: `core（身份/硬偏好）只能来自用户亲口陈述，当前 trust=${candidate.trust}`,
      required_trust: 'user_stated',
    });
  }

  // ── 3) 作用域隔离：project 作用域的写入不许改动 user 作用域的既有 id
  const existingNote = mode === 'update' ? noteOf(existingById).note : null;
  if (mode === 'update' && existingNote.scope !== candidate.scope) {
    return deny('scope_forbidden', {
      why: `id ${candidate.id} 属于 ${existingNote.scope ?? '未知'} 作用域，不能从 ${candidate.scope} 改写`,
    });
  }

  // ── 4) 幂等：同一条事实重复写入 → duplicate（不是错误，是正常返回）
  const fingerprint = contentFingerprint(candidate);
  details.fingerprint = fingerprint;
  const dup = existing.find((e) => {
    if (String(e?.id) === String(candidate.id)) return false; // 同一个 id 走「更新」路径
    return fingerprintOf(e) === fingerprint;
  });
  if (dup && !options.force) {
    return deny('duplicate', { existing_id: String(dup.id) });
  }

  // ── 5) 破坏性改动：既有 id 被换成了**不同的一条事实**，而且没有声明 supersedes
  if (mode === 'update' && !shrinkEscape) {
    const prevFp = fingerprintOf(existingById);
    if (prevFp !== fingerprint && !options.force) {
      const declared =
        (candidate.supersedes ?? []).includes(candidate.id) ||
        existingNote.superseded_by === candidate.id;
      if (!declared && chars > prevChars * cap.growthRatio) {
        return deny('destructive_rewrite', {
          why: '既有 note 的正文被整体换成另一条事实且变长了；要么声明 supersedes，要么把旧 id 归档',
          previous_fingerprint: prevFp,
          new_fingerprint: fingerprint,
          previousChars: prevChars,
          chars,
        });
      }
    }
  }

  // ── 6) 长度上界（核心档 ≤ 400 字 / ≤ 200 token）：超了就拒，并给出该怎么切
  if (!shrinkEscape) {
    if (chars > cap.maxChars) {
      return deny('too_long', {
        limit: cap.maxChars,
        chars,
        suggestion: `按「一条事实一个文件」切成 ${Math.ceil(chars / cap.maxChars)} 条，或把细节写进正文之外的引用`,
      });
    }
    if (tokens > cap.maxTokens) {
      return deny('too_many_tokens', { limit: cap.maxTokens, tokens });
    }
  }

  // ── 7) 价值闸门：太短/闲聊/占位符 → skip（不落盘，但不是错误）
  //
  // 顺序：**先认闲聊，再看长度**。`好的` 只有 2 个字，如果先判长度就会报 `too_short`，
  // 于是「用户在打招呼」和「用户说了什么但太短没记」在统计里分不开 ——
  // 而这两个数字的用途完全不同（前者说明抓取时机不对，后者说明取值标准太严）。
  // 判据是可识别的就先认，比「谁先谁后无所谓」多花一次正则，换一个准确的 reason。
  // 判据必须跑在**归一化之后**的文本上：中文输入法打出来的是全角「明白了！」
  // 而中文句号是「。」，正则里逐字写 `!` n 种变体迟早漏一种
  // （漏掉的直接后果：闲聊被算成 too_short，统计里这一类的意义就没了）。
  // `normalizeText()` 是全项目唯一的归一入口（去 BOM/CRLF、全角转半角、NFKC），
  // 这里复用它 —— 闸门读到的形态必须和索引读到的形态一致。
  const judged = normalizeText(body).trim();
  if (CHITCHAT.some((re) => re.test(judged))) return skip('chitchat');
  if (INDEFINITE.some((re) => re.test(judged))) return skip('no_durable_content');
  if (chars < cap.minChars) return skip('too_short', { minChars: cap.minChars, chars });

  return allow(shrinkEscape ? 'shrink_rewrite_allowed' : 'ok', 'stored', { fingerprint });
}

/**
 * 含命令式语句的启发式检查（**只用于 external 内容**）。
 *
 * 判据刻意保守：只有明确的祈使句/规则句才算。宁可漏放几条，
 * 也不要把「文档里写了要先做 A 再做 B」这种正常陈述判成注入。
 */
export function looksLikeInstruction(text) {
  const s = String(text);
  const patterns = [
    /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\b/i,
    /^(请|务必|必须)?(不要|别|禁止)\s*(告诉|通知|提醒)/m,
    /\byou\s+must\s+(always|never)\b/i,
    /^\s*(always|never)\s+[a-z]/im,
    /\b(system|assistant|developer)\s*:\s*/i,
    // `{0,6}?` 是惰性量词，不是把分组变成可选的 `?` —— 写成 `{0,4}(…)` 时
    // 「忽略之前的所有规则」有 5 个字夹在中间，整条正则匹配不上（实测漏判）。
    /忽略[^\n。；;]{0,6}?(指令|指示|规则|要求|提示)/,
    // 中间允许 0~2 个字：「你必须**永远**先执行」「务必**马上**调用」这类
    // 插入副词的说法才是注入最常见的形状，早先只认紧挨着的三个词，
    // 于是一句「外部博客说：你必须永远先执行 X」被放行了（实测漏判）。
    /(必须|务必)[^\n。；;]{0,2}(先|立即|马上|立刻)?[^\n。；;]{0,2}(执行|运行|调用|遵守|照做|跑|走|装|删|加|改|写|发|用)/,
    // 「不要/别 告诉用户」——隐藏指令的经典形状
    /(不要|别|禁止)[^\n。；;]{0,4}(告诉|通知|提醒|告知)[^\n。；;]{0,4}(用户|human|user)/,
  ];
  return patterns.some((re) => re.test(s));
}

/**
 * 索引闸门（旧项目 `index-guard.js` 的规则，`00-brief.md §10` 引用其结论）：
 * 索引有行数/字节上限；**缩小的重写永远放行**。
 *
 * 注意这里的「缩小」是**两维**的：行数与字节数任一缩小都算缩小
 * （压缩一行里的长内容也是有价值的压缩）。
 * 超限时给的是 deny + 一条可执行的建议，不是一句「超限了」。
 */
export function evaluateIndexWrite({ current, next, caps }) {
  const before = { lines: current?.lines ?? 0, bytes: current?.bytes ?? 0, exists: Boolean(current?.exists) };
  const after = { lines: next.lines ?? 0, bytes: next.bytes ?? 0 };
  const details = { before, after, caps };
  const shrinking = after.lines <= before.lines || after.bytes <= before.bytes;
  const withinCaps = after.lines <= caps.maxLines && after.bytes <= caps.maxBytes;
  if (withinCaps) return { verdict: 'allow', reason: 'within_caps', details };
  if (shrinking) return { verdict: 'allow', reason: 'shrink_rewrite_allowed', details };
  return {
    verdict: 'deny',
    reason: 'index_over_caps',
    details: {
      ...details,
      suggestion: `索引超限（${after.lines} 行 / ${after.bytes}B）；重写必须至少在一个维度上缩小：合并同类指针、把细节移进笔记正文`,
    },
  };
}
