import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@personal-agent/client';
import {LayaActionChoiceService} from '@personal-agent/cognition';
import {createAgentArtsRuntimeApplication,createProactiveCognitionHost} from '@personal-agent/runtime/application';
import {createDesktopGoalCognitionHost} from '../electron/goal-cognition-host.js';

const namespace='synthetic-desktop-cognition';
const ref=(id,revision=1)=>({id,revision});
const node=(id,kind,dependencies,summary=id,sensitivity='public')=>({id,kind,dependencies,summary,sensitivity,
  sourceRef:'synthetic/source',state:'active',reason:'fixture',
  validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'});
async function terminal(application,id) {
  for(let i=0;i<100;i++) {
    const task=application.runtime.getTask(id);
    if(['succeeded','failed','cancelled'].includes(task.state)) return task;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('Synthetic task did not settle');
}
async function fixture(t,{revokeDuringCredentialRead=false,changeGraphDuringCredentialRead=false,uncertain=false,unavailableInitially=false,newGoal=false}={}) {
  const root=fileURLToPath(new URL('../../../.cache/desktop-goal-cognition/',import.meta.url));
  await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'case-'));
  let host,layaCalls=0,time=Date.now(),unavailable=unavailableInitially;const sent=[],announced=[];
  const application=createAgentArtsRuntimeApplication({path:path.join(directory,'runtime.sqlite'),
    gatewayUrl:'https://agentarts.example.test',runtimeName:'synthetic',
    beforeCompetitionSend:request=>host.assertCloudSend(request),
    authorizationProvider:{read:async()=>{
      if(revokeDuringCredentialRead) host.configure({enabled:true,cloudAllowed:false});
      if(changeGraphDuringCredentialRead) store.append(store.read().revision,node('goal','goal',[ref('private-source')],'更新的目标','private'));
      return 'Bearer synthetic-not-a-key';
    }},
    fetchImpl:async(_url,input)=>{
      sent.push(JSON.parse(input.body));
      return new Response(JSON.stringify({event:'message',data:{text:'合成规划已接收',index:0}}),
        {headers:{'content-type':'application/json'}});
    }});
  const store=application.runtime.provisionCoordinationStore(namespace);
  store.append(0,node('private-source','fact',[],'PRIVATE_SOURCE_SENTINEL','private'));
  store.append(1,node('goal','goal',[ref('private-source')],'原目标','private'));
  if(!newGoal) {
    store.append(2,node('decision','decision',[ref('goal')],'关联决策'));
    store.append(3,node('plan','plan',[ref('decision')],'关联计划'));
    store.append(4,node('goal','goal',[ref('private-source')],'修改后的目标','private'));
  }
  const sourceTask=application.runtime.submitTask({goal:'Synthetic completed goal edit',conversationId:'host-fixture',idempotencyKey:'synthetic-goal-edit'});
  await application.runtime.runTask(sourceTask.taskId,async()=>({resultSummary:'Synthetic goal receipt'}),
    {deadline:new Date(Date.now()+60_000).toISOString(),sideEffect:'read'});
  const goalHost={listTasks:()=>[{taskId:sourceTask.taskId,state:'succeeded',result:{kind:'applied',
    graphRevision:newGoal?2:5,...(newGoal?{}:{previousGoal:ref('goal')}),currentGoal:ref('goal',newGoal?1:2)}}]};
  const facts=application.createCompetitionFactHost({memoryPath:path.join(directory,'memory.sqlite'),
    memoryNamespace:'synthetic-public-memory',graphNamespace:namespace,consumerKey:'fixture'});
  const client=new Client(application,Date.now);await client.connect();
  const chooser=new LayaActionChoiceService({infer:async payload=>{
    layaCalls++;
    if(unavailable) throw Error('Synthetic temporary Laya outage');
    const keys=Object.keys(payload.questions.action.criteria),selected=newGoal?keys[0]:keys.at(-1);
    const probability=uncertain?1/keys.length:0.98;
    return {answers:{action:{choice:selected,probabilities:Object.fromEntries(keys.map(key=>[key,key===selected?probability:(1-probability)/(keys.length-1)])),
      answer_confidence:probability,confidence:0.5}}};
  }});
  const options={application,client,facts,namespace,goalHost,chooser,ready:()=>true,
    createHost:input=>createProactiveCognitionHost({...input,now:()=>time}),onTask:item=>announced.push(item),now:()=>time};
  host=createDesktopGoalCognitionHost(options);
  t.after(async()=>{host.close();facts.close();application.close();await rm(directory,{recursive:true,force:true});});
  return {application,sent,announced,store,sourceTaskId:sourceTask.taskId,host:()=>host,layaCalls:()=>layaCalls,
    restoreLaya:()=>{unavailable=false;},advance:(ms=1100)=>{time+=ms;},restart:()=>{host.close();host=createDesktopGoalCognitionHost(options);return host;}};
}

test('goal change chooses locally; explicit cloud grant sends one minimized task and restart cannot reuse its grant',async t=>{
  const f=await fixture(t);
  f.host().configure({enabled:true,cloudAllowed:false});await f.host().tick();
  assert.equal(f.layaCalls(),1);assert.equal(f.sent.length,0);
  f.host().configure({enabled:true,cloudAllowed:true});await f.host().tick();
  const taskId=f.announced[0]?.taskId;assert.ok(taskId);
  assert.equal((await terminal(f.application,taskId)).state,'succeeded');
  assert.equal(f.sent.length,1);assert.match(f.sent[0].query,/修改后的目标/);
  assert.doesNotMatch(f.sent[0].query,/PRIVATE_SOURCE_SENTINEL|synthetic\/source|private-source/);
  f.advance();await f.host().tick();assert.equal(f.layaCalls(),1);assert.equal(f.sent.length,1);
  assert.equal(f.store.read().revision,5,'selection does not directly mutate plans');
  const restarted=f.restart();
  assert.throws(()=>restarted.assertCloudSend({taskId,goal:f.sent[0].query,signal:new AbortController().signal}),/当前会话/);
});

test('revocation while credentials are pending prevents the actual cloud request',async t=>{
  const f=await fixture(t,{revokeDuringCredentialRead:true});
  f.host().configure({enabled:true,cloudAllowed:true});await f.host().tick();
  const taskId=f.announced[0]?.taskId;assert.ok(taskId);
  assert.equal((await terminal(f.application,taskId)).state,'failed');
  assert.equal(f.sent.length,0);assert.equal(f.layaCalls(),1);
});

test('a newer graph revision before HTTP invalidates the old selected projection',async t=>{
  const f=await fixture(t,{changeGraphDuringCredentialRead:true});
  f.host().configure({enabled:true,cloudAllowed:true});await f.host().tick();
  const taskId=f.announced[0]?.taskId;assert.ok(taskId);
  assert.equal((await terminal(f.application,taskId)).state,'failed');
  assert.equal(f.sent.length,0);assert.equal(f.store.read().revision,6);
});

test('uncertain Laya selection hands off one explicit machine review without claiming a chosen action',async t=>{
  const f=await fixture(t,{uncertain:true});
  f.host().configure({enabled:true,cloudAllowed:false});await f.host().tick();
  assert.equal(f.sent.length,0);assert.match(f.host().snapshot().reason,/尚不确定/);
  f.host().configure({enabled:true,cloudAllowed:true});await f.host().tick();
  const taskId=f.announced[0]?.taskId;assert.ok(taskId);
  assert.equal((await terminal(f.application,taskId)).state,'succeeded');
  assert.equal(f.sent.length,1);
  assert.match(f.sent[0].query,/Laya 尚未确定选择/);
  assert.doesNotMatch(f.sent[0].query,/Laya 已选择|PRIVATE_SOURCE_SENTINEL/);
  const payload=JSON.parse(f.sent[0].query.slice(f.sent[0].query.indexOf('\n')+1));
  assert.equal(payload.action,'RECHECK');assert.equal(payload.selectedOption,null);
  assert.equal(payload.eligibleForRuntime,false);assert.equal(payload.executed,false);
  f.advance();await f.host().tick();assert.equal(f.sent.length,1);assert.equal(f.layaCalls(),1);
  assert.equal(f.store.read().revision,5);
});

test('legacy Goal marker resumes after a transient Laya outage without reopening the old terminal task',async t=>{
  const f=await fixture(t,{unavailableInitially:true});
  f.host().configure({enabled:true,cloudAllowed:true});await f.host().tick();
  assert.equal(f.host().snapshot().status,'error');assert.equal(f.layaCalls(),1);
  const old=f.application.runtime.listTasks({}).items.find(task=>
    f.application.runtime.loadCheckpoint(task.taskId,'proactive-cognition-review-v1')?.selection?.reason==='unavailable');
  assert.ok(old);assert.equal(old.state,'succeeded');
  // Emulate the marker saved by older Desktop versions before unavailable propagation was fixed.
  f.application.runtime.saveCheckpoint(f.sourceTaskId,'desktop-goal-cognition-review',old.taskId);
  f.restoreLaya();f.restart().configure({enabled:true,cloudAllowed:true});await f.host().tick();
  assert.equal(f.layaCalls(),1,'persisted cooldown survives Desktop restart');
  f.advance(31_000);await f.host().tick();
  const taskId=f.announced[0]?.taskId;assert.ok(taskId);
  assert.equal((await terminal(f.application,taskId)).state,'succeeded');
  assert.equal(f.sent.length,1);assert.equal(f.layaCalls(),2);
  assert.notEqual(f.application.runtime.loadCheckpoint(f.sourceTaskId,'desktop-goal-cognition-review'),old.taskId);
  assert.equal(f.application.runtime.getTask(old.taskId).state,'succeeded');
  f.advance();await f.host().tick();assert.equal(f.sent.length,1);
});

test('a newly registered Goal supplies its real subject to the first planning handoff',async t=>{
  const f=await fixture(t,{newGoal:true});
  f.host().configure({enabled:true,cloudAllowed:true});await f.host().tick();
  const taskId=f.announced[0]?.taskId;assert.ok(taskId);
  assert.equal((await terminal(f.application,taskId)).state,'succeeded');
  assert.equal(f.sent.length,1);assert.match(f.sent[0].query,/目标已登记/);
  const payload=JSON.parse(f.sent[0].query.slice(f.sent[0].query.indexOf('\n')+1));
  assert.equal(payload.action,'RECHECK');assert.equal(payload.executed,false);
  assert.ok(payload.nodes.some(node=>node.kind==='goal'&&node.summary==='原目标'));
  assert.doesNotMatch(f.sent[0].query,/PRIVATE_SOURCE_SENTINEL|private-source/);
  f.advance();await f.host().tick();assert.equal(f.sent.length,1);assert.equal(f.store.read().revision,2);
});

test('goal cognition snapshot exposes trigger, Laya choice, and executionStatus for Desktop rendering', async t => {
  const f = await fixture(t);
  f.host().configure({enabled: true, cloudAllowed: false});
  await f.host().tick();
  const snapshot = f.host().snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.cloudAllowed, false);
  assert.equal(snapshot.reviews.length, 1);
  const review = snapshot.reviews[0];
  assert.ok(review.trigger, 'trigger must be present');
  assert.match(review.choice, /defer|revise|recheck|plan/);
  assert.equal(review.executionStatus, '本地决策建议');

  // When cloud is allowed and submitted
  f.host().configure({enabled: true, cloudAllowed: true});
  await f.host().tick();
  const taskId = f.announced[0]?.taskId;
  assert.ok(taskId);
  assert.equal((await terminal(f.application, taskId)).state, 'succeeded');
  const updated = f.host().snapshot().reviews[0];
  assert.equal(updated.executionStatus, '已提交 AgentArts 编排');
});

