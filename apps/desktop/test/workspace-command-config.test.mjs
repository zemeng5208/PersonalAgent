import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import * as coding from '@personal-agent/coding-tools';
import {createWorkspaceCommandRecipeTool} from '../electron/workspace-command-recipes.js';
import {createWorkspaceConfigHost} from '../electron/workspace-config-host.js';

const cache=new URL('../../../.cache/workspace-command-config-tests/',import.meta.url);
mkdirSync(cache,{recursive:true});
const safeStorage={isEncryptionAvailable:()=>true,
  encryptString:value=>Buffer.from(value).reverse(),
  decryptString:value=>Buffer.from(value).reverse().toString()};
const createCommandRecipeTool=options=>createWorkspaceCommandRecipeTool({
  ...options,createWorkspaceCommandTool:coding.createWorkspaceCommandTool});

test('encrypted legacy workspace adds fixed Node check without granting writes or project scripts',async()=>{
  const root=mkdtempSync(new URL('root-',cache));
  const userData=mkdtempSync(new URL('data-',cache));
  const target=path.join(root,'syntax.js');writeFileSync(target,'const answer = 42;\n');
  const outside=path.join(userData,'outside.js');writeFileSync(outside,'const x = 1;\n');
  writeFileSync(path.join(root,'node.exe'),'not executable');
  let host=createWorkspaceConfigHost({userData,safeStorage,selectDirectory:async()=>root,
    selectNodeExecutable:async()=>process.execPath,selectCheckFile:async()=>target,createCommandRecipeTool});
  assert.equal(host.snapshot().configured,false);
  await host.select();await host.selectNode();
  await host.selectCheckFile();
  const record=readFileSync(path.join(userData,'coding-workspace.json'),'utf8');
  assert.equal(JSON.parse(record).version,1);
  for (const plain of [root,process.execPath,'syntax.js']) assert.equal(record.includes(plain),false);
  host.close();

  host=createWorkspaceConfigHost({userData,safeStorage,selectDirectory:async()=>undefined,
    selectNodeExecutable:async()=>path.join(root,'node.exe'),
    selectCheckFile:async()=>outside,createCommandRecipeTool});
  const checkpoints=new Map();
  host.bindApplication({runtime:{loadCheckpoint:(id,key)=>checkpoints.get(`${id}:${key}`),
    saveCheckpoint:(id,key,value)=>checkpoints.set(`${id}:${key}`,value)}});
  try {
    assert.equal(host.snapshot().configured,true);
    assert.equal(host.snapshot().nodeConfigured,true);
    assert.equal(host.snapshot().checkFileName,'syntax.js');
    const tool=host.tools.find(item=>item.descriptor.name==='workspace.node_check');
    assert.ok(tool);
    assert.deepEqual(tool.descriptor.inputSchema,{type:'object',properties:{},additionalProperties:false});
    const binding=host.competitionToolAvailability.find(item=>item.toolName==='workspace.node_check');
    const request={taskId:'node-task',signal:new AbortController().signal,
      deadline:new Date(Date.now()+30_000).toISOString()};
    assert.equal(binding.available(request),false);
    host.authorize({cloudExportAllowed:true,writeAllowed:false,commandAllowed:true,projectCodeAllowed:false});
    assert.equal(host.snapshot().writeAvailable,false);
    assert.equal(host.snapshot().nodeCheckAvailable,true);
    assert.equal(host.snapshot().projectScriptsAvailable,false);
    assert.equal(binding.available(request),true);
    const result=await tool.execute({}, {...request,runId:'node-run',authorizationRef:'node-run',
      scopes:['workspace:execute']});
    assert.deepEqual([result.recipeId,result.exitCode],['node-check',0]);
    assert.equal(result.stderr,'');
    const cloud=host.competitionToolExports.find(item=>item.toolName==='workspace.node_check');
    assert.equal(cloud.accepts(request),true);
    assert.deepEqual(cloud.project({...request,result:{...result,stderr:`${root} private source`,stdout:'secret'}}),
      {recipeId:'node-check',exitCode:0,passed:true});
    host.revoke();assert.equal(binding.available(request),false);
    assert.throws(()=>host.authorize({cloudExportAllowed:true,writeAllowed:false,
      commandAllowed:true,projectCodeAllowed:true}),/权限/);
    await assert.rejects(host.selectNode(),/Node/);
    await assert.rejects(host.selectCheckFile(),/工作区/);
    assert.equal(host.snapshot().checkFileName,'syntax.js');
  } finally {host.close();}
});
