import {ProtocolError,validateContract} from '@personal-agent/contracts';
import type {ProtocolContracts,TaskSnapshot} from '@personal-agent/contracts';
import {createHash} from 'node:crypto';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {isDeepStrictEqual} from 'node:util';
import type {TaskRuntime} from '../index.js';
import type {KnowledgeWriteFinalizationAcceptance} from '@personal-agent/knowledge/write';

const TOOL='knowledge.apply_note_patch';
const VERSION='1.0.0';
async function bounded<T>(context:{deadline:string;signal:AbortSignal},work:()=>Promise<T>):Promise<T> {
  const remaining=Date.parse(context.deadline)-Date.now();
  if(context.signal.aborted || !Number.isFinite(remaining) || remaining<=0)throw new ProtocolError('TIMEOUT','Knowledge recovery expired');
  let onAbort=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  const interrupted=new Promise<never>((_resolve,reject)=> {
    onAbort=()=>reject(new ProtocolError('CANCELLED','Knowledge recovery cancelled'));
    context.signal.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>reject(new ProtocolError('TIMEOUT','Knowledge recovery expired')),Math.min(remaining,2147483647));
  });
  try {return await Promise.race([Promise.resolve().then(work),interrupted]);}
  finally {if(timer)clearTimeout(timer);context.signal.removeEventListener('abort',onAbort);}
}
export interface KnowledgeWriteReconciliationPort {
  reconcile(input:{taskId:string;runId:string;argumentsDigest:string},context:{deadline:string;signal:AbortSignal}):Promise<{
    state:'applied'|'not_applied'|'unknown'|'in_progress';operationId:string;backupId:string;lockRetained:boolean;currentSha256?:string}>;
  finalize(accepted:KnowledgeWriteFinalizationAcceptance,context:{deadline:string;signal:AbortSignal}):Promise<{
    state:'finalized'|'still_unknown';operationId:string;outcome?:'applied'|'not_applied';currentSha256?:string}>;
}

