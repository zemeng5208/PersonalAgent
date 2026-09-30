// Manual one-scenario consumer. It never creates a model, Runtime, Policy grant or cloud client.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {toolArgumentsDigest} from '@personal-agent/tool-gateway';

const ref=(id,revision=1)=>({id,revision});
const base={sourceRef:'synthetic:p5-reviewed-goal',sensitivity:'public',state:'active',
  validFrom:'2026-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z',reason:'Synthetic acceptance baseline'};
export const reviewedGoalFixture=Object.freeze({
  goal:{...base,id:'synthetic-report-goal',kind:'goal',dependencies:[],summary:'Prepare a three-slide report for the project review.'},
  decision:{...base,id:'synthetic-report-decision',kind:'decision',dependencies:[ref('synthetic-report-goal')],
    summary:'The report has three slides: objective, findings, next steps.'},
  plan:{...base,id:'synthetic-report-plan',kind:'plan',dependencies:[ref('synthetic-report-decision')],
    summary:'Draft three slides and check that each planned section fits one slide.'},
  nextSummary:'Prepare a five-slide report for the project review. Cover objective, method, findings, risks and next steps, one slide per section.',
});

/** Pass chooser into the existing P8 composition; the result is delegated unchanged. */
export function createReviewedGoalChoiceAudit(layaHost) {
  const calls=[];
  const chooser={async choose(request) {
    const identity=layaHost.readClassifierIdentity();
    assert.ok(layaHost.snapshot().ready && identity,'Existing owned Laya must already be ready');
    assert.ok(request.candidates.length>=2,'A real choice requires multiple legal candidates');
    const result=await layaHost.choose(request);
    assert.equal(layaHost.readClassifierIdentity(),identity,'Loaded model identity changed');
    calls.push({identity,requestDigest:toolArgumentsDigest({context:request.context,candidates:request.candidates}),
      candidates:request.candidates.map(({id,revision})=>({id,revision})),result:structuredClone(result)});
    return result;
  }};
  return {chooser,count:()=>calls.length,verify(selection) {
    const matching=calls.filter(call=>isDeepStrictEqual(call.result,selection));
    assert.equal(matching.length,1,'Review must contain exactly one unchanged real host choice');
    return structuredClone(matching[0]);
  }};
}

