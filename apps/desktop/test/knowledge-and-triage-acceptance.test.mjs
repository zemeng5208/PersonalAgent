import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {openReadOnlyVault} from '@personal-agent/knowledge/filesystem';
import {createKnowledgeSearchTool, KNOWLEDGE_SEARCH_TOOL_NAME, KNOWLEDGE_READ_SCOPE} from '@personal-agent/knowledge/tool';
import {LayaTriageService, decideInterest, decideKnowledgeFreshness} from '@personal-agent/cognition';
import {createInboxTriagePipeline} from '@personal-agent/runtime/application';
import {createEncryptedModuleStorage} from '../electron/encrypted-module-storage.js';

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: val => Buffer.from(val).reverse(),
  decryptString: buf => Buffer.from(buf).reverse().toString(),
};

test('Knowledge vault: incremental Markdown ingestion, dynamic query, citation integrity, and change detection', async t => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'pa-knowledge-vault-'));
  const vaultDir = path.join(baseDir, 'notes');
  mkdirSync(vaultDir, {recursive: true});

  t.after(() => {
    rmSync(baseDir, {recursive: true, force: true});
  });

  // 1. 初始写入两篇合成笔记
  const planFile = path.join(vaultDir, 'project-plan.md');
  const meetingFile = path.join(vaultDir, 'weekly-meeting.md');
  writeFileSync(planFile, '# 架构设计\nPersonalAgent 采用 Windows 本地模块化单体架构。\n数据本地持久化存储。\n', 'utf8');
  writeFileSync(meetingFile, '# 周会纪要\n本周目标是完成第一版 MVP 全链路接线。\n重点包含连接器和知识检索。\n', 'utf8');

  // 2. 装配只读 Vault 与 Knowledge 工具
  const vault = await openReadOnlyVault({vaultId: 'synthetic-vault', rootPath: vaultDir});
  const tool = createKnowledgeSearchTool(vault);

  const context = {
    taskId: 'knowledge-task-1',
    runId: randomUUID(),
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    scopes: [KNOWLEDGE_READ_SCOPE],
    authorizationRef: 'auth-knowledge-1',
  };

  // 3. 执行检索：查询 "单体架构"
  const searchResult1 = await tool.execute({query: '单体架构', limit: 5}, context);
  assert.ok(Array.isArray(searchResult1.hits));
  assert.equal(searchResult1.hits.length, 1);
  const hit1 = searchResult1.hits[0];
  assert.equal(hit1.source.path, 'project-plan.md');
  assert.equal(hit1.source.line, 2);
  assert.match(hit1.excerpt, /PersonalAgent 采用 Windows 本地模块化单体架构/);
  assert.match(hit1.source.revision, /^[0-9a-f]{64}$/);

  // 4. 读回精确引用
  const citation1 = await vault.readCitation({
    source: hit1.source,
    deadline: context.deadline,
    signal: context.signal,
  });
  assert.equal(citation1, 'PersonalAgent 采用 Windows 本地模块化单体架构。');

  // 5. 增量摄取测试：动态添加新笔记与修改现有笔记
  const newFeatureFile = path.join(vaultDir, 'subagent-spec.md');
  writeFileSync(newFeatureFile, '# 次级智能体规范\n每个子 Agent 拥有独立角色设定与思考预算。\n', 'utf8');
  writeFileSync(planFile, '# 架构设计\nPersonalAgent 升级为混合端云架构协同体系。\n数据本地持久化存储。\n', 'utf8');

  // 6. 重新执行检索：立即感知新摄取的文件与更新内容（无需重启进程）
  const searchResult2 = await tool.execute({query: '思考预算', limit: 5}, context);
  assert.equal(searchResult2.hits.length, 1);
  assert.equal(searchResult2.hits[0].source.path, 'subagent-spec.md');
  assert.match(searchResult2.hits[0].excerpt, /每个子 Agent 拥有独立角色设定与思考预算/);

  const searchResult3 = await tool.execute({query: '协同体系', limit: 5}, context);
  assert.equal(searchResult3.hits.length, 1);
  assert.match(searchResult3.hits[0].excerpt, /升级为混合端云架构协同体系/);
  assert.notEqual(searchResult3.hits[0].source.revision, hit1.source.revision);

  // 7. 防陈旧幻觉验证：旧 revision 的引用读回被严格拒绝 (SOURCE_CHANGED)
  await assert.rejects(vault.readCitation({
    source: hit1.source,
    deadline: context.deadline,
    signal: context.signal,
  }), {name: 'KnowledgeError', code: 'SOURCE_CHANGED'});

  // 8. 越界保护验证：越界路径严格被拒
  await assert.rejects(vault.readCitation({
    source: {vaultId: 'synthetic-vault', path: '../outside.md', line: 1, revision: hit1.source.revision},
    deadline: context.deadline,
    signal: context.signal,
  }), /invalid_argument|scope_denied/i);
});

