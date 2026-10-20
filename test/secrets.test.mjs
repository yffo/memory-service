import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCredential } from '../src/core/secrets.js';

test('known token shapes are rejected', () => {
  assert.equal(looksLikeCredential('临时 key：sk-abc123DEF456ghi789'), true);
  assert.equal(looksLikeCredential('用 ghp_abcdefghijklmnopqrstuvwxyz0123456789 拉库'), true);
  assert.equal(looksLikeCredential('AKIAIOSFODNN7EXAMPLE'), true);
  assert.equal(looksLikeCredential('Authorization: Bearer abcdefghijklmnop'), true);
  assert.equal(looksLikeCredential('-----BEGIN RSA PRIVATE KEY-----'), true);
});

test('assignment with a real-looking value is rejected', () => {
  assert.equal(looksLikeCredential('数据库密码是 Abc123xyz'), true);
  assert.equal(looksLikeCredential('测试库 token 改成 X7kP9mQ2'), true);
  assert.equal(looksLikeCredential('管理员口令设为 Passw0rd!'), true);
});

test('credential policy sentences are allowed', () => {
  assert.equal(looksLikeCredential('密钥由 KMS 管理，本机不落明文'), false);
  assert.equal(looksLikeCredential('密码统一放 1Password'), false);
  assert.equal(looksLikeCredential('token 放环境变量 TABELLIO_TOKEN'), false);
  assert.equal(looksLikeCredential('凭据交给密钥库保管'), false);
  assert.equal(looksLikeCredential('每周轮换一次数据库口令'), false);
});

test('ordinary notes are unaffected', () => {
  assert.equal(looksLikeCredential('发版前跑 npm test，然后打 tag'), false);
  assert.equal(looksLikeCredential(''), false);
  assert.equal(looksLikeCredential(null), false);
});
