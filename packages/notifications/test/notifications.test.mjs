import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  NOTIFICATIONS_MODULE_VERSION,
  NotificationService,
  assertPolicyValid,
  localMinuteOfDay,
  nextQuietEndMs,
  quietHoursActive,
  register,
} from '../dist/index.js';
import {FakeClock, FakeStorage, FakeToolHost} from '@personal-agent/testkit';
import {validateContract} from '@personal-agent/contracts';

/** 北京 2026-09-07 周一 12:00（午间，任何常规安静窗口之外）。 */
const NOON = Date.parse('2026-09-07T04:00:00.000Z');

function item(dedupeKey, source = 'feeds') {
  return {
    source,
    accountRef: 'acct',
    externalId: `ext-${dedupeKey}`,
    occurredAt: '2026-09-07T00:00:00.000Z',
    fetchedAt: '2026-09-07T04:00:00.000Z',
    contentRef: `内容 ${dedupeKey}`,
    sensitivity: 'normal',
    dedupeKey,
  };
}

function makeService(policy, startMs = NOON) {
  const clock = new FakeClock(startMs);
  const storage = new FakeStorage().namespace('notifications');
  let counter = 0;
  const service = new NotificationService(storage, policy, {now: clock.now, idFactory: () => `n${++counter}`});
  return {clock, storage, service};
}

test('安静时段判定：正常窗口、跨午夜窗口与不覆盖时刻', () => {
  const quiet = {startLocal: '22:00', endLocal: '07:00', timeZone: 'Asia/Shanghai'};
  assert.equal(quietHoursActive(quiet, Date.parse('2026-09-07T15:00:00.000Z')), true, '北京 23:00 在窗口内');
  assert.equal(quietHoursActive(quiet, Date.parse('2026-09-07T22:30:00.000Z')), true, '北京 06:30 早段仍在窗口内');
  assert.equal(quietHoursActive(quiet, NOON), false, '北京 12:00 不在窗口内');
  const day = {startLocal: '09:00', endLocal: '17:00', timeZone: 'Asia/Shanghai'};
  assert.equal(quietHoursActive(day, Date.parse('2026-09-07T02:00:00.000Z')), true, '北京 10:00 在日间窗口 09:00-17:00 内');
  assert.equal(quietHoursActive(day, Date.parse('2026-09-07T09:30:00.000Z')), false, '北京 17:30 已出窗（end 不含）');
});

test('安静窗口在 DST 切换日照旧成立（纽约 22:00-07:00，跨回拨夜）', () => {
  const quiet = {startLocal: '22:00', endLocal: '07:00', timeZone: 'America/New_York'};
  // 2026-11-01 纽约回拨夜：05:30Z=01:30 EDT，06:30Z=01:30 EST —— 两者都应是安静期（01:30 < 07:00）
  assert.equal(quietHoursActive(quiet, Date.parse('2026-11-01T05:30:00.000Z')), true);
  assert.equal(quietHoursActive(quiet, Date.parse('2026-11-01T06:30:00.000Z')), true, '回拨后的同一墙上时刻仍安静');
  assert.equal(quietHoursActive(quiet, Date.parse('2026-11-01T13:00:00.000Z')), false, '纽约 08:00 已出窗');
});

test('localMinuteOfDay 与 nextQuietEndMs 基本事实', () => {
  assert.equal(localMinuteOfDay(Date.parse('2026-09-07T04:30:00.000Z'), 'Asia/Shanghai'), 12 * 60 + 30);
  const quiet = {startLocal: '22:00', endLocal: '07:00', timeZone: 'Asia/Shanghai'};
  const end = nextQuietEndMs(quiet, Date.parse('2026-09-07T15:00:00.000Z'));
  assert.equal(end, Date.parse('2026-09-07T23:00:00.000Z'), '北京 23:00 → 下一个 07:00 是次日 23:00Z');
  assert.equal(nextQuietEndMs(quiet, NOON), null, '不在安静期返回 null');
});

