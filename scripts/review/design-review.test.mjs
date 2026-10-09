import test from 'node:test';
import assert from 'node:assert/strict';
import {policy} from './design-manifest.mjs';
import {evaluateReviews,receiptFrom} from './check-design-review.mjs';
const head='a'.repeat(40),digest='b'.repeat(64);
function review(login,id,state='APPROVED',overrides={}) {
  const receipt={version:1,headSha:head,manifestDigest:digest,confirmedOnOwnComputer:true,confirmedFiles:policy.requiredFiles,confirmedAt:'2026-10-09T00:00:00Z',...overrides};
  return {id,user:{login},state,commit_id:head,body:`<!-- ${policy.receiptMarker} -->\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\``};
}
function check(reviews,author='zemeng5208'){return evaluateReviews({headSha:head,author,reviews,digest});}
test('both named users approve with current-content receipts',()=>assert.equal(check([review('goo122',1),review('Potatos498',2)]).passed,true));
test('one user and a different approver cannot replace the second user',()=>assert.deepEqual(check([review('goo122',1),review('outsider',2)]).missing,['Potatos498']));
test('stale head, changed content and missing own-computer attestation fail',()=>{
  for(const patch of [{headSha:'c'.repeat(40)},{manifestDigest:'c'.repeat(64)},{confirmedOnOwnComputer:false},{confirmedFiles:['index.html']}]) {
    assert.equal(check([review('goo122',1,'APPROVED',patch),review('Potatos498',2)]).passed,false);
  }
});
test('dismissed and changes-requested reviews block earlier approvals',()=>{
  for(const state of ['DISMISSED','CHANGES_REQUESTED']) assert.equal(check([review('goo122',1),review('Potatos498',2),review('goo122',3,state)]).passed,false);
});
test('author must personally attest, platform external-review count remains independent',()=>{
  assert.equal(check([review('goo122',1,'COMMENTED'),review('Potatos498',2)],'goo122').passed,true);
  assert.equal(check([review('Potatos498',2)],'goo122').passed,false);
});
test('ordinary prose and malformed or oversized receipts fail closed',()=>{
  assert.equal(receiptFrom('I opened everything'),null);
  assert.equal(receiptFrom('x'.repeat(65537)),null);
  assert.equal(receiptFrom(`<!-- ${policy.receiptMarker} -->\n\`\`\`json\n{bad}\n\`\`\``),null);
});
