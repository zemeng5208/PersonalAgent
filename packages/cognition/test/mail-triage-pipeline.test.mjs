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
          // If message is marked with special text or high impact
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

test('MailTriagePipeline processes messages in bounded chunks (chunkSize = 4)', async () => {
  const inference = createMockInference();
  const pipeline = new MailTriagePipeline({
    inference,
    chunkSize: 4,
  });

  const messages = Array.from({length: 6}, (_, i) => ({
    source: 'mail:inbox',
    messageId: `msg-${i}`,
    sourceRevision: `rev-${i}`,
    text: i === 1 ? 'URGENT: Contract review deadline today' : `Weekly sync notes and updates #${i}`,
  }));

  const deadline = new Date(Date.now() + 60_000).toISOString();
  const summary = await pipeline.processBatch({
    messages,
    deadline,
    signal: new AbortController().signal,
  });

  assert.equal(summary.total, 6);
  assert.equal(summary.classifiedCount, 6);
  assert.equal(summary.abstainedCount, 0);
  assert.equal(summary.uncertainCount, 0);
  assert.equal(summary.results.length, 6);

  // 6 messages in chunks of 4 -> 2 inference calls (chunk 1: 4 msgs, chunk 2: 2 msgs)
  assert.equal(inference.calls.length, 2);
  assert.equal(inference.calls[0].state.events.length, 4);
  assert.equal(inference.calls[1].state.events.length, 2);

  // High impact detected for message 1
  assert.equal(summary.highImpactCount, 1);
  assert.equal(summary.highImpactNotices.length, 1);
  assert.equal(summary.highImpactNotices[0].messageId, 'msg-1');
  assert.equal(summary.highImpactNotices[0].route, 'main_agent');
  assert.equal(summary.highImpactNotices[0].reason, 'high_impact');

  // Verify privacy: no raw text or headers leaked in summary or notices
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /Contract review deadline/);
  assert.doesNotMatch(serialized, /Weekly sync notes/);

  // Verify real throughput calculation
  assert.ok(summary.throughput.durationMs >= 0);
  assert.ok(Number.isFinite(summary.throughput.messagesPerSecond));
  assert.ok(summary.throughput.messagesPerSecond > 0);
});

test('MailTriagePipeline checkpoint save and resume deduplication', async () => {
  const inference = createMockInference();
  const storage = {};
  const saveSnapshots = [];
  const checkpoint = {
    load() {
      return {...storage};
    },
    save(results) {
      saveSnapshots.push(Object.keys(results).length);
      Object.assign(storage, results);
    },
  };

  const pipeline = new MailTriagePipeline({
    inference,
    checkpoint,
    chunkSize: 2,
  });

  const messagesBatch1 = [
    {source: 'mail', messageId: 'm1', sourceRevision: 'r1', text: 'Task assignment 1'},
    {source: 'mail', messageId: 'm2', sourceRevision: 'r2', text: 'Task assignment 2'},
    {source: 'mail', messageId: 'm3', sourceRevision: 'r3', text: 'Task assignment 3'},
  ];

  const summary1 = await pipeline.processBatch({
    messages: messagesBatch1,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });

  assert.equal(summary1.total, 3);
  assert.equal(inference.calls.length, 2); // 3 items with chunkSize 2 -> 2 calls
  assert.ok(saveSnapshots.length >= 2);
  assert.equal(Object.keys(storage).length, 3);

  // Second run with overlapping messages (m2, m3) and a new message (m4)
  const messagesBatch2 = [
    {source: 'mail', messageId: 'm2', sourceRevision: 'r2', text: 'Task assignment 2'},
    {source: 'mail', messageId: 'm3', sourceRevision: 'r3', text: 'Task assignment 3'},
    {source: 'mail', messageId: 'm4', sourceRevision: 'r4', text: 'Task assignment 4'},
  ];

  const summary2 = await pipeline.processBatch({
    messages: messagesBatch2,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });

  assert.equal(summary2.total, 3);
  // Only 1 new message pending -> exactly 1 new inference call
  assert.equal(inference.calls.length, 3);
  assert.equal(Object.keys(storage).length, 4);
});

test('MailTriagePipeline enforces cancellation and deadline validation', async () => {
  const inference = createMockInference();
  const pipeline = new MailTriagePipeline({inference});

  const abort = new AbortController();
  abort.abort();

  await assert.rejects(
    async () => {
      await pipeline.processBatch({
        messages: [{source: 'mail', messageId: 'm1', sourceRevision: 'r1', text: 'Hello'}],
        deadline: new Date(Date.now() + 60_000).toISOString(),
        signal: abort.signal,
      });
    },
    (err) => err instanceof CognitionError && err.code === 'INVALID_ARGUMENT'
  );

  // Expired deadline
  await assert.rejects(
    async () => {
      await pipeline.processBatch({
        messages: [{source: 'mail', messageId: 'm1', sourceRevision: 'r1', text: 'Hello'}],
        deadline: new Date(Date.now() - 1_000).toISOString(),
        signal: new AbortController().signal,
      });
    },
    (err) => err instanceof CognitionError && err.code === 'INVALID_ARGUMENT'
  );
});
