// Explicit trusted-host doubles for recheck binding tests. This does not verify
// native consent; native grants have their own tests. Callers cannot set intake IDs.
export function knowledgeInterestFixture(namespace, runtime = {}) {
  const tasks=new Map(),signals=new Map();
  const readGrant=identity=>{
    const signal=signals.get(identity.taskId);
    if(identity.namespace!==namespace || identity.sourceId!==signal?.source.id) return null;
    return structuredClone(signal.scope);
  };
  const ports={runtime:{...runtime,getTask:id=>structuredClone(tasks.get(id) ?? runtime.getTask?.(id))},
    readInterestSignal:async identity=>identity.namespace===namespace ? structuredClone(signals.get(identity.taskId)) : null,
    readTrackingGrant:async identity=>readGrant(identity),readTrackingGrantSnapshot:readGrant};
  for(const method of ['loadCheckpoint','findTaskByIdempotencyKey','submitTask']) {
    if(typeof runtime[method]==='function') ports.runtime[method]=runtime[method].bind(runtime);
  }
  return {ports,async consume(host,signal,request){
    const taskId=`synthetic-intake-${signal.topicId}-${tasks.size+1}`;
    tasks.set(taskId,{taskId,conversationId:'synthetic-interest',goal:`Follow up ${signal.topicId}`,state:'created'});
    signals.set(taskId,structuredClone(signal));
    return host.consumeInterestTask(taskId,request);
  }};
}