test('立即裁定：安静窗外的事件一次性交付并去重', () => {
  const {service} = makeService({});
  const {accepted, duplicates} = service.ingest([item('k1'), item('k2'), item('k1')]);
  assert.deepEqual({accepted, duplicates}, {accepted: 2, duplicates: 1});
  const first = service.drain();
  assert.equal(first.batches.length, 1);
  assert.equal(first.batches[0].kind, 'immediate');
  assert.deepEqual(first.batches[0].itemRefs, ['k1', 'k2']);
  assert.equal(first.held.quiet, 0);
  const second = service.drain();
  assert.equal(second.batches.length, 1, '未确认批次在确认前会被 drain 再次返回（恢复语义）');
  assert.deepEqual(second.batches[0].itemRefs, ['k1', 'k2']);
  assert.equal(second.batches[0].id, first.batches[0].id, '同一批次，不重复生成');
  service.acknowledge(first.batches[0].id);
  const afterAck = service.drain();
  assert.equal(afterAck.batches.length, 0, '确认后不再返回');
  const again = service.ingest([item('k1')]);
  assert.equal(again.accepted, 0, '交付过的 dedupeKey 不再进入待裁');
});

test('安静时段：hold 到出窗，出窗后 drain 交付', () => {
  // 北京 23:00 起步（安静期 22:00-07:00）
  const {clock, service} = makeService({quietHours: {startLocal: '22:00', endLocal: '07:00', timeZone: 'Asia/Shanghai'}}, Date.parse('2026-09-07T15:00:00.000Z'));
  service.ingest([item('q1')]);
  const held = service.drain();
  assert.equal(held.batches.length, 0);
  assert.equal(held.held.quiet, 1);
  const status = service.status();
  assert.equal(status.quietUntil, '2026-09-07T23:00:00.000Z');
  clock.advance(8 * 3_600_000); // 到北京 07:00 出窗
  const delivered = service.drain();
  assert.equal(delivered.batches.length, 1);
  assert.deepEqual(delivered.batches[0].itemRefs, ['q1']);
  assert.equal(delivered.batches[0].heldSince > delivered.batches[0].decidedAt, false);
});

test('暂停：hold 一切（含摘要）并在 pauseUntilUtc 过后自动恢复', () => {
  const {clock, service} = makeService({pauseUntilUtc: '2026-09-07T05:00:00.000Z', digest: {windowMs: 60_000, maxItems: 10, sources: ['feeds']}}, NOON);
  service.ingest([item('p1')]);
  const held = service.drain();
  assert.equal(held.batches.length, 0);
  assert.equal(held.held.paused, 1);
  assert.equal(service.status().pausedUntil, '2026-09-07T05:00:00.000Z');
  clock.advance(3_600_000);
  const resumed = service.drain();
  assert.ok(resumed.batches.length >= 1, '暂停结束，摘要窗口早已超时，应立即产出摘要');
  assert.equal(resumed.batches[0].kind, 'digest');
  assert.equal(service.status().pausedUntil, null, '过期后状态不再报告暂停');
});

test('聚合：窗口关闭触发摘要；达上限提前触发；非聚合来源立即交付', () => {
  const {clock, service} = makeService({digest: {windowMs: 3_600_000, maxItems: 3, sources: ['feeds']}}, NOON);
  service.ingest([item('d1'), item('d2'), item('mail-1', 'mail')]);
  const mixed = service.drain();
  assert.equal(mixed.batches.length, 1, 'mail 来源不在聚合范围，立即交付');
  assert.deepEqual(mixed.batches[0].itemRefs, ['mail-1']);
  assert.equal(mixed.held.digest, 2);
  service.acknowledge(mixed.batches[0].id);
  clock.advance(3_600_000);
  const closed = service.drain();
  assert.equal(closed.batches.length, 1);
  assert.equal(closed.batches[0].kind, 'digest');
  assert.equal(closed.batches[0].reason, 'digest_window_closed');
  assert.deepEqual(closed.batches[0].itemRefs, ['d1', 'd2']);

  const {service: capped} = makeService({digest: {windowMs: 86_400_000, maxItems: 2}}, NOON);
  capped.ingest([item('c1'), item('c2')]);
  const flushed = capped.drain();
  assert.equal(flushed.batches[0].reason, 'digest_max_items', '上限优先于窗口');
});

