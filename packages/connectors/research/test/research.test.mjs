import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  FakeResearchProvider,
  OpenAlexProvider,
  ResearchConnector,
  RESEARCH_CONNECTOR_VERSION,
  ResearchService,
  defaultResearchFixtures,
  register,
} from '../dist/index.js';
import {FakeClock, FakeToolHost} from '@personal-agent/testkit';
import {ProtocolError, validateContract} from '@personal-agent/contracts';

const NOW = Date.parse('2026-09-08T00:00:00.000Z');
const ACCOUNT = 'research-me';

function makeService(options = {}, fixtures = defaultResearchFixtures) {
  const provider = new FakeResearchProvider(fixtures);
  const service = new ResearchService(provider, {now: () => NOW, ...options});
  return {provider, service};
}

test('检索返回带时间与来源的材料，每条过 connectorItem 契约校验', async () => {
  const {service} = makeService();
  const result = await service.search(ACCOUNT, 'agent', {});
  assert.ok(result.results.length >= 1);
  for (const entry of result.results) {
    validateContract('connectorItem', entry.record);
    assert.equal(entry.record.source, 'research');
    assert.equal(entry.record.sensitivity, 'public');
    assert.match(entry.record.dedupeKey, /^research:/);
  }
  assert.equal(result.cache.state, 'fetched');
});

test('PA-010 失败/过期区分：新鲜材料 fresh，1999 年材料 stale 但仍返回', async () => {
  const {service} = makeService();
  const result = await service.search(ACCOUNT, 'survey', {});
  const stale = result.results.find(entry => entry.record.externalId === 'W-fixture-1999');
  assert.ok(stale, '旧材料在结果里');
  assert.equal(stale.freshness, 'stale');
  assert.ok(stale.ageMs > 365 * 86_400_000);
  assert.match(stale.record.validFor, /^1999-12-01T00:00:00\.000Z\//, 'validFor 承载时效窗口');
  const fresh = await service.search(ACCOUNT, 'architectures', {});
  assert.ok(fresh.results.every(entry => entry.freshness === 'fresh'));
});

test('无发布时间的材料：occurredAt 回退抓取时刻且显式标注 fetched_fallback', async () => {
  const {service} = makeService();
  const result = await service.search(ACCOUNT, 'preprint', {});
  const noDate = result.results.find(entry => entry.record.externalId === 'W-fixture-nodate');
  assert.ok(noDate);
  assert.equal(noDate.publishedTimeKind, 'fetched_fallback');
  assert.equal(noDate.publishedAt, '2026-09-08T00:00:00.000Z', '回退到获取时间');
  assert.match(noDate.record.contentRef, /无发布时间，取抓取时刻/);
  assert.equal(noDate.record.validFor, undefined, '无发布时间不给时效窗口');
  assert.equal(noDate.freshness, 'fresh', '无发布时间不判过期');
});

test('缓存三态：TTL 内 fresh 不打提供商；过期重取 fetched；可重试失败回退 stale 附 lastError', async () => {
  const {provider, service} = makeService({cacheTtlMs: 600_000});
  const first = await service.search(ACCOUNT, 'agent', {});
  assert.equal(first.cache.state, 'fetched');
  provider.setFailure(new ProtocolError('RATE_LIMITED', 'limit hit', true, 60_000));
  const cached = await service.search(ACCOUNT, 'agent', {});
  assert.equal(cached.cache.state, 'fresh', 'TTL 内命中缓存，不打提供商');

  // 过期 + 可重试失败 → 回退 stale 并附 lastError（缓存先在成功时预热，再让时钟越过 TTL）
  let offset = 700_000;
  const later = {now: () => NOW + offset};
  const expired = new ResearchService(provider, {now: later.now, cacheTtlMs: 600_000});
  provider.setFailure(null);
  await expired.search(ACCOUNT, 'agent', {}); // 预热该实例的缓存（时刻 = NOW+700s）
  offset += 700_000; // 时钟越过 TTL
  provider.setFailure(new ProtocolError('RATE_LIMITED', 'limit hit again', true, 60_000));
  const degraded = await expired.search(ACCOUNT, 'agent', {});
  assert.equal(degraded.cache.state, 'stale', '缓存过期 + 可重试失败 → stale');
  assert.equal(degraded.cache.lastError?.code, 'RATE_LIMITED');
  assert.ok(degraded.results.length >= 1, '旧结果随披露返回，不冒充新结果');

  provider.setFailure(new ProtocolError('INVALID_ARGUMENT', 'bad query', false));
  await assert.rejects(expired.search(ACCOUNT, 'agent', {}), err => err.code === 'INVALID_ARGUMENT', '不可重试错误照实抛出');
});

test('检索失败且无缓存：照实抛出，不用任何东西冒充', async () => {
  const {provider, service} = makeService();
  provider.setFailure(new ProtocolError('EXTERNAL_FAILURE', 'network down', true));
  await assert.rejects(service.search(ACCOUNT, 'anything', {}), err => err.code === 'EXTERNAL_FAILURE');
});

test('OpenAlex 规范化：publication_date 归一当日 UTC 零点、作者/venue/DOI 提取、坏条目跳过', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {id: 'https://openalex.org/W123', display_name: 'Paper A', publication_date: '2026-01-15',
            authorships: [{author: {display_name: '甲'}}, {author: {display_name: '乙'}}],
            primary_location: {source: {display_name: 'Venue X'}}, doi: 'https://doi.org/10.x/a', cited_by_count: 7},
          {id: 'https://openalex.org/W456'}, // 无标题：跳过
          {id: 'https://openalex.org/W789', display_name: 'No date paper'}, // 无日期：null
        ],
      }),
    };
  };
  const provider = new OpenAlexProvider({fetchImpl});
  const materials = await provider.search(ACCOUNT, {query: 'anything', limit: 3});
  assert.equal(materials.length, 2);
  assert.equal(materials[0].externalId, 'W123');
  assert.equal(materials[0].publishedAt, '2026-01-15T00:00:00.000Z');
  assert.deepEqual(materials[0].authors, ['甲', '乙']);
  assert.equal(materials[0].venue, 'Venue X');
  assert.equal(materials[0].url, 'https://doi.org/10.x/a');
  assert.equal(materials[0].citedBy, 7);
  assert.equal(materials[1].publishedAt, null);
  assert.ok(calls[0].includes('per-page=3'));
  void validateContract;
});

