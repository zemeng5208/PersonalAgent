import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createReadonlyMcpHost,MCP_READ_SCOPE,MCP_READ_TOOL_NAME,MCP_READ_TOOL_VERSION} from '../dist/index.js';
import {ToolGateway,toolArgumentsDigest} from '@personal-agent/tool-gateway';
import {InMemoryAuthorizationPolicy} from '@personal-agent/policy';

const future=()=>new Date(Date.now()+20000).toISOString();
const signal=()=>new AbortController().signal;
const invocation=(runId,args={path:'reference.md'})=>({toolName:MCP_READ_TOOL_NAME,toolVersion:MCP_READ_TOOL_VERSION,arguments:args,taskId:'synthetic-mcp-task',runId,authorizationRef:runId,deadline:future(),signal:signal()});

test('official filesystem stdio discover and real read pass Gateway and Policy; write/schema/cancel/disabled fail closed',async()=>{
  const parent=fileURLToPath(new URL('../../../.cache/mcp-real/',import.meta.url));
  await mkdir(parent,{recursive:true});const root=await mkdtemp(parent+'case-');
  const text='Public synthetic competition reference.\nRuntime owns approvals and evidence.\n';
  await writeFile(root+'/reference.md',text);
  await writeFile(root+'/invalid.txt',Buffer.from([0xff,0xfe,0x41]));
  const host=createReadonlyMcpHost({nodeExecutable:process.execPath,rootPath:root,enabled:true});
  const policy=new InMemoryAuthorizationPolicy(); const gateway=new ToolGateway({policy});
  const release=host.register(gateway);
  const grant=run=>policy.grant({authorizationRef:run.runId,taskId:run.taskId,toolName:run.toolName,scopes:[MCP_READ_SCOPE],argumentsDigest:toolArgumentsDigest(run.arguments),maxUses:1,expiresAt:run.deadline});
  try {
    await host.start({signal:signal(),deadline:future()});
    assert.equal(host.health().connected,true);assert.ok(host.health().discoveredTools>1);
    assert.match(host.health().protocolVersion,/^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(gateway.list().map(tool=>tool.name),[MCP_READ_TOOL_NAME]);
    const denied=invocation('denied');await assert.rejects(gateway.invoke(denied),{code:'UNAUTHORIZED'});
    const read=invocation('approved');grant(read);const result=await gateway.invoke(read);
    assert.equal(result.text,text);assert.equal(result.path,'reference.md');assert.equal(result.source,'mcp');
    assert.equal(result.contentDigest,createHash('sha256').update(text).digest('hex'));
    assert.equal(policy.get('approved').usesRemaining,0);
    await assert.rejects(gateway.invoke({...read,toolName:'write_file'}),{code:'UNSUPPORTED_CAPABILITY'});
    const malformed=invocation('schema',{path:'reference.md',shell:'echo leaked'});grant(malformed);
    await assert.rejects(gateway.invoke(malformed),{code:'INVALID_ARGUMENT'});assert.equal(policy.get('schema').usesRemaining,1);
    const escaped=invocation('escape',{path:'../reference.md'});grant(escaped);
    await assert.rejects(gateway.invoke(escaped),{code:'INVALID_ARGUMENT'});
    const invalidText=invocation('invalid-text',{path:'invalid.txt'});grant(invalidText);
    await assert.rejects(gateway.invoke(invalidText),{code:'EXTERNAL_FAILURE'});
    const controller=new AbortController();controller.abort();const cancelled=invocation('cancel');grant(cancelled);
    await assert.rejects(gateway.invoke({...cancelled,signal:controller.signal}),{code:'CANCELLED'});
    assert.equal(policy.get('cancel').usesRemaining,1);
    await host.setEnabled(false);assert.equal(host.health().state,'disabled');assert.equal(host.health().connected,false);
    const stopped=invocation('stopped');grant(stopped);await assert.rejects(gateway.invoke(stopped),{code:'UNSUPPORTED_CAPABILITY'});
  } finally {release();await host.dispose();}
  assert.deepEqual(gateway.list(),[]);assert.equal(host.health().state,'disposed');
});

test('missing configuration is unavailable and never launches a substitute service',async()=>{
  const host=createReadonlyMcpHost();assert.equal(host.health().state,'unavailable');
  await assert.rejects(host.start({signal:signal(),deadline:future()}),{code:'UNSUPPORTED_CAPABILITY'});
  await host.dispose();
});
