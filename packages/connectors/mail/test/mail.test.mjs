import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  MAIL_CONNECTOR_VERSION,
  FakeMailProvider,
  MailConnector,
  MailService,
  decodeMailCursor,
  encodeMailCursor,
  messageFromImap,
  messageToItem,
  register,
} from '../dist/index.js';
import {FakeClock, FakeToolHost} from '@personal-agent/testkit';
import {ProtocolError, validateContract} from '@personal-agent/contracts';

const NOW = Date.parse('2026-09-07T02:00:00.000Z');
const ACCOUNT = 'qq-me';

function makeService(fixtures, options = {}) {
  const provider = new FakeMailProvider(fixtures, options);
  const service = new MailService(provider, {now: () => NOW});
  return {provider, service};
}

test('游标编解码与畸形拒绝', () => {
  const cursor = {uidValidity: 1725686400, lastUid: 42};
  assert.equal(decodeMailCursor(encodeMailCursor(cursor)).lastUid, 42);
  assert.throws(() => decodeMailCursor('abc'), /malformed/i);
  assert.throws(() => decodeMailCursor('1:2:3'), /malformed/i);
});

test('增量分页：首页→次页→取尽；重复 fetch 同游标零新条目', async () => {
  const {service} = makeService();
  const page1 = await service.fetchInbox(ACCOUNT, {limit: 3});
  assert.equal(page1.items.length, 3);
  assert.ok(page1.hasMore);
  const page2 = await service.fetchInbox(ACCOUNT, {cursor: decodeMailCursor(page1.nextCursor), limit: 3});
  assert.equal(page2.items.length, 3);
  const page3 = await service.fetchInbox(ACCOUNT, {cursor: decodeMailCursor(page2.nextCursor), limit: 3});
  assert.equal(page3.items.length, 2);
  assert.equal(page3.hasMore, false);
  const again = await service.fetchInbox(ACCOUNT, {cursor: decodeMailCursor(page3.nextCursor), limit: 3});
  assert.equal(again.items.length, 0, '已消费的 UID 不重复投递');

  const all = [...page1.items, ...page2.items, ...page3.items];
  assert.equal(new Set(all.map(item => item.dedupeKey)).size, all.length, '跨页无重复');
  for (const item of all) validateContract('connectorItem', item);
});

test('条目语义：occurredAt 取 Date 头、缺失回退抓取时刻并标注、sensitivity=private', () => {
  const withDate = messageToItem(
    {uid: 2, folder: 'INBOX', from: 'a@b.c', to: 'me@qq.com', subject: 's', sentAt: '2026-09-05T08:30:00.000Z', seen: false},
    ACCOUNT,
    '2026-09-07T02:00:00.000Z',
  );
  assert.equal(withDate.occurredAt, '2026-09-05T08:30:00.000Z');
  assert.equal(withDate.sensitivity, 'private');
  assert.equal(withDate.externalId, 'INBOX:2');

  const noDate = messageToItem(
    {uid: 5, folder: 'INBOX', from: 'a@b.c', to: 'me@qq.com', subject: 's', sentAt: null, seen: false},
    ACCOUNT,
    '2026-09-07T02:00:00.000Z',
  );
  assert.equal(noDate.occurredAt, '2026-09-07T02:00:00.000Z');
  assert.match(noDate.contentRef, /无 Date 头/);
});

test('uidValidity 变化 → CURSOR_EXPIRED（文件夹重建需从头同步）', async () => {
  const {provider, service} = makeService();
  const page1 = await service.fetchInbox(ACCOUNT, {limit: 2});
  const stale = decodeMailCursor(page1.nextCursor);
  provider.rotateUidValidity();
  await assert.rejects(service.fetchInbox(ACCOUNT, {cursor: stale, limit: 5}), err => err.code === 'CURSOR_EXPIRED');
  const fresh = await service.fetchInbox(ACCOUNT, {limit: 2});
  assert.equal(fresh.items.length, 2, '新游标从头同步');
});

test('mark_seen 幂等且真实生效', async () => {
  const {provider, service} = makeService();
  const first = await service.markSeen(ACCOUNT, {folder: 'INBOX', uid: 2, idempotencyKey: 'k1'});
  const repeat = await service.markSeen(ACCOUNT, {folder: 'INBOX', uid: 2, idempotencyKey: 'k1'});
  assert.deepEqual(first, repeat);
  validateContract('connectorAction', first);
  assert.equal(first.state, 'confirmed');
  const page = await service.fetchInbox(ACCOUNT, {limit: 100});
  const seen = page.items.find(item => item.externalId === 'INBOX:2');
  assert.match(seen.contentRef, /已读/);
  await assert.rejects(service.markSeen(ACCOUNT, {folder: 'INBOX', uid: 999, idempotencyKey: 'k2'}), err => err.code === 'NOT_FOUND');
});

