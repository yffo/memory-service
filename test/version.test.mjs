import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';
import { SERVER_VERSION, initializeResult } from '../src/mcp/protocol.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('版本只有一个真相源：CLI、MCP 与 package.json 一致', () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(SERVER_VERSION, pkg.version);
  assert.equal(initializeResult({ requested: '2026-07-28' }).serverInfo.version, pkg.version);
});

test('装出来的 CLI --version 报 package.json 的版本', () => {
  const bin = fileURLToPath(new URL('../bin/memory', import.meta.url));
  const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});
