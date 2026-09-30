import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createReferenceSummarySkill} from '../dist/index.js';
import {createReadonlyMcpHost,MCP_READ_SCOPE} from '@personal-agent/mcp';
import {ToolGateway,toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';

test('two-step Skill really reads the official stdio service through Gateway/Policy; replay does not execute again',async()=>{
  const parent=fileURLToPath(new URL('../../../.cache/skill-real/',import.meta.url));await mkdir(parent,{recursive:true});
  const root=await mkdtemp(parent+'case-');const text='Competition reference from a public synthetic fixture.\nRuntime validates each authorized read.\n';await writeFile(root+'/reference.md',text);
  const host=createReadonlyMcpHost({rootPath:root,nodeExecutable:process.execPath,enabled:true});const policy=new InMemoryAuthorizationPolicy();const gateway=new ToolGateway({policy});host.register(gateway);
  const deadline=new Date(Date.now()+20000).toISOString();const signal=new AbortController().signal;
  const checkpoints=new Map();let calls=0;
  const tools={list:()=>gateway.list(),invoke:async invocation=>{calls++;const result=await gateway.invoke(invocation);return {state:'confirmed',result,evidenceRefs:[]};}};
  const skill=createReferenceSummarySkill({enabled:true,tools,isToolAvailable:()=>host.health().connected});
  const context={taskId:'synthetic-skill-real',deadline,signal,loadCheckpoint:key=>structuredClone(checkpoints.get(key)),saveCheckpoint:(key,value)=>checkpoints.set(key,structuredClone(value)),reportProgress:()=>{}};
  try {
    await host.start({deadline,signal});const manifest=skill.manifest();
    const input={skillId:manifest.id,version:manifest.version,digest:manifest.digest,path:'reference.md'};
    const runId=`skill-read-${context.taskId}-${manifest.digest.slice(0,16)}`;
    // Explicit synthetic trusted-host grant, outside the Skill and Gateway.
    policy.grant({authorizationRef:runId,taskId:context.taskId,toolName:manifest.capabilities[0].toolName,scopes:[MCP_READ_SCOPE],argumentsDigest:toolArgumentsDigest({path:'reference.md'}),expiresAt:deadline,maxUses:1});
    const result=await skill.invoke(input,context);assert.equal(result.state,'confirmed');assert.match(result.resultSummary,/Competition reference from a public synthetic fixture/);
    assert.equal(result.sources[0].path,'reference.md');assert.equal(policy.get(runId).usesRemaining,0);
    assert.equal([...checkpoints.values()][0].read.text,text);
    assert.deepEqual(await skill.invoke(input,context),result);assert.equal(calls,1);
    assert.deepEqual(result.evidenceRefs,[]); // No fabricated Runtime Evidence receipt.
  } finally {skill.dispose();await host.dispose();}
});