/** Use isolated, already-mounted production ports; caller retains session/model cleanup ownership. */
export async function runReviewedGoalAcceptance({application,goalHost,proactiveHost,namespace,choiceAudit,
  reopen,signal,deadline,onProgress=()=>{}}) {
  assert.ok(signal instanceof AbortSignal && Number.isFinite(Date.parse(deadline)));
  assert.equal(typeof reopen,'function','Same-database production re-open callback is required');
  const active=()=>{signal.throwIfAborted();assert.ok(Date.now()<Date.parse(deadline),'Acceptance deadline expired');};
  const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
  const settle=async(runtime,taskId)=>{
    for(;;){active();const task=runtime.getTask(taskId);
      if(['succeeded','failed','cancelled','waiting_approval','waiting_reconciliation'].includes(task.state))return task;
      await pause();}
  };
  active();
  const store=application.runtime.bindCoordinationStore(namespace);
  assert.equal(store.read().revision,0,'Use a fresh isolated graph, never user data');
  assert.equal(choiceAudit.count(),0,'Audit must belong to this scenario only');
  // These three explicit baseline nodes are fixture setup, not execution Evidence or fake Facts.
  for(const node of [reviewedGoalFixture.goal,reviewedGoalFixture.decision,reviewedGoalFixture.plan]) {
    store.append(store.read().revision,structuredClone(node));
  }
  const {kind,sourceRef,...goal}=structuredClone(reviewedGoalFixture.goal);
  const changed=goalHost.revise({expectedGraphRevision:3,expectedGoalRevision:1,
    goal:{...goal,summary:reviewedGoalFixture.nextSummary,reason:'Synthetic user changes the report to five slides'}});
  const goalTask=await settle(application.runtime,changed.taskId);
  const report={profile:'huawei_ict_agentarts',dataClass:'synthetic_pure_goal',goalTaskId:goalTask.taskId,
    goalState:goalTask.state,cloudSourceVerified:false,semanticReviewRequired:true};
  onProgress(structuredClone(report));
  if(goalTask.state!=='succeeded')return {...report,outcome:goalTask.state};
  assert.equal(store.read().revision,4);
  const goalReceipt=goalHost.readTask(goalTask.taskId);
  assert.equal(goalReceipt.result?.kind,'applied');assert.ok(goalReceipt.evidenceRefs.length);
  await proactiveHost.configure({enabled:false,cloudAnalysis:false,goalAnalysis:true,goalCloudAnalysis:false});
  await proactiveHost.tick();
  const reviewTaskId=application.runtime.loadCheckpoint(goalTask.taskId,'desktop-goal-cognition-review');
  assert.equal(typeof reviewTaskId,'string','Goal revision must have a real persisted review');
  const review=application.runtime.loadCheckpoint(reviewTaskId,'proactive-cognition-review-v1');
  const choice=choiceAudit.verify(review.selection);
  assert.deepEqual(choice.candidates,[ref('recheck'),ref('defer'),ref('revise')]);
  assert.equal(choiceAudit.count(),1);
  Object.assign(report,{reviewTaskId,selection:structuredClone(review.selection),
    modelIdentity:choice.identity,choiceRequestDigest:choice.requestDigest,graphBeforeRepair:4});
  onProgress(structuredClone(report));
  if(review.selection.state!=='selected' || !review.selection.eligibleForRuntime || review.selectedOption?.action!=='REVISE') {
    assert.equal(store.read().revision,4);
    return {...report,outcome:'needs_review',repairExecuted:false};
  }
  // Only current production consent/Policy may enable this; the runner never grants or approves tools.
  await proactiveHost.configure({enabled:false,cloudAnalysis:false,goalAnalysis:true,goalCloudAnalysis:true});
  let sourceTaskId;
  for(;;){active();await proactiveHost.tick();
    sourceTaskId=application.runtime.loadCheckpoint(reviewTaskId,'desktop-goal-cognition-handoff-task-v1')?.taskId;
    if(sourceTaskId)break;await pause();}
  Object.assign(report,{sourceTaskId});
  onProgress(structuredClone(report));
  const source=await settle(application.runtime,sourceTaskId);
  if(source.state!=='succeeded')return {...report,outcome:source.state,repairExecuted:false};
  const candidate=application.runtime.loadCheckpoint(sourceTaskId,'competition-repair-candidate');
  if(!candidate)return {...report,outcome:'no_structured_candidate',repairExecuted:false};
  report.cloudCandidateDigest=toolArgumentsDigest(candidate);
  report.cloudCandidateVersion=candidate.candidateVersion;
  const accepted=await proactiveHost.applyCognitionDecision(reviewTaskId);
  if(!accepted.taskId || accepted.taskId===sourceTaskId)return {...report,outcome:'repair_unavailable',repairExecuted:false};
  report.repairTaskId=accepted.taskId;
  onProgress(structuredClone(report));
  const repair=await settle(application.runtime,accepted.taskId);
  if(repair.state!=='succeeded')return {...report,outcome:repair.state,repairExecuted:false};
  const receipt=await proactiveHost.applyCognitionDecision(reviewTaskId);
  assert.equal(receipt.status,'applied');assert.equal(receipt.executionVerified,true);assert.equal(receipt.graphUpdateVerified,true);
  const snapshot=store.read(),records=application.runtime.readToolExecutions(repair.taskId);
  assert.equal(snapshot.revision,6);assert.equal(records.length,1);
  assert.equal(records[0].toolName,'cognition.commit_repair');assert.equal(records[0].state,'confirmed');
  assert.equal(records[0].policyDecision,'allow');assert.equal(records[0].executionStarted,true);
  assert.ok(repair.evidenceRefs.includes(records[0].evidenceId));
  assert.deepEqual(receipt.updatedNodes.map(({id,revision})=>({id,revision})),
    [ref(reviewedGoalFixture.decision.id,2),ref(reviewedGoalFixture.plan.id,2)]);
  const changedNodes=receipt.updatedNodes.map(({id})=>snapshot.history.findLast(node=>node.id===id));
  const semanticTextChanged=changedNodes.some(node=>node.summary!==reviewedGoalFixture[node.kind].summary);
  // No cloud retry or second inference for recovery; reopen uses identical SQLite and namespace.
  const recovered=await reopen();
  assert.deepEqual(recovered.application.runtime.bindCoordinationStore(namespace).read(),snapshot);
  assert.equal(recovered.proactiveHost.snapshot().cognition.cloudAllowed,false);
  const restored=await recovered.proactiveHost.applyCognitionDecision(reviewTaskId);
  assert.equal(restored.taskId,repair.taskId);assert.equal(restored.executionVerified,true);assert.equal(restored.graphUpdateVerified,true);
  assert.equal(recovered.application.runtime.readToolExecutions(repair.taskId).length,1);
  assert.equal(choiceAudit.count(),1,'Recovery must not infer again');
  return {...report,outcome:semanticTextChanged?'execution_verified':'semantic_text_unchanged',
    repairExecuted:true,graphAfterRepair:snapshot.revision,receipt:structuredClone(receipt),
    updatedSummaries:changedNodes.map(({id,revision,summary})=>({id,revision,summary})),
    semanticTextChanged,recoveryVerified:true};
}
