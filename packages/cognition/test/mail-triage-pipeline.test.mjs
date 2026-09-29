import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MailTriagePipeline,
  DEFAULT_MAIL_LABELS,
  CognitionError,
} from '../dist/index.js';

function createMockInference(options = {}) {
  const calls = [];
  const inference = {
    async infer(payload) {
      calls.push(payload);
      const answers = {};
      for (const [key, q] of Object.entries(payload.questions)) {
        if (key.startsWith('category_')) {
          answers[key] = {
            choice: 'work',
            probabilities: {
              work: 0.85,
              schedule: 0.05,
              finance: 0.04,
              notification: 0.03,
              promotional: 0.03,
            },
            answer_confidence: 0.85,
            confidence: 0.6,
          };
        } else if (key.startsWith('impact_')) {
          const idx = key.replace('impact_', '');
          const event = payload.state.events[Number(idx)];
          const isHigh = event?.observation?.includes('URGENT') || options.forceHighImpact;
          answers[key] = {
            choice: isHigh ? 'high_impact' : 'routine',
            probabilities: {
              routine: isHigh ? 0.1 : 0.9,
              high_impact: isHigh ? 0.9 : 0.1,
            },
            answer_confidence: 0.9,
            confidence: 0.7,
          };
        }
      }
      return {answers};
    },
    calls,
  };
  return inference;
}

test('MailTriagePipeline processes messages in bounded chunks and deduplicates in-batch duplicates', async () => {
  const inference = createMockInference();
  const pipeline = new MailTriagePipeline({
    inference,
    chunkSize: 4,
  });

  const messages = [
    {source: 'mail:inbox', messageId: 'm1', sourceRevision: 'r1', text: 'URGENT: Contract review today'},
    {source: 'mail:inbox', messageId: 'm2', sourceRevision: 'r1', text: 'Weekly sync notes'},
    {source: 'mail:inbox', messageId: 'm2', sourceRevision: 'r1', text: 'Weekly sync notes (duplicate in batch)'},
    {source: 'mail:inbox', messageId: 'm3', sourceRevision: 'r1', text: 'Status update 3'},
    {source: 'mail:inbox', messageId: 'm4', sourceRevision: 'r1', text: 'Status update 4'},
    {source: 'mail:inbox', messageId: 'm5', sourceRevision: 'r1', text: 'Status update 5'},
  ];

  const deadline = new Date(Date.now() + 60_000).toISOString();
  const summary = await pipeline.processBatch({
    messages,
    deadline,
    signal: new AbortController().signal,
  });

  // 6 input messages with 1 duplicate -> 5 unique messages processed
  assert.equal(summary.total, 5);
  assert.equal(summary.newlyClassifiedCount, 5);
  assert.equal(summary.cachedCount, 0);

  // High impact detected for message 1
  assert.equal(summary.highImpactCount, 1);
  assert.equal(summary.highImpactNotices.length, 1);
  assert.equal(summary.highImpactNotices[0].messageId, 'm1');

  // Pure model throughput calculation
  assert.ok(summary.throughput.messagesPerSecond > 0);
  assert.ok(summary.throughput.inferenceDurationMs >= 0);
});

test('MailTriagePipeline transactional checkpointing: save failure does not commit to memory cache', async () => {
  const inference = createMockInference();
  let shouldFailSave = true;
  const storage = {};

  const checkpoint = {
    load() {
      return {...storage};
    },
    async save(results) {
      if (shouldFailSave) {
        throw new Error('durable_storage_write_failure');
      }
      Object.assign(storage, results);
    },
  };

  const pipeline = new MailTriagePipeline({
    inference,
    checkpoint,
    chunkSize: 2,
  });

  const messages = [
    {source: 'mail', messageId: 'm1', sourceRevision: 'r1', text: 'Task 1'},
    {source: 'mail', messageId: 'm2', sourceRevision: 'r2', text: 'Task 2'},
  ];

  // First call fails at checkpoint.save
  await assert.rejects(
    async () => {
      await pipeline.processBatch({
        messages,
        deadline: new Date(Date.now() + 60_000).toISOString(),
        signal: new AbortController().signal,
      });
    },
    /durable_storage_write_failure/
  );

  // Storage should be empty
  assert.equal(Object.keys(storage).length, 0);

  // Now fix save, run again: messages should be classified and saved, not falsely hit in memory
  shouldFailSave = false;
  const summary = await pipeline.processBatch({
    messages,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });

  assert.equal(summary.total, 2);
  assert.equal(summary.newlyClassifiedCount, 2);
  assert.equal(Object.keys(storage).length, 2);

  // Subsequent call: both served from cache
  const summary2 = await pipeline.processBatch({
    messages,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });
  assert.equal(summary2.cachedCount, 2);
  assert.equal(summary2.newlyClassifiedCount, 0);
  // Pure model throughput when 0 newly classified messages should be 0
  assert.equal(summary2.throughput.messagesPerSecond, 0);
});

test('MailTriagePipeline config change produces different cache key', async () => {
  const inference = createMockInference();
  const storage = {};
  const checkpoint = {
    load: () => ({...storage}),
    save: (r) => { Object.assign(storage, r); },
  };

  const labels1 = {work: '工作事务', finance: '账单财务'};
  const pipeline1 = new MailTriagePipeline({
    inference,
    checkpoint,
    labels: labels1,
  });

  const msg = [{source: 'mail', messageId: 'm1', sourceRevision: 'r1', text: 'Invoice 101'}];
  await pipeline1.processBatch({
    messages: msg,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });
  assert.equal(inference.calls.length, 1);

  // Different label config: should NOT hit cache key of labels1
  const labels2 = {urgent_work: '紧急工作', promotional: '广告营销'};
  const pipeline2 = new MailTriagePipeline({
    inference,
    checkpoint,
    labels: labels2,
  });

  await pipeline2.processBatch({
    messages: msg,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });
  // Must make a new inference call because label configuration changed!
  assert.equal(inference.calls.length, 2);
});
