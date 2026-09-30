import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {AgentToolPort, AgentWorkerContext, ToolInvocationResult} from '@personal-agent/agents';

export const REFERENCE_SUMMARY_SKILL_ID='workspace-reference-summary';
export const REFERENCE_SUMMARY_SKILL_VERSION='1.0.0';
const TOOL_NAME='mcp.workspace.read_text';
const TOOL_VERSION='1.0.0';
const CHECKPOINT='skill:workspace-reference-summary:v1';
function fail(code:string,message:string):never {throw new ProtocolError(code,message);}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const parameters={type:'object',properties:{skillId:{const:REFERENCE_SUMMARY_SKILL_ID},version:{const:REFERENCE_SUMMARY_SKILL_VERSION},digest:{type:'string',pattern:'^[a-f0-9]{64}$'},path:{type:'string',minLength:1,maxLength:1024}},required:['skillId','version','digest','path'],additionalProperties:false};
const readResultSchema={type:'object',properties:{path:{type:'string'},text:{type:'string',maxLength:262144},contentDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},source:{const:'mcp'},serverVersion:{type:'string'}},required:['path','text','contentDigest','source','serverVersion'],additionalProperties:false};

export interface SkillManifest {
  id:typeof REFERENCE_SUMMARY_SKILL_ID;
  version:typeof REFERENCE_SUMMARY_SKILL_VERSION;
  digest:string;
  name:string;
  description:string;
  capabilities:readonly {toolName:string;toolVersion:string;sideEffect:'read'}[];
  inputSchema:typeof parameters;
  steps:readonly ['read-reference','summarize-reference'];
}
export interface ReferenceSummaryInput {skillId:string;version:string;digest:string;path:string}
export interface SkillOutcome {
  state:'confirmed'|'pending'|'unknown';
  evidenceRefs:readonly string[];
  resultSummary?:string;
  sources?:readonly {path:string;contentDigest:string}[];
}
export interface ReferenceSummaryOptions {
  /** Existing Runtime tool port; never RegisteredTool.execute or self-issued grants. */
  tools:AgentToolPort;
  enabled?:boolean;
  /** Fresh trusted MCP health check, not an external tool annotation. */
  isToolAvailable:()=>boolean;
}
interface Checkpoint {
  binding:string;
  phase:'started'|'pending'|'unknown'|'read-confirmed'|'complete';
  read?:{path:string;text:string;contentDigest:string};
  evidenceRefs:string[];
  outcome?:SkillOutcome;
}

