import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES,
  CONTRACT_NAME,
  CONTRACT_VERSION,
  contractView,
} from '../src/conformance.js';
import { READ_TOOLS, SUPPORTED_PROTOCOL_VERSIONS, WRITE_TOOLS } from '../src/mcp/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'conformance.mjs');

test('contract declares a name and a semver-ish version', () => {
  const view = contractView();
  assert.equal(view.name, CONTRACT_NAME);
  assert.equal(view.version, CONTRACT_VERSION);
  assert.match(view.version, /^\d+\.\d+$/);
  assert.equal(view.capabilities, CAPABILITIES);
});

test('contract capability counts match the real MCP surface', () => {
  const mcp = CAPABILITIES.mcp;
  assert.equal(mcp.readTools, READ_TOOLS.length);
  assert.equal(mcp.writeTools, WRITE_TOOLS.length);
  assert.deepEqual(mcp.protocolVersions, SUPPORTED_PROTOCOL_VERSIONS);
});

test('contract stays additive: core capabilities are present', () => {
  for (const key of ['recall', 'search', 'read', 'receipts', 'writeGate', 'candidates', 'feedback', 'decay', 'asOf']) {
    assert.equal(CAPABILITIES[key], true, key);
  }
  assert.equal(CAPABILITIES.semantic, 'host-provided-embedding');
  assert.deepEqual(CAPABILITIES.lifecycle, ['active', 'draft', 'archived', 'superseded']);
});

test('the tool prints the contract and exits 0', () => {
  const run = spawnSync(process.execPath, [TOOL, '--contract'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(contractView())));
});

test('the tool rejects unknown arguments with exit 2', () => {
  const run = spawnSync(process.execPath, [TOOL, '--bogus'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown argument/);
});