test('聚合交付尊重安静时段：窗口到了但仍在安静期，继续持有', () => {
  const {clock, service} = makeService(
    {
      quietHours: {startLocal: '22:00', endLocal: '07:00', timeZone: 'Asia/Shanghai'},
      digest: {windowMs: 60_000, maxItems: 10},
    },
    Date.parse('2026-09-07T15:00:00.000Z'),
  );
  service.ingest([item('dq1')]);
  clock.advance(2 * 3_600_000);
  const suppressed = service.drain();
  assert.equal(suppressed.batches.length, 0);
  assert.equal(suppressed.held.digest, 1, '摘要窗口已关但安静期压制');
});

test('调度建议：安静结束与摘要关闭各一条，字段与 ScheduleInput 结构兼容且幂等键确定', () => {
  const {service} = makeService(
    {
      quietHours: {startLocal: '22:00', endLocal: '07:00', timeZone: 'Asia/Shanghai'},
      digest: {windowMs: 3_600_000, maxItems: 10},
    },
    Date.parse('2026-09-07T15:00:00.000Z'),
  );
  service.ingest([item('s1')]);
  const plans = service.planSchedules('conv-1');
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.deepEqual(
      Object.keys(plan).sort(),
      ['conversationId', 'goal', 'missedRunPolicy', 'runAt', 'scheduleId', 'taskIdempotencyKey', 'timeZone'],
      '字段集与 Runtime ScheduleInput 结构兼容',
    );
    assert.equal(plan.missedRunPolicy, 'run_once');
    assert.equal(plan.scheduleId, plan.taskIdempotencyKey);
    assert.equal(plan.conversationId, 'conv-1');
  }
  assert.ok(plans.some(plan => plan.scheduleId.startsWith('notifications:quiet-end:')));
  assert.ok(plans.some(plan => plan.scheduleId.startsWith('notifications:digest:')));
  const repeat = service.planSchedules('conv-1');
  assert.deepEqual(plans, repeat, '同一时刻重复规划结果确定');
});

test('策略校验拒绝畸形输入', () => {
  assert.throws(() => assertPolicyValid({quietHours: {startLocal: '25:00', endLocal: '07:00', timeZone: 'Asia/Shanghai'}}), /HH:mm/);
  assert.throws(() => assertPolicyValid({quietHours: {startLocal: '22:00', endLocal: '22:00', timeZone: 'Asia/Shanghai'}}), /not be empty/);
  assert.throws(() => assertPolicyValid({quietHours: {startLocal: '22:00', endLocal: '07:00', timeZone: 'Mars/Olympus'}}), /IANA/);
  assert.throws(() => assertPolicyValid({pauseUntilUtc: 'tomorrow'}), /ISO-8601/);
  assert.throws(() => assertPolicyValid({digest: {windowMs: 1000, maxItems: 5}}), /60000/);
  assert.throws(() => assertPolicyValid({digest: {windowMs: 60_000, maxItems: 0}}), /1\.\.100/);
});

test('ingest 拒绝非 ConnectorItem 形状的输入', () => {
  const {service} = makeService({});
  assert.throws(() => service.ingest([{no: 'dedupeKey'}]), /ConnectorItems/);
});

