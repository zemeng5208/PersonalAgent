// Prepared for local execution. All transports below are explicit offline fixtures.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MailService, QQMailProvider, FakeMailProvider, MailConnector, register, messageFromImap} from '../dist/index.js';
import {validateContract} from '@personal-agent/contracts';
import {FakeToolHost} from '@personal-agent/testkit';

const now = () => Date.parse('2026-09-30T11:00:00.000Z');
const input = {to: 'recipient@example.invalid', subject: 'Fixture draft', text: 'not a real message',
  timeoutMs: 1000, idempotencyKey: 'fixture-key'};
const message = uid => ({uid, folder: 'INBOX', from: 'sender@example.invalid', to: 'fixture@example.invalid',
  subject: 'Header only', sentAt: null, seen: false});

test('out-of-order overfull UID page does not skip the unreturned UID and stamps the page epoch', async () => {
  const provider = new FakeMailProvider();
  provider.fetchPage = (_account, request) => ({messages: [3, 1, 2].filter(uid => uid > (request.cursor?.lastUid ?? 0)).map(message),
    uidValidity: 17, nextCursor: {uidValidity: 17, lastUid: 3}, hasMore: false});
  const service = new MailService(provider, {now});
  const first = await service.fetchInbox('fixture', {limit: 2});
  assert.deepEqual(first.items.map(item => item.externalId), ['INBOX:1', 'INBOX:2']);
  assert.equal(first.nextCursor, '17:2');
  assert.equal(first.hasMore, true);
  assert.match(first.items[0].dedupeKey, /^fixture:17:INBOX:1:/);
  const next = await service.fetchInbox('fixture', {limit: 2, cursor: {uidValidity: 17, lastUid: 2}});
  assert.deepEqual(next.items.map(item => item.externalId), ['INBOX:3']);
});

test('epoch change, duplicate UID, and non-progressing pages are rejected', async () => {
  const provider = new FakeMailProvider();
  const service = new MailService(provider, {now});
  provider.fetchPage = () => ({messages: [message(1)], uidValidity: 18,
    nextCursor: {uidValidity: 18, lastUid: 1}, hasMore: false});
  await assert.rejects(service.fetchInbox('fixture', {cursor: {uidValidity: 17, lastUid: 0}}), {code: 'CURSOR_EXPIRED'});
  provider.fetchPage = () => ({messages: [message(1), message(1)], uidValidity: 18,
    nextCursor: {uidValidity: 18, lastUid: 1}, hasMore: false});
  await assert.rejects(service.fetchInbox('fixture', {}), {code: 'EXTERNAL_FAILURE'});
  provider.fetchPage = () => ({messages: [], uidValidity: 18,
    nextCursor: {uidValidity: 18, lastUid: 0}, hasMore: true});
  await assert.rejects(service.fetchInbox('fixture', {}), {code: 'EXTERNAL_FAILURE'});
});

test('invalid Date header falls back explicitly; aborted inbox read never calls the provider', async () => {
  assert.equal(messageFromImap(1, 'INBOX', {date: 'not a date'}, false).sentAt, null);
  const provider = new FakeMailProvider();
  provider.fetchPage = () => { throw Error('must not fetch'); };
  const signal = AbortSignal.abort();
  await assert.rejects(new MailService(provider, {now}).fetchInbox('fixture', {signal}), {code: 'CANCELLED'});
});

function fixtureQQ() {
  const provider = new QQMailProvider({user: 'fixture@qq.com', authCode: 'offline-fixture-never-used'});
  const stored = new Map();
  const client = {
    usable: true, mailbox: {uidValidity: 19}, appends: 0, selected: '',
    list: async () => [{path: 'Drafts', specialUse: '\\Drafts'}, {path: 'Sent', specialUse: '\\Sent'}],
    getMailboxLock: async folder => {client.selected = folder; return {release() {}};},
    search: async query => [...stored.entries()].filter(([, row]) => row.folder === client.selected
      && row.messageId === query.header['message-id']).map(([uid]) => uid),
    async *fetch(uids) {for (const uid of uids) yield {uid, envelope: {messageId: stored.get(uid)?.messageId}};},
    append: async (folder, mime, flags) => {
      client.appends++;
      assert.deepEqual(flags, ['\\Draft']);
      assert.ok(Buffer.isBuffer(mime));
      const messageId = /^Message-ID:\s*(.+)$/mi.exec(mime.toString())[1].trim();
      stored.set(7, {folder, messageId});
      return {uid: 7, uidValidity: 19};
    },
    fetchOne: async uid => ({uid: Number(uid), envelope: {messageId: stored.get(Number(uid))?.messageId}}),
    close() {},
  };
  provider.client = client;
  return {provider, client, stored};
}

