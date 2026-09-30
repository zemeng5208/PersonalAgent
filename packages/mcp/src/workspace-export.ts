import {createHash} from 'node:crypto';
import {validateToolValue} from '@personal-agent/contracts';
import type {WorkspaceReadResult} from '@personal-agent/coding-tools';
import type {PublicReferenceReadQuery,PublicReferenceExportPreflight,PublicReferenceContentQuery,PublicReferenceExportAuthorization} from './public-export.js';
import {createReferenceTextExport} from './reference-text-export.js';

export interface WorkspaceReferenceExportOptions {
  currentConfigurationRef():string|undefined;
  readPreflight(query:PublicReferenceReadQuery):PublicReferenceExportPreflight|undefined;
  readAuthorization(query:PublicReferenceContentQuery):PublicReferenceExportAuthorization|undefined;
  /** Original workspace Runtime confirmation, including full maxBytes arguments. */
  readConfirmed(query:PublicReferenceReadQuery & {contentDigest:string}):{runId:string;result:WorkspaceReadResult}|undefined;
}
const inputSchema={type:'object',properties:{path:{type:'string',minLength:1,maxLength:1024},maxBytes:{type:'integer',minimum:1,maximum:262144}},required:['path'],additionalProperties:false};
const resultSchema={type:'object',properties:{path:{type:'string'},encoding:{const:'utf-8'},byteLength:{type:'integer',minimum:0,maximum:262144},content:{type:'string'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['path','encoding','byteLength','content','sha256'],additionalProperties:false};

/** Original workspace result schema; only exact native PUBLIC contents project. */
export function createWorkspaceReferenceExport(options?:WorkspaceReferenceExportOptions) {
  return createReferenceTextExport(options,{
    toolName:'workspace.read_text',exportPolicyVersion:'workspace-reference-3.0.0',source:'approved-workspace-reference',inputSchema,
    pathAllowed:()=>true,
    normalize(value) {
      validateToolValue(resultSchema,value);
      const read=value as WorkspaceReadResult;
      return {path:read.path,content:read.content,byteLength:read.byteLength,contentDigest:read.sha256!,
        actualDigest:createHash('sha256').update(read.content,'utf8').digest('hex')};
    },
  });
}
