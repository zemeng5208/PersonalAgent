import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createP5SystemObservationSource} from '../electron/p5-system-observation-source.js';

const observation = taskId => ({taskId, source: 'node:os', timestamp: '2026-09-29T12:00:00.000Z',
  cpuPercent: 92, memoryPercent: 75, samplingIntervalMs: 30_000, evidenceRefs: [`host-tool-${taskId}`]});

test('publishes each confirmed sample once and only while its Runtime consent readback is current', () => {
  let active = true;
  const source = createP5SystemObservationSource({application: {
    readCurrentSystemObservationSample: taskId => active ? observation(taskId) : undefined,
  }});
  const received = [];
  const unsubscribe = source.subscribe(sample => received.push(sample));
  assert.equal(source.publishCompletedTask('task-1'), true);
  assert.equal(source.publishCompletedTask('task-1'), false);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {...observation('task-1')});
  assert.deepEqual(source.readCurrentProvenance({source: 'node:os', timestamp: observation('task-1').timestamp}), observation('task-1'));

  active = false;
  assert.equal(source.readCurrentProvenance({source: 'node:os', timestamp: observation('task-1').timestamp}), undefined);
  assert.equal(source.publishCompletedTask('task-2'), false);
  unsubscribe();
  source.dispose();
  assert.equal(source.publishCompletedTask('task-3'), false);
});

test('rejects malformed or evidence-free Runtime projections', () => {
  const source = createP5SystemObservationSource({application: {
    readCurrentSystemObservationSample: taskId => ({...observation(taskId), evidenceRefs: []}),
  }});
  let received = 0;
  source.subscribe(() => { received++; });
  assert.equal(source.publishCompletedTask('task-1'), false);
  assert.equal(received, 0);
  assert.throws(() => createP5SystemObservationSource({application: {}}), /Invalid/);
  source.dispose();
});
