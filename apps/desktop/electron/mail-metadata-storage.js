import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

/** Derived inbox labels only; Runtime remains the task/Evidence store. */
export function createMailMetadataStorage({userData, safeStorage}) {
  const file = path.join(userData, 'mail-classification.json');
  let values = {};
  if (existsSync(file)) {
    if (!safeStorage.isEncryptionAvailable()) throw Error('邮箱分类安全存储不可用');
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    if (envelope.version !== 1 || typeof envelope.encrypted !== 'string') throw Error('邮箱分类记录需要恢复');
    values = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64')));
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('邮箱分类记录需要恢复');
  }
  return {get:key => structuredClone(values[key]), set(key, value) {
    if (!safeStorage.isEncryptionAvailable()) throw Error('邮箱分类安全存储不可用');
    const next = {...values, [key]:structuredClone(value)};
    const encrypted = safeStorage.encryptString(JSON.stringify(next)).toString('base64');
    mkdirSync(userData, {recursive:true});
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({version:1, encrypted}), 'utf8'); renameSync(temporary, file); values = next;
  }};
}