test('工具 notifications.status 经 FakeToolHost 的 schema 与 scope 校验', async () => {
  const clock = new FakeClock(Date.parse('2026-09-07T15:00:00.000Z'));
  const storage = new FakeStorage().namespace('notifications');
  const host = new FakeToolHost(clock.now);
  const dispose = register(host, {
    storage,
    policy: {quietHours: {startLocal: '22:00', endLocal: '07:00', timeZone: 'Asia/Shanghai'}},
    now: clock.now,
  });
  const context = {taskId: 't', runId: 'r', signal: new AbortController().signal, deadline: '2026-09-07T16:00:00.000Z', authorizationRef: 'test', scopes: ['notifications:read']};
  const status = await host.invoke('notifications.status', {}, context);
  assert.equal(status.quietUntil, '2026-09-07T23:00:00.000Z');
  assert.equal(status.policy.quietHoursConfigured, true);
  assert.equal(status.policy.digestConfigured, false);
  assert.equal(status.pending, 0);
  await assert.rejects(host.invoke('notifications.status', {}, {...context, scopes: []}), err => err.code === 'SCOPE_DENIED');
  assert.throws(() => register(host, {storage}), /policy must be explicitly provided/);
  assert.throws(() => register(host, {storage, policy: {digest: {windowMs: 1, maxItems: 1}}}), /60000/);
  dispose();
  void NOTIFICATIONS_MODULE_VERSION;
  void validateContract;
});

test('崩溃恢复：drain 后、桌面确认前重启，仍取得相同批次且不重复生成', () => {
  const storage = new FakeStorage().namespace('notifications');
  let counter = 0;
  const first = new NotificationService(storage, {}, {now: () => NOON, idFactory: () => `n${++counter}`});
  first.ingest([item('r1'), item('r2')]);
  const before = first.drain();
  assert.equal(before.batches.length, 1);
  assert.equal(before.batches[0].state, 'ready_for_delivery');

  // 模拟崩溃：同一存储上新建实例（重启）
  const restarted = new NotificationService(storage, {}, {now: () => NOON, idFactory: () => `n${++counter}`});
  const recovered = restarted.drain();
  assert.equal(recovered.batches.length, 1);
  assert.deepEqual(recovered.batches[0], before.batches[0], '批次 id/条目引用/状态原样取回');
  assert.equal(restarted.status().unacknowledgedBatches, 1);
  // 重启后同一批事件不会再次进入待裁（条目级 delivered 标记持久）
  const reingest = restarted.ingest([item('r1'), item('r2')]);
  assert.deepEqual(reingest, {accepted: 0, duplicates: 2});
});

test('确认后重启不重复通知；acknowledge 幂等且未知 id 报 NOT_FOUND', () => {
  const storage = new FakeStorage().namespace('notifications');
  let counter = 0;
  const first = new NotificationService(storage, {}, {now: () => NOON, idFactory: () => `n${++counter}`});
  first.ingest([item('a1')]);
  const [batch] = first.drain().batches;
  const acked = first.acknowledge(batch.id);
  assert.equal(acked.state, 'delivered');
  first.acknowledge(batch.id); // 幂等
  assert.throws(() => first.acknowledge('ghost'), err => err.code === 'NOT_FOUND');

  const restarted = new NotificationService(storage, {}, {now: () => NOON, idFactory: () => `n${++counter}`});
  const after = restarted.drain();
  assert.equal(after.batches.length, 0, '确认过的批次重启后不再返回');
  assert.equal(restarted.status().unacknowledgedBatches, 0);
});

