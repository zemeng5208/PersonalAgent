import {existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const VERSION = 1;
const DEFAULT_LIMIT = 100;
const text = (value, max = 512) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => structuredClone(value);
const keys = ['id', 'source', 'timestamp', 'title', 'message', 'advice', 'candidateId',
  'sourceTaskId', 'evidenceRefs', 'deliveredAt'];

function validRecord(value) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
    && text(value.id) && value.source === 'node:os' && text(value.timestamp, 32)
    && Number.isFinite(Date.parse(value.timestamp)) && text(value.title) && text(value.message)
    && text(value.advice, 2000) && text(value.candidateId, 256) && text(value.sourceTaskId, 256)
    && text(value.deliveredAt, 32) && Number.isFinite(Date.parse(value.deliveredAt))
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0 && value.evidenceRefs.length <= 256
    && value.evidenceRefs.every(ref => text(ref, 256));
}

function load(filePath) {
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!plain(parsed) || parsed.version !== VERSION || !Array.isArray(parsed.records)
    || !parsed.records.every(validRecord)
    || new Set(parsed.records.map(item => item.id)).size !== parsed.records.length) {
    throw new Error('P5 device receipt store is invalid');
  }
  return parsed.records.map(clone);
}

/** Durable, bounded local card history used by the existing proactive panel. */
export function createP5DeviceReceiptStore({filePath, maxEntries = DEFAULT_LIMIT, now = Date.now} = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000
    || typeof now !== 'function') throw new Error('Invalid P5 device receipt store');
  let records = load(filePath);
  if (records.length > maxEntries) records = records.slice(-maxEntries);

  function persist(next) {
    mkdirSync(path.dirname(filePath), {recursive: true});
    const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, JSON.stringify({version: VERSION, records: next}, null, 2), {encoding: 'utf8', flag: 'wx'});
      renameSync(temporary, filePath);
      records = next;
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  return Object.freeze({
    addNotification(notification, provenance) {
      if (!plain(notification) || !text(notification.id) || notification.source !== 'node:os'
        || !text(notification.timestamp, 32) || !text(notification.title) || !text(notification.message)
        || !text(notification.advice, 2000) || !text(notification.candidateId, 256)
        || !plain(provenance) || !text(provenance.taskId, 256)
        || provenance.source !== 'node:os' || provenance.timestamp !== notification.timestamp
        || !Array.isArray(provenance.evidenceRefs) || provenance.evidenceRefs.length === 0 || provenance.evidenceRefs.length > 256
        || !provenance.evidenceRefs.every(ref => text(ref, 256))) {
        throw new Error('Invalid P5 device notification receipt');
      }
      const existing = records.find(item => item.id === notification.id);
      if (existing) {
        const sameEvidence = existing.evidenceRefs.length === provenance.evidenceRefs.length
          && existing.evidenceRefs.every((ref, index) => ref === provenance.evidenceRefs[index]);
        if (existing.source !== notification.source || existing.timestamp !== notification.timestamp
          || existing.title !== notification.title || existing.message !== notification.message
          || existing.advice !== notification.advice || existing.candidateId !== notification.candidateId
          || existing.sourceTaskId !== provenance.taskId || !sameEvidence) {
          throw new Error('P5 device receipt identity conflict');
        }
        return {record: clone(existing), duplicate: true};
      }
      const record = {
        id: notification.id, source: 'node:os', timestamp: notification.timestamp,
        title: notification.title, message: notification.message, advice: notification.advice,
        candidateId: notification.candidateId, sourceTaskId: provenance.taskId,
        evidenceRefs: [...provenance.evidenceRefs], deliveredAt: new Date(now()).toISOString(),
      };
      if (!validRecord(record)) throw new Error('Invalid P5 device notification receipt');
      persist([...records, record].slice(-maxEntries));
      return {record: clone(record), duplicate: false};
    },
    list() { return records.map(clone); },
  });
}
