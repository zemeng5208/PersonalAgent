import test from 'node:test';
import assert from 'node:assert/strict';
// No dist writes: this pure module uses erasable TypeScript supported by the repository's Node 24 runtime.
import {decideInterest, decideKnowledgeFreshness} from '../src/interest-policy.ts';

test('interest decisions bind context, respect revocation and keep stale knowledge explicit', () => {
  const at = '2026-09-27T12:00:00Z';
  const evidence = (id, kind = 'question', extra = {}) => ({id,topicId:'typescript',sourceId:'conversation',sourceRevision:'r1',
    occurredAt:'2026-09-27T11:00:00Z',interactionId:id,kind,match:'semantic',...extra});
  const input = {topicId:'typescript',at,evidenceMaxAgeMs:86400000,watchDurationMs:3600000,
    evidence:[evidence('q1')],source:{id:'official-docs',revision:'source-v1',visibility:'public',risk:'low',transportVerified:true,verificationExpiresAt:'2026-09-28T00:00:00Z'},
    scope:{state:'granted',id:'public-tracking',revision:1,publicLowRiskTracking:true,expiresAt:'2026-09-28T00:00:00Z'}};
  assert.equal(decideInterest(input).state,'candidate');
  assert.equal(decideInterest({...input,evidence:[]}).state,'abstain');
  assert.equal(decideInterest({...input,evidence:[],previous:{state:'watch_public'}}).state,'decay');
  assert.equal(decideInterest({...input,evidence:[evidence('old','question',{occurredAt:'2026-09-20T00:00:00Z'})],previous:{state:'watch_public'}}).state,'decay');
  const repeated = [evidence('q1'),evidence('q2')];
  assert.equal(decideInterest({...input,evidence:repeated}).state,'candidate');
  const refs = repeated.map(({id,topicId,sourceId,sourceRevision})=>({id,topicId,sourceId,sourceRevision}));
  const classification = {label:'sustained',abstained:false,calibrated:false,evidence:refs};
  assert.equal(decideInterest({...input,evidence:repeated,classification}).state,'watch_public');
  assert.equal(decideInterest({...input,evidence:repeated,classification:{...classification,evidence:refs.map(ref=>({...ref,sourceRevision:'old'}))}}).state,'abstain');
  assert.equal(decideInterest({...input,evidence:repeated,classification:{...classification,abstained:true}}).state,'abstain');
  assert.equal(decideInterest({...input,evidence:repeated.map(e=>({...e,match:'keyword'})),classification}).state,'abstain');
  const contextual = {...input,evidence:[evidence('q1'),evidence('follow','followup',{relatedEvidenceId:'q1'})]};
  const decision = decideInterest(contextual);
  assert.equal(decision.state,'watch_public');
  assert.equal(decision.classificationCalibrated,false);
  assert.equal(decision.expiresAt,'2026-09-27T13:00:00.000Z');
  assert.deepEqual(decision.evidence,contextual.evidence.map(({id,topicId,sourceId,sourceRevision})=>({id,topicId,sourceId,sourceRevision})));
  assert.equal(decideInterest({...input,evidence:[evidence('q1'),evidence('follow','followup',{relatedEvidenceId:'wrong'})]}).state,'candidate');
  assert.equal(decideInterest({...input,evidence:[evidence('q1'),evidence('follow','followup',{relatedEvidenceId:'q1',topicId:'unrelated'})]}).state,'candidate');
  assert.equal(decideInterest({...input,evidence:[evidence('q1'),evidence('saved','bookmark')]}).state,'watch_public');
  assert.equal(decideInterest({...input,evidence:[evidence('q1'),evidence('goal','active_goal')]}).state,'watch_public');
  assert.equal(decideInterest({...contextual,source:undefined}).state,'abstain');
  for (const source of [{visibility:'private'},{risk:'high'},{transportVerified:false},{verificationExpiresAt:'2026-09-26T00:00:00Z'}])
    assert.equal(decideInterest({...contextual,source:{...input.source,...source}}).state,'abstain');
  assert.equal(decideInterest({...contextual,scope:{...input.scope,publicLowRiskTracking:false}}).state,'abstain');
  assert.equal(decideInterest({...contextual,scope:{...input.scope,state:'revoked'}}).state,'revoked');
  const tombstone = {id:'stop-1',topicId:'typescript',revokedAt:'2026-09-27T11:30:00Z'};
  assert.equal(decideInterest({...contextual,tombstone}).state,'revoked');
  assert.equal(decideInterest({...contextual,previous:{state:'revoked'}}).state,'revoked');
  assert.equal(decideInterest({...contextual,tombstone,explicitEnable:{id:'enable-old',topicId:'typescript',occurredAt:'2026-09-27T11:20:00Z'}}).state,'revoked');
  assert.equal(decideInterest({...contextual,tombstone,explicitEnable:{id:'enable-new',topicId:'typescript',occurredAt:'2026-09-27T11:45:00Z'}}).state,'watch_public');
  assert.throws(()=>decideInterest({...input,evidence:[evidence('q1'),evidence('q1','question',{sourceRevision:'r2'})]}),/Conflicting/);
  const sha = 'a'.repeat(64);
  const fresh = {at,maxAgeMs:7200000,requestedVersion:'5.9',sourceState:'available',cache:{version:'5.9',sourceId:'docs',sourceRevision:'r1',contentSha256:sha,lastSuccessfulCheck:'2026-09-27T11:00:00Z',validUntil:'2026-09-28T00:00:00Z'}};
  assert.equal(decideKnowledgeFreshness(fresh).action,'use_cache');
  assert.equal(decideKnowledgeFreshness({...fresh,requestedVersion:'6.0'}).action,'refresh_required');
  assert.equal(decideKnowledgeFreshness({...fresh,sourceState:'withdrawn'}).action,'unavailable');
  assert.equal(decideKnowledgeFreshness({...fresh,sourceState:'unavailable'}).action,'last_verified_only');
  const check = {outcome:'unchanged',checkedAt:'2026-09-27T11:59:00Z',sourceId:'docs',sourceRevision:'r1',cachedContentSha256:sha};
  assert.equal(decideKnowledgeFreshness({...fresh,check}).lastSuccessfulCheck,check.checkedAt);
  assert.equal(decideKnowledgeFreshness({...fresh,check:{...check,outcome:'failed'}}).lastSuccessfulCheck,fresh.cache.lastSuccessfulCheck);
  assert.equal(decideKnowledgeFreshness({...fresh,check:{...check,outcome:'failed'}}).action,'last_verified_only');
  assert.equal(decideKnowledgeFreshness({...fresh,check:{...check,outcome:'changed'}}).action,'refresh_required');
  assert.equal(decideKnowledgeFreshness({...fresh,check:{...check,cachedContentSha256:'etag-123'}}).action,'last_verified_only');
  assert.equal(decideKnowledgeFreshness({...fresh,check:{...check,checkedAt:'2026-09-28T00:00:00Z'}}).action,'last_verified_only');
  assert.equal(decideKnowledgeFreshness({...fresh,check,cache:{...fresh.cache,validUntil:'2026-09-27T11:50:00Z'}}).action,'last_verified_only');
  assert.equal(decideKnowledgeFreshness({...fresh,cache:{...fresh.cache,lastSuccessfulCheck:'2026-09-26T00:00:00Z'}}).reason,'verification_expired');
  assert.throws(()=>decideKnowledgeFreshness({...fresh,cache:{...fresh.cache,contentSha256:'W/etag'}}),/Invalid/);
});