/** Metadata recovery of the original authorized run; never invokes the write tool. */
export class KnowledgeWriteReconciliationAdapter {
  private readonly active=new Map<string,Promise<TaskSnapshot>>();
  constructor(private readonly runtime:TaskRuntime,private readonly namespace:string,
    private readonly port:KnowledgeWriteReconciliationPort) {}
  isKnowledgeTask(taskId:string):boolean {
    const intent=this.runtime.loadCheckpoint(taskId,'host-tool-intent') as {namespace?:string;toolName?:string;toolVersion?:string}|undefined;
    return intent?.namespace===this.namespace && intent.toolName===TOOL && intent.toolVersion===VERSION;
  }
  reconcile(taskId:string,context:{deadline:string;signal:AbortSignal}):Promise<TaskSnapshot> {
    const pending=this.active.get(taskId);if(pending)return pending;
    const work=Promise.resolve().then(async()=>{
      const runId=`host-tool-${taskId}`;
      const intent=this.runtime.loadCheckpoint(taskId,'host-tool-intent') as {
        namespace:string;toolName:string;toolVersion:string;arguments:KnowledgeWriteFinalizationAcceptance['originalInput'];argumentsDigest:string};
      const task=this.runtime.getTask(taskId);
      const record=this.runtime.readToolExecutions(taskId).find(value=>value.evidenceId===runId);
      if(!this.isKnowledgeTask(taskId) || !record || task.conversationId!==`host-tool:${this.namespace}`
        || record.taskId!==taskId || record.toolName!==TOOL || record.toolVersion!==VERSION
        || !record.executionStarted || record.policyDecision!=='allow'
        || intent.argumentsDigest!==toolArgumentsDigest(intent.arguments)
        || !this.runtime.matchesToolExecutionInput(record,{arguments:{...intent.arguments},scopeRef:runId})) {
        throw new ProtocolError('UNAUTHORIZED','Knowledge recovery does not match the original execution');
      }
      if(['succeeded','failed','cancelled'].includes(task.state))return task;
      if(task.state!=='waiting_reconciliation' || !['started','unknown'].includes(record.state)) {
        throw new ProtocolError('REVISION_CONFLICT','Knowledge task is not waiting for recovery');
      }
      const current=()=>{
        if(context.signal.aborted)throw new ProtocolError('CANCELLED','Knowledge readback cancelled');
        if(Date.now()>=Date.parse(context.deadline) || !Number.isFinite(Date.parse(context.deadline)))throw new ProtocolError('TIMEOUT','Knowledge readback expired');
        if(!isDeepStrictEqual(this.runtime.loadCheckpoint(taskId,'host-tool-intent'),intent)
          || !isDeepStrictEqual(record,this.runtime.readToolExecutions(taskId).find(value=>value.evidenceId===runId))
          || this.runtime.getTask(taskId).state!=='waiting_reconciliation')throw new ProtocolError('REVISION_CONFLICT','Original knowledge recovery changed');
      };
      current();
      const result=await bounded(context,()=>this.port.reconcile({taskId,runId,argumentsDigest:intent.argumentsDigest},context));
      current();
      if(!result || !['applied','not_applied','unknown','in_progress'].includes(result.state)
        || typeof result.operationId!=='string' || !/^[a-f0-9]{64}$/.test(result.operationId)
        || typeof result.backupId!=='string' || typeof result.lockRetained!=='boolean')throw new ProtocolError('RESULT_UNKNOWN','Knowledge readback is invalid');
      if(result.state==='unknown' || result.state==='in_progress')return this.runtime.getTask(taskId);
      if(!result.currentSha256 || !/^[a-f0-9]{64}$/.test(result.currentSha256))throw new ProtocolError('RESULT_UNKNOWN','Knowledge current hash is missing');
      const evidenceId='knowledge-readback-'+createHash('sha256').update(JSON.stringify([
        taskId,runId,intent.argumentsDigest,result.operationId,result.state,result.currentSha256])).digest('hex');
      const evidence:ProtocolContracts['evidence']={evidenceId,kind:'observation',sourceRef:'runtime:knowledge-readback',
        capturedAt:new Date().toISOString(),summary:`Knowledge write readback ${result.state}; operation=${result.operationId}; SHA256=${result.currentSha256}`,
        verification:'verified',sensitivity:'internal'};
      validateContract('evidence',evidence);
      const receipt={taskId,runId,toolName:TOOL,toolVersion:VERSION,argumentsDigest:intent.argumentsDigest,
        executionRecordId:record.evidenceId,result,evidence};
      // Persist the trusted local observation before metadata finalization. The
      // original task remains unknown until the locked finalizer also confirms it.
      this.runtime.saveCheckpoint(taskId,'knowledge-write-readback',receipt);
      this.runtime.saveCheckpoint(taskId,`trusted-readback-evidence:${evidenceId}`,evidence);
      if(!isDeepStrictEqual(this.runtime.loadCheckpoint(taskId,'knowledge-write-readback'),receipt))throw new ProtocolError('RESULT_UNKNOWN','Knowledge readback persistence failed');
      if(!isDeepStrictEqual(this.runtime.readEvidence(taskId).find(item=>item.evidenceId===evidenceId),evidence)) {
        throw new ProtocolError('RESULT_UNKNOWN','Knowledge readback Evidence is unavailable');
      }
      const accepted:KnowledgeWriteFinalizationAcceptance={taskId,runId,toolName:TOOL,toolVersion:VERSION,
        argumentsDigest:intent.argumentsDigest,operationId:result.operationId,originalInput:intent.arguments,
        outcome:result.state,currentSha256:result.currentSha256,executionRecordId:record.evidenceId,
        readbackEvidenceRefs:[evidence.evidenceId]};
      const finalized=await bounded(context,()=>this.port.finalize(accepted,context));current();
      if(finalized.state!=='finalized')return this.runtime.getTask(taskId);
      if(finalized.operationId!==result.operationId || finalized.outcome!==result.state
        || finalized.currentSha256!==result.currentSha256)throw new ProtocolError('RESULT_UNKNOWN','Knowledge finalization changed its readback');
      return this.runtime.reconcileToolExecution(taskId,runId,result.state,result,[evidenceId]);
    }).finally(()=>this.active.delete(taskId));
    this.active.set(taskId,work);return work;
  }
}