test('发送确认：messageId 进 externalId，幂等键重放返回一致结果且不重发', async () => {
  const {provider, service} = makeService();
  const first = await service.send(ACCOUNT, {to: 'lead@example.com', subject: '周报', text: '内容', idempotencyKey: 's1'});
  assert.equal(first.state, 'confirmed');
  validateContract('connectorAction', first);
  const repeat = await service.send(ACCOUNT, {to: 'lead@example.com', subject: '周报', text: '内容', idempotencyKey: 's1'});
  assert.deepEqual(first, repeat);
  assert.equal(provider.outbox().length, 1, '同幂等键只发一次');
});

test('发送超时 → state unknown（不是失败）：先核对结果，同键重放仍 unknown 不盲重发', async () => {
  const {provider, service} = makeService();
  const timed = await service.send(ACCOUNT, {to: 'lead@example.com', subject: '急', text: 'x', timeoutMs: 0, idempotencyKey: 't1'});
  assert.equal(timed.state, 'unknown');
  assert.equal(timed.externalId, undefined);
  assert.ok(timed.evidenceRefs.some(ref => ref.includes('unconfirmed')), '证据链标注未确认');
  const recheck = await service.send(ACCOUNT, {to: 'lead@example.com', subject: '急', text: 'x', timeoutMs: 30_000, idempotencyKey: 't1'});
  assert.equal(recheck.state, 'unknown', '同键核对不产生第二次发送');
  assert.equal(provider.outbox().length, 1, '只存在一封（可能已发出的）邮件');
});

test('输入校验：非法地址/主题/空幂等键拒绝', async () => {
  const {service} = makeService();
  await assert.rejects(service.send(ACCOUNT, {to: 'not-an-address', subject: 's', text: 'x', idempotencyKey: 'k'}), /email address/);
  await assert.rejects(service.send(ACCOUNT, {to: 'a@b.c', subject: '', text: 'x', idempotencyKey: 'k'}), /1\.\.500/);
  await assert.rejects(service.send(ACCOUNT, {to: 'a@b.c', subject: 's', text: 'x', idempotencyKey: ''}), /idempotencyKey/);
  void ProtocolError;
});

test('搜索与单条读取；不存在返回 NOT_FOUND', async () => {
  const {service} = makeService();
  const found = await service.search(ACCOUNT, '站会', {});
  assert.equal(found.items.length, 1);
  assert.match(found.items[0].contentRef, /站会纪要/);
  const item = await service.getItem(ACCOUNT, 'INBOX', 4);
  assert.equal(item.externalId, 'INBOX:4');
  assert.equal(item.occurredAt, '2026-11-01T05:30:00.000Z', 'Date 头原样保留（含跨 DST 事件）');
  await assert.rejects(service.getItem(ACCOUNT, 'INBOX', 99), err => err.code === 'NOT_FOUND');
});

test('连接器：manifest、健康状态、未连接拒绝、fetchChanges/getItem/performAction 全链路', async () => {
  const {service} = makeService();
  const connector = new MailConnector(service, MAIL_CONNECTOR_VERSION);
  validateContract('connector', connector.manifest);
  assert.equal(connector.manifest.accountTypes[0], 'qq');
  assert.equal(connector.manifest.authentication, 'password');
  assert.equal(connector.manifest.syncStrategy, 'incremental');
  assert.equal(connector.health().state, 'disconnected');
  await assert.rejects(connector.fetchChanges({accountRef: ACCOUNT, limit: 5}), err => err.code === 'UNAUTHORIZED');
  connector.connect();

  const page = await connector.fetchChanges({accountRef: ACCOUNT, limit: 4});
  assert.equal(page.items.length, 4);
  assert.ok(page.hasMore);
  assert.match(page.nextCursor, /^\d+:\d+$/);
  const page2 = await connector.fetchChanges({accountRef: ACCOUNT, cursor: page.nextCursor, limit: 4});
  const overlap = page.items.filter(item => page2.items.some(other => other.externalId === item.externalId));
  assert.equal(overlap.length, 0);

  const direct = await connector.getItem(ACCOUNT, 'INBOX:3');
  assert.equal(direct.externalId, 'INBOX:3');

  const seen = await connector.performAction({accountRef: ACCOUNT, action: 'mark_seen', input: {folder: 'INBOX', uid: 3}, idempotencyKey: 'mk-1'});
  assert.equal(seen.state, 'confirmed');
  const sent = await connector.performAction({accountRef: ACCOUNT, action: 'send', input: {to: 'x@y.z', subject: 't', text: 'b'}, idempotencyKey: 'sd-1'});
  assert.equal(sent.state, 'confirmed');
  await assert.rejects(
    connector.performAction({accountRef: ACCOUNT, action: 'delete', input: {}, idempotencyKey: 'nope'}),
    err => err.code === 'UNSUPPORTED_CAPABILITY',
  );
});

