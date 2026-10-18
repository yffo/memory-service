/**
 * `tabellio doctor`：只读体检。
 *
 * 它不修任何东西，只回答三个问题：
 *  1. 库本身健不健康（解析失败、索引陈旧、超长、待处理候选/提案）；
 *  2. 宿主 MCP 配置在不在、是不是指向当前库；
 *  3. Claude 钩子与 macOS 定时任务装没装、加载没加载。
 *
 * 所有探测都必须只读：不 ensure、不重建索引、不写配置、不写提案。
 * `--verify` 例外，但它只跑宿主自己的 CLI，且用配置临时副本（见 hostverify.js）。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

import { status } from './api.js';
import { planHookInstall, claudeSettingsPath } from './hooks.js';
import { planSetup } from './setup.js';
import { scheduleStatus } from './schedule.js';
import { verifyHosts } from './hostverify.js';

function errorText(e) {
  return String(e?.message ?? e);
}

function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

function localChecks(host) {
  const desired = host.desired;
  if (!desired || typeof desired.command !== 'string' || !Array.isArray(desired.args)) return null;
  const check = (p) => (typeof p === 'string' && isAbsolute(p) ? existsSync(p) : null);
  return {
    command: desired.command,
    command_exists: check(desired.command),
    mcp_bin: desired.args[0] ?? null,
    mcp_bin_exists: check(desired.args[0]),
  };
}

function hostAction(host) {
  // 冲突/坏配置先说，避免被「入口不存在」盖掉真正要先处理的事。
  if (host.action === 'conflict') {
    return {
      id: 'host:' + host.host,
      severity: 'error',
      title: host.label + ' 的 tabellio 配置指向别处',
      detail: '已有不同的 command/args（可能是旧路径或别的库）。确认替换再写。',
      command: 'tabellio setup --host ' + host.host + ' --write --force',
    };
  }
  if (host.action === 'invalid') {
    return {
      id: 'host:' + host.host,
      severity: 'error',
      title: host.label + ' 的配置文件读不了',
      detail: host.error?.message ?? 'JSON/TOML 解析失败；先手工修好，setup 不会写半份。',
      command: null,
    };
  }

  const checks = host.checks;
  if (checks?.command_exists === false) {
    return {
      id: 'host:' + host.host + ':command',
      severity: 'error',
      title: host.label + ' 配置里的 Node 不存在',
      detail: '指向 ' + checks.command + '；常见于 nvm 升级或换机器后。重写配置即可。',
      command: 'tabellio setup --host ' + host.host + ' --write',
    };
  }
  if (checks?.mcp_bin_exists === false) {
    return {
      id: 'host:' + host.host + ':mcp-bin',
      severity: 'error',
      title: host.label + ' 配置里的 MCP 入口不存在',
      detail: '指向 ' + checks.mcp_bin + '；宿主会启动失败。重写配置即可。',
      command: 'tabellio setup --host ' + host.host + ' --write',
    };
  }

  switch (host.action) {
    case 'create':
    case 'append':
      return {
        id: 'host:' + host.host,
        severity: 'info',
        title: host.label + ' 还没配置 tabellio',
        detail: '配置后宿主才能通过 MCP 读写记忆。',
        command: 'tabellio setup --host ' + host.host + ' --write',
      };
    case 'update':
      return {
        id: 'host:' + host.host,
        severity: 'info',
        title: host.label + ' 的配置需要更新',
        detail: '当前 command/args 与本次 doctor 使用的路径或库不一致。',
        command: 'tabellio setup --host ' + host.host + ' --write',
      };
    default:
      return null;
  }
}

function buildActions({ storeExists, health, setup, hostItems, hook, schedule }) {
  const actions = [];

  if (!storeExists && health.notes === 0 && health.candidates === 0 && health.proposals === 0) {
    actions.push({
      id: 'store:empty',
      severity: 'info',
      title: '库还没有内容',
      detail: '第一次 remember / capture 会自动建库；也可以先跑 tabellio capture 收一条候选。',
      command: null,
    });
  }

  if (health.parseFailures > 0) {
    const sample = (health.failures ?? []).slice(0, 3).map((f) => f.path);
    actions.push({
      id: 'store:parse-failures',
      severity: 'error',
      title: health.parseFailures + ' 个笔记文件解析失败，已退出检索面',
      detail: 'fail-closed 是故意的；修好 frontmatter 或把坏文件移出 notes/ 后重试。' + (sample.length ? ' 先看：' + sample.join('、') : ''),
      command: 'tabellio status --json',
    });
  }

  if (health.notes > 0 && !health.indexExists) {
    actions.push({
      id: 'index:missing',
      severity: 'warn',
      title: '索引还没生成',
      detail: '检索不依赖索引，但「读索引」这条路径会看不到任何笔记。',
      command: 'tabellio status --rebuild-index',
    });
  } else if (health.indexStale) {
    actions.push({
      id: 'index:stale',
      severity: 'warn',
      title: '索引是旧的',
      detail: '路由层记的条数与 notes/ 对不上。',
      command: 'tabellio status --rebuild-index',
    });
  }

  if (health.oversizeChars > 0 || health.oversizeTokens > 0) {
    actions.push({
      id: 'store:oversize',
      severity: 'warn',
      title: health.oversizeChars + ' 条超长、' + health.oversizeTokens + ' 条超 token 上限',
      detail: '超长内容会被截断参与检索；建议拆成多条。',
      command: 'tabellio status --json',
    });
  }

  if (health.candidates > 0 || health.proposals > 0) {
    const parts = [];
    if (health.candidates > 0) parts.push(health.candidates + ' 条候选');
    if (health.proposals > 0) parts.push(health.proposals + ' 条自动巩固提案');
    actions.push({
      id: 'inbox:pending',
      severity: 'warn',
      title: '有待批准的内容：' + parts.join('、'),
      detail: '批准前不会进正式库；拒绝也走同一个入口。',
      command: 'tabellio inbox',
    });
  }

  for (const item of hostItems) {
    const action = hostAction(item);
    if (action) actions.push(action);
  }

  if (hostItems.length === 0) {
    actions.push({
      id: 'host:none',
      severity: 'info',
      title: '没有检测到已安装的宿主',
      detail: '装好 Claude Code / Cursor / Codex 后再跑 setup；也可以 --host 显式指定。',
      command: 'tabellio setup --host claude --write',
    });
  }

  if (hook) {
    if (!hook.ok) {
      actions.push({
        id: 'hook:config',
        severity: 'error',
        title: 'Claude 钩子配置读不了',
        detail: hook.reason === 'conflict' ? '已有指向别处的 tabellio 钩子；确认替换加 --force。' : '检查 ~/.claude/settings.json 的 hooks 结构。',
        command: 'tabellio hook install --host claude --auto-consolidate --write --force',
      });
    } else if (!hook.session_end) {
      actions.push({
        id: 'hook:session-end',
        severity: 'info',
        title: 'Claude 会话结束时不会自动生成候选',
        detail: '装钩子后只写 notes/candidates/，不静默入库；批准仍走 inbox。',
        command: 'tabellio hook install --host claude --auto-consolidate --write',
      });
    } else if (!hook.auto_consolidate || !hook.session_start) {
      actions.push({
        id: 'hook:auto-consolidate',
        severity: 'info',
        title: 'Claude 钩子已装，但还没开启自动发现/待办提示',
        detail: '--auto-consolidate 会在会话结束顺带发现提案，并隐含安装 SessionStart 提示。',
        command: 'tabellio hook install --host claude --auto-consolidate --write',
      });
    }
  }

  if (schedule && schedule.supported) {
    if (!schedule.ok) {
      actions.push({
        id: 'schedule:unreadable',
        severity: 'error',
        title: '定时任务的 plist 读不了',
        detail: schedule.reason ?? '文件存在但无法解析/读取。',
        command: 'tabellio schedule status --json',
      });
    } else if (!schedule.installed) {
      actions.push({
        id: 'schedule:missing',
        severity: 'info',
        title: '没有定时自动发现',
        detail: 'macOS launchd 会定期跑 consolidate --auto --write，只产提案，不自动批准。',
        command: 'tabellio schedule install --write',
      });
    } else if (schedule.checked && !schedule.loaded) {
      actions.push({
        id: 'schedule:not-loaded',
        severity: 'warn',
        title: '定时任务已写盘，但 launchd 没加载',
        detail: '可能是 Node 路径变了，或上次 bootstrap 失败；重装一次会重新加载。',
        command: 'tabellio schedule install --write',
      });
    }
  }

  return actions;
}

/**
 * @param {object} input
 * @param {object} input.ctx openStore() 的上下文
 * @param {string} input.bin CLI 入口（写进钩子命令）
 * @param {string} input.mcpBin MCP server 入口（写进宿主配置）
 * @param {string} [input.home]
 * @param {string} [input.platform]
 * @param {boolean} [input.verify] 是否让宿主 CLI 自查连接
 */
