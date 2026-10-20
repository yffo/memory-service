/**
 * 凭据值检测：只拦「把真实凭据写进记忆」，不拦「凭据该怎么管理」。
 *
 * 两类信号：
 *   1. 已知令牌形状（sk-、ghp_、AKIA、AIza、私钥块、Bearer）；
 *   2. 「密码/密钥/token … 是/改成/放到 <值>」这类赋值形态，且值看起来像真值
 *      （≥6 个字符、同时含字母与数字，且不在占位/策略名词表里）。
 *
 * 策略句（「密钥由 KMS 管理」「统一放 1Password」）必须放行——它们本身就是值得记的规则。
 */

const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/,
];

const ASSIGNMENT =
  /(?:密码|口令|密钥|私钥|token|api[ _-]?key|secret|password|passwd|凭据|凭证)[^。！？\n]{0,24}?(?:是|为|用|放|存|放到|设成|改成|换成|改为|=|:|：)\s*([^\s，。；,;、]{6,})/i;

const PLACEHOLDER_VALUES = new Set([
  '1password',
  'vault',
  'keychain',
  'kms',
  '环境变量',
  '变量',
  '密钥库',
  '保险箱',
  '配置中心',
  '密钥管理',
  '凭据服务',
  '密码管理器',
  '占位',
  'xxxxxx',
]);

export function looksLikeCredential(text) {
  const value = String(text ?? '');
  if (!value.trim()) return false;
  if (TOKEN_SHAPES.some((pattern) => pattern.test(value))) return true;
  const match = value.match(ASSIGNMENT);
  if (!match) return false;
  const candidate = match[1].replace(/[。)）\]】]+$/, '');
  const lowered = candidate.toLowerCase();
  if (PLACEHOLDER_VALUES.has(lowered)) return false;
  if (/^(环境变量|变量|配置|参数|文件|目录)/.test(candidate)) return false;
  // 「统一放 1Password」这类策略句：值里没有数字，通常也不是真凭据。
  const hasLetter = /[A-Za-z]/.test(candidate);
  const hasDigit = /\d/.test(candidate);
  return hasLetter && hasDigit && candidate.length >= 6;
}
