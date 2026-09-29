import assert from 'node:assert/strict';
import test from 'node:test';
import {createObsidianVaultPort} from '../dist/obsidian.js';

const deadline = () => new Date(Date.now() + 10_000).toISOString();
const request = (query, extra = {}) => ({
  query, limit: 10, deadline: deadline(), signal: new AbortController().signal, ...extra
});

function fixture(documents) {
  const entries = new Map(documents.map(([path, content]) => [
    path, {path, content, stat: {mtime: 1, size: Buffer.byteLength(content, 'utf8')}}
  ]));
  const reads = [];
  const vault = {
    getMarkdownFiles: () => [...entries.values()],
    getAbstractFileByPath: path => entries.get(path) ?? null,
    read: async file => {
      reads.push(file.path);
      return file.content;
    }
  };
  const update = (path, content) => {
    const file = entries.get(path);
    file.content = content;
    file.stat = {mtime: file.stat.mtime + 1, size: Buffer.byteLength(content, 'utf8')};
  };
  return {vault, entries, reads, update};
}

test('plugin Vault reader searches only its bound folder and verifies citations', async () => {
  const {vault, reads} = fixture([
    ['notes/a.md', '标题\n第一行 天气\n天气 结束'],
    ['private.md', '天气 private'],
    ['notes/.hidden.md', '天气 hidden'],
    ['notes/../secret.md', '天气 escaped']
  ]);
  const port = createObsidianVaultPort({vaultId: 'v', allowedFolder: 'notes', vault});
  const result = await port.search(request('天气', {limit: 1}));
  assert.equal(result.hits.length, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hits[0].source.path, 'notes/a.md');
  assert.match(result.hits[0].source.revision, /^[0-9a-f]{64}$/);
  assert.equal(await port.readCitation({...request('天气'), source: result.hits[0].source}), '第一行 天气');
  assert.deepEqual(reads, ['notes/a.md', 'notes/a.md']);
  await assert.rejects(port.readCitation({
    ...request('天气'), source: {...result.hits[0].source, path: 'private.md'}
  }), {code: 'SCOPE_DENIED'});
});

test('changed, renamed and deleted notes invalidate old citations', async () => {
  const {vault, entries, update} = fixture([['notes/a.md', 'hello']]);
  const port = createObsidianVaultPort({vaultId: 'v', allowedFolder: 'notes', vault});
  const source = (await port.search(request('hello'))).hits[0].source;
  update('notes/a.md', 'new hello');
  await assert.rejects(port.readCitation({...request('hello'), source}), {code: 'SOURCE_CHANGED'});
  const fresh = (await port.search(request('hello'))).hits[0].source;
  const renamed = entries.get('notes/a.md');
  entries.delete('notes/a.md');
  renamed.path = 'notes/b.md';
  entries.set(renamed.path, renamed);
  await assert.rejects(port.readCitation({...request('hello'), source: fresh}), {code: 'SOURCE_CHANGED'});
  entries.delete(renamed.path);
  assert.deepEqual(await port.search(request('hello')), {hits: [], truncated: false});
});

test('bounds, invalid input and cancelled requests fail before reading', async () => {
  const {vault, entries, reads} = fixture([['notes/a.md', 'hello']]);
  assert.throws(() => createObsidianVaultPort({vaultId: 'v', allowedFolder: '../private', vault}),
    {code: 'INVALID_ARGUMENT'});
  const port = createObsidianVaultPort({vaultId: 'v', allowedFolder: 'notes', vault});
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(port.search(request('hello', {signal: aborted.signal})), {code: 'CANCELLED'});
  await assert.rejects(port.search(request('hello', {
    deadline: new Date(Date.now() - 1000).toISOString()
  })), {code: 'TIMEOUT'});
  await assert.rejects(port.search(request('hello', {limit: 0})), {code: 'INVALID_ARGUMENT'});
  assert.deepEqual(reads, []);
  entries.get('notes/a.md').stat.size = 512 * 1024 + 1;
  await assert.rejects(port.search(request('hello')), {code: 'LIMIT_EXCEEDED'});
  assert.deepEqual(reads, []);
});

test('too many in-scope files fail before any Vault body is read', async () => {
  const {vault, reads} = fixture(Array.from({length: 1001},
    (_, index) => ['notes/' + index + '.md', 'hello']));
  const port = createObsidianVaultPort({vaultId: 'v', allowedFolder: 'notes', vault});
  await assert.rejects(port.search(request('hello')), {code: 'LIMIT_EXCEEDED'});
  assert.deepEqual(reads, []);
});

test('read failure and mid-read changes never return partial search results', async () => {
  const {vault, entries, update} = fixture([
    ['notes/a.md', 'hello'], ['notes/b.md', 'hello']
  ]);
  vault.read = async file => {
    if (file.path === 'notes/b.md') throw new Error('unavailable');
    return file.content;
  };
  const port = createObsidianVaultPort({vaultId: 'v', allowedFolder: 'notes', vault});
  await assert.rejects(port.search(request('hello')), {code: 'SOURCE_UNAVAILABLE'});

  let release;
  let entered;
  const waiting = new Promise(resolve => {entered = resolve;});
  vault.read = async file => {
    const content = file.content;
    entered();
    await new Promise(resolve => {release = resolve;});
    return content;
  };
  entries.delete('notes/b.md');
  const pending = port.search(request('hello'));
  await waiting;
  update('notes/a.md', 'changed');
  release();
  await assert.rejects(pending, {code: 'SOURCE_CHANGED'});
});

test('a cancelled in-flight Vault read cannot yield a result', async () => {
  const {vault} = fixture([['notes/a.md', 'hello']]);
  let release;
  let entered;
  const waiting = new Promise(resolve => {entered = resolve;});
  vault.read = async file => {
    entered();
    await new Promise(resolve => {release = resolve;});
    return file.content;
  };
  const port = createObsidianVaultPort({vaultId: 'v', allowedFolder: 'notes', vault});
  const controller = new AbortController();
  const pending = port.search(request('hello', {signal: controller.signal}));
  await waiting;
  controller.abort();
  release();
  await assert.rejects(pending, {code: 'CANCELLED'});
});