test('DST 春季跳时：纽约 22:00–02:30 窗口在 02:30 不存在的当天，于首次离开安静区（03:00 EDT）释放', () => {
  const quiet = {startLocal: '22:00', endLocal: '02:30', timeZone: 'America/New_York'};
  // 2026-03-08 06:30Z = 纽约 01:30 EST（跳跃前），在窗口内
  const inWindow = Date.parse('2026-03-08T06:30:00.000Z');
  assert.equal(quietHoursActive(quiet, inWindow), true);
  const end = nextQuietEndMs(quiet, inWindow);
  assert.equal(end, Date.parse('2026-03-08T07:00:00.000Z'), '跳跃发生在 07:00Z（02:00 EST→03:00 EDT），越过 02:30 即出窗');
  // 旧实现按 endLocal 分钟数匹配，02:30 当天不存在 → 扫 26 小时返回 null
  // 回拨夜不受影响：2026-11-01 从 05:00Z（01:00 EDT）起，回拨后本地重走 01:00–01:59（EST），
  // 02:30 当晚只出现一次（02:30 EST = 07:30Z）——首次离开安静区即在那里
  const fallBack = {startLocal: '22:00', endLocal: '02:30', timeZone: 'America/New_York'};
  const inFall = Date.parse('2026-11-01T05:00:00.000Z');
  assert.equal(nextQuietEndMs(fallBack, inFall), Date.parse('2026-11-01T07:30:00.000Z'), '回拨夜在 02:30 唯一一次出现时释放');
});

test('原子性：唯一写入点注入异常 → 整体不生效，重试后批次恰好出现一次（不丢通知）', () => {
  // 故障注入存储：第 failOn 次 set 抛出（模拟写入落盘前崩溃）
  const makeFlakyStorage = (failOn) => {
    const inner = new FakeStorage().namespace('notifications');
    let calls = 0;
    return {
      get: key => inner.get(key),
      set: (key, value) => {
        calls += 1;
        if (calls === failOn) throw new Error('injected storage failure at write');
        inner.set(key, value);
      },
      delete: key => inner.delete(key),
    };
  };
  let counter = 0;
  const idFactory = () => `n${++counter}`;

  // drain 的状态写入失败（写入序：ingest=1、drain=2）：旧状态必须原样保留（不丢 pending、不加去重标记、无半成品批次）
  const flaky = makeFlakyStorage(2);
  const service1 = new NotificationService(flaky, {}, {now: () => NOON, idFactory});
  service1.ingest([item('f1')]);
  assert.throws(() => service1.drain(), /injected storage failure/);
  const healthy = new NotificationService(flaky, {}, {now: () => NOON, idFactory});
  assert.equal(healthy.status().pending, 1, '失败的 drain 未消费 pending');
  const recovered = healthy.drain();
  assert.equal(recovered.batches.length, 1, '重试后批次正常产出');
  const again = healthy.ingest([item('f1')]);
  assert.equal(again.accepted, 0, '事件只计一次，未因失败重复待裁');

  // acknowledge 写入失败（写入序：ingest=1、drain=2、ack=3）：批次保持 ready，重试确认成功
  const flaky2 = makeFlakyStorage(3);
  const service2 = new NotificationService(flaky2, {}, {now: () => NOON, idFactory});
  service2.ingest([item('f2')]);
  const [batch] = service2.drain().batches;
  assert.throws(() => service2.acknowledge(batch.id), /injected storage failure/);
  const afterFailure = new NotificationService(flaky2, {}, {now: () => NOON, idFactory});
  assert.equal(afterFailure.status().unacknowledgedBatches, 1, '确认失败后批次仍待交付');
  const acked = afterFailure.acknowledge(batch.id);
  assert.equal(acked.state, 'delivered');

  // ingest 写入失败：条目不半途进入待裁
  const flaky3 = makeFlakyStorage(1);
  const service3 = new NotificationService(flaky3, {}, {now: () => NOON, idFactory});
  assert.throws(() => service3.ingest([item('f3')]), /injected storage failure/);
  const afterIngest = new NotificationService(flaky3, {}, {now: () => NOON, idFactory});
  assert.equal(afterIngest.status().pending, 0, '失败的 ingest 未产生半途状态');
  afterIngest.ingest([item('f3')]);
  assert.equal(afterIngest.status().pending, 1);
});
