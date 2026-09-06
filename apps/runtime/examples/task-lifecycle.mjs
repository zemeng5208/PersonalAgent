import {mkdirSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskRuntime} from '../dist/index.js';

const root = fileURLToPath(new URL('../../../.cache/runtime-demo/', import.meta.url));
mkdirSync(root, {recursive: true});
const path = join(mkdtempSync(join(root, 'run-')), 'runtime.sqlite');
const runtime = new TaskRuntime(path);

try {
  const task = runtime.submitTask({
    goal: 'run the local Runtime demonstration',
    conversationId: 'demo-conversation',
    idempotencyKey: 'demo-submit'
  });
  const complete = await runtime.runTask(task.taskId, async context => {
    context.saveCheckpoint('fixture', {prepared: true});
    context.reportProgress({stepId: 'demo-step', label: 'local fixture', completedUnits: 1, totalUnits: 1});
    return {resultSummary: 'Local fixture completed; no model or external action was used'};
  }, {
    deadline: new Date(Date.now() + 5000).toISOString(),
    sideEffect: 'read'
  });
  console.log(JSON.stringify({
    verification: 'mock',
    taskId: complete.taskId,
    state: complete.state,
    eventCount: runtime.readEvents().length,
    database: path
  }, null, 2));
} finally {
  runtime.close();
}