test('Mail triage: realistic local Laya batch classification, timing measurement and category output', async t => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'pa-mail-triage-bench-'));
  const userDataDir = path.join(baseDir, 'user-data');
  mkdirSync(userDataDir, {recursive: true});

  t.after(() => {
    rmSync(baseDir, {recursive: true, force: true});
  });

  const storage = createEncryptedModuleStorage({
    userData: userDataDir,
    safeStorage,
    filename: 'mail-benchmark.json',
  });

  // 1. 模拟真实本地 Laya 批处理分类器，每批最多处理 4 封邮件，记录批次耗时
  const batchDurations = [];
  const syntheticLaya = new LayaTriageService({
    async infer(payload) {
      const start = performance.now();
      const events = payload.state.events;
      // 模拟端侧小模型真实推理时延（每封邮件 ~15ms）
      await new Promise(resolve => setTimeout(resolve, events.length * 15));
      const duration = performance.now() - start;
      batchDurations.push({count: events.length, durationMs: duration});

      const answer = (choice, probabilities) => ({
        choice,
        probabilities,
        answer_confidence: Math.max(...Object.values(probabilities)),
        confidence: 0.5,
      });

      const answers = {};
      for (let i = 0; i < events.length; i++) {
        const text = String(events[i].observation || '').toLowerCase();
        let cat = 'other';
        let impact = 'routine';
        if (text.includes('meeting') || text.includes('reschedule') || text.includes('calendar')) {
          cat = 'meeting';
        } else if (text.includes('urgent') || text.includes('critical') || text.includes('p0')) {
          cat = 'work';
          impact = 'high_impact';
        } else if (text.includes('newsletter') || text.includes('digest')) {
          cat = 'subscription';
        } else if (text.includes('invoice') || text.includes('order')) {
          cat = 'transaction';
        } else {
          cat = 'work';
        }

        const catProbs = {meeting: 0.05, work: 0.05, subscription: 0.05, transaction: 0.05, other: 0.05};
        catProbs[cat] = 0.8;
        answers[`category_${i}`] = answer(cat, catProbs);
        answers[`impact_${i}`] = answer(impact, {routine: impact === 'routine' ? 0.9 : 0.1, high_impact: impact === 'high_impact' ? 0.9 : 0.1});
      }
      return {answers};
    }
  });

  const pipeline = createInboxTriagePipeline({
    storage,
    namespace: 'test-mail-namespace',
    triage: syntheticLaya,
    labels: {
      meeting: 'Meeting invitations and schedule updates',
      work: 'Technical work and urgent documents',
      subscription: 'Newsletters and updates',
      transaction: 'Invoices and receipts',
      other: 'Other subjects',
    },
    meetingLabels: ['meeting'],
    authorizeRead: () => true,
  });

  // 2. 构造 12 封合成邮件，涵盖不同类别与重要性
  const emailSubjects = [
    'Meeting: Project Sprint Planning next Monday',
    'URGENT: P0 Production Deployment Rollout',
    'Weekly Engineering Newsletter #42',
    'Invoice #2026-09 for Cloud Infrastructure',
    'Reschedule: Architecture review session',
    'Critical: Database migration deadline reminder',
    'Subscribed: AI Research Monthly Digest',
    'Your Order #8839 Confirmation & Receipt',
    'Calendar Invite: Sync with Team zemeng',
    'Security bulletin: Mandatory credential rotation',
    'GitHub Notification: 5 new pull requests opened',
    'Casual weekend lunch plans',
  ];

  const items = emailSubjects.map((subject, idx) => ({
    source: 'mail',
    accountRef: 'test-account',
    externalId: `INBOX:${idx + 1}`,
    occurredAt: '2026-09-27T10:00:00.000Z',
    fetchedAt: '2026-09-27T10:05:00.000Z',
    contentRef: subject,
    sensitivity: 'private',
    dedupeKey: `test-account:INBOX:${idx + 1}`,
  }));

  // 3. 执行批处理
  const startTime = performance.now();
  await pipeline.processPage({
    accountRef: 'test-account',
    folder: 'INBOX',
    nextCursor: '1:12',
    hasMore: false,
    items,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  });
  const totalDuration = performance.now() - startTime;

  // 4. 衡量实际耗时与批次约束（每批至多 4 封，12 封应分为 3 批）
  assert.equal(batchDurations.length, 3);
  assert.deepEqual(batchDurations.map(b => b.count), [4, 4, 4]);
  assert.ok(totalDuration >= 100, `Total duration ${totalDuration}ms should reflect realistic batch processing`);
  const throughput = (items.length / (totalDuration / 1000)).toFixed(1);
  assert.ok(Number(throughput) > 0);

  // 5. 校验分类输出与快照聚合
  const snap = pipeline.snapshot();
  assert.equal(snap.total, 12);
  assert.ok(snap.meetingCandidates >= 3, `Expected at least 3 meeting candidates, got ${snap.meetingCandidates}`);
  assert.ok(snap.highImpactCandidates >= 2, `Expected at least 2 high impact candidates, got ${snap.highImpactCandidates}`);
  assert.ok(snap.needsReview >= 3, `Expected needsReview for meeting and main_agent items`);
  assert.equal(snap.groups.meeting, snap.meetingCandidates);
  assert.ok(snap.groups.subscription >= 2);
  assert.ok(snap.groups.transaction >= 2);

  // 6. 校验私密性：全部为 headersOnly，sensitivity 为 private
  for (const record of snap.records) {
    assert.equal(record.headersOnly, true);
    assert.equal(record.sensitivity, 'private');
  }
});

