import assert from 'node:assert/strict';
import test from 'node:test';
import {createDesktopGoalCloudHost} from '../electron/goal-cloud-host.js';

test('exact trusted proactive repair scope permits only matching read refs and denies generic writes', async () => {
  const checkpoints = new Map();
  const selected = {id:'selected',revision:2,summary:'Selected goal',reason:'Local review',
    sensitivity:'private',state:'active',validFrom:'2026-09-30T00:00:00.000Z',validUntil:'2026-10-02T00:00:00.000Z',
    dependencies:[{id:'fact-ref',revision:3}]};
  const other = {...selected,id:'other',dependencies:[]};
  let scope = {reviewTaskId:'review-1',graphNamespace:'ns',bindingVersion:'review-v1',graphRevision:4,
    selectionDigest:'a'.repeat(64),candidateDigest:'b'.repeat(64),
    targets:[{id:'selected',revision:2}],dependencies:[{id:'fact-ref',revision:3}]};
  const writes = ['goals.create','goals.revise'].map(name=>({descriptor:{name,version:'1.0.0',
    inputSchema:{properties:{goal:{required:['id','sourceRef']}}}},execute:()=>{throw Error('write must not run');}}));
  const goalHost={tools:writes,list:()=>({graphRevision:4,goals:[selected,other]}),
    get:id=>({graphRevision:4,goal:id==='selected'?selected:other})};
  const host=createDesktopGoalCloudHost({goalHost,namespace:'ns',readProactiveBinding:()=>scope});
  host.bindApplication({profile:'huawei_ict_agentarts',runtime:{
    getTask:id=>({conversationId:id==='wrong-ns'?'desktop-proactive-goals:foreign':'desktop-proactive-goals:ns'}),
    loadCheckpoint:(id,key)=>checkpoints.get(`${id}:${key}`),
    saveCheckpointOnce(id,key,value){const address=`${id}:${key}`;if(checkpoints.has(address))return false;
      checkpoints.set(address,structuredClone(value));return true;},
  }});
  const signal=new AbortController().signal;
  const available=(name,taskId='handoff')=>host.competitionToolAvailability.find(value=>value.toolName===name)
    .available({taskId,signal});
  assert.equal(available('goals.list'),false,'P5 binding does not replace Goal cloud consent');
  host.authorize({goalCloudConsent:true});
  assert.equal(available('goals.list','wrong-ns'),false);
  assert.equal(available('goals.list'),true);
  assert.equal(available('goals.get'),true);
  assert.equal(available('goals.create'),false);
  assert.equal(available('goals.revise'),false);
  const context={taskId:'handoff',signal};
  const listed=await host.tools.find(value=>value.descriptor.name==='goals.list').execute({},context);
  assert.deepEqual(listed.goals.map(value=>value.id),['selected']);
  assert.deepEqual(listed.goals[0].dependencies,[{id:'fact-ref',revision:3}]);
  const one=await host.tools.find(value=>value.descriptor.name==='goals.get').execute({id:'other'},context);
  assert.equal(one.goal,null);
  assert.equal(host.competitionToolExports.find(value=>value.toolName==='goals.revise')
    .accepts({taskId:'handoff',arguments:{goal:selected}}),false);
  await assert.rejects(host.tools.find(value=>value.descriptor.name==='goals.revise')
    .execute({goal:selected},context),/unavailable/);
  scope={...scope,candidateDigest:'c'.repeat(64)};
  assert.equal(available('goals.get'),false,'old task cannot inherit another selected candidate');
  scope=undefined;
  assert.equal(available('goals.list','uncertain'),false,'uncertain/RECHECK without a repair scope remains unavailable');
});
