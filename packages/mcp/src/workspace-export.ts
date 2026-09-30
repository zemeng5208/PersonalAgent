import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {WorkspaceReadResult} from '@personal-agent/coding-tools';
import type {PublicReferenceExportQuery, PublicReferenceExportAuthorization} from './public-export.js';

/** Same native authorization DTO as MCP, but the original workspace result type
 * remains a workspace result. The native port pins root/configGeneration in ref.
 */
export interface WorkspaceReferenceExportOptions {
  currentConfigurationRef():string|undefined;
  readAuthorization(query:PublicReferenceExportQuery):PublicReferenceExportAuthorization|undefined;
  /** Original workspace.read_text@1.0.0 Runtime execution, never an MCP receipt.
   * Verify exact proposal/run/tool/version/full arguments/scope/Policy/Evidence.
   * No invocation, grant, external receipt or task-state mutation here. */
  readConfirmed(query:PublicReferenceExportQuery & {contentDigest:string}):{runId:string;result:WorkspaceReadResult}|undefined;
}
const argumentsSchema={type:'object',properties:{path:{type:'string',minLength:1,maxLength:1024},maxBytes:{type:'integer',minimum:1,maximum:262144}},required:['path'],additionalProperties:false};
const resultSchema={type:'object',properties:{path:{type:'string'},encoding:{const:'utf-8'},byteLength:{type:'integer',minimum:0,maximum:262144},content:{type:'string'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['path','encoding','byteLength','content','sha256'],additionalProperties:false};
const opaque=(value:unknown):value is string=>typeof value==='string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const identity=(value:unknown):value is string=>typeof value==='string' && value.length>0 && value.length<=1024;
const deny=():never=>{throw new ProtocolError('UNAUTHORIZED','Workspace public export is unavailable or revoked');};
const safePath=(path:string)=>!path.includes('\\') && !path.includes(':')
  && path.split('/').every(part=>!!part && part!=='.' && part!=='..');

/** Digest-only confirmed workspace export; compatible CompetitionToolExport.
 * No raw paths/body/secret/authorization/run/Evidence in projected cloud values. */
export function createWorkspaceReferenceExport(options?:WorkspaceReferenceExportOptions) {
  const current=options?.currentConfigurationRef.bind(options);
  const authorize=options?.readAuthorization.bind(options);
  const confirmed=options?.readConfirmed.bind(options);
  let disposed=false;
  const bindings=new Map<string,{query:PublicReferenceExportQuery;arguments:Record<string,unknown>;authorization:PublicReferenceExportAuthorization;runId?:string}>();
  const key=(taskId:string,proposalId:string)=>JSON.stringify([taskId,proposalId]);
  function check(query:PublicReferenceExportQuery):PublicReferenceExportAuthorization {
    if(disposed || !current || !authorize || !confirmed || current()!==query.configurationRef) deny();
    const permission=authorize({...query});
    if(!permission || !opaque(permission.authorizationId) || !/^[a-f0-9]{64}$/.test(permission.contentDigest)
      || !Number.isFinite(Date.parse(permission.expiresAt)) || Date.parse(permission.expiresAt)<=Date.now()
      || current()!==query.configurationRef) deny();
    return {...permission};
  }
  function matching(a:PublicReferenceExportAuthorization,b:PublicReferenceExportAuthorization) {
    return a.authorizationId===b.authorizationId && a.contentDigest===b.contentDigest && a.expiresAt===b.expiresAt;
  }
  function result(value:unknown):WorkspaceReadResult {
    validateToolValue(resultSchema,value);
    const read=structuredClone(value) as WorkspaceReadResult;
    if(Buffer.byteLength(read.content)!==read.byteLength || read.byteLength>262144
      || createHash('sha256').update(read.content,'utf8').digest('hex')!==read.sha256) deny();
    return read;
  }
  return {
    toolName:'workspace.read_text',toolVersion:'1.0.0',exportPolicyVersion:'workspace-reference-2.0.0',
    accepts(input:{taskId:string;proposalId:string;arguments:Record<string,unknown>}) {
      try {
        validateToolValue(argumentsSchema,input.arguments);
        const path=input.arguments.path as string,configurationRef=current?.();
        if(!identity(input.taskId) || !identity(input.proposalId) || !opaque(configurationRef) || !safePath(path)) return false;
        const query={taskId:input.taskId,proposalId:input.proposalId,path,configurationRef};
        const authorization=check(query),saved=bindings.get(key(input.taskId,input.proposalId));
        if(saved && (!isDeepStrictEqual(saved.query,query) || !isDeepStrictEqual(saved.arguments,input.arguments)
          || !matching(saved.authorization,authorization))) return false;
        if(!saved) bindings.set(key(input.taskId,input.proposalId),{query,arguments:structuredClone(input.arguments),authorization});
        return true;
      } catch {return false;}
    },
    project(input:{taskId:string;proposalId:string;result:unknown;signal:AbortSignal}) {
      try {
        if(input.signal.aborted) throw new ProtocolError('CANCELLED','Workspace public export cancelled');
        const saved=bindings.get(key(input.taskId,input.proposalId));
        if(!saved || !matching(saved.authorization,check(saved.query))) deny();
        const read=result(input.result);
        if(read.path!==saved.query.path || read.sha256!==saved.authorization.contentDigest) deny();
        const receipt=confirmed!({...saved.query,contentDigest:saved.authorization.contentDigest});
        if(!receipt || !identity(receipt.runId) || (saved.runId && saved.runId!==receipt.runId)
          || !isDeepStrictEqual(read,result(receipt.result))) deny();
        if(input.signal.aborted) throw new ProtocolError('CANCELLED','Workspace public export cancelled');
        if(!matching(saved.authorization,check(saved.query))) deny();
        saved.runId=receipt.runId;
        return {source:'approved-workspace-reference' as const,contentDigest:read.sha256!,readConfirmed:true as const};
      } catch(error) {
        if(error instanceof ProtocolError && error.code==='CANCELLED') throw error;
        deny();
      }
    },
    dispose(){disposed=true;bindings.clear();},
  };
}
