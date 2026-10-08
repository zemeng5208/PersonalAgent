import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {openReadOnlyVault} from '@personal-agent/knowledge/filesystem';
import {openSqliteMemoryHost} from '@personal-agent/memory/sqlite';
import {ingestConfirmedPrivateCitation} from '@personal-agent/runtime/application';

const namespace = 'desktop-private';
const validUntil = '9999-12-31T23:59:59.999Z';
const context = () => ({deadline: new Date(Date.now() + 3 * 60_000).toISOString(),
  signal: new AbortController().signal});
const hash = value => createHash('sha256').update(value).digest('hex');

/** Local admin-only memory; the caller must present a native confirmation dialog. */
export function createPrivateMemoryController(databasePath, confirm, confirmDelete = async () => false,
  {confirmWithdraw = async () => false, authorizeConsumption = async () => false} = {}) {
  let memory;
  let maintenanceNeeded = true;
  const memoryHost = () => {
    if (closed) throw Error('私人记忆控制器已关闭');
    if (!memory) {
      const opened = openSqliteMemoryHost(databasePath);
      try { opened.provision(namespace); }
      catch (error) { opened.close(); throw error; }
      memory = opened;
    }
    if (maintenanceNeeded) {
      memory.resumeCompletedErasureMaintenance(namespace);
      maintenanceNeeded = false;
    }
    return memory;
  };
  let vault;
  let configurationRevision = 0;
  const controllerId = randomUUID();
  let closed = false;
  const head = ref => {
    if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string'
      || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw Error('无效的记忆版本');
    const current = memoryHost().readUserFactHead(namespace, ref.id);
    if (!current || current.ref.revision !== ref.revision) throw Error('记忆版本已变化，请刷新列表');
    return current;
  };
  const consumptionBinding = ref => {
    if (closed || !vault) throw Error('私人来源配置不可用');
    const fact = head(ref);
    const now = Date.now();
    if (fact.state !== 'active' || fact.confirmation !== 'user_confirmed'
      || Date.parse(fact.validFrom) > now || Date.parse(fact.validUntil) <= now) throw Error('私人记忆已撤回或失效');
    return {ref: structuredClone(fact.ref), configurationRef: `private-vault:${controllerId}:${configurationRevision}`,
      sourceDigest: hash(fact.sourceRef), summaryDigest: hash(fact.summary)};
  };
  return Object.freeze({
    get selected() { return Boolean(vault); },
    get configurationRevision() { return configurationRevision; },
    /** Content-free host binding. Neither source paths nor summaries cross this port. */
    readConsumptionBinding(ref) { return consumptionBinding(ref); },
    assertConsumption(binding) {
      if (JSON.stringify(consumptionBinding(binding?.ref)) !== JSON.stringify(binding)) {
        throw Error('私人记忆消费绑定已变化');
      }
    },
    /** Durable, content-free deletion authority, readable even while WAL maintenance is pending. */
    listErasureMarkers(request) {
      if (closed) throw Error('私人记忆控制器已关闭');
      return (memory ?? memoryHost()).listFactErasures(namespace, request);
    },
    prepareWrite() {
      const store = memoryHost();
      store.assertUnboundNamespace(namespace);
      return {state: 'ready', coverage: 'active_private_database', managedCopies: 'host_inventory_required'};
    },
    async selectVault(rootPath) {
      if (closed) throw Error('私人记忆控制器已关闭');
      const canonical = await realpath(rootPath);
      const selected = await openReadOnlyVault({vaultId: hash(process.platform === 'win32'
        ? canonical.toLowerCase() : canonical), rootPath});
      if (closed) throw Error('私人记忆控制器已关闭');
      vault = selected;
      configurationRevision += 1;
    },
    search(query) {
      if (closed) throw Error('私人记忆控制器已关闭');
      if (!vault) throw Error('请先选择本机 Vault');
      return vault.search({query, limit: 5, ...context()}).then(result => {
        if (closed) throw Error('私人记忆控制器已关闭');
        return result;
      });
    },
    async previewSave(source) {
      if (!vault || closed) throw Error('请先选择本机 Vault');
      const selected = vault;
      const generation = configurationRevision;
      const citation = structuredClone(source);
      await selected.readCitation({source: citation, ...context()});
      if (generation !== configurationRevision || closed) throw Error('来源配置已变化，请重新检索');
      const factId = `private-${hash(`${citation.vaultId}/${citation.path}#L${citation.line}`)}`;
      const current = memoryHost().readUserFactHead(namespace, factId);
      return {configurationRevision: generation, expectedRevision: current?.ref.revision ?? null};
    },
    async listSaved({at, snapshot, cursor} = {}) {
      const queryAt = at ?? new Date().toISOString();
      if (!memory && !existsSync(databasePath)) return {facts: [], at: queryAt};
      const page = await memoryHost().listUserFactHeads(namespace, {at: queryAt, limit: 20,
          ...(snapshot === undefined ? {} : {snapshot}),
          ...(cursor === undefined ? {} : {cursor}), ...context()});
      return {...page, at: queryAt};
    },
    async save(source, summary, baseline) {
      if (!vault) throw Error('请先选择本机 Vault');
      const generation = configurationRevision;
      const selectedVault = vault;
      const selectedSource = structuredClone(source);
      if (baseline && baseline.configurationRevision !== generation) throw Error('来源配置已变化，请重新检索');
      if (typeof summary !== 'string' || !summary || summary !== summary.trim()
        || summary.length > 500 || /[\u0000-\u001f\u007f]/.test(summary)) {
        throw Error('记忆摘要必须是 1～500 字的单行文本');
      }
      if (!source || typeof source !== 'object') throw Error('无效的来源引文');
      const store = memoryHost();
      const now = new Date().toISOString();
      const factId = `private-${hash(`${selectedSource.vaultId}/${selectedSource.path}#L${selectedSource.line}`)}`;
      const sourceRef = `${selectedSource.vaultId}/${selectedSource.path}#L${selectedSource.line}@${selectedSource.revision}`;
      const current = store.readUserFactHead(namespace, factId);
      if (baseline && baseline.expectedRevision !== (current?.ref.revision ?? null)) throw Error('记忆版本已变化，请刷新列表');
      const stable = () => {
        if (closed || configurationRevision !== generation) throw Error('来源配置已变化，请重新检索');
      };
      const readCitation = async request => { stable(); const value = await selectedVault.readCitation(request); stable(); return value; };
      if (current?.state === 'active' && current.summary === summary && current.sourceRef === sourceRef) {
        await readCitation({source: selectedSource, ...context()});
        return {state: 'unchanged', revision: current.ref.revision};
      }
      const saved = await ingestConfirmedPrivateCitation({
        vault: {readCitation}, memory: store, namespace, factId, expectedRevision: current?.ref.revision ?? null,
        source: selectedSource, observedAt: now, validFrom: now, validUntil,
        confirm: async citation => {
          if (citation.length > 4000) throw Error('摘录过长，无法完整展示确认');
          const allowed = await confirm({citation, summary, source: selectedSource,
            configurationRevision: generation, expectedRevision: current?.ref.revision ?? null,
            previous: current?.summary});
          stable();
          return allowed ? {operationId: randomUUID(), summary} : null;
        },
      }, context());
      return saved ? {state: 'saved', revision: saved.fact.ref.revision} : {state: 'declined'};
    },
    async withdraw(ref) {
      const target = structuredClone(ref);
      const current = head(target);
      if (current.state === 'withdrawn') return {state: 'withdrawn', revision: target.revision};
      if (!await confirmWithdraw(structuredClone(current))) return {state: 'declined'};
      head(target);
      const now = new Date().toISOString();
      const saved = memoryHost().reviseUserFact(namespace, {factId: target.id,
        expectedRevision: target.revision, operationId: randomUUID(),
        summary: '用户已撤回此私人记忆', sourceRef: `user-withdrawal:${hash(`${target.id}@${target.revision}`)}`,
        observedAt: now, validFrom: current.validFrom, validUntil: current.validUntil,
        sensitivity: 'private', state: 'withdrawn', ...context()});
      return {state: 'withdrawn', revision: saved.fact.ref.revision};
    },
    /** Host-only per-task data authorization. Never register this as public Fact projection. */
    async consumeConfirmed({refs, taskId, destination, configurationRef, deadline, signal}) {
      if (!Array.isArray(refs) || refs.length < 1 || refs.length > 10
        || typeof taskId !== 'string' || !taskId.trim() || taskId.length > 256
        || !['local', 'agentarts'].includes(destination) || !signal
        || signal.aborted || !Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now()) {
        throw Error('无效的私人记忆消费范围');
      }
      const selected = structuredClone(refs);
      const bindings = selected.map(consumptionBinding);
      if (new Set(selected.map(ref => ref.id)).size !== selected.length) throw Error('重复的私人记忆引用');
      const check = () => {
        if (closed || signal.aborted || Date.parse(deadline) <= Date.now()) throw Error('私人记忆消费已取消或过期');
        const now = Date.now();
        return selected.map(ref => {
          const original = bindings.find(binding => binding.ref.id === ref.id);
          if (JSON.stringify(consumptionBinding(ref)) !== JSON.stringify(original)) throw Error('私人记忆消费绑定已变化');
          const fact = head(ref);
          if (fact.state !== 'active' || fact.confirmation !== 'user_confirmed'
            || Date.parse(fact.validFrom) > now || Date.parse(fact.validUntil) <= now) throw Error('私人记忆已撤回或失效');
          return {ref: fact.ref, summary: fact.summary};
        });
      };
      const facts = check();
      // The injected callback is a trusted native decision, never renderer/model-supplied permission.
      if (await authorizeConsumption({taskId, destination, configurationRef,
        bindings: structuredClone(bindings), facts: structuredClone(facts), deadline}) !== true) {
        return {state: 'declined', facts: []};
      }
      return {state: 'authorized', taskId, destination, facts: check(),
        bindings, treatment: 'user_confirmed_data'};
    },
    async delete(ref) {
      if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string'
        || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw Error('无效的记忆版本');
      if (!memory && !existsSync(databasePath)) throw Error('没有可删除的私人记忆');
      const store = memoryHost();
      const query = store.bind(namespace, {allowedSensitivities: ['private']});
      const target = structuredClone(ref);
      const current = head(target);
      if (!await confirmDelete(current)) return {state: 'declined'};
      head(target);
      maintenanceNeeded = true;
      store.eraseUnboundFact(namespace, {factId: target.id, expectedRevision: target.revision,
        operationId: `desktop-private-${hash(`${target.id}@${target.revision}`)}`, ...context()});
      maintenanceNeeded = false;
      const [visible, history] = await Promise.all([
        query.listCurrent({factId: target.id, at: new Date().toISOString(), limit: 1, ...context()}),
        query.listHistory({factId: target.id, limit: 20, ...context()}),
      ]);
      if (visible.facts.length || history.facts.length) throw Error('删除读回未通过');
      return {state: 'deleted'};
    },
    /** Restore caller owns the copied file and must keep it hidden until this succeeds. */
    filterRestoredHost(restoredMemory, request = context()) {
      if (!existsSync(databasePath)) throw Error('缺少权威删除清单，恢复保持禁用');
      const store = memoryHost();
      if (restoredMemory === store) throw Error('恢复副本必须与权威私人库隔离');
      let afterFactId;
      for (;;) {
        const markers = store.listFactErasures(namespace, {limit: 100, ...request,
          ...(afterFactId ? {afterFactId} : {})});
        restoredMemory.restoreUnboundErasureMarkers(namespace, {markers, ...request});
        if (markers.length < 100) return {state: 'filtered', coverage: 'authoritative_application_copy'};
        afterFactId = markers.at(-1).factId;
      }
    },
    close() { if (!closed) memory?.close(); closed = true; vault = undefined; },
  });
}