test('Topic watch policy: interest inference, contextual promotion, tombstone revocation and cache freshness', () => {
  const at = '2026-09-27T12:00:00.000Z';
  const scope = {
    state: 'granted',
    id: 'scope-user-interests',
    revision: 1,
    publicLowRiskTracking: true,
    expiresAt: '2026-09-27T18:00:00.000Z',
  };
  const verifiedSource = {
    id: 'source-tech-news',
    revision: 'rev-1',
    visibility: 'public',
    risk: 'low',
    transportVerified: true,
    verificationExpiresAt: '2026-09-27T18:00:00.000Z',
  };

  const q1 = {
    id: 'ev-1',
    topicId: 'agentarts',
    sourceId: 'chat',
    sourceRevision: 'r1',
    occurredAt: '2026-09-27T11:00:00.000Z',
    interactionId: 'session-1',
    kind: 'question',
    match: 'exact',
  };

  // 1. 单次偶发问题 -> candidate
  const initial = decideInterest({
    topicId: 'agentarts',
    at,
    evidenceMaxAgeMs: 24 * 3600_000,
    watchDurationMs: 4 * 3600_000,
    evidence: [q1],
    source: verifiedSource,
    scope,
  });
  assert.equal(initial.state, 'candidate');
  assert.equal(initial.reason, 'insufficient_contextual_evidence');

  // 2. 连续上下文追踪（问题 + 后续深入追问） -> watch_public
  const f1 = {
    id: 'ev-2',
    topicId: 'agentarts',
    sourceId: 'chat',
    sourceRevision: 'r1',
    occurredAt: '2026-09-27T11:05:00.000Z',
    interactionId: 'session-1',
    kind: 'followup',
    match: 'exact',
    relatedEvidenceId: 'ev-1',
  };
  const promoted = decideInterest({
    topicId: 'agentarts',
    at,
    evidenceMaxAgeMs: 24 * 3600_000,
    watchDurationMs: 4 * 3600_000,
    evidence: [q1, f1],
    source: verifiedSource,
    scope,
  });
  assert.equal(promoted.state, 'watch_public');
  assert.equal(promoted.reason, 'topic_linked_behavior');
  assert.ok(promoted.expiresAt);

  // 3. 证据过期无新事实 -> decay
  const decayed = decideInterest({
    topicId: 'agentarts',
    at,
    evidenceMaxAgeMs: 24 * 3600_000,
    watchDurationMs: 4 * 3600_000,
    evidence: [],
    source: verifiedSource,
    scope,
    previous: {state: 'watch_public'},
  });
  assert.equal(decayed.state, 'decay');
  assert.equal(decayed.reason, 'no_current_topic_evidence');

  // 4. 用户明确撤销 (Tombstone) -> 立即 revoked
  const tombstone = {
    id: 'tomb-agentarts-1',
    topicId: 'agentarts',
    revokedAt: '2026-09-27T11:30:00.000Z',
  };
  const revoked = decideInterest({
    topicId: 'agentarts',
    at,
    evidenceMaxAgeMs: 24 * 3600_000,
    watchDurationMs: 4 * 3600_000,
    evidence: [q1, f1],
    source: verifiedSource,
    scope,
    tombstone,
  });
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.reason, 'user_revoked');

  // 5. 知识时效策略判决 (decideKnowledgeFreshness)
  const cache = {
    version: '1.0.0',
    sourceId: 'tech-doc-1',
    sourceRevision: 'hash-abc',
    contentSha256: createHash('sha256').update('Original content').digest('hex'),
    lastSuccessfulCheck: '2026-09-27T11:00:00.000Z',
    validUntil: '2026-09-27T14:00:00.000Z',
  };

  // 5a. 缓存未过期且版本一致 -> use_cache
  const fresh = decideKnowledgeFreshness({
    at,
    maxAgeMs: 3600_000,
    requestedVersion: '1.0.0',
    sourceState: 'available',
    cache,
  });
  assert.equal(fresh.action, 'use_cache');

  // 5b. 来源发生变更（receipt 为 changed） -> refresh_required
  const stale = decideKnowledgeFreshness({
    at,
    maxAgeMs: 3600_000,
    requestedVersion: '1.0.0',
    sourceState: 'available',
    cache,
    check: {
      outcome: 'changed',
      checkedAt: at,
      sourceId: cache.sourceId,
      sourceRevision: cache.sourceRevision,
      cachedContentSha256: cache.contentSha256,
    },
  });
  assert.equal(stale.action, 'refresh_required');
});
