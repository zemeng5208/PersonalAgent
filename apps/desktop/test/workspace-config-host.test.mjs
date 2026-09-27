import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createWorkspaceConfigHost} from '../electron/workspace-config-host.js';

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
    assert.equal(policy.project({...request,result:larger}).content,largerSource);
    assert.equal(policy.accepts(request),true);
    host.revoke();assert.equal(policy.accepts(request),false);
    await assert.rejects(read.execute({path:'hello.js'},context),/撤销|绑定/);
    host.authorize({cloudExportAllowed:true,writeAllowed:false,commandAllowed:false});
    assert.equal(binding.available(request),false);
    assert.equal(binding.available({...request,taskId:'task-two'}),true);
  } finally {host.close();}
});
