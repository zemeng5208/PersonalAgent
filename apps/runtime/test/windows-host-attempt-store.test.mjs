import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {TaskRuntime} from '../dist/index.js';
import {createRuntimeWindowsHostAttemptStore} from '../dist/application.js';

test('Windows Host attempt identity is create-only and survives Runtime restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-windows-attempt-'));
  const path = join(directory, 'runtime.sqlite');
  let runtime = new TaskRuntime(path);
  const task = runtime.submitTask({goal: 'Synthetic Notepad update',
    conversationId: 'synthetic', idempotencyKey: 'attempt'});
  const store = createRuntimeWindowsHostAttemptStore(() => runtime);
  const identity = {taskId: task.taskId, runId: 'notepad-run-1',
    toolName: 'computer.notepad.replace_text', toolVersion: '1.0.0',
    argumentsDigest: 'a'.repeat(64), targetRef: 'notepad_target_123456789'};
  try {
    await store.record(identity);
    assert.deepEqual(await store.read(task.taskId, identity.runId), identity);
    await assert.rejects(store.record(identity), {code: 'REVISION_CONFLICT'});
    await assert.rejects(store.record({...identity, argumentsDigest: 'b'.repeat(64)}),
      {code: 'REVISION_CONFLICT'});
    runtime.close();
    runtime = new TaskRuntime(path);
    assert.deepEqual(await store.read(task.taskId, identity.runId), identity);
    assert.equal(await store.read(task.taskId, 'unknown-run'), undefined);
  } finally {
    runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
});
