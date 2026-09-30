import {createHash} from 'node:crypto';
import {validateToolValue} from '@personal-agent/contracts';
import type {McpReadResult} from './index.js';
import {createReferenceTextExport} from './reference-text-export.js';

export interface PublicReferenceExportQuery {taskId:string;proposalId:string;path:string;configurationRef:string}
/** All arguments remain local and must match the original Runtime input digest. */
export interface PublicReferenceReadQuery extends PublicReferenceExportQuery {arguments:Record<string,unknown>}
export interface PublicReferenceExportPreflight {
  authorizationId:string;
  expiresAt:string;
  sensitivity:'PUBLIC';
  purpose:'reference-summary'|'coding-reference';
  maxExportBytes:number;
}
export interface PublicReferenceExportAuthorization extends PublicReferenceExportPreflight {contentDigest:string}
export interface PublicReferenceContentQuery extends PublicReferenceReadQuery {contentDigest:string;byteLength:number}
export interface PublicReferenceTextProjection {
  source:'approved-reference'|'approved-workspace-reference';content:string;byteLength:number;contentDigest:string;
  /** These read implementations reject oversized files, rather than truncating. */
  truncated:false;readConfirmed:true;
}
export interface PublicReferenceExportOptions {
  currentConfigurationRef():string|undefined;
  /** Native PUBLIC path/purpose prepermission + original task/read eligibility.
   * No receipt/digest requirement and no execute/grant or file read here. */
  readPreflight(query:PublicReferenceReadQuery):PublicReferenceExportPreflight|undefined;
  /** Native exact-content consent after the original confirmed read only. */
  readAuthorization(query:PublicReferenceContentQuery):PublicReferenceExportAuthorization|undefined;
  /** Verify original proposal/run/tool/version/full args/scope/Policy/Evidence
   * and result checkpoint; no execute, grant or external receipt. */
  readConfirmed(query:PublicReferenceReadQuery & {contentDigest:string}):{runId:string;result:McpReadResult}|undefined;
}
const inputSchema={type:'object',properties:{path:{type:'string',minLength:1,maxLength:1024}},required:['path'],additionalProperties:false};
const resultSchema={type:'object',properties:{path:{type:'string'},text:{type:'string'},contentDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},source:{const:'mcp'},serverVersion:{const:'2026.8.31'}},required:['path','text','contentDigest','source','serverVersion'],additionalProperties:false};

/** Existing accepts/project interface; explicit final phase on every real I/O and replay. */
export function createPublicReferenceExport(options?:PublicReferenceExportOptions) {
  return createReferenceTextExport(options,{
    toolName:'mcp.workspace.read_text',exportPolicyVersion:'3.0.0',source:'approved-reference',inputSchema,
    pathAllowed:path=>/\.(?:md|txt)$/i.test(path),
    normalize(value) {
      validateToolValue(resultSchema,value);
      const read=value as McpReadResult;
      return {path:read.path,content:read.text,byteLength:Buffer.byteLength(read.text),
        contentDigest:read.contentDigest,actualDigest:createHash('sha256').update(read.text).digest('hex')};
    },
  });
}
