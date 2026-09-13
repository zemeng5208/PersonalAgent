import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseCoordinationTextResult} from '../dist/index.js';
import {FakeCloudAgentPort, FakeCoordinationPort} from '../dist/testing.js';

test('explicit fakes preserve request boundaries and mark output mock', async () => {
  const input = {taskId: 'task', revision: 2, goal: '你好', deadline: new Date().toISOString(), signal: new AbortController().signal};
  for (const [port, method] of [[new FakeCoordinationPort(r => r.goal), 'execute'], [new FakeCloudAgentPort(r => r.goal), 'invoke']]) {
    assert.deepEqual(await port[method](input), {kind: 'text', text: '你好', verification: 'mock'});
    assert.equal(port.requests[0].signal, input.signal);
  }
});

test('text result rejects privileged claims and unbounded or malformed content', () => {
  const good = {kind: 'text', text: '回答', verification: 'unverified'};
  assert.deepEqual(parseCoordinationTextResult(good), good);
  for (const bad of [null, [], {}, {...good, state: 'succeeded'}, {...good, evidenceRefs: ['cloud']},
    {...good, kind: 'tool_proposal'}, {...good, verification: 'verified'}, {...good, text: ' '}, {...good, text: 'x'.repeat(16_001)}]) {
    assert.throws(() => parseCoordinationTextResult(bad), /Invalid coordination|Expected bounded/);
  }
});
