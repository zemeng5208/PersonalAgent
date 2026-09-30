import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createWorkspaceConfigHost} from '../electron/workspace-config-host.js';

async function workspaceBindingFixture(t) {
  const cache=path.resolve(fileURLToPath(new URL('../../../.cache/',import.meta.url)));
  await mkdir(cache,{recursive:true});
  const base=await mkdtemp(path.join(cache,'p6-workspace-binding-'));
  const root=path.join(base,'workspace'),otherRoot=path.join(base,'other-workspace');
  const userData=path.join(base,'user-data'),nodeDir=path.join(base,'node-a'),otherNodeDir=path.join(base,'node-b');
  await Promise.all([root,otherRoot,userData,nodeDir,otherNodeDir].map(dir=>mkdir(dir)));
  const nodeName=process.platform==='win32'?'node.exe':'node';
  const node=path.join(nodeDir,nodeName),otherNode=path.join(otherNodeDir,nodeName);
  // Metadata fixtures only: neither selected executable is ever launched.
  await writeFile(node,'synthetic node A');await writeFile(otherNode,'synthetic node B');
  const configuration=path.join(userData,'coding-workspace.json');
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
  await writeFile(configuration,JSON.stringify({version:1,encrypted:Buffer.from(root).toString('base64'),
    encryptedNode:Buffer.from(node).toString('base64')}));
  const hosts=[];
  const open=()=> {
    const host=createWorkspaceConfigHost({userData,safeStorage,
      selectDirectory:async()=>otherRoot,selectNodeExecutable:async()=>otherNode});
    hosts.push(host);return host;
  };
  t.after(async()=> {
    for(const host of hosts) host.close();
    assert.equal(path.dirname(base),cache); // Only this newly created cache fixture is removed.
    assert.ok(path.basename(base).startsWith('p6-workspace-binding-'));
    await rm(base,{recursive:true,force:true});
  });
  return {root,node,configuration,open};
}
const allowWorkspaceRead=host=>host.authorize({cloudExportAllowed:true,writeAllowed:false,commandAllowed:false});

test('trusted workspace binding requires session consent and invalidates old generations', async t=> {
  const {root,node,configuration,open}=await workspaceBindingFixture(t);
  const host=open();
  assert.equal(host.readWorkspaceBinding(),undefined);
  const stored=await readFile(configuration,'utf8');
  allowWorkspaceRead(host);
  const binding=host.readWorkspaceBinding();
  assert.deepEqual(Object.keys(binding),['rootPath','nodeExecutable','bindingId']);
  assert.equal(binding.rootPath,root);assert.equal(binding.nodeExecutable,node);assert.ok(Object.isFrozen(binding));
  assert.equal(host.isWorkspaceBindingCurrent({...binding}),true);
  assert.equal(host.isWorkspaceBindingCurrent({...binding,bindingId:'old'}),false);
  assert.equal(host.isWorkspaceBindingCurrent({...binding,extra:true}),false);
  let getterReads=0;
  assert.equal(host.isWorkspaceBindingCurrent({nodeExecutable:node,bindingId:binding.bindingId,
    get rootPath(){getterReads++;return root;}}),false);
  assert.equal(getterReads,0);
  const visible=JSON.stringify(host.snapshot());
  for(const privateValue of [root,node,binding.bindingId]) assert.equal(visible.includes(privateValue),false);
  assert.equal(await readFile(configuration,'utf8'),stored);
  host.revoke();assert.equal(host.readWorkspaceBinding(),undefined);
  assert.equal(host.isWorkspaceBindingCurrent(binding),false);
  allowWorkspaceRead(host);
  const renewed=host.readWorkspaceBinding();
  assert.notEqual(renewed.bindingId,binding.bindingId);assert.equal(host.isWorkspaceBindingCurrent(binding),false);
  host.close();assert.equal(host.readWorkspaceBinding(),undefined);
  assert.equal(host.isWorkspaceBindingCurrent(renewed),false);
  assert.equal(open().readWorkspaceBinding(),undefined); // Encrypted settings never restore consent.
});

test('trusted workspace binding rejects changed selections until reassembly', async t=> {
  const {open}=await workspaceBindingFixture(t);
  let host=open();allowWorkspaceRead(host);
  const original=host.readWorkspaceBinding();
  await host.selectNode();
  assert.equal(host.readWorkspaceBinding(),undefined);assert.equal(host.isWorkspaceBindingCurrent(original),false);
  allowWorkspaceRead(host);assert.equal(host.readWorkspaceBinding(),undefined);
  host.close();host=open();allowWorkspaceRead(host);
  const rebound=host.readWorkspaceBinding();assert.ok(rebound);
  await host.select();
  assert.equal(host.readWorkspaceBinding(),undefined);assert.equal(host.isWorkspaceBindingCurrent(rebound),false);
  assert.throws(()=>allowWorkspaceRead(host),/重启/);
});

test('trusted workspace binding rejects root or Node replacement at the same path', async t=> {
  for(const changed of ['root','node']) {
    const {root,node,open}=await workspaceBindingFixture(t);
    const host=open();allowWorkspaceRead(host);
    const binding=host.readWorkspaceBinding();
    if(changed==='node') {await rename(node,node+'.previous');await writeFile(node,'synthetic node C');}
    else {await rename(root,root+'-previous');await mkdir(root);}
    assert.equal(host.readWorkspaceBinding(),undefined);assert.equal(host.isWorkspaceBindingCurrent(binding),false);
  }
});

