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
export function createPrivateMemoryController(databasePath, confirm, confirmDelete = async () => false) {
  let memory;
  const memoryHost = () => {
    if (!memory) {
      const opened = openSqliteMemoryHost(databasePath);
      try { opened.provision(namespace); }
      catch (error) { opened.close(); throw error; }
      memory = opened;
    }
    return memory;
  };
  let vault;
  return Object.freeze({
    get selected() { return Boolean(vault); },
    async selectVault(rootPath) {
      const canonical = await realpath(rootPath);
      const selected = await openReadOnlyVault({vaultId: hash(process.platform === 'win32'
        ? canonical.toLowerCase() : canonical), rootPath});
      vault = selected;
    },
    search(query) {
      if (!vault) throw Error('请先选择本机 Vault');
      return vault.search({query, limit: 5, ...context()});
    },
    async listSaved({at, snapshot, cursor} = {}) {
      const queryAt = at ?? new Date().toISOString();
      if (!memory && !existsSync(databasePath)) return {facts: [], at: queryAt};
      const page = await memoryHost().bind(namespace, {allowedSensitivities: ['private']})
        .listCurrent({at: queryAt, limit: 20,
          ...(snapshot === undefined ? {} : {snapshot}),
          ...(cursor === undefined ? {} : {cursor}), ...context()});
      return {...page, at: queryAt};
    },
    async save(source, summary) {
      if (!vault) throw Error('请先选择本机 Vault');
      if (typeof summary !== 'string' || !summary || summary !== summary.trim()
        || summary.length > 500 || /[\u0000-\u001f\u007f]/.test(summary)) {
        throw Error('记忆摘要必须是 1～500 字的单行文本');
      }
      if (!source || typeof source !== 'object') throw Error('无效的来源引文');
      const store = memoryHost();
      const now = new Date().toISOString();
      const factId = `private-${hash(`${source.vaultId}/${source.path}#L${source.line}`)}`;
      const sourceRef = `${source.vaultId}/${source.path}#L${source.line}@${source.revision}`;
      const current = (await store.bind(namespace, {allowedSensitivities: ['private']})
        .listCurrent({factId, at: now, limit: 1, ...context()})).facts[0];
      if (current?.summary === summary && current.sourceRef === sourceRef) {
        await vault.readCitation({source, ...context()});
        return {state: 'unchanged', revision: current.ref.revision};
      }
      const saved = await ingestConfirmedPrivateCitation({
        vault, memory: store, namespace, factId, expectedRevision: current?.ref.revision ?? null,
        source, observedAt: now, validFrom: now, validUntil,
        confirm: async citation => {
          if (citation.length > 4000) throw Error('摘录过长，无法完整展示确认');
          return await confirm({citation, summary, source, previous: current?.summary})
            ? {operationId: randomUUID(), summary} : null;
        },
      }, context());
      return saved ? {state: 'saved', revision: saved.fact.ref.revision} : {state: 'declined'};
    },
    async delete(ref) {
      if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string'
        || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw Error('无效的记忆版本');
      if (!memory && !existsSync(databasePath)) throw Error('没有可删除的私人记忆');
      const store = memoryHost();
      const query = store.bind(namespace, {allowedSensitivities: ['private']});
      const current = (await query.listCurrent({factId: ref.id,
        at: new Date().toISOString(), limit: 1, ...context()})).facts[0];
      if (!current || current.ref.revision !== ref.revision) throw Error('记忆版本已变化，请刷新列表');
      if (!await confirmDelete(current)) return {state: 'declined'};
      store.eraseUnboundFact(namespace, {factId: ref.id, expectedRevision: ref.revision,
        operationId: `desktop-private-${hash(`${ref.id}@${ref.revision}`)}`, ...context()});
      const [visible, history] = await Promise.all([
        query.listCurrent({factId: ref.id, at: new Date().toISOString(), limit: 1, ...context()}),
        query.listHistory({factId: ref.id, limit: 20, ...context()}),
      ]);
      if (visible.facts.length || history.facts.length) throw Error('删除读回未通过');
      return {state: 'deleted'};
    },
    close() { memory?.close(); },
  });
}
