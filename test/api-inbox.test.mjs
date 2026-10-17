/**
 * 候选箱（capture → inbox）的 API 层用例。
 *
 * 这里守的是 P0 的产品承诺：**捕获不等于入库**。候选只写 notes/candidates/，
 * 不参与检索、不重建索引；只有用户显式 accept 才走 remember 的同一道闸门。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir, rm } from './helpers.mjs';
import {
  openStore,
  remember,
  addCandidate,
  listCandidates,
  reviewCandidates,
  status,
  search,
  read,
} from '../src/api.js';

function fresh(prefix) {
  const dir = tempDir(prefix);
  return { dir, ctx: openStore(dir) };
}

test('addCandidate：只写候选，主库/检索/索引都不动', () => {
  const { dir, ctx } = fresh('memory-inbox-add-');
  try {
    const added = addCandidate(ctx, { text: '# 项目代号\n\n内部代号是青鸟。', source: 'session:42' });
    assert.equal(added.ok, true, added.reason);
    assert.equal(added.written, true);
    assert.equal(added.title, '项目代号');
    assert.equal(added.source, 'session:42');
    assert.equal(added.path, join(dir, 'notes', 'candidates', added.id + '.md'));
    assert.equal(existsSync(added.path), true);
    assert.equal(existsSync(join(dir, 'notes', added.id + '.md')), false, '候选不能写进主库');
    assert.deepEqual(readdirSync(join(dir, 'index')).filter((f) => f.endsWith('.md')), [], '捕获不重建主索引');

    const st = status(ctx);
    assert.equal(st.notes, 0);
    assert.equal(st.candidates, 1);
    assert.ok(st.warnings.some((w) => w.includes('候选待处理')), st.warnings.join('\n'));

    const listed = listCandidates(ctx);
    assert.equal(listed.count, 1);
    assert.equal(listed.candidates[0].id, added.id);
    assert.equal(listed.candidates[0].title, '项目代号');
    assert.equal(listed.candidates[0].chars, added.chars, 'capture 与 inbox 的字数必须一致');

    const hit = search(ctx, '青鸟');
    assert.equal(hit.refused, true, '候选不参与检索');
    assert.deepEqual(hit.hits, []);
    assert.equal(read(ctx, added.id).ok, false, 'read 也不能穿透到候选');
  } finally {
    rm(dir);
  }
});

test('addCandidate：重复内容拒绝，force 才能再收一份', () => {
  const { dir, ctx } = fresh('memory-inbox-dup-');
  try {
    const first = addCandidate(ctx, { text: '内部代号是青鸟，代号只在周会里说。' });
    assert.equal(first.ok, true, first.reason);
    const again = addCandidate(ctx, { text: '内部代号是青鸟，代号只在周会里说。' });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'duplicate');
    assert.equal(again.duplicate_of.kind, 'candidate');
    assert.equal(again.duplicate_of.id, first.id);

    const forced = addCandidate(ctx, { text: '内部代号是青鸟，代号只在周会里说。' }, { force: true });
    assert.equal(forced.ok, true, forced.reason);
    assert.equal(listCandidates(ctx).count, 2);
  } finally {
    rm(dir);
  }
});

test('addCandidate：空文本/超长/id 冲突/坏 id 都拒绝且不落盘', () => {
  const { dir, ctx } = fresh('memory-inbox-invalid-');
  try {
    assert.deepEqual(addCandidate(ctx, { text: '   ' }), { ok: false, reason: 'empty', chars: 0 });
    const tooLong = addCandidate(ctx, { text: '青'.repeat(3000) });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.reason, 'too_large');
    assert.equal(tooLong.limit, 8 * 1024);

    const first = addCandidate(ctx, { text: '第一条候选：内部代号是青鸟。' });
    assert.equal(first.ok, true, first.reason);
    const sameId = addCandidate(ctx, { text: '第二条候选：项目代号是白鹭。' }, { id: first.id });
    assert.equal(sameId.ok, false);
    assert.equal(sameId.reason, 'id_exists');
    const badId = addCandidate(ctx, { text: '第三条候选：项目代号是白鹭。' }, { id: '../escape' });
    assert.equal(badId.ok, false);
    assert.equal(badId.reason, 'invalid_id');
    assert.equal(listCandidates(ctx).count, 1);
  } finally {
    rm(dir);
  }
});

test('addCandidate：dry-run 返回 would_write，不建目录不写文件', () => {
  const { dir, ctx } = fresh('memory-inbox-dry-');
  try {
    const dry = addCandidate(ctx, { text: '内部代号是青鸟。' }, { dry: true });
    assert.equal(dry.ok, true, dry.reason);
    assert.equal(dry.dry_run, true);
    assert.equal(dry.written, undefined);
    assert.ok(dry.would_write.endsWith('.md'));
    assert.equal(existsSync(join(dir, 'notes')), false, 'dry-run 不能 ensure 库目录');
    assert.equal(status(ctx).candidates, 0);
  } finally {
    rm(dir);
  }
});

test('reviewCandidates：accept 后进主库、可检索、候选归档到 decided', () => {
  const { dir, ctx } = fresh('memory-inbox-accept-');
  try {
    const added = addCandidate(ctx, { text: '# 项目代号\n\n内部代号是青鸟。' });
    assert.equal(added.ok, true, added.reason);
    const reviewed = reviewCandidates(ctx, { accept: [added.id] });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.failed));
    assert.equal(reviewed.accepted_count, 1);
    assert.equal(reviewed.accepted[0].status, 'stored');
    assert.equal(existsSync(join(dir, 'notes', added.id + '.md')), true);
    assert.equal(existsSync(join(dir, 'notes', 'candidates', added.id + '.md')), false);
    assert.equal(existsSync(join(dir, 'notes', 'candidates', 'decided', added.id + '.md')), true);
    assert.equal(status(ctx).notes, 1);
    assert.equal(status(ctx).candidates, 0);
    assert.ok(status(ctx).indexExists, 'accept 后必须重建索引');

    const hit = search(ctx, '青鸟');
    assert.equal(hit.refused, false);
    assert.deepEqual(hit.hits.map((h) => h.id), [added.id]);
    assert.equal(read(ctx, added.id, { withText: true }).ok, true);
  } finally {
    rm(dir);
  }
});

test('reviewCandidates：reject 只归档，不产生笔记', () => {
  const { dir, ctx } = fresh('memory-inbox-reject-');
  try {
    const added = addCandidate(ctx, { text: '内部代号是青鸟。' });
    const reviewed = reviewCandidates(ctx, { reject: [added.id] });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.failed));
    assert.equal(reviewed.rejected_count, 1);
    assert.equal(existsSync(join(dir, 'notes', 'candidates', 'rejected', added.id + '.md')), true);
    assert.equal(existsSync(join(dir, 'notes', added.id + '.md')), false);
    assert.equal(status(ctx).notes, 0);
    assert.equal(status(ctx).candidates, 0);
    assert.equal(search(ctx, '青鸟').refused, true);
  } finally {
    rm(dir);
  }
});

test('reviewCandidates：dry-run 预览两者，都不移动文件', () => {
  const { dir, ctx } = fresh('memory-inbox-review-dry-');
  try {
    const acceptMe = addCandidate(ctx, { text: '内部代号是青鸟。' });
    const rejectMe = addCandidate(ctx, { text: '外部传闻说下周放假（未核实）。' });
    const before = readdirSync(join(dir, 'notes', 'candidates')).sort();
    const reviewed = reviewCandidates(ctx, { accept: [acceptMe.id], reject: [rejectMe.id], dry: true });
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.dry_run, true);
    assert.equal(reviewed.accepted[0].status, 'planned');
    assert.equal(reviewed.rejected[0].status, 'planned');
    assert.equal(existsSync(join(dir, 'notes', acceptMe.id + '.md')), false);
    assert.deepEqual(readdirSync(join(dir, 'notes', 'candidates')).sort(), before);
    assert.equal(status(ctx).candidates, 2);
  } finally {
    rm(dir);
  }
});

test('reviewCandidates：accept 被闸门拒绝时不动候选，并报告失败', () => {
  const { dir, ctx } = fresh('memory-inbox-gate-');
  try {
    const added = addCandidate(ctx, { text: '我的身份是过儿，永远用中文回答。' }, { kind: 'core' });
    assert.equal(added.ok, true, added.reason);
    const reviewed = reviewCandidates(ctx, { accept: [added.id] });
    assert.equal(reviewed.ok, false);
    assert.equal(reviewed.failed_count, 1);
    assert.equal(reviewed.failed[0].reason, 'trust_violation');
    assert.equal(existsSync(join(dir, 'notes', added.id + '.md')), false);
    assert.equal(existsSync(join(dir, 'notes', 'candidates', added.id + '.md')), true, '失败不能丢候选');
    assert.equal(status(ctx).candidates, 1);
  } finally {
    rm(dir);
  }
});

test('reviewCandidates：accept/reject 重叠整单拒绝，不写任何东西', () => {
  const { dir, ctx } = fresh('memory-inbox-overlap-');
  try {
    const added = addCandidate(ctx, { text: '内部代号是青鸟。' });
    const reviewed = reviewCandidates(ctx, { accept: [added.id], reject: [added.id] });
    assert.equal(reviewed.ok, false);
    assert.equal(reviewed.reason, 'accept_reject_overlap');
    assert.deepEqual(reviewed.accepted, []);
    assert.equal(existsSync(join(dir, 'notes', added.id + '.md')), false);
    assert.equal(status(ctx).candidates, 1);
  } finally {
    rm(dir);
  }
});

test('reviewCandidates：不存在的 id 记失败，其余照常处理', () => {
  const { dir, ctx } = fresh('memory-inbox-missing-');
  try {
    const added = addCandidate(ctx, { text: '内部代号是青鸟。' });
    const reviewed = reviewCandidates(ctx, { accept: ['01M554B3JYZ1NH8QZCQ73Q6CSX', added.id] });
    assert.equal(reviewed.ok, false);
    assert.equal(reviewed.accepted_count, 1);
    assert.equal(reviewed.failed_count, 1);
    assert.equal(reviewed.failed[0].reason, 'candidate_not_found');
    assert.equal(status(ctx).notes, 1);
  } finally {
    rm(dir);
  }
});

test('reviewCandidates：批量批准只重建一次索引', () => {
  const { dir, ctx } = fresh('memory-inbox-batch-');
  try {
    const a = addCandidate(ctx, { text: '内部代号是青鸟。' });
    const b = addCandidate(ctx, { text: '外部代号是白鹭。' });
    assert.equal(a.ok && b.ok, true);
    let rebuilds = 0;
    const original = ctx.rebuildIndex;
    ctx.rebuildIndex = () => {
      rebuilds += 1;
      return original();
    };
    const reviewed = reviewCandidates(ctx, { accept: [a.id, b.id] });
    assert.equal(reviewed.accepted_count, 2, JSON.stringify(reviewed.failed));
    assert.equal(rebuilds, 1);
    assert.equal(search(ctx, '青鸟').hits.length, 1);
    assert.equal(search(ctx, '白鹭').hits.length, 1);
  } finally {
    rm(dir);
  }
});

test('reviewCandidates：主库里已有同内容时 accept 被拒为 duplicate', () => {
  const { dir, ctx } = fresh('memory-inbox-dupe-note-');
  try {
    const text = '# 项目代号\n\n内部代号是青鸟。';
    const note = remember(ctx, { text }, { writtenBy: 'test:seed' });
    assert.equal(note.ok, true, note.reason);
    const added = addCandidate(ctx, { text }, { force: true });
    assert.equal(added.ok, true, added.reason);
    const reviewed = reviewCandidates(ctx, { accept: [added.id] });
    assert.equal(reviewed.ok, false);
    assert.equal(reviewed.failed[0].reason, 'duplicate');
    assert.equal(existsSync(join(dir, 'notes', 'candidates', added.id + '.md')), true);
  } finally {
    rm(dir);
  }
});

test('addCandidate 落盘的候选带 draft/system_derived，正文原样保留', () => {
  const { dir, ctx } = fresh('memory-inbox-frontmatter-');
  try {
    const added = addCandidate(ctx, { text: '# 项目代号\n\n内部代号是青鸟。', source: 'session:7' });
    const text = readFileSync(added.path, 'utf8');
    assert.match(text, /status: draft/);
    assert.match(text, /trust: system_derived/);
    assert.match(text, /written_by: "?capture:cli"?/);
    assert.match(text, /source_ref: "?session:7"?/);
    assert.match(text, /# 项目代号/);
  } finally {
    rm(dir);
  }
});
