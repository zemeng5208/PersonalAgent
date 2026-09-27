import assert from 'node:assert/strict';
import test from 'node:test';
import {createInboxTriagePipeline} from '../src/application/inbox-triage.ts';

test('private inbox persistence: partial retry, restart dedupe, source revision, no fabricated public facts', async () => {
  const data = new Map();
  const storage = {get: key => structuredClone(data.get(key)),
    set: (key, value) => data.set(key, structuredClone(value)), delete: key => data.delete(key)};
  let failLast = true;
  let authorized = true;
  const calls = [];
  const triage = {async classify({messages}) {
    calls.push(messages.map(message => message.messageId));
    return messages.map(message => ({...message,
      label: failLast && message.text === 'subject 5' ? null : 'meeting',
      route: failLast && message.text === 'subject 5' ? 'review' : 'main_agent',
      abstained: failLast && message.text === 'subject 5',
      reason: failLast && message.text === 'subject 5' ? 'unavailable' : 'high_impact',
      calibrated: false, batching: 'multi_question'}));
  }};
  const options = {storage, namespace: 'synthetic-user', triage,
    labels: {meeting: 'Meeting-related subject needing source review', other: 'Other'},
    meetingLabels: ['meeting'], authorizeRead: () => authorized};
  const context = {deadline: new Date(Date.now() + 60000).toISOString(), signal: new AbortController().signal};
  const items = Array.from({length: 5}, (_, index) => ({source: 'mail', accountRef: 'fixture',
    externalId: `INBOX:${index + 1}`, occurredAt: '2026-09-27T00:00:00.000Z',
    fetchedAt: '2026-09-27T01:00:00.000Z', contentRef: `subject ${index + 1}`,
    sensitivity: 'private', dedupeKey: `fixture:1:INBOX:${index + 1}:message-${index + 1}`}));
  const page = {...context, accountRef: 'fixture', folder: 'INBOX', nextCursor: '1:5', hasMore: false, items};
  let pipeline = createInboxTriagePipeline(options);
  const partial = await pipeline.processPage(page);
  assert.equal(partial.complete, false);
  assert.equal(partial.classified, 4);
  assert.equal(pipeline.cursor('fixture', 'INBOX'), undefined);
  assert.equal(pipeline.snapshot().total, 4);
  failLast = false;
  pipeline = createInboxTriagePipeline(options);
  const resumed = await pipeline.processPage(page);
  assert.equal(resumed.classified, 1);
  assert.equal(resumed.reused, 4);
  assert.equal(pipeline.cursor('fixture', 'INBOX'), '1:5');
  const callCount = calls.length;
  pipeline = createInboxTriagePipeline(options);
  const replay = await pipeline.processPage({...page,
    items: items.map(item => ({...item, fetchedAt: '2026-09-27T02:00:00.000Z'}))});
  assert.equal(replay.classified, 0);
  assert.equal(calls.length, callCount);
  const changed = await pipeline.processPage({...page,
    items: items.map((item, index) => index === 0 ? {...item, contentRef: 'revised meeting subject'} : item)});
  assert.equal(changed.classified, 1);
  assert.equal(changed.summary.total, 5);
  assert.equal(changed.summary.meetingCandidates, 5);
  assert.ok(changed.summary.records.every(item => item.headersOnly && item.sensitivity === 'private' && item.needsReview));
  assert.equal(JSON.stringify([...data.values()]).includes('revised meeting subject'), false);
  assert.equal(JSON.stringify([...data.values()]).includes('validFrom'), false);
  await assert.rejects(pipeline.processPage({...page, items: [{...items[0], sensitivity: 'public'}]}),
    {code: 'INVALID_ARGUMENT'});
  authorized = false;
  await assert.rejects(pipeline.processPage(page), {code: 'UNAUTHORIZED'});
  assert.equal(pipeline.cursor('fixture', 'INBOX'), '1:5');
});
