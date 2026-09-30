import {isDeepStrictEqual} from 'node:util';
import {ProtocolError, validateToolValue} from '@personal-agent/contracts';
import type {PublicReferenceReadQuery,PublicReferenceContentQuery,PublicReferenceExportPreflight,
  PublicReferenceExportAuthorization,PublicReferenceTextProjection} from './public-export.js';

interface Ports {
  currentConfigurationRef():string|undefined;
  readPreflight(query:PublicReferenceReadQuery):PublicReferenceExportPreflight|undefined;
  readAuthorization(query:PublicReferenceContentQuery):PublicReferenceExportAuthorization|undefined;
  readConfirmed(query:PublicReferenceReadQuery & {contentDigest:string}):{runId:string;result:unknown}|undefined;
}
interface TextRead {path:string;content:string;byteLength:number;contentDigest:string;actualDigest:string}
interface Format {toolName:string;exportPolicyVersion:string;source:PublicReferenceTextProjection['source'];inputSchema:object;
  pathAllowed(path:string):boolean;normalize(value:unknown):TextRead}
interface Binding {query:PublicReferenceReadQuery;permission:PublicReferenceExportPreflight;runId?:string}
const opaque=(value:unknown):value is string=>typeof value==='string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const identity=(value:unknown):value is string=>typeof value==='string' && !!value && value.length<=1024;
function deny():never {throw new ProtocolError('UNAUTHORIZED','Public reference export is unavailable or no longer authorized');}
const safePath=(value:string)=>!value.includes('\\') && !value.includes(':')
  && value.split('/').every(part=>!!part && part!=='.' && part!=='..');
const scope=(value:PublicReferenceExportPreflight|undefined):PublicReferenceExportPreflight=>{
  if(!value || !opaque(value.authorizationId) || typeof value.expiresAt!=='string'
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt)<=Date.now()
    || value.sensitivity!=='PUBLIC' || !['reference-summary','coding-reference'].includes(value.purpose)
    || !Number.isSafeInteger(value.maxExportBytes) || value.maxExportBytes<1 || value.maxExportBytes>262144) deny();
  return {authorizationId:value.authorizationId,expiresAt:value.expiresAt,sensitivity:value.sensitivity,
    purpose:value.purpose,maxExportBytes:value.maxExportBytes};
};

/** Private shared validation for the two existing read-result formats. */
export function createReferenceTextExport(options:Ports|undefined,format:Format) {
  const current=options?.currentConfigurationRef.bind(options),preflight=options?.readPreflight.bind(options),
    authorization=options?.readAuthorization.bind(options),confirmed=options?.readConfirmed.bind(options);
  let disposed=false;
  const bindings=new Map<string,Binding>();
  const key=(taskId:string,proposalId:string)=>JSON.stringify([taskId,proposalId]);
  function check(query:PublicReferenceReadQuery) {
    if(disposed || !current || !preflight || !authorization || !confirmed || current()!==query.configurationRef) deny();
    const permission=scope(preflight(structuredClone(query)));
    if(current()!==query.configurationRef) deny();
    return permission;
  }
  function bind(input:{taskId:string;proposalId:string;arguments:Record<string,unknown>}) {
    validateToolValue(format.inputSchema,input.arguments);
    const path=input.arguments.path as string,configurationRef=current?.();
    if(!identity(input.taskId) || !identity(input.proposalId) || !opaque(configurationRef)
      || !safePath(path) || !format.pathAllowed(path)) deny();
    const query={taskId:input.taskId,proposalId:input.proposalId,path,configurationRef,arguments:structuredClone(input.arguments)};
    const permission=check(query),saved=bindings.get(key(input.taskId,input.proposalId));
    if(saved && (!isDeepStrictEqual(saved.query,query) || !isDeepStrictEqual(saved.permission,permission))) deny();
    const bound=saved??{query,permission};
    if(!saved) bindings.set(key(input.taskId,input.proposalId),bound);
    return bound;
  }
  function checkRead(value:unknown,saved:Binding) {
    const read=format.normalize(structuredClone(value));
    if(read.path!==saved.query.path || !/^[a-f0-9]{64}$/.test(read.contentDigest) || read.contentDigest!==read.actualDigest
      || Buffer.byteLength(read.content)!==read.byteLength || read.byteLength>saved.permission.maxExportBytes) deny();
    return read;
  }
  function project(saved:Binding,value:unknown,signal?:AbortSignal):PublicReferenceTextProjection {
    const cancelled=()=>{if(signal?.aborted) throw new ProtocolError('CANCELLED','Public reference export cancelled');};
    cancelled();
    if(!isDeepStrictEqual(saved.permission,check(saved.query))) deny();
    const read=checkRead(value,saved);
    const receipt=confirmed!({...structuredClone(saved.query),contentDigest:read.contentDigest});
    cancelled();
    if(!receipt || !identity(receipt.runId) || (saved.runId && saved.runId!==receipt.runId)
      || !isDeepStrictEqual(read,checkRead(receipt.result,saved))) deny();
    const query={...structuredClone(saved.query),contentDigest:read.contentDigest,byteLength:read.byteLength};
    const permit=authorization!(query);
    if(!isDeepStrictEqual(scope(permit),saved.permission) || permit?.contentDigest!==read.contentDigest) deny();
    cancelled();
    if(!isDeepStrictEqual(saved.permission,check(saved.query))) deny();
    const finalPermit=authorization!(structuredClone(query));
    if(!isDeepStrictEqual(scope(finalPermit),saved.permission) || finalPermit?.contentDigest!==read.contentDigest) deny();
    cancelled();
    if(!isDeepStrictEqual(saved.permission,check(saved.query))) deny();
    cancelled();
    saved.runId=receipt.runId;
    return {source:format.source,content:read.content,byteLength:read.byteLength,contentDigest:read.contentDigest,truncated:false,readConfirmed:true};
  }
  return {
    toolName:format.toolName,toolVersion:'1.0.0',exportPolicyVersion:format.exportPolicyVersion,
    accepts(input:{taskId:string;proposalId:string;arguments:Record<string,unknown>;phase?:'preflight'|'final';projection?:unknown;signal?:AbortSignal}):boolean {
      try {
        if(input.signal?.aborted) return false;
        const saved=bind(input);
        if(input.phase===undefined || input.phase==='preflight') return true;
        if(input.phase!=='final') return false;
        const projection=input.projection as PublicReferenceTextProjection|undefined;
        if(!projection || typeof projection.contentDigest!=='string') return false;
        const receipt=confirmed!({...structuredClone(saved.query),contentDigest:projection.contentDigest});
        if(!receipt) return false;
        return isDeepStrictEqual(project(saved,receipt.result,input.signal),projection);
      } catch {return false;}
    },
    project(input:{taskId:string;proposalId:string;result:unknown;signal:AbortSignal}) {
      try {
        if(input.signal.aborted) throw new ProtocolError('CANCELLED','Public reference export cancelled');
        const saved=bindings.get(key(input.taskId,input.proposalId));
        if(!saved) deny();
        return project(saved,input.result,input.signal);
      } catch(error) {
        if(error instanceof ProtocolError && error.code==='CANCELLED') throw error;
        deny();
      }
    },
    dispose(){disposed=true;bindings.clear();},
  };
}