// Prepared for the final unified suite. These do not grant PUBLIC export consent.
test('workspace export gate keeps source local and redacts non-content result projections', async t=> {
  const {root,open}=await workspaceBindingFixture(t);
  const host=open();
  const checkpoints=new Map();
  host.bindApplication({runtime:{loadCheckpoint:(id,key)=>checkpoints.get(id+key),
    saveCheckpoint:(id,key,value)=>checkpoints.set(id+key,value)}});
  await writeFile(path.join(root,'private.js'),'const privateValue="LOCAL_ONLY";\n');
  host.authorize({cloudExportAllowed:true,writeAllowed:true,commandAllowed:false});
  const request={taskId:'export-private',proposalId:'proposal-private',
    signal:new AbortController().signal,deadline:new Date(Date.now()+30000).toISOString()};
  const local=async(name,args,scopes)=> {
    assert.equal(host.competitionToolAvailability.find(item=>item.toolName===name).available(request),true);
    return host.tools.find(item=>item.descriptor.name===name).execute(args,{...request,scopes});
  };
  const read=await local('workspace.read_text',{path:'private.js'},['workspace:read']);
  assert.match(read.content,/LOCAL_ONLY/); // The real local result is preserved.
  const readExport=host.competitionToolExports.find(item=>item.toolName==='workspace.read_text');
  assert.throws(()=>readExport.project({...request,result:read}),{code:'UNSUPPORTED_CAPABILITY'});
  const list=await local('workspace.list_entries',{path:'.'},['workspace:list']);
  const listExport=host.competitionToolExports.find(item=>item.toolName==='workspace.list_entries');
  assert.deepEqual(listExport.project({...request,result:list}),{listed:true,truncated:false});
  const preview=await local('workspace.preview_text_patch',{path:'private.js',expectedSha256:read.sha256,
    edits:[{oldText:'LOCAL_ONLY',newText:'STILL_LOCAL'}]},['workspace:read']);
  const previewExport=host.competitionToolExports.find(item=>item.toolName==='workspace.preview_text_patch');
  const safe=previewExport.project({...request,result:preview});
  assert.deepEqual(safe,{previewed:true,changed:true});
  for(const privateValue of ['private.js','LOCAL_ONLY','STILL_LOCAL',read.sha256]) {
    assert.equal(JSON.stringify(safe).includes(privateValue),false);
  }
  assert.throws(()=>previewExport.project({...request,result:{...preview,unexpected:'private'}}),{code:'INVALID_ARGUMENT'});
  const cancelled=new AbortController();cancelled.abort();
  assert.throws(()=>previewExport.project({...request,signal:cancelled.signal,result:preview}),{code:'CANCELLED'});
  host.revoke();assert.throws(()=>previewExport.project({...request,result:preview}),{code:'UNAUTHORIZED'});
});

test('selected workspace binds tasks, keeps consent session-only and rejects reuse after revocation', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'pa-coding-selected-'));
  const userData=await mkdtemp(path.join(os.tmpdir(),'pa-coding-config-'));
  await writeFile(path.join(root,'hello.js'),'console.log("hello");\n');
  const largerSource='// Synthetic source above the old demo limit\n'.repeat(256);
  await writeFile(path.join(root,'larger.js'),largerSource);
  // Explicit in-memory crypto stand-in; no actual account configuration is accessed.
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
  let host=createWorkspaceConfigHost({userData,safeStorage,selectDirectory:async()=>root});
  assert.equal(host.snapshot().configured,false);
  await host.select();assert.equal(host.snapshot().configured,true);
  assert.match(host.snapshot().reason,/重启/);host.close();
  host=createWorkspaceConfigHost({userData,safeStorage,selectDirectory:async()=>undefined});
  const checkpoints=new Map();
  host.bindApplication({runtime:{loadCheckpoint:(id,key)=>checkpoints.get(id+key),
    saveCheckpoint:(id,key,value)=>checkpoints.set(id+key,value)}});
  const request={taskId:'task-one',signal:new AbortController().signal,deadline:new Date(Date.now()+30000).toISOString()};
  const binding=host.competitionToolAvailability.find(item=>item.toolName==='workspace.read_text');
  const read=host.tools.find(item=>item.descriptor.name==='workspace.read_text');
  const context={...request,scopes:['workspace:read']};
  try {
    assert.equal(binding.available(request),false);
    host.authorize({cloudExportAllowed:true,writeAllowed:false,commandAllowed:false});
    assert.equal(binding.available(request),true);
    const result=await read.execute({path:'hello.js'},context);
    assert.equal(result.content,'console.log("hello");\n');
    const policy=host.competitionToolExports.find(item=>item.toolName==='workspace.read_text');
    const larger=await read.execute({path:'larger.js'},context);
    assert.equal(larger.content,largerSource);
    assert.throws(()=>policy.project({...request,result:larger}),{code:'UNSUPPORTED_CAPABILITY'});
    assert.equal(policy.accepts(request),true);
    host.revoke();assert.equal(policy.accepts(request),false);
    await assert.rejects(read.execute({path:'hello.js'},context),/撤销|绑定/);
    host.authorize({cloudExportAllowed:true,writeAllowed:false,commandAllowed:false});
    assert.equal(binding.available(request),false);
    assert.equal(binding.available({...request,taskId:'task-two'}),true);
  } finally {host.close();}
});