/** Fixed two-step skill runner, called at the worker layer outside tool locks. */
export function createReferenceSummarySkill(options?:ReferenceSummaryOptions) {
  let enabled=options?.enabled ?? false;
  let disposed=false;
  let epoch=0;
  let controller=new AbortController();
  const activeTasks=new Set<string>();
  function manifest():SkillManifest {
    let body:string;
    try {body=readFileSync(new URL('../workspace-reference-summary/SKILL.md',import.meta.url),'utf8').replace(/\r\n/g,'\n');}
    catch {return fail('UNSUPPORTED_CAPABILITY','Skill bundle could not be loaded');}
    // This is an owned fixed Agent Skills bundle, not a general YAML/script loader.
    if(!body.startsWith('---\nname: workspace-reference-summary\ndescription: ') || body.length>16384) fail('PROTOCOL_MISMATCH','Skill bundle metadata is incompatible');
    const base={id:REFERENCE_SUMMARY_SKILL_ID,version:REFERENCE_SUMMARY_SKILL_VERSION,
      name:'Workspace reference summary',description:'Read approved text and return two source lines with provenance.',
      capabilities:[{toolName:TOOL_NAME,toolVersion:TOOL_VERSION,sideEffect:'read' as const}],inputSchema:parameters,
      steps:['read-reference','summarize-reference'] as const} satisfies Omit<SkillManifest,'digest'>;
    return {...structuredClone(base),digest:hash(JSON.stringify(base)+'\n'+body)};
  }
  function available() {
    if(!options || disposed || !enabled || !options.isToolAvailable()) return false;
    return options.tools.list().some(tool=>tool.name===TOOL_NAME && tool.version===TOOL_VERSION && tool.sideEffect==='read');
  }
  const health=()=>({configured:!!options,enabled,connected:available(),state:disposed?'disposed':!options?'unavailable':!enabled?'disabled':available()?'ready':'unavailable',id:REFERENCE_SUMMARY_SKILL_ID,version:REFERENCE_SUMMARY_SKILL_VERSION,digest:manifest().digest});
  function check(context:AgentWorkerContext, generation:number, bindingDigest:string) {
    if(context.signal.aborted || controller.signal.aborted || generation!==epoch) fail('CANCELLED','Skill invocation was cancelled or disabled');
    if(!Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline)<=Date.now()) fail('TIMEOUT','Skill deadline expired');
    if(manifest().digest!==bindingDigest) fail('PROTOCOL_MISMATCH','Skill content changed during invocation');
    if(!available()) fail('UNSUPPORTED_CAPABILITY','Skill tool dependency is unavailable');
  }
  async function run(input:ReferenceSummaryInput,context:AgentWorkerContext):Promise<SkillOutcome> {
    validateToolValue(parameters,input);
    const current=manifest();
    if(input.digest!==current.digest) fail('PROTOCOL_MISMATCH','Skill version or digest is not current');
    const generation=epoch; check(context,generation,input.digest);
    const binding=JSON.stringify({taskId:context.taskId,skillId:input.skillId,version:input.version,digest:input.digest,path:input.path});
    let saved=context.loadCheckpoint(CHECKPOINT) as Checkpoint|undefined;
    if(saved && (typeof saved!=='object' || saved.binding!==binding)) fail('REVISION_CONFLICT','Skill task is bound to different input or version');
    if(saved?.phase==='complete') return structuredClone(saved.outcome!);
    if(saved?.phase==='started' || saved?.phase==='unknown') return {state:'unknown',evidenceRefs:[...saved.evidenceRefs]};
    if(!saved?.read) {
      context.reportProgress({stepId:'skill-read-reference',label:'Read approved reference',completedUnits:0,totalUnits:2});
      const runId=`skill-read-${context.taskId}-${input.digest.slice(0,16)}`;
      saved={binding,phase:'started',evidenceRefs:saved?.evidenceRefs ?? []};
      context.saveCheckpoint(CHECKPOINT,saved);
      let result:ToolInvocationResult;
      try {
        result=await options!.tools.invoke({toolName:TOOL_NAME,toolVersion:TOOL_VERSION,arguments:{path:input.path},
          taskId:context.taskId,runId,authorizationRef:runId,deadline:context.deadline,
          signal:AbortSignal.any([context.signal,controller.signal])});
      } catch(error) {
        saved.phase='unknown';context.saveCheckpoint(CHECKPOINT,saved);
        throw error instanceof ProtocolError ? error : new ProtocolError('EXTERNAL_FAILURE','Skill read did not return a confirmed result');
      }
      saved.evidenceRefs=[...result.evidenceRefs];
      if(result.state!=='confirmed') {
        saved.phase=result.state;context.saveCheckpoint(CHECKPOINT,saved);
        return {state:result.state,evidenceRefs:[...result.evidenceRefs]};
      }
      try {
        validateToolValue(readResultSchema,result.result);
        const read=result.result as {path:string;text:string;contentDigest:string};
        if(read.path!==input.path || hash(read.text)!==read.contentDigest || Buffer.byteLength(read.text)>262144) fail('EXTERNAL_FAILURE','Skill source result is inconsistent');
        saved.read={path:read.path,text:read.text,contentDigest:read.contentDigest};saved.phase='read-confirmed';
      } catch {
        saved.phase='unknown';context.saveCheckpoint(CHECKPOINT,saved);
        fail('RESULT_UNKNOWN','Skill read returned an invalid result; reconcile before retrying');
      }
      // Preserve a confirmed execution even if stop/cancel happened while awaiting it.
      context.saveCheckpoint(CHECKPOINT,saved);
    }
    check(context,generation,input.digest);
    context.reportProgress({stepId:'skill-summarize-reference',label:'Summarize confirmed reference',completedUnits:1,totalUnits:2});
    const read=saved.read!;
    const excerpt=read.text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).slice(0,2).join(' ').slice(0,480);
    const outcome:SkillOutcome={state:'confirmed',resultSummary:`${excerpt || '(empty reference)'} [source=${read.path}; sha256=${read.contentDigest}]`,sources:[{path:read.path,contentDigest:read.contentDigest}],evidenceRefs:[...saved.evidenceRefs]};
    check(context,generation,input.digest);
    saved.phase='complete';saved.outcome=outcome;context.saveCheckpoint(CHECKPOINT,saved);
    context.reportProgress({stepId:'skill-summarize-reference',label:'Reference summary ready',completedUnits:2,totalUnits:2});
    return structuredClone(outcome);
  }
  return {
    manifest,health,
    async invoke(input:ReferenceSummaryInput,context:AgentWorkerContext) {
      if(activeTasks.has(context.taskId)) fail('REVISION_CONFLICT','Skill task is already active');
      activeTasks.add(context.taskId);
      try {return await run(input,context);} finally {activeTasks.delete(context.taskId);}
    },
    setEnabled(value:boolean){if(disposed)fail('UNSUPPORTED_CAPABILITY','Skill is disposed');if(enabled!==value){epoch++;controller.abort();controller=new AbortController();enabled=value;}return health();},
    dispose(){if(disposed)return;disposed=true;enabled=false;epoch++;controller.abort();},
  };
}
