// Explicit in-memory host ports for composition tests; production uses Runtime KV
// and encrypted inbox storage. Neither port creates public Facts or approvals.
export function p5FixturePorts() {
  const records = new Map();
  const storage = {get:key=>structuredClone(records.get(key)),
    set:(key,value)=>records.set(key,structuredClone(value)),delete:key=>records.delete(key)};
  return {hostStateStorage:storage,mailStorage:storage,
    mailReadAuthorization:()=>true,getClassifierFingerprint:()=> 'synthetic-classifier-v1'};
}

export const inboxScope = {accountRef:'synthetic',folder:'INBOX',nextCursor:'1:1',hasMore:false};
export function inboxItem(id, text) {
  return {source:'mail',accountRef:'synthetic',externalId:`INBOX:${id}`,
    occurredAt:'2026-09-29T00:00:00.000Z',fetchedAt:'2026-09-29T01:00:00.000Z',
    contentRef:text,sensitivity:'private',dedupeKey:`synthetic:1:INBOX:${id}:message-${id}`};
}
