import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {createRuntimeApplication} from '@personal-agent/runtime/application';
import {createGoalTools} from '@personal-agent/goals/tool';
import {getGoal,listGoals} from '@personal-agent/goals/commands';
import {createDesktopGoalCloudHost} from '../electron/goal-cloud-host.js';

const cache=new URL('../../../.cache/goal-cloud-host-tests/',import.meta.url);
mkdirSync(cache,{recursive:true});
const signal=new AbortController().signal;
const goal=(summary,sensitivity='private')=>({id:'goal-one',summary,
  validFrom:'2026-09-27T00:00:00.000Z',validUntil:'2026-10-27T00:00:00.000Z',
  sensitivity,state:'active',reason:'User selected this goal',dependencies:[]});
async function until(predicate){for(let n=0;n<100;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('State did not arrive');}

test('public Goal tools retain CAS while read projection and consent guard cloud export',async t=>{
  const file=path.join(mkdtempSync(new URL('run-',cache)),'runtime.sqlite');
  let store;
  const goalHost={tools:createGoalTools(()=>store),list:()=>listGoals(store),get:id=>getGoal(store,id)};
  const cloud=createDesktopGoalCloudHost({goalHost});
  const app=createRuntimeApplication({path:file,profile:'huawei_ict_agentarts',hostUserNamespace:'test-user',
    tools:cloud.tools,competitionToolAvailability:cloud.competitionToolAvailability,
    competitionToolExports:cloud.competitionToolExports});
  t.after(()=>{cloud.close();app.close();});
  store=app.runtime.provisionCoordinationStore('test-user-goals');
  cloud.bindApplication(app);
  const task=app.runtime.submitTask({goal:'Manage my goal',conversationId:'desktop-panel',
    idempotencyKey:'goal-cloud-test'});
  const available=name=>cloud.competitionToolAvailability.find(item=>item.toolName===name)
    .available({taskId:task.taskId,revision:task.revision,deadline:'2026-09-28T00:00:00.000Z',signal});
  assert.equal(available('goals.create'),false);
  cloud.authorize({goalCloudConsent:true});
  assert.equal(available('goals.create'),true);
  const context={taskId:task.taskId,runId:'goal-run',signal,
    deadline:'2026-09-28T00:00:00.000Z',authorizationRef:'goal-run',scopes:['goals:write','goals:read']};
  const execute=(name,input)=>cloud.tools.find(item=>item.descriptor.name===name).execute(input,context);
  const create=await execute('goals.create',{expectedGraphRevision:0,goal:goal('First revision')});
  assert.deepEqual(create,{kind:'applied',graphRevision:1,previousGoal:null,
    currentGoal:{id:'goal-one',revision:1}});
  assert.match(store.read().history[0].sourceRef,/^desktop-goal-cloud:/);
  const listed=await execute('goals.list',{});
  assert.equal(listed.graphRevision,1);
  assert.deepEqual(listed.goals.map(item=>[item.id,item.revision,item.summary]),
    [['goal-one',1,'First revision']]);
  assert.equal(Object.hasOwn(listed.goals[0],'sourceRef'),false);
  assert.equal((await execute('goals.get',{id:'goal-one'})).goal.revision,1);
  const revise=await execute('goals.revise',{expectedGraphRevision:1,expectedGoalRevision:1,
    goal:goal('Second revision')});
  assert.deepEqual(revise,{kind:'applied',graphRevision:2,
    previousGoal:{id:'goal-one',revision:1},currentGoal:{id:'goal-one',revision:2}});
  const stale=await execute('goals.revise',{expectedGraphRevision:1,expectedGoalRevision:1,
    goal:goal('Stale revision')});
  assert.deepEqual(stale,{kind:'conflict',graphRevision:2});
  const exportRead=cloud.competitionToolExports.find(item=>item.toolName==='goals.list');
  assert.deepEqual(exportRead.project({taskId:task.taskId,result:await execute('goals.list',{}),signal}).goals
    .map(item=>item.summary),['Second revision']);
  app.runtime.saveCheckpoint(task.taskId,'competition-tool-catalog',
    {entries:[{name:'goals.list',version:'1.0.0'}]});
  cloud.assertCloudSend({taskId:task.taskId,signal});
  cloud.revoke();
  assert.equal(available('goals.create'),false);
  assert.equal(exportRead.accepts({taskId:task.taskId,arguments:{}}),false);
  assert.throws(()=>cloud.assertCloudSend({taskId:task.taskId,signal}),/revoked/);
  cloud.authorize({goalCloudConsent:true});
  assert.equal(available('goals.create'),false,'old task does not inherit a renewed grant');
  const restarted=createDesktopGoalCloudHost({goalHost});
  restarted.bindApplication(app);
  assert.equal(restarted.snapshot().sessionAllowed,false);
  restarted.authorize({goalCloudConsent:true});
  assert.equal(restarted.competitionToolAvailability[0].available({taskId:task.taskId,signal}),false,
    'old task does not inherit a restarted Desktop grant');
  restarted.close();
  const local=app.submitHostToolTask({commandId:'local-command',toolName:'goals.create',
    toolVersion:'1.0.0',deadline:new Date(Date.now()+600_000).toISOString(),
    arguments:{expectedGraphRevision:2,goal:{...goal('Local UI write'),id:'goal-two',
      sourceRef:'desktop-goal:local-command'}}});
  await until(()=>app.readHostToolTask(local.task.taskId).approval?.state==='pending');
  const approval=app.readHostToolTask(local.task.taskId).approval;
  app.runtime.respondApproval(approval.approvalId,'allow_once',approval.revision);
  await until(()=>app.activeTaskCount===0);
  app.resumeHostToolTask(local.task.taskId);
  await until(()=>app.runtime.getTask(local.task.taskId).state==='succeeded');
  assert.equal(app.runtime.getTask(local.task.taskId).state,'succeeded',
    JSON.stringify(app.runtime.getTask(local.task.taskId)));
  assert.equal(goalHost.get('goal-two').goal.summary,'Local UI write',
    'local Goal host tool does not depend on cloud consent');
});

test('restricted goals, unsafe content and unrelated conversations stay off the cloud',async t=>{
  const file=path.join(mkdtempSync(new URL('run-',cache)),'runtime.sqlite');
  let store;
  const goalHost={tools:createGoalTools(()=>store),list:()=>listGoals(store),get:id=>getGoal(store,id)};
  const cloud=createDesktopGoalCloudHost({goalHost});
  const app=createRuntimeApplication({path:file,profile:'huawei_ict_agentarts',hostUserNamespace:'test-user',tools:cloud.tools});
  t.after(()=>{cloud.close();app.close();});
  store=app.runtime.provisionCoordinationStore('test-user-goals');cloud.bindApplication(app);
  cloud.authorize({goalCloudConsent:true});
  const unrelated=app.runtime.submitTask({goal:'Other',conversationId:'desktop-todo-reminders:test-user',
    idempotencyKey:'unrelated'});
  assert.equal(cloud.competitionToolAvailability[0].available({taskId:unrelated.taskId,signal}),false);
  const task=app.runtime.submitTask({goal:'Goal',conversationId:'desktop-panel',idempotencyKey:'restricted'});
  assert.equal(cloud.competitionToolAvailability[0].available({taskId:task.taskId,signal}),true);
  const exportWrite=cloud.competitionToolExports.find(item=>item.toolName==='goals.create');
  assert.equal(exportWrite.accepts({taskId:task.taskId,arguments:{goal:goal('Secret','restricted')}}),false);
  assert.equal(exportWrite.accepts({taskId:task.taskId,arguments:{goal:goal('C:\\Users\\Alice\\secret')}}),false);
  const context={taskId:task.taskId,runId:'goal-run',signal,scopes:['goals:write','goals:read']};
  await assert.rejects(()=>cloud.tools.find(item=>item.descriptor.name==='goals.create')
    .execute({expectedGraphRevision:0,goal:goal('Secret','restricted')},context),/cloud/);
  store.append(0,{...goal('Private local only','restricted'),kind:'goal',sourceRef:'desktop-local'});
  const read=await cloud.tools.find(item=>item.descriptor.name==='goals.list').execute({},context);
  assert.deepEqual(read.goals,[]);
  const exportRevise=cloud.competitionToolExports.find(item=>item.toolName==='goals.revise');
  assert.equal(exportRevise.accepts({taskId:task.taskId,arguments:{goal:goal('Make public','public')}}),false);
});
