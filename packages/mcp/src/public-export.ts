import {createHash} from 'node:crypto';
import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {McpReadResult} from './index.js';

export interface PublicReferenceExportQuery {
  taskId:string;
  proposalId:string;
  path:string;
  configurationRef:string;
}
export interface PublicReferenceExportAuthorization {
  /** Native host identity for explicit public/synthetic data export consent. */
  authorizationId:string;
  contentDigest:string;
  expiresAt:string;
}
export interface PublicReferenceExportOptions {
  currentConfigurationRef():string|undefined;
  /** Exact native-confirmed task/proposal/path/configuration. Not workspace read consent. */
  readAuthorization(query:PublicReferenceExportQuery):PublicReferenceExportAuthorization|undefined;
  /** Original Runtime confirmed execution and result checkpoint only. Verify the
   * proposal/run/tool/version/arguments/scope/Policy/Evidence before returning.
   * Never invoke, grant or accept a Renderer/cloud receipt. */
  readConfirmed(query:PublicReferenceExportQuery & {contentDigest:string}):{runId:string;result:McpReadResult}|undefined;
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const opaque=(value:unknown):value is string=>typeof value==='string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const identifier=(value:unknown):value is string=>typeof value==='string' && value.length>0 && value.length<=1024;
const pathSchema={type:'object',properties:{path:{type:'string',minLength:1,maxLength:1024}},required:['path'],additionalProperties:false};
const resultSchema={type:'object',properties:{path:{type:'string'},text:{type:'string'},contentDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},source:{const:'mcp'},serverVersion:{const:'2026.8.31'}},required:['path','text','contentDigest','source','serverVersion'],additionalProperties:false};
function deny():never {throw new ProtocolError('UNAUTHORIZED','Public reference export is unavailable or no longer authorized');}
function safePath(path:string) {
  return !path.includes('\\') && !path.includes(':') && /\.(?:md|txt)$/i.test(path)
    && path.split('/').every(part=>!!part && part!=='.' && part!=='..');
}

/** Compatible with the existing trusted CompetitionToolExport. No execution or
 * outbound I/O; the native host remains the sole permission and receipt source. */
export function createPublicReferenceExport(options?:PublicReferenceExportOptions) {
  const current=options?.currentConfigurationRef.bind(options);
  const authorize=options?.readAuthorization.bind(options);
  const confirmed=options?.readConfirmed.bind(options);
  let disposed=false;
  const bindings=new Map<string,{query:PublicReferenceExportQuery;authorization:PublicReferenceExportAuthorization;runId?:string}>();
  const key=(taskId:string,proposalId:string)=>JSON.stringify([taskId,proposalId]);
  function check(query:PublicReferenceExportQuery) {
    if(disposed || !current || !authorize || !confirmed || current()!==query.configurationRef) deny();
    const authorization=authorize({...query});
    if(!authorization || !opaque(authorization.authorizationId) || typeof authorization.contentDigest!=='string'
      || !/^[a-f0-9]{64}$/.test(authorization.contentDigest) || typeof authorization.expiresAt!=='string'
      || !Number.isFinite(Date.parse(authorization.expiresAt)) || Date.parse(authorization.expiresAt)<=Date.now()
      || current()!==query.configurationRef) deny();
    return {...authorization};
  }
  function sameAuthorization(a:PublicReferenceExportAuthorization,b:PublicReferenceExportAuthorization) {
    return a.authorizationId===b.authorizationId && a.contentDigest===b.contentDigest && a.expiresAt===b.expiresAt;
  }
  return {
    toolName:'mcp.workspace.read_text',toolVersion:'1.0.0',exportPolicyVersion:'2.0.0',
    accepts(input:{taskId:string;proposalId:string;arguments:Record<string,unknown>}):boolean {
      try {
        validateToolValue(pathSchema,input.arguments);
        const path=input.arguments.path as string,configurationRef=current?.();
        if(!identifier(input.taskId) || !identifier(input.proposalId) || !opaque(configurationRef) || !safePath(path)) return false;
        const query={taskId:input.taskId,proposalId:input.proposalId,path,configurationRef};
        const authorization=check(query),saved=bindings.get(key(input.taskId,input.proposalId));
        if(saved && (saved.query.path!==path || saved.query.configurationRef!==configurationRef
          || !sameAuthorization(saved.authorization,authorization))) return false;
        if(!saved) bindings.set(key(input.taskId,input.proposalId),{query,authorization});
        return true;
      } catch {return false;}
    },
    project(input:{taskId:string;proposalId:string;result:unknown;signal:AbortSignal}) {
      try {
        if(input.signal.aborted) throw new ProtocolError('CANCELLED','Public reference export cancelled');
        const saved=bindings.get(key(input.taskId,input.proposalId));
        if(!saved || !sameAuthorization(saved.authorization,check(saved.query))) deny();
        validateToolValue(resultSchema,input.result);
        const result=structuredClone(input.result) as McpReadResult;
        if(result.path!==saved.query.path || result.contentDigest!==saved.authorization.contentDigest
          || Buffer.byteLength(result.text)>262144 || hash(result.text)!==result.contentDigest) deny();
        const receipt=confirmed!({...saved.query,contentDigest:saved.authorization.contentDigest});
        if(!receipt || typeof receipt.runId!=='string' || !receipt.runId || (saved.runId && saved.runId!==receipt.runId)) deny();
        validateToolValue(resultSchema,receipt.result);
        if(receipt.result.path!==result.path || receipt.result.contentDigest!==result.contentDigest || receipt.result.text!==result.text) deny();
        if(input.signal.aborted) throw new ProtocolError('CANCELLED','Public reference export cancelled');
        if(!sameAuthorization(saved.authorization,check(saved.query))) deny();
        saved.runId=receipt.runId;
        return {source:'approved-reference' as const,contentDigest:result.contentDigest,readConfirmed:true as const};
      } catch(error) {
        if(error instanceof ProtocolError && error.code==='CANCELLED') throw error;
        deny();
      }
    },
    dispose(){disposed=true;bindings.clear();},
  };
}
