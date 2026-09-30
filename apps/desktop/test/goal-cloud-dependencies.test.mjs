import assert from 'node:assert/strict';
import test from 'node:test';
import {createDesktopGoalCloudHost} from '../electron/goal-cloud-host.js';

function fixture(dependencies) {
  const node = {id: 'goal', revision: 2, summary: 'Keep the confirmed meeting',
    validFrom: '2026-09-30T00:00:00.000Z', validUntil: '2026-10-02T00:00:00.000Z',
    sensitivity: 'private', state: 'active', reason: 'User-selected goal', dependencies,
    sourceRef: 'private-source-not-exported'};
  const writes = ['goals.create', 'goals.revise'].map(name => ({descriptor: {name, version: '1.0.0',
    inputSchema: {properties: {goal: {required: ['id','sourceRef']}}}}, execute: () => {throw Error('no writes');}}));
  const host = createDesktopGoalCloudHost({goalHost: {tools: writes,
    list: () => ({graphRevision: 4, goals: [structuredClone(node)]}),
    get: () => ({graphRevision: 4, goal: structuredClone(node)})}});
  const checkpoints = new Map();
  host.bindApplication({profile: 'huawei_ict_agentarts', runtime: {
    getTask: () => ({conversationId: 'desktop-panel'}),
    loadCheckpoint: (taskId, key) => checkpoints.get(`${taskId}:${key}`),
    saveCheckpoint: (taskId, key, value) => checkpoints.set(`${taskId}:${key}`, value),
  }});
  host.authorize({goalCloudConsent: true});
  const signal = new AbortController().signal;
  assert.equal(host.competitionToolAvailability.find(value => value.toolName === 'goals.get')
    .available({taskId: 'task', signal}), true);
  return {host, signal, context: {taskId: 'task', signal}};
}

test('Goal list/get retain exact dependency refs through public result and cloud projection', async () => {
  const refs = [{id: 'meeting-fact', revision: 3}, {id: 'decision', revision: 1}];
  const {host, signal, context} = fixture(refs);
  for (const name of ['goals.list', 'goals.get']) {
    const tool = host.tools.find(value => value.descriptor.name === name);
    const result = await tool.execute(name === 'goals.list' ? {} : {id: 'goal'}, context);
    const projected = host.competitionToolExports.find(value => value.toolName === name)
      .project({taskId: 'task', result, signal});
    const goal = name === 'goals.list' ? projected.goals[0] : projected.goal;
    assert.deepEqual(goal.dependencies, refs);
    assert.equal(Object.hasOwn(goal, 'sourceRef'), false);
    goal.dependencies[0].revision = 99;
    const reread = await tool.execute(name === 'goals.list' ? {} : {id: 'goal'}, context);
    assert.equal((name === 'goals.list' ? reread.goals[0] : reread.goal).dependencies[0].revision, 3);
  }
});

test('unsafe or incomplete dependency metadata makes the entire Goal unavailable', async () => {
  for (const refs of [undefined, [{id: 'fact', revision: 0}], [{id: 'C:\\private\\fact', revision: 1}]]) {
    const {host, context} = fixture(refs);
    const result = await host.tools.find(value => value.descriptor.name === 'goals.get').execute({id: 'goal'}, context);
    assert.equal(result.goal, null);
  }
});