export function buildDoctorReport({
  ctx,
  bin,
  mcpBin,
  home = homedir(),
  platform = process.platform,
  command = process.execPath,
  verify = false,
  env = process.env,
  run,
  now = Date.now(),
} = {}) {
  if (!ctx || typeof ctx.store !== 'string') throw new TypeError('doctor 需要 openStore() 上下文');

  const errors = [];
  const storeExists = ctx.exists();
  const healthAttempt = attempt(() => status(ctx));
  if (!healthAttempt.ok) errors.push({ scope: 'store', message: healthAttempt.error });
  const health = healthAttempt.ok ? healthAttempt.value : null;

  let setup = { ok: false, reason: 'not_checked', hosts: [], store: ctx.store, mcp_bin: mcpBin };
  if (mcpBin) {
    const setupAttempt = attempt(() => planSetup({ hosts: 'all', home, command, mcpBin, store: ctx.store, readOnly: false, now }));
    if (setupAttempt.ok) setup = setupAttempt.value;
    else errors.push({ scope: 'hosts', message: setupAttempt.error });
  }
  const hostItems = (setup.hosts ?? []).map((host) => ({
    host: host.host,
    label: host.label,
    path: host.path,
    kind: host.kind,
    action: host.action,
    ok: host.ok,
    error: host.error ?? null,
    checks: localChecks(host),
  }));

  // 只有配置已经指向当前 bin/store 时才验证：否则宿主 CLI 验的是旧配置，
  // 报「connected」会把「别的库连上了」误读成「当前配置没问题」。
  const verificationEligible = hostItems.length > 0 && hostItems.every((h) => h.action === 'unchanged');
  let verification = null;
  if (verify && verificationEligible) {
    const verifyAttempt = attempt(() => verifyHosts({ hosts: hostItems.map((h) => h.host), home, env, run }));
    if (verifyAttempt.ok) verification = verifyAttempt.value;
    else errors.push({ scope: 'verify', message: verifyAttempt.error });
  }

  const claudeDetected = hostItems.some((h) => h.host === 'claude') || existsSync(claudeSettingsPath(home));
  let hook = null;
  if (claudeDetected) {
    const hookAttempt = attempt(() => planHookInstall({
      host: 'claude',
      home,
      bin,
      store: ctx.store,
      command,
      events: ['session-end', 'session-start'],
      autoConsolidate: true,
      now,
    }));
    if (hookAttempt.ok) {
      const plan = hookAttempt.value;
      const events = Object.fromEntries((plan.events ?? []).map((e) => [e.event, e]));
      const end = events['session-end'] ?? null;
      const start = events['session-start'] ?? null;
      hook = {
        ok: plan.ok,
        action: plan.action ?? null,
        reason: plan.reason ?? null,
        path: plan.path ?? claudeSettingsPath(home),
        session_end: Boolean(end?.current),
        session_start: Boolean(start?.current),
        auto_consolidate: Boolean(end?.current?.args?.includes('--auto-consolidate')),
        matches_current: end?.action === 'unchanged' && start?.action === 'unchanged',
      };
    } else {
      hook = { ok: false, action: 'error', reason: 'unreadable', path: claudeSettingsPath(home), error: hookAttempt.error, session_end: false, session_start: false, auto_consolidate: false };
      errors.push({ scope: 'hooks', message: hookAttempt.error });
    }
  }

  const scheduleAttempt = attempt(() => scheduleStatus({ platform, home, env, run }));
  if (!scheduleAttempt.ok) errors.push({ scope: 'schedule', message: scheduleAttempt.error });
  const schedule = scheduleAttempt.ok ? {
    ok: scheduleAttempt.value.ok,
    supported: scheduleAttempt.value.supported,
    installed: scheduleAttempt.value.installed,
    loaded: scheduleAttempt.value.loaded,
    checked: scheduleAttempt.value.checked,
    interval_minutes: scheduleAttempt.value.interval_minutes ?? null,
    path: scheduleAttempt.value.path ?? null,
    reason: scheduleAttempt.value.reason ?? null,
  } : null;

  const healthView = health ? {
    notes: health.notes,
    core: health.coreNotes,
    index_exists: health.indexExists,
    index_stale: health.indexStale,
    index_listed: health.indexListed,
    index_hidden: health.indexHidden,
    index_lines: health.indexLines,
    index_bytes: health.indexBytes,
    parse_failures: health.parseFailures,
    failures: (health.failures ?? []).slice(0, 20),
    oversize_chars: health.oversizeChars,
    oversize_tokens: health.oversizeTokens,
    candidates: health.candidates,
    proposals: health.proposals,
    warnings: health.warnings,
  } : null;

  const actions = buildActions({
    storeExists,
    health: health ?? { notes: 0, parseFailures: 0, oversizeChars: 0, oversizeTokens: 0, candidates: 0, proposals: 0, indexExists: false, indexStale: false },
    setup,
    hostItems,
    hook,
    schedule,
  });

  return {
    ok: !errors.length && !actions.some((a) => a.severity === 'error'),
    store: {
      path: ctx.store,
      exists: storeExists,
      ...(healthView ?? {}),
    },
    hosts: {
      detected: hostItems.map((h) => h.host),
      items: hostItems,
      setup_ok: setup.ok,
      setup_reason: setup.reason ?? null,
      ...(verification ? { verification } : {}),
    },
    hook,
    schedule,
    actions,
    ...(errors.length ? { errors } : {}),
  };
}