test('messageFromImap：envelope 边界（缺 from/subject/date）映射稳定', () => {
  const full = messageFromImap(7, 'INBOX', {
    from: [{address: 'a@b.c', name: '甲'}], to: [{address: 'me@qq.com'}],
    subject: '标题', date: new Date('2026-09-06T09:00:00.000Z'), messageId: '<m1@x>',
  }, false);
  assert.equal(full.from, 'a@b.c');
  assert.equal(full.fromName, '甲');
  assert.equal(full.sentAt, '2026-09-06T09:00:00.000Z');
  assert.equal(full.messageId, '<m1@x>');

  const empty = messageFromImap(8, 'INBOX', {}, true);
  assert.equal(empty.from, 'unknown@unknown');
  assert.equal(empty.subject, '(无主题)');
  assert.equal(empty.sentAt, null);
  assert.equal(empty.seen, true);
});

test('工具 mail.inbox 经 FakeToolHost 的 schema 与 scope 校验', async () => {
  const clock = new FakeClock(NOW);
  const host = new FakeToolHost(clock.now);
  const provider = new FakeMailProvider();
  const dispose = register(host, {provider, accountRef: ACCOUNT, now: clock.now});
  const context = {taskId: 't', runId: 'r', signal: new AbortController().signal, deadline: '2026-09-07T03:00:00.000Z', authorizationRef: 'test', scopes: ['mail:read']};

  const page = await host.invoke('mail.inbox', {limit: 3}, context);
  assert.equal(page.items.length, 3);
  assert.equal(page.folder, 'INBOX');
  for (const item of page.items) validateContract('connectorItem', item);
  const page2 = await host.invoke('mail.inbox', {cursor: page.nextCursor, limit: 3}, context);
  assert.equal(page2.items.length, 3);
  await assert.rejects(host.invoke('mail.inbox', {}, {...context, scopes: []}), err => err.code === 'SCOPE_DENIED');
  await assert.rejects(host.invoke('mail.inbox', {cursor: 'garbage'}, context), err => err.code === 'INVALID_ARGUMENT');
  assert.throws(() => register(host, {}), /provider must be explicitly configured/);
  dispose();
});

const LIVE = process.env.PA_MAIL_LIVE === '1';
const LIVE_SKIP = LIVE ? false : 'set PA_MAIL_LIVE=1, PA_QQ_MAIL_USER and PA_QQ_MAIL_AUTH_CODE to run the real QQ read-back';

test('live QQ mail read-back (read-only, no send)', {skip: LIVE_SKIP}, async () => {
  const {QQMailProvider} = await import('../dist/index.js');
  const provider = new QQMailProvider({user: process.env.PA_QQ_MAIL_USER, authCode: process.env.PA_QQ_MAIL_AUTH_CODE});
  try {
    const folders = await provider.listFolders('live');
    assert.ok(folders.some(folder => folder.role === 'inbox'), `folders: ${JSON.stringify(folders)}`);
    const page = await provider.fetchPage('live', {folder: 'INBOX', limit: 5});
    assert.ok(Array.isArray(page.messages));
    assert.ok(page.uidValidity > 0, 'uidValidity captured for cursor semantics');
  } finally {
    await provider.dispose();
  }
});

test('live QQ mail send (opt-in separately, sends a real message)', {skip: process.env.PA_MAIL_LIVE_SEND === '1' ? false : 'set PA_MAIL_LIVE=1, PA_MAIL_LIVE_SEND=1, PA_QQ_MAIL_USER, PA_QQ_MAIL_AUTH_CODE and PA_QQ_MAIL_TO to send a real test mail'}, async () => {
  const {QQMailProvider} = await import('../dist/index.js');
  const provider = new QQMailProvider({user: process.env.PA_QQ_MAIL_USER, authCode: process.env.PA_QQ_MAIL_AUTH_CODE});
  try {
    const result = await provider.send('live', {
      to: process.env.PA_QQ_MAIL_TO,
      subject: 'PersonalAgent MOD-21 发送链路验证',
      text: '这是 MOD-21 邮件连接器的真实发送验证邮件，可忽略。',
      timeoutMs: 30_000,
      idempotencyKey: `mod21-live-${Date.now()}`,
    });
    assert.equal(result.state, 'confirmed', JSON.stringify(result));
  } finally {
    await provider.dispose();
  }
});
