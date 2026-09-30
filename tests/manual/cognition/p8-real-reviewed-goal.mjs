// One isolated Runtime composition with the original trusted credential adapter.
// Electron uses its existing encrypted profile; business/task data stays isolated.
import {app,safeStorage} from 'electron';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Client} from '@personal-agent/client';
import {LayaActionChoiceService,LocalLayaHttpTransport} from '@personal-agent/cognition';
import {createAgentArtsRuntimeApplication,createProactiveCognitionHost,createLocalInboxClassifier,LOCAL_REPAIR_TOOL} from '@personal-agent/runtime/application';
import {createGoalHost} from '../../../apps/desktop/electron/goal-host.js';
import {createDesktopGoalCloudHost} from '../../../apps/desktop/electron/goal-cloud-host.js';
import {createDesktopProactiveHost} from '../../../apps/desktop/electron/proactive-host.js';
import {createAgentArtsConfig} from '../../../apps/desktop/electron/agentarts-config.js';
import {createLocalLayaHost} from '../../../apps/desktop/electron/laya-local-host.js';
import {createReviewedGoalChoiceAudit,runReviewedGoalAcceptance} from './p5-reviewed-goal.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const sourceUserData=process.argv.find(arg=>arg.startsWith('--configuration-source='))?.slice('--configuration-source='.length);
if(!sourceUserData || !path.isAbsolute(sourceUserData)) throw Error('Existing trusted configuration source is required');
const directory=path.join(project,'.cache','p5-real-reviewed-goal',randomUUID());mkdirSync(directory,{recursive:true});
app.setPath('userData',sourceUserData);app.commandLine.appendSwitch('disable-gpu');
const namespace='synthetic-p5-reviewed-'+randomUUID();
const calls=[],diagnostics=[];let session,laya,audit,report;
const captures=[];
function publish(value) {console.info('P8_ACCEPTANCE',JSON.stringify(value));}
async function captureFetch(url,init) {
  const started=performance.now(),request=JSON.parse(init.body);
  const capture={endpoint:url,request,startedAt:new Date().toISOString(),ttftMs:null};calls.push(capture);
  const response=await fetch(url,init);
  Object.assign(capture,{status:response.status,headers:Object.fromEntries(['content-type','x-request-id','x-trace-id','x-runtime-version','x-agent-version'].map(key=>[key,response.headers.get(key)]))});
  let total=0;const decoder=new TextDecoder();
  return {status:response.status,headers:response.headers,body:{async *[Symbol.asyncIterator]() {
    try {for await(const chunk of response.body) {
      if(capture.firstByteMs===undefined)capture.firstByteMs=performance.now()-started;
      total+=chunk.byteLength;if(total<=1048576)capture.rawOutput=(capture.rawOutput??'')+decoder.decode(chunk,{stream:true});
      yield chunk;
    }} finally {capture.totalMs=performance.now()-started;capture.bytes=total;capture.complete=total<=1048576;}
  }}};
}
async function closeSession() {
  if(!session)return;
  const old=session;session=undefined;old.goalCloud.revoke();old.proactiveHost.stop();
  for(const task of old.application.runtime.listTasks({limit:100}).items)if(!['succeeded','failed','cancelled'].includes(task.state))old.application.runtime.requestCancel(task.taskId,'Acceptance session stopped');
  while(old.application.activeTaskCount)await new Promise(resolve=>setTimeout(resolve,20));
  old.proactiveHost.close();old.goalCloud.close();old.client.dispose?.();old.application.close();
}
async function openSession(config,binding) {
  const goalHost=createGoalHost(namespace);let proactiveHost,lock=Promise.resolve();
  const goalCloud=createDesktopGoalCloudHost({goalHost,namespace,readProactiveBinding:taskId=>proactiveHost?.readRepairBinding(taskId)});
  const application=createAgentArtsRuntimeApplication({path:path.join(directory,'runtime.sqlite'),hostUserNamespace:namespace,
    ...binding,invokeMode:'published',responseMode:'tool-proposal-json',initialRequestMode:'goal-with-tools-json',repairCandidateVersion:'1.0',
    ...(process.env.PA_AGENTARTS_WORKFLOW_GOAL_INPUT===undefined?{}:{workflowGoalInput:process.env.PA_AGENTARTS_WORKFLOW_GOAL_INPUT}),
    tools:goalCloud.tools,competitionToolAvailability:goalCloud.competitionToolAvailability,competitionToolExports:goalCloud.competitionToolExports,
    automaticTools:[...goalCloud.tools.map(tool=>({toolName:tool.descriptor.name,toolVersion:tool.descriptor.version})),{toolName:LOCAL_REPAIR_TOOL,toolVersion:'1.0.0'}],
    localRepair:{graphNamespace:namespace,bindingVersion:'desktop-reviewed-execution-v1',
      withSourceLock:work=>{const next=lock.then(work);lock=next.catch(()=>{});return next;},
      reviewedSource:{resolve({sourceTaskId,reviewTaskId}){const value=proactiveHost?.readPreparedRepair(sourceTaskId);return value?.kind==='prepared' && value.binding.reviewTaskId===reviewTaskId?value:undefined;}}},
    authorizationProvider:{read:async()=>config.readAuthorization(binding)},fetchImpl:captureFetch,
    beforeCompetitionSend:request=>goalCloud.assertCloudSend(request),onDiagnostic:value=>diagnostics.push(value)});
  goalHost.bind(application);goalCloud.bindApplication(application);
  const client=new Client(application,Date.now);await client.connect();
  proactiveHost=createDesktopProactiveHost({application,client,userData:directory,namespace,goalHost,
    chooser:audit.chooser,cognitionReady:()=>laya.snapshot().ready,createCognitionHost:createProactiveCognitionHost});
  session={application,goalHost,proactiveHost,goalCloud,client};return session;
}
app.whenReady().then(async()=>{
try {
  const config=createAgentArtsConfig({userData:sourceUserData,safeStorage});
  publish({stage:'trusted_configuration',configured:config.snapshot().configured});
  const binding=config.binding();
  laya=createLocalLayaHost({projectRoot:project,createService:createLocalInboxClassifier,
    createChooser:({port,getApiKey})=>new LayaActionChoiceService(new LocalLayaHttpTransport(port,getApiKey))});
  publish({stage:'starting_existing_laya',configuredCloud:config.snapshot().configured});
  const state=await laya.start();publish({stage:'laya_ready',state:state.state,ready:state.ready});
  if(!state.ready)throw Object.assign(Error('Existing local model is unavailable'),{code:'UNSUPPORTED_CAPABILITY'});
  audit=createReviewedGoalChoiceAudit(laya);const initial=await openSession(config,binding);
  initial.goalCloud.authorize({goalCloudConsent:true});
  const started=performance.now();
  report=await runReviewedGoalAcceptance({...initial,namespace,choiceAudit:audit,
    signal:new AbortController().signal,deadline:new Date(Date.now()+180000).toISOString(),onProgress:publish,
    reopen:async()=>{await closeSession();return openSession(config,binding);}});
  Object.assign(report,{totalMs:performance.now()-started,cloudCalls:calls.length,nodeVersion:process.versions.node,
    consoleDeploymentReadback:{runtimeVersion:'v16',controllerEntity:'2f5d361c-bd85-4d2f-9903-bb35d4f55afa',controllerSource:'1790763483827',routerSource:'1790763138570',planSource:'1790761689353',reviewSource:'1790762412803'},
    requestLevelDeploymentVerified:false});
  publish(report);
} catch(error) {
  report={...report,outcome:'failed',code:typeof error?.code==='string'?error.code:'ACCEPTANCE_ASSERTION',cloudCalls:calls.length};publish(report);
} finally {
  if(session)for(const task of session.application.runtime.listTasks({limit:100}).items)captures.push({task:session.application.runtime.getTask(task.taskId),executions:session.application.runtime.readToolExecutions(task.taskId)});
  await closeSession();const stopped=await laya?.stop();
  const output=path.join(directory,'result.json');writeFileSync(output,JSON.stringify({report,calls,diagnostics,captures,layaStopped:stopped?.state},null,2));
  publish({stage:'saved',output,cloudCalls:calls.length,layaStopped:stopped?.state});
  app.exit(report?.outcome==='failed'?1:0);
}
}).catch(()=>{publish({outcome:'failed',code:'ACCEPTANCE_CLEANUP_FAILED'});app.exit(1);});
