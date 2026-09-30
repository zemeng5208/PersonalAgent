import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {AgentWorkerContext} from '@personal-agent/agents';
import type {CoordinationAvailableTool, CoordinationToolProposalResult} from '@personal-agent/coordination';
import {createPublicReferenceExport} from '@personal-agent/mcp';
import type {PublicReferenceExportPreflight,PublicReferenceExportOptions} from '@personal-agent/mcp';
import type {ReferenceSummaryInput, SkillManifest, SkillOutcome} from './index.js';
import {referenceSummary} from './reference-summary.js';

/** The existing versioned worker, injected at Runtime dispatch OUTSIDE tool locks. */
export interface VersionedSkillWorkerPort {
  manifest():SkillManifest;
  health():{connected:boolean};
  invoke(input:ReferenceSummaryInput, context:AgentWorkerContext):Promise<SkillOutcome>;
}
export interface PublicSkillSource extends PublicReferenceExportPreflight {
  path:string; sourceRef:string; configurationRef:string; revision:number;
}
export interface CloudSkillChoice {skillId:string; version:string; digest:string; sourceRef:string}
export interface CloudSkillContext extends AgentWorkerContext {revision:number; proposalId:string}
export interface CloudSkillSelection {selectionRef:string; skillId:string; version:string; digest:string}
export interface CloudSkillReceipt {
  state:SkillOutcome['state']; selectionRef:string; sourceRef:string; contentDigest?:string;
  content?:string;byteLength?:number;summaryDigest?:string;truncated?:boolean;
}
export interface CloudSkillSelectionOptions {
  versionedSkillworker?:VersionedSkillWorkerPort|undefined;
  /** Same native two-phase export gate as the original MCP read. Missing denies. */
  publicReferenceExport?:PublicReferenceExportOptions|undefined;
  /** Trusted, fresh PUBLIC export permission check. No grants issued here. */
  resolvePublicSource(input:{taskId:string; proposalId:string; revision:number; sourceRef:string; deadline:string; signal:AbortSignal}):PublicSkillSource;
}
const KEY='skill:cloud-selection:v1';
export const CLOUD_SKILL_TOOL_NAME='skill.workspace_reference_summary';
export const CLOUD_SKILL_TOOL_VERSION='1.0.0';
export const CLOUD_SKILL_PUBLIC_ENUM_PATHS=['/skillId','/version','/digest'] as const;
export const CLOUD_SKILL_CHOICE_SCHEMA={type:'object',properties:{skillId:{type:'string',const:'workspace-reference-summary'},version:{type:'string',const:'1.0.0'},digest:{type:'string',pattern:'^[a-f0-9]{64}$'},sourceRef:{type:'string',pattern:'^[A-Za-z0-9._:-]{1,128}$'}},required:['skillId','version','digest','sourceRef'],additionalProperties:false};
const selectionSchema={type:'object',properties:{selectionRef:{type:'string',minLength:1,maxLength:128},skillId:{const:'workspace-reference-summary'},version:{const:'1.0.0'},digest:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['selectionRef','skillId','version','digest'],additionalProperties:false};
interface Saved {taskId:string; proposalId:string; choice:CloudSkillChoice; source:PublicSkillSource; selection:CloudSkillSelection; receipt?:CloudSkillReceipt}
function fail(code:string,message:string):never {throw new ProtocolError(code,message);}

/** Selection/receipt adapter only: no second framework, loop, Gateway or DB. */
export function createCloudSkillSelectionPort(options:CloudSkillSelectionOptions) {
  const worker=options.versionedSkillworker;
  const exporter=createPublicReferenceExport(options.publicReferenceExport);
  let closed=false;
  const controller=new AbortController();
  const active=new Set<string>();
  function check(context:CloudSkillContext) {
    if(closed || context.signal.aborted) fail('CANCELLED','Skill selection was stopped');
    if(!Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline)<=Date.now()) fail('TIMEOUT','Skill selection expired');
    if(!Number.isSafeInteger(context.revision) || context.revision<1) fail('INVALID_ARGUMENT','Skill revision is required');
    if(typeof context.proposalId!=='string' || !context.proposalId || context.proposalId.length>1024) fail('INVALID_ARGUMENT','Original Skill proposal is required');
    if(!worker?.health().connected || !options.publicReferenceExport) fail('UNSUPPORTED_CAPABILITY','Versioned Skill worker or public export is unavailable');
  }
  function source(choice:CloudSkillChoice,context:CloudSkillContext):PublicSkillSource {
    const value=options.resolvePublicSource({taskId:context.taskId,proposalId:context.proposalId,revision:context.revision,
      sourceRef:choice.sourceRef,deadline:context.deadline,signal:context.signal});
    if(!value || value.sourceRef!==choice.sourceRef || value.revision!==context.revision
      || typeof value.path!=='string' || !value.path || typeof value.configurationRef!=='string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.configurationRef)
      || value.sensitivity!=='PUBLIC' || value.purpose!=='reference-summary'
      || !Number.isSafeInteger(value.maxExportBytes) || value.maxExportBytes<1 || value.maxExportBytes>262144
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.authorizationId)
      || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt)<=Date.now()) fail('UNAUTHORIZED','Public Skill source is unavailable');
    // Content SHA is not invented before the original read has happened.
    return {path:value.path,sourceRef:value.sourceRef,configurationRef:value.configurationRef,revision:value.revision,
      sensitivity:value.sensitivity,purpose:value.purpose,maxExportBytes:value.maxExportBytes,
      authorizationId:value.authorizationId,expiresAt:value.expiresAt};
  }
  function readInput(saved:Saved) {return {taskId:saved.taskId,proposalId:saved.proposalId,arguments:{path:saved.source.path}};}
  function assertPublicReadScope(saved:Saved,context:CloudSkillContext) {
    const permission=options.publicReferenceExport!.readPreflight({...readInput(saved),path:saved.source.path,
      configurationRef:saved.source.configurationRef});
    if(!permission || ['authorizationId','expiresAt','sensitivity','purpose','maxExportBytes'].some(key=>
      permission[key as keyof PublicReferenceExportPreflight]!==saved.source[key as keyof PublicReferenceExportPreflight]))
      fail('UNAUTHORIZED','Skill and read export permissions do not match');
    if(!exporter.accepts({...readInput(saved),phase:'preflight',signal:context.signal})) fail('UNAUTHORIZED','Public Skill read scope is unavailable');
  }
  function publicSummary(saved:Saved,contentDigest:string,context:CloudSkillContext) {
    const input=readInput(saved);
    assertPublicReadScope(saved,context);
    const original=options.publicReferenceExport!.readConfirmed({...input,path:saved.source.path,
      configurationRef:saved.source.configurationRef,contentDigest});
    if(!original) fail('RESULT_UNKNOWN','Original Skill read is not confirmed');
    const projection=exporter.project({...input,result:original.result,signal:context.signal});
    if(projection.contentDigest!==contentDigest) fail('RESULT_UNKNOWN','Public Skill source changed');
    assertPublicReadScope(saved,context);
    const summary=referenceSummary(projection.content);
    return {content:summary.content,byteLength:Buffer.byteLength(summary.content),
      summaryDigest:createHash('sha256').update(summary.content).digest('hex'),truncated:summary.truncated};
  }
  function matchingManifest(choice:CloudSkillChoice) {
    const manifest=worker!.manifest();
    if(choice.skillId!==manifest.id || choice.version!==manifest.version || choice.digest!==manifest.digest)
      fail('PROTOCOL_MISMATCH','Skill selection version changed');
  }
  function bound(selection:CloudSkillSelection,context:CloudSkillContext):Saved {
    validateToolValue(selectionSchema,selection); check(context);
    const saved=context.loadCheckpoint(KEY) as Saved|undefined;
    if(!saved || saved.taskId!==context.taskId || saved.proposalId!==context.proposalId || !isDeepStrictEqual(saved.selection,selection)) fail('UNAUTHORIZED','Skill selection is not bound to this task');
    matchingManifest(saved.choice);
    if(!isDeepStrictEqual(saved.source,source(saved.choice,context))) fail('REVISION_CONFLICT','Skill source or configuration changed');
    return saved;
  }
  function select(choice:CloudSkillChoice,context:CloudSkillContext):CloudSkillSelection {
    validateToolValue(CLOUD_SKILL_CHOICE_SCHEMA,choice); check(context); matchingManifest(choice);
    const current=source(choice,context);
    const saved=context.loadCheckpoint(KEY) as Saved|undefined;
    if(saved) {
      if(saved.taskId!==context.taskId || saved.proposalId!==context.proposalId || !isDeepStrictEqual(saved.choice,choice)
        || !isDeepStrictEqual(saved.source,current)) fail('REVISION_CONFLICT','Skill selection binding changed');
      return structuredClone(saved.selection);
    }
    const selection={selectionRef:randomUUID(),skillId:choice.skillId,version:choice.version,digest:choice.digest};
    context.saveCheckpoint(KEY,{taskId:context.taskId,proposalId:context.proposalId,choice:structuredClone(choice),source:current,selection});
    return structuredClone(selection);
  }
  const port={
    /** Native host approves publishing these owned public enums. This descriptor
     * feeds existing availableTools, not ToolGateway.register. */
    describe():CoordinationAvailableTool|undefined {
      if(closed || !worker?.health().connected || !options.publicReferenceExport) return undefined;
      const manifest=worker.manifest();
      return {name:CLOUD_SKILL_TOOL_NAME,version:CLOUD_SKILL_TOOL_VERSION,inputSchema:{
        type:'object',properties:{skillId:{type:'string',enum:[manifest.id]},version:{type:'string',enum:[manifest.version]},
          digest:{type:'string',enum:[manifest.digest]},sourceRef:{type:'string',minLength:1,maxLength:128}},
        required:['skillId','version','digest','sourceRef'],additionalProperties:false}};
    },
    catalog(sourceRef:string,context:CloudSkillContext):CloudSkillChoice {
      check(context);
      const manifest=worker!.manifest();
      const choice={skillId:manifest.id,version:manifest.version,digest:manifest.digest,sourceRef};
      validateToolValue(CLOUD_SKILL_CHOICE_SCHEMA,choice); source(choice,context);
      return choice;
    },
    /** Call only after AgentArts has returned a validated choice. The sourceRef is
     * a host-published opaque PUBLIC identifier, never a private path. */
    select,
    async run(selection:CloudSkillSelection,context:CloudSkillContext):Promise<CloudSkillReceipt> {
      const saved=bound(selection,context);
      assertPublicReadScope(saved,context);
      if(active.has(context.taskId)) fail('REVISION_CONFLICT','Skill selection is already running');
      active.add(context.taskId);
      try {
        const outcome=await worker!.invoke({skillId:selection.skillId,version:selection.version,digest:selection.digest,path:saved.source.path},
          {...context,signal:AbortSignal.any([context.signal,controller.signal])});
        // Unknown is never retried here: worker owns original run/checkpoint and
        // trusted read-only reconciliation. Caller persists receipt in its loop.
        check(context); matchingManifest(saved.choice);
        if(!isDeepStrictEqual(saved.source,source(saved.choice,context))) fail('REVISION_CONFLICT','Skill export permission changed');
        if(!['confirmed','pending','unknown'].includes(outcome.state)) fail('RESULT_UNKNOWN','Skill receipt is not valid');
        if(outcome.state==='confirmed' && (outcome.sources?.length!==1 || outcome.sources[0]?.path!==saved.source.path
          || !/^[a-f0-9]{64}$/.test(outcome.sources[0]?.contentDigest??''))) fail('RESULT_UNKNOWN','Skill body digest is not bound to the public source');
        const contentDigest=outcome.state==='confirmed'?outcome.sources![0]!.contentDigest:undefined;
        const receipt:CloudSkillReceipt={state:outcome.state,selectionRef:selection.selectionRef,sourceRef:saved.source.sourceRef,
          ...(contentDigest?{contentDigest,...publicSummary(saved,contentDigest,context)}:{})};
        saved.receipt=receipt;context.saveCheckpoint(KEY,saved);
        return structuredClone(receipt);
      } finally {active.delete(context.taskId);}
    },
    /** Call after any asynchronous credential/config read, immediately before
     * existing CloudAgentPort I/O, including resumed continuation. */
    assertReceiptAllowed(selection:CloudSkillSelection,receipt:CloudSkillReceipt,context:CloudSkillContext):void {
      const saved=bound(selection,context);
      if(receipt.state!=='confirmed' || !receipt.contentDigest || !saved.receipt || !isDeepStrictEqual(saved.receipt,receipt))
        fail('UNAUTHORIZED','Skill receipt is not the persisted original confirmed result');
      const projected=publicSummary(saved,receipt.contentDigest,context);
      if(!isDeepStrictEqual({...receipt,...projected},receipt)) fail('UNAUTHORIZED','Skill summary is no longer exportable');
    },
    close(){closed=true;controller.abort();exporter.dispose();},
  };
  return {...port,
    /** Existing validated Coordination tool_proposal, dispatched by the original
     * coordination worker BEFORE tools.invoke acquires any Gateway task lock. */
    dispatch(proposal:CoordinationToolProposalResult,context:Omit<CloudSkillContext,'proposalId'>) {
      if(proposal.kind!=='tool_proposal' || proposal.toolName!==CLOUD_SKILL_TOOL_NAME
        || proposal.toolVersion!==CLOUD_SKILL_TOOL_VERSION || proposal.verification!=='unverified')
        fail('UNSUPPORTED_CAPABILITY','Proposal does not select the real Skill worker');
      const boundContext={...context,proposalId:proposal.proposalId};
      const selection=select(proposal.arguments as unknown as CloudSkillChoice,boundContext);
      return port.run(selection,boundContext);
    },
  };
}
