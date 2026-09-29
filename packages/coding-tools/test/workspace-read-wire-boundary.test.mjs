import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {encodeFrame, MAX_FRAME_BYTES} from '../../contracts/dist/index.js';
import {
  MAX_SERIALIZED_WORKSPACE_READ_RESULT_BYTES,
  WORKSPACE_READ_SCOPE,
  createWorkspaceReadTool,
} from '../dist/index.js';

const context = () => ({
  taskId: 'task-wire-boundary',
  runId: 'run-wire-boundary',
  authorizationRef: 'authorization-wire-boundary',
  scopes: [WORKSPACE_READ_SCOPE],
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 60_000).toISOString(),
});

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'personal-agent-coding-tools-wire-'));
  const root = join(base, 'workspace');
  await mkdir(join(root, 'src'), {recursive: true});
  t.after(() => rm(base, {recursive: true, force: true}));
  return root;
}

function wrapResult(result) {
  return {
    kind: 'response',
    protocolVersion: '1.0.0',
    requestId: 'request-wire-boundary',
    outcome: 'ok',
    data: {
      runId: 'run-wire-boundary',
      state: 'confirmed',
      result,
      evidenceRefs: [],
    },
    evidenceRefs: [],
  };
}

function normalUtf8WithByteLength(byteLength) {
  return '界'.repeat(Math.floor(byteLength / 3)) + 'a'.repeat(byteLength % 3);
}

test('rejects JSON control-character expansion before returning a successful result', async t => {
  const root = await fixture(t);
  const path = 'src/tab-heavy.txt';
  const content = '\t'.repeat(512 * 1024);
  const oversizedResult = {path, encoding: 'utf-8', byteLength: Buffer.byteLength(content), content};
  await writeFile(join(root, 'src', 'tab-heavy.txt'), content, 'utf8');

  assert.throws(() => encodeFrame(wrapResult(oversizedResult)), {code: 'INVALID_ARGUMENT'});
  const tool = createWorkspaceReadTool({rootPath: root, maxReadBytes: MAX_FRAME_BYTES});
  await assert.rejects(
    tool.execute({path}, context()),
    error => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.message, 'Workspace read result exceeds the bounded serialized-output limit');
      assert.equal(error.message.includes(path), false);
      assert.equal(error.message.includes(content.slice(0, 32)), false);
      return true;
    },
  );
});

test('returns normal UTF-8 text at the serialized result boundary', async t => {
  const root = await fixture(t);
  const path = 'src/utf8-boundary.txt';
  let contentBytes = MAX_SERIALIZED_WORKSPACE_READ_RESULT_BYTES;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const emptyResult = {path, encoding: 'utf-8', byteLength: contentBytes, content: ''};
    contentBytes = MAX_SERIALIZED_WORKSPACE_READ_RESULT_BYTES - Buffer.byteLength(JSON.stringify(emptyResult));
  }
  const content = normalUtf8WithByteLength(contentBytes);
  await writeFile(join(root, 'src', 'utf8-boundary.txt'), content, 'utf8');

  const tool = createWorkspaceReadTool({rootPath: root, maxReadBytes: MAX_FRAME_BYTES});
  const result = await tool.execute({path}, context());

  assert.equal(Buffer.byteLength(JSON.stringify(result)), MAX_SERIALIZED_WORKSPACE_READ_RESULT_BYTES);
  assert.equal(result.byteLength, contentBytes);
  assert.equal(result.content, content);
  assert.doesNotThrow(() => encodeFrame(wrapResult(result)));
});