test('draft MIME appends once, confirms by exact readback, replays across provider recreation without SMTP', async () => {
  const {provider, client} = fixtureQQ();
  provider.transporter = {sendMail() {throw Error('draft must never send SMTP');}, close() {}};
  const [first, same] = await Promise.all([provider.saveDraft('fixture', input), provider.saveDraft('fixture', input)]);
  validateContract('connectorAction', first);
  assert.deepEqual(same, first);
  assert.equal(first.state, 'confirmed');
  assert.equal(first.externalId, 'Drafts:7');
  assert.equal(client.appends, 1);
  const reopened = fixtureQQ().provider;
  reopened.client = client;
  assert.deepEqual(await reopened.saveDraft('fixture', input), first);
  assert.equal(client.appends, 1);
  await assert.rejects(provider.saveDraft('fixture', {...input, text: 'changed'}), {code: 'INVALID_ARGUMENT'});
});

test('draft disconnect after APPEND remains unknown and same key never reappends', async () => {
  const {provider, client} = fixtureQQ();
  client.append = async () => {client.appends++; throw Error('fixture post-append disconnect');};
  const first = await provider.saveDraft('fixture', input);
  assert.equal(first.state, 'unknown');
  assert.match(first.externalId, /^<pa-/);
  assert.deepEqual(await provider.saveDraft('fixture', input), first);
  assert.equal(client.appends, 1);
});

test('unknown SMTP retains deterministic Message-ID; missing Sent match stays unknown; exact match confirms without resend', async () => {
  const {provider, client, stored} = fixtureQQ();
  let smtpCalls = 0;
  provider.transporter = {sendMail: async mail => {smtpCalls++; assert.match(mail.messageId, /^<pa-/); throw Error('disconnect');}, close() {}};
  const result = await provider.send('fixture', input);
  assert.equal(result.state, 'unknown');
  assert.match(result.messageId, /^<pa-/);
  assert.equal((await provider.reconcileSend('fixture', result.messageId)).state, 'unknown');
  stored.set(8, {folder: 'Sent', messageId: result.messageId});
  const confirmed = await provider.reconcileSend('fixture', result.messageId);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(smtpCalls, 1);
  client.search = async () => [8];
  stored.set(8, {folder: 'Sent', messageId: '<different@example.invalid>'});
  assert.equal((await provider.reconcileSend('fixture', result.messageId)).state, 'unknown', 'fuzzy SEARCH must not confirm');
});

test('unsupported provider has no draft tool; supported tools use public schema and draft scope', async () => {
  const host = new FakeToolHost(now);
  const stop = register(host, {provider: new FakeMailProvider(), accountRef: 'fixture'});
  await assert.rejects(host.invoke('mail.save_draft', {}, {}), {code: 'UNSUPPORTED_CAPABILITY'});
  stop();
  const fixture = fixtureQQ();
  const dispose = register(host, {provider: fixture.provider, accountRef: 'fixture'});
  const context = {taskId: 'fixture-task', runId: 'fixture-run', authorizationRef: 'explicit-test-only',
    scopes: ['mail:draft'], deadline: new Date(now() + 1000).toISOString(), signal: new AbortController().signal};
  const result = await host.invoke('mail.save_draft', {to: input.to, subject: input.subject, text: input.text}, context);
  validateContract('connectorAction', result);
  assert.equal(result.state, 'confirmed');
  await assert.rejects(host.invoke('mail.save_draft', {to: input.to, subject: input.subject, text: input.text},
    {...context, scopes: ['mail:read']}), {code: 'SCOPE_DENIED'});
  dispose();
});

test('folder names containing a colon roundtrip via the connector item identity', async () => {
  const provider = new FakeMailProvider();
  provider.getMessage = (_account, folder, uid) => ({...message(uid), folder});
  const connector = new MailConnector(new MailService(provider, {now}));
  connector.connect();
  assert.equal((await connector.getItem('fixture', 'Archive:2026:42')).externalId, 'Archive:2026:42');
});
