import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {KnowledgeError} from '../dist/index.js';
import {createFakeKnowledgePort} from '../dist/testing.js';

const deadline = () => new Date(Date.now() + 10_000).toISOString();
const request = (query, options = {}) => ({
  query, limit: 10, deadline: deadline(), signal: new AbortController().signal, ...options
});

test('Fake search returns bounded literal matches with stable line citations', async () => {
  const content = '标题\n第一行 天气\n第二行\n天气 结束';
  const port = createFakeKnowledgePort('test-vault', [{path: 'notes/weather.md', content}]);
  const result = await port.search(request('天气'));
  const revision = createHash('sha256').update(content).digest('hex');
  assert.deepEqual(result, {
    hits: [
      {source: {vaultId: 'test-vault', path: 'notes/weather.md', line: 2, revision}, excerpt: '第一行 天气'},
      {source: {vaultId: 'test-vault', path: 'notes/weather.md', line: 4, revision}, excerpt: '天气 结束'}
    ],
    truncated: false
  });
  assert.deepEqual(await port.search(request('不存在')), {hits: [], truncated: false});
});

test('result limit and vault binding do not leak another fixture', async () => {
  const documents = [{path: 'note.md', content: 'hello\nhello'}];
  const first = createFakeKnowledgePort('first', documents);
  const second = createFakeKnowledgePort('second', [{path: 'other.md', content: 'secret'}]);
  assert.deepEqual((await first.search(request('hello', {limit: 1}))).truncated, true);
  assert.deepEqual(await first.search(request('secret')), {hits: [], truncated: false});
  assert.equal((await second.search(request('secret'))).hits[0].source.vaultId, 'second');
  documents[0].content = 'changed';
  assert.equal((await first.search(request('hello'))).hits.length, 2);
});

test('invalid fixture paths and duplicate names are rejected', () => {
  for (const path of ['../private.md', '/absolute.md', 'C:/absolute.md', 'notes\\file.md', 'note.txt']) {
    assert.throws(() => createFakeKnowledgePort('v', [{path, content: 'text'}]),
      error => error instanceof KnowledgeError && error.code === 'INVALID_ARGUMENT');
  }
  assert.throws(() => createFakeKnowledgePort('v', [
    {path: 'Note.md', content: 'a'}, {path: 'note.md', content: 'b'}
  ]), error => error.code === 'INVALID_ARGUMENT');
});

test('invalid search, cancellation and deadline fail closed', async () => {
  const port = createFakeKnowledgePort('v', [{path: 'note.md', content: 'hello'}]);
  const cancelled = new AbortController();
  cancelled.abort();
  for (const input of [
    request(''), request('hello', {limit: 0}), request('hello', {deadline: 'bad'})
  ]) {
    await assert.rejects(port.search(input), error => error.code === 'INVALID_ARGUMENT');
  }
  await assert.rejects(port.search(request('hello', {signal: cancelled.signal})),
    error => error.code === 'CANCELLED');
  await assert.rejects(port.search(request('hello', {deadline: new Date(Date.now() - 1000).toISOString()})),
    error => error.code === 'TIMEOUT');
});
