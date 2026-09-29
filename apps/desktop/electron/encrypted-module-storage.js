import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import path from 'node:path';

/** A single atomic value map for module-owned records, never Runtime tasks. */
export function createEncryptedModuleStorage({userData,safeStorage,filename}) {
  if (path.basename(filename)!==filename) throw Error('Invalid module storage filename');
  const file=path.join(userData,filename); let values={};
  const ready=()=>{if(!safeStorage.isEncryptionAvailable()) throw Error('本机安全存储不可用');};
  if (existsSync(file)) {
    ready();const envelope=JSON.parse(readFileSync(file,'utf8'));
    if (envelope.version!==1 || typeof envelope.encrypted!=='string') throw Error('本机模块记录需要恢复');
    values=JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted,'base64')));
    if (!values || typeof values!=='object' || Array.isArray(values)) throw Error('本机模块记录需要恢复');
  }
  function save(next) {
    ready(); const encrypted=safeStorage.encryptString(JSON.stringify(next)).toString('base64');
    mkdirSync(userData,{recursive:true}); const temporary=`${file}.tmp-${process.pid}`;
    writeFileSync(temporary,JSON.stringify({version:1,encrypted}),{encoding:'utf8',flush:true});
    renameSync(temporary,file);values=next;
  }
  return {get:key=>structuredClone(values[key]),
    set(key,value){save({...values,[key]:structuredClone(value)});},
    delete(key){const next={...values};delete next[key];save(next);}};
}
