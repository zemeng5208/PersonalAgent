import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => value === undefined ? undefined : structuredClone(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const fail = () => {throw Error('P5 持久认知状态需要核实，原文件已保留');};

/** Namespace-bound KV supplied by the existing Runtime; never creates a task or database. */
export function createP5RuntimeCheckpoints({storage, namespace, userData, legacyDeviceNamespace = namespace}) {
  if (!text(namespace) || !text(userData)
    || !['get', 'set'].every(name => typeof storage?.[name] === 'function')) fail();
  const load = name => copy(storage.get(name));
  const save = (name, value) => storage.set(name, copy(value));
  const migrateOnce = (name, readLegacy) => {
    if (load(name) === undefined) save(name, readLegacy());
    return load(name);
  };
  const deviceKey = 'p5-device-anomaly-v1';
  const meetingsKey = 'p5-meeting-receipts-v1';
  const meetingKey = record => hash([namespace, record.source, record.eventId]);
  const validRecord = record => record && record.namespace === namespace
    && [record.eventId, record.source, record.sourceRevision, record.inputDigest].every(text)
    && record.receipt?.eventId === record.eventId && record.receipt.source === record.source
    && record.receipt.sourceRevision === record.sourceRevision && record.status === record.receipt.status;
  const meetingState = () => {
    const state = migrateOnce(meetingsKey, () => {
      const records = {};
      const directory = path.join(userData, 'meeting-receipts');
      if (existsSync(directory)) for (const name of readdirSync(directory)) {
        if (!/^receipt-.*\.json$/.test(name)) continue;
        // Never silently skip a corrupt legacy receipt and subsequently re-execute it.
        const record = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
        if (!record || !text(record.namespace)) fail();
        if (record.namespace !== namespace) continue;
        if (!validRecord(record)) fail();
        const id = meetingKey(record);
        if (records[id] !== undefined) fail();
        records[id] = record;
      }
      return {version: 1, namespace, revision: 0, records};
    });
    if (state?.version !== 1 || state.namespace !== namespace || !state.records || Array.isArray(state.records)
      || (state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 0))
      || Object.entries(state.records).some(([id, record]) => !validRecord(record) || id !== meetingKey(record))) fail();
    return state;
  };
  return Object.freeze({
    persistence: 'runtime_sqlite',
    device: {
      load() {
        const envelope = migrateOnce(deviceKey, () => {
          const file = path.join(userData, 'device-anomaly-checkpoint.json');
          // userData belongs to the trusted current user. An explicit different
          // legacy owner disables import of this old unnamespaced file.
          return {version: 1, namespace, revision: 0, state: namespace === legacyDeviceNamespace
            && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null};
        });
        if (envelope?.version !== 1 || envelope.namespace !== namespace
          || (envelope.revision !== undefined && (!Number.isSafeInteger(envelope.revision) || envelope.revision < 0))) fail();
        return copy(envelope.state ?? undefined);
      },
      save(value) {
        this.load();
        const previous = load(deviceKey);
        save(deviceKey, {version: 1, namespace, revision: (previous.revision ?? 0) + 1, state: value});
      },
    },
    meetings: {
      loadReceipt(query) {
        const target = typeof query === 'string' ? {eventId: query} : query;
        if (target?.namespace !== undefined && target.namespace !== namespace) return undefined;
        return copy(Object.values(meetingState().records).find(record => record.eventId === target?.eventId
          && (target.source === undefined || record.source === target.source)));
      },
      saveReceipt(record) {
        if (!validRecord(record)) fail();
        const state = meetingState();
        const previous = state.records[meetingKey(record)];
        if (previous && previous.inputDigest !== record.inputDigest) fail();
        state.records[meetingKey(record)] = copy(record);
        state.revision = (state.revision ?? 0) + 1;
        // Record and enumeration are one atomic existing SQLite checkpoint replacement.
        save(meetingsKey, state);
      },
      listReceipts(filter = {}) {
        if (filter.namespace !== undefined && filter.namespace !== namespace) return [];
        return Object.values(meetingState().records).filter(record =>
          (filter.source === undefined || record.source === filter.source)
          && (filter.status === undefined || record.status === filter.status)).map(copy);
      },
    },
  });
}
