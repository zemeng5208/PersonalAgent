import {randomUUID} from 'node:crypto';

const context = () => ({deadline: new Date(Date.now() + 180_000).toISOString(),
  signal: new AbortController().signal});
const versionView = version => version === null ? null : ({workflowId: version.workflowId,
  revision: version.revision, summary: version.summary, validation: version.validation,
  hasEvidence: Boolean(version.evidenceRef)});

/** Trusted admin composition. The shared main/preload owns sender validation and native dialogs. */
export function createMemoryLearningHost({profile, privateMemory, learningApplication,
  publicErasure, managedPrivateCopies}) {
  if (profile !== 'huawei_ict_agentarts' || !privateMemory) throw Error('需要 Competition 私人记忆宿主');
  // Only the composition owner can supply the actual application-copy inventory.
  // Unknown/existing unsupported managed copies keep production writes disabled.
  const noManagedCopies = () => {
    const inventory = typeof managedPrivateCopies === 'function' ? managedPrivateCopies() : managedPrivateCopies;
    return Array.isArray(inventory) && inventory.length === 0;
  };
  const writeReady = () => {
    if (!noManagedCopies()) throw Error('应用管理副本删除未接通，私人写入保持禁用');
    return privateMemory.prepareWrite();
  };
  return Object.freeze({
    snapshot() {
      let writeEnabled = false;
      let writeState = 'managed_copy_inventory_required';
      if (noManagedCopies()) {
        try { writeReady(); writeEnabled = true; writeState = 'ready'; }
        catch { writeState = 'deletion_maintenance_required'; }
      }
      return {available: true, writeEnabled, writeState,
        configurationRevision: privateMemory.configurationRevision,
        learningAvailable: Boolean(learningApplication), publicErasureAvailable: Boolean(publicErasure),
        deletionCoverage: 'active_application_databases', externalCopies: 'not_controlled'};
    },
    async recover() {
      // No writes or model calls are retried; public coordinator only follows durable erasure receipts.
      writeReady();
      return publicErasure ? publicErasure.reconcile(context()) : {state: 'not_configured'};
    },
    async invoke(name, payload = {}) {
      if (name === 'memory.previewSave') { writeReady(); return privateMemory.previewSave(payload.source); }
      if (name === 'memory.save') {
        writeReady();
        if (!payload.baseline || !Object.hasOwn(payload.baseline, 'expectedRevision')
          || !Number.isSafeInteger(payload.baseline.configurationRevision)) throw Error('缺少精确来源配置与记忆基线');
        return privateMemory.save(payload.source, payload.summary, payload.baseline);
      }
      if (name === 'memory.withdraw') return privateMemory.withdraw(payload.ref);
      if (name === 'memory.delete') { writeReady(); return privateMemory.delete(payload.ref); }
      if (name === 'memory.boundErase') {
        if (!publicErasure) throw Error('公共事实跨库删除未配置');
        return publicErasure.erase({factId: payload.ref?.id, expectedRevision: payload.ref?.revision,
          operationId: randomUUID(), ...context()});
      }
      if (!name.startsWith('learning.') || !learningApplication) throw Error('流程学习未配置');
      const scope = context();
      if (name === 'learning.read') return {
        version: versionView(learningApplication.readVersion(payload.workflowId, payload.revision)),
        active: versionView(learningApplication.readActive(payload.workflowId)),
      };
      if (name === 'learning.propose') return {state: 'candidate', version: versionView(learningApplication.propose({
        workflowId: payload.workflowId, expectedRevision: payload.expectedRevision,
        summary: payload.summary, path: payload.path, operationId: randomUUID(),
        createdAt: new Date().toISOString(), ...scope}))};
      if (name === 'learning.startValidation') return learningApplication.startValidation({
        workflowId: payload.workflowId, revision: payload.revision, operationId: randomUUID(), ...scope});
      if (name === 'learning.validate') {
        const result = await learningApplication.validate({workflowId: payload.workflowId,
          revision: payload.revision, taskId: payload.taskId, ...scope});
        return result.version ? {...result, version: versionView(result.version)} : result;
      }
      if (name === 'learning.activate') return learningApplication.activate({workflowId: payload.workflowId,
        revision: payload.revision, expectedActiveRevision: payload.expectedActiveRevision,
        operationId: randomUUID(), activatedAt: new Date().toISOString(), ...scope});
      if (name === 'learning.run') return learningApplication.run({workflowId: payload.workflowId,
        revision: payload.revision, operationId: randomUUID(), ...scope});
      if (name === 'learning.stop') return learningApplication.stop({workflowId: payload.workflowId,
        revision: payload.revision, taskId: payload.taskId, ...scope});
      if (name === 'learning.erase') return learningApplication.erase({workflowId: payload.workflowId,
        expectedRevision: payload.expectedRevision, operationId: randomUUID(), ...scope});
      throw Error('不支持的流程学习操作');
    },
  });
}
