import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openSqliteLearningHost, createEvidenceWorkflowValidator} from '../dist/index.js';

const context = () => ({deadline: '2099-01-01T00:00:00.000Z', signal: new AbortController().signal});
const at = '2026-09-30T00:00:00.000Z';
const candidate = {namespace: 'synthetic', workflowId: 'review', revision: 1,
  summary: 'Synthetic local review', steps: ['Read one confirmed source'], sourceRef: 'memory-fact:synthetic', createdAt: at};
const binding = {sourceRef: candidate.sourceRef, workflowId: 'review', revision: 1,
  skillId: 'review-skill', skillRevision: 'v1', skillContentSha256: 'a'.repeat(64),
  taskId: 'synthetic-task', evidenceId: 'synthetic-run', toolName: 'workspace.read_text', toolVersion: '1', inputDigest: 'b'.repeat(64)};
function fixture() {
  let live = true;
  const skill = {id: binding.skillId, revision: binding.skillRevision,
    contentSha256: binding.skillContentSha256, enabled: true};
  const record = {taskId: binding.taskId, evidenceId: binding.evidenceId, toolName: binding.toolName,
    toolVersion: binding.toolVersion, inputDigest: binding.inputDigest, policyDecision: 'allow',
    executionStarted: true, state: 'confirmed', finishedAt: at};
  const ports = {readBinding: async () => live ? structuredClone(binding) : null,
    readSkill: async () => structuredClone(skill),
    readCurrent: () => ({binding: live ? structuredClone(binding) : null, skill: structuredClone(skill)}),
    readExecution: async () => ({task: {taskId: binding.taskId, state: 'succeeded', evidenceRefs: [binding.evidenceId]}, record})};
  return {ports, record, skill, revoke: () => {live = false;}};
}

test('validator requires exact persisted Skill, policy decision and confirmed execution evidence', async () => {
  const fx = fixture();
  const validator = createEvidenceWorkflowValidator(fx.ports);
  assert.deepEqual(await validator.validate(candidate, context()), {passed: true, evidenceRef: binding.evidenceId});
  for (const change of [{state: 'unknown'}, {policyDecision: 'deny'}, {executionStarted: false}, {inputDigest: 'c'.repeat(64)}]) {
    const broken = fixture(); Object.assign(broken.record, change);
    await assert.rejects(createEvidenceWorkflowValidator(broken.ports).validate(candidate, context()), {code: 'NOT_VALIDATED'});
  }
  const late = fixture();
  const read = late.ports.readExecution;
  late.ports.readExecution = async (...args) => {const result = await read(...args); late.revoke(); return result;};
  await assert.rejects(createEvidenceWorkflowValidator(late.ports).validate(candidate, context()), {code: 'REVISION_CONFLICT'});
});

test('Skill disable, revision or content changes while execution is awaited reject an unchanged binding', async () => {
  for (const change of [{enabled: false}, {revision: 'v2'}, {contentSha256: 'c'.repeat(64)}]) {
    const fx = fixture();
    const skill = fx.skill;
    let skillReads = 0;
    fx.ports.readSkill = async () => {skillReads++; return structuredClone(skill);};
    const originalRead = fx.ports.readExecution;
    fx.ports.readExecution = async (...args) => {
      const execution = await originalRead(...args);
      Object.assign(skill, change);
      return execution;
    };
    await assert.rejects(createEvidenceWorkflowValidator(fx.ports).validate(candidate, context()),
      {code: 'NOT_VALIDATED'});
    assert.equal(skillReads, 2);
    assert.deepEqual(await fx.ports.readBinding(), binding);
  }
});

test('Skill final read still obeys cancellation and deadline after otherwise valid execution', async () => {
  for (const expected of ['CANCELLED', 'TIMEOUT']) {
    const fx = fixture();
    const controller = new AbortController();
    const scope = {...context(), signal: controller.signal};
    const originalRead = fx.ports.readSkill;
    let reads = 0;
    fx.ports.readSkill = async (...args) => {
      const skill = await originalRead(...args);
      if (++reads === 2) {
        if (expected === 'CANCELLED') controller.abort();
        else scope.deadline = '2000-01-01T00:00:00.000Z';
      }
      return skill;
    };
    await assert.rejects(createEvidenceWorkflowValidator(fx.ports).validate(candidate, scope), {code: expected});
  }
});

