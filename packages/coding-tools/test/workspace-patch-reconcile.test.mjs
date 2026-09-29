import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  reconcileWorkspacePatchApply,
} from '../dist/index.js';
import {workspacePatchInflightPath} from '../dist/patch-reconcile.js';

const sha = value => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');

async function fixture(t, source = 'before\n') {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-reconcile-'));
  const root = join(base, 'workspace');
  const recoveryRootPath = join(base, 'trusted-recovery');
  await mkdir(join(root, 'src'), {recursive: true});
  await mkdir(recoveryRootPath);
  await writeFile(join(root, 'src', 'note.txt'), source);
  const relativePath = 'src/note.txt';
  const markerPath = workspacePatchInflightPath(root, recoveryRootPath, relativePath);
  t.after(() => rm(base, {recursive: true, force: true}));
  return {rootPath: root, recoveryRootPath, relativePath, markerPath, sourcePath: join(root, 'src', 'note.txt')};
}

async function marker(path, value) {
  await writeFile(path, JSON.stringify(value), {encoding: 'utf8'});
}

test('missing marker is already clear', async t => {
  const f = await fixture(t);
  assert.deepEqual(await reconcileWorkspacePatchApply(f), {path: f.relativePath, state: 'clear'});
});

test('live helper marker remains blocked and is not deleted', async t => {
  const f = await fixture(t);
  await marker(f.markerPath, {pid: 1234, beforeSha256: sha('before\n'), afterSha256: sha('after\n')});
  const result = await reconcileWorkspacePatchApply({...f, isProcessAlive: () => true});
  assert.deepEqual(result, {path: f.relativePath, state: 'in_progress', pid: 1234,
    beforeSha256: sha('before\n'), afterSha256: sha('after\n')});
  assert.match(await readFile(f.markerPath, 'utf8'), /1234/);
});

test('dead helper with after hash is reconciled as applied', async t => {
  const f = await fixture(t, 'after\n');
  await marker(f.markerPath, {pid: 1234, beforeSha256: sha('before\n'), afterSha256: sha('after\n')});
  const result = await reconcileWorkspacePatchApply({...f, isProcessAlive: () => false});
  assert.deepEqual(result, {path: f.relativePath, state: 'reconciled', outcome: 'applied',
    beforeSha256: sha('before\n'), afterSha256: sha('after\n'), currentSha256: sha('after\n')});
  await assert.rejects(readFile(f.markerPath), {code: 'ENOENT'});
});

test('dead helper with before hash is reconciled as not applied', async t => {
  const f = await fixture(t);
  await marker(f.markerPath, {pid: 1234, beforeSha256: sha('before\n'), afterSha256: sha('after\n')});
  const result = await reconcileWorkspacePatchApply({...f, isProcessAlive: () => false});
  assert.equal(result.state, 'reconciled');
  assert.equal(result.outcome, 'not_applied');
  assert.equal(result.currentSha256, sha('before\n'));
  await assert.rejects(readFile(f.markerPath), {code: 'ENOENT'});
});

test('unexpected current hash is reconciled as unknown and never success', async t => {
  const f = await fixture(t, 'user edit\n');
  await marker(f.markerPath, {pid: 1234, beforeSha256: sha('before\n'), afterSha256: sha('after\n')});
  const result = await reconcileWorkspacePatchApply({...f, isProcessAlive: () => false});
  assert.equal(result.state, 'reconciled');
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.currentSha256, sha('user edit\n'));
  await assert.rejects(readFile(f.markerPath), {code: 'ENOENT'});
});

test('unconfirmed process or malformed marker keeps the block', async t => {
  const f = await fixture(t);
  await marker(f.markerPath, {pid: null, beforeSha256: sha('before\n'), afterSha256: sha('after\n')});
  await assert.rejects(reconcileWorkspacePatchApply(f), {code: 'RESULT_UNKNOWN'});
  assert.equal(await readFile(f.markerPath, 'utf8').then(() => true), true);

  await marker(f.markerPath, {pid: 1234, beforeSha256: 'wrong', afterSha256: sha('after\n'), extra: true});
  await assert.rejects(reconcileWorkspacePatchApply({...f, isProcessAlive: () => false}), {code: 'RESULT_UNKNOWN'});
  assert.equal(await readFile(f.markerPath, 'utf8').then(() => true), true);
});

test('source containment failure keeps marker for trusted recovery', async t => {
  const f = await fixture(t);
  await marker(f.markerPath, {pid: 1234, beforeSha256: sha('before\n'), afterSha256: sha('after\n')});
  await rm(f.sourcePath);
  await assert.rejects(reconcileWorkspacePatchApply({...f, isProcessAlive: () => false}), {code: 'RESULT_UNKNOWN'});
  assert.equal(await readFile(f.markerPath, 'utf8').then(() => true), true);
});
