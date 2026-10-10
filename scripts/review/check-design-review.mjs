import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {policy,hashText,manifestDigest} from './design-manifest.mjs';

export function receiptFrom(body) {
  if(typeof body!=='string'||body.length>65536) return null;
  const marker=`<!-- ${policy.receiptMarker} -->`;
  const start=body.indexOf(marker);
  if(start<0) return null;
  const match=/^\s*```json\s*\n([\s\S]*?)\n```/.exec(body.slice(start+marker.length));
  if(!match) return null;
  try{return JSON.parse(match[1]);}catch{return null;}
}
export function evaluateReviews({headSha,author,reviews,digest}) {
  const missing=[];
  for(const login of policy.requiredReviewers) {
    const mine=reviews.filter(review=>review.user?.login?.toLowerCase()===login.toLowerCase()).sort((a,b)=>a.id-b.id);
    const governing=mine.filter(review=>['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(review.state)).at(-1);
    const isAuthor=author.toLowerCase()===login.toLowerCase();
    const approved=isAuthor || (governing?.state==='APPROVED'&&governing.commit_id===headSha);
    const hasReceipt=mine.some(review=>{
      if(review.commit_id!==headSha||!['APPROVED','COMMENTED'].includes(review.state)) return false;
      const receipt=receiptFrom(review.body);
      return receipt?.version===1&&receipt.headSha===headSha&&receipt.manifestDigest===digest
        &&receipt.confirmedOnOwnComputer===true&&Array.isArray(receipt.confirmedFiles)
        &&JSON.stringify(receipt.confirmedFiles)===JSON.stringify(policy.requiredFiles)
        &&typeof receipt.confirmedAt==='string'&&Number.isFinite(Date.parse(receipt.confirmedAt));
    });
    if(!approved||!hasReceipt) missing.push(login);
  }
  return {passed:missing.length===0,missing};
}
async function run() {
  const token=process.env.GITHUB_TOKEN;
  const repository=process.env.GITHUB_REPOSITORY;
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  const number=event.pull_request?.number;
  if(!token||!/^[-\w]+\/[-\w.]+$/.test(repository??'')||!Number.isSafeInteger(number)) throw Error('Missing trusted GitHub PR context');
  async function api(route) {
    const response=await fetch(`https://api.github.com/repos/${repository}/${route}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
    if(!response.ok) throw Error(`GitHub read failed (${response.status}); no confirmation accepted`);
    return response.json();
  }
  const pr=await api(`pulls/${number}`);
  const headSha=pr.head.sha;
  const files=[];
  for(const name of policy.requiredFiles) {
    const relative=path.posix.join(policy.designDirectory,name);
    const blob=await api(`contents/${relative}?ref=${headSha}`);
    if(blob.type!=='file'||blob.encoding!=='base64'||blob.size>1_000_000) throw Error('Design artifact unavailable or oversized');
    files.push({path:relative,sha256:hashText(Buffer.from(blob.content,'base64').toString('utf8'))});
  }
  const digest=manifestDigest(files);
  const reviews=[];
  for(let page=1;;page++) {
    const batch=await api(`pulls/${number}/reviews?per_page=100&page=${page}`);
    reviews.push(...batch);
    if(batch.length<100)break;
  }
  const result=evaluateReviews({headSha,author:pr.user.login,reviews,digest});
  console.log(JSON.stringify({headSha,manifestDigest:digest,...result}));
  if(!result.passed) throw Error(`Awaiting current-head approvals and personal reading receipts: ${result.missing.join(', ')}. Never bypass this check.`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await run();