test('连接器：manifest/健康/未连接拒绝/只读能力边界', async () => {
  const {service} = makeService();
  const connector = new ResearchConnector(service, RESEARCH_CONNECTOR_VERSION);
  validateContract('connector', connector.manifest);
  assert.equal(connector.manifest.accountTypes[0], 'openalex');
  assert.equal(connector.manifest.verification, 'mock', 'Fake 装配诚实为 mock');
  assert.equal(connector.health().state, 'disconnected');
  await assert.rejects(connector.search(ACCOUNT, 'x'), err => err.code === 'UNAUTHORIZED');
  connector.connect();
  assert.equal(connector.health().state, 'ready');
  const items = await connector.search(ACCOUNT, 'agent');
  assert.ok(items.length >= 1);
  await assert.rejects(connector.performAction({accountRef: ACCOUNT, action: 'x', input: {}, idempotencyKey: 'k'}), err => err.code === 'UNSUPPORTED_CAPABILITY');
});

test('工具 research.search 经 FakeToolHost 的 schema 与 scope 校验', async () => {
  const clock = new FakeClock(NOW);
  const host = new FakeToolHost(clock.now);
  const provider = new FakeResearchProvider();
  const dispose = register(host, {provider, accountRef: ACCOUNT, now: clock.now});
  const context = {taskId: 't', runId: 'r', signal: new AbortController().signal, deadline: '2026-09-08T01:00:00.000Z', authorizationRef: 'test', scopes: ['research:read']};

  const result = await host.invoke('research.search', {query: 'agent architectures'}, context);
  assert.ok(result.results.length >= 1);
  assert.equal(result.cache.state, 'fetched');
  await assert.rejects(host.invoke('research.search', {query: 'agent'}, {...context, scopes: []}), err => err.code === 'SCOPE_DENIED');
  await assert.rejects(host.invoke('research.search', {}, context), err => err.code === 'INVALID_ARGUMENT');
  assert.throws(() => register(host, {}), /provider must be explicitly configured/);
  dispose();
});

const LIVE = process.env.PA_RESEARCH_LIVE === '1';
const LIVE_SKIP = LIVE ? false : 'set PA_RESEARCH_LIVE=1 to run the real OpenAlex read-back';

test('live OpenAlex read-back（真实学术源，免 key）', {skip: LIVE_SKIP}, async () => {
  const provider = new OpenAlexProvider();
  const service = new ResearchService(provider, {now: Date.now});
  const result = await service.search('live', 'weather personal assistant', {limit: 5});
  assert.ok(result.results.length >= 1, '真实返回非空');
  for (const entry of result.results) {
    validateContract('connectorItem', entry.record);
    assert.ok(entry.record.externalId.startsWith('W'), `OpenAlex W-id: ${entry.record.externalId}`);
  }
  assert.equal(result.cache.state, 'fetched');
});

test('signal 一路透传：ToolContext 取消后真实 fetch 收到 abort（zemeng 09-13 P1）', async () => {
  let forwardedSignal = null;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    forwardedSignal = init.signal;
    forwardedSignal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    setTimeout(() => resolve({ok: true, status: 200, json: async () => ({results: []})}), 50);
  });
  const provider = new OpenAlexProvider({fetchImpl});
  const service = new ResearchService(provider, {now: () => NOW});
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(service.search(ACCOUNT, 'agent', {signal: controller.signal}), err => err.code === 'CANCELLED');
  assert.ok(forwardedSignal !== null && forwardedSignal.aborted, 'provider 收到的 signal 已中止');
});

test('缓存键含 limit：limit=1 后 limit=3 不得命中同键只回 1 条（zemeng 09-13 P2）', async () => {
  const {service} = makeService();
  const first = await service.search(ACCOUNT, 're', {limit: 1});
  assert.equal(first.results.length, 1);
  assert.equal(first.cache.state, 'fetched');
  const second = await service.search(ACCOUNT, 're', {limit: 3});
  assert.equal(second.cache.state, 'fetched', '不同 limit 是不同缓存键，重新检索');
  assert.equal(second.results.length, 3, '拿到请求的全部 3 条而非缓存里的 1 条');
});