test('source revocation during the final Skill await is rejected by the synchronous joint gate', async () => {
  const fx = fixture();
  const read = fx.ports.readSkill;
  let reads = 0;
  let jointReads = 0;
  const joint = fx.ports.readCurrent;
  fx.ports.readCurrent = (...args) => {jointReads++; return joint(...args);};
  fx.ports.readSkill = async (...args) => {
    const skill = await read(...args);
    if (++reads === 2) fx.revoke();
    return skill;
  };
  await assert.rejects(createEvidenceWorkflowValidator(fx.ports).validate(candidate, context()),
    {code: 'REVISION_CONFLICT'});
  assert.equal(jointReads, 1);
  assert.equal(reads, 2);
});

test('joint gate cannot be missing, async, disabled, cancelled or expired', async () => {
  for (const changed of ['missing', 'async', 'disabled', 'cancelled', 'expired']) {
    const fx = fixture();
    const controller = new AbortController();
    const scope = {...context(), signal: controller.signal};
    const joint = fx.ports.readCurrent;
    if (changed === 'missing') delete fx.ports.readCurrent;
    else if (changed === 'async') fx.ports.readCurrent = async (...args) => joint(...args);
    else fx.ports.readCurrent = (...args) => {
      if (changed === 'disabled') fx.skill.enabled = false;
      if (changed === 'cancelled') controller.abort();
      if (changed === 'expired') scope.deadline = '2000-01-01T00:00:00.000Z';
      return joint(...args);
    };
    await assert.rejects(createEvidenceWorkflowValidator(fx.ports).validate(candidate, scope),
      {code: changed === 'cancelled' ? 'CANCELLED' : changed === 'expired' ? 'TIMEOUT' : 'NOT_VALIDATED'});
  }
});

test('stop and source invalidation persist across restart without silently restoring older selections', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-learning-owned-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'learning.sqlite');
  let host = openSqliteLearningHost(path);
  const proposal = {...candidate, expectedRevision: null, operationId: 'propose-1', ...context()};
  delete proposal.revision;
  host.propose(proposal);
  await host.validate('synthetic', 'review', 1, createEvidenceWorkflowValidator(fixture().ports), context());
  const activation = {namespace: 'synthetic', workflowId: 'review', revision: 1, expectedActiveRevision: null,
    operationId: 'activate-1', activatedAt: at, ...context()};
  host.activateVersion(activation);
  const stop = {namespace: 'synthetic', workflowId: 'review', expectedActiveRevision: 1,
    operationId: 'stop-1', stoppedAt: at, ...context()};
  host.stopWorkflow(stop);
  assert.equal(host.readActive('synthetic', 'review'), null);
  host.close(); host = openSqliteLearningHost(path);
  try {
    host.stopWorkflow(stop);
    assert.equal(host.readActive('synthetic', 'review'), null);
    host.activateVersion({...activation, operationId: 'reactivate-1'});
    const invalidate = {namespace: 'synthetic', sourceRef: candidate.sourceRef, operationId: 'invalidate-1', invalidatedAt: at, ...context()};
    host.invalidateSource(invalidate);
    host.invalidateSource({...invalidate, invalidatedAt: '2026-09-30T01:00:00.000Z'});
    assert.equal(host.readActive('synthetic', 'review'), null);
    assert.throws(() => host.activateVersion({...activation, operationId: 'forbidden-reactivation'}), {code: 'NOT_FOUND'});
    await assert.rejects(host.validate('synthetic', 'review', 1, createEvidenceWorkflowValidator(fixture().ports), context()), {code: 'NOT_FOUND'});
  } finally {host.close();}
});
