import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ProtocolError} from '@personal-agent/contracts';
import {GhCliProvider, FakeGitHubProvider, GitHubService, register} from '../dist/index.js';
const fixtures = JSON.parse(await readFile(new URL('./fixtures/github.json', import.meta.url), 'utf8'));
const repo = 'example/repository';
const token = 'ghp_fakecredential01234567890';
const context = () => ({signal: new AbortController().signal, deadline: new Date(Date.now() + 5000).toISOString()});
function provider(responses) {
  const calls = [];
  const runner = {async run(command) {
    calls.push(command);
    const next = responses.shift();
    assert.notEqual(next, undefined, 'unexpected command');
    if (next instanceof Error) throw next;
    return next.exitCode !== undefined ? next : {exitCode: 0, stdout: JSON.stringify(next), stderr: ''};
  }};
  return {calls, value: new GhCliProvider({runner, readToken: async () => token, repositories: [repo]})};
}
test('run and job pages preserve explicit next page', async () => {
  const p = provider([fixtures.runs, fixtures.jobs]);
  const run = await p.value.execute('actions.run.list', {repo, perPage: 1}, context());
  assert.equal(run.items[0].conclusion, 'failure'); assert.equal(run.nextPage, 2);
  const jobs = await p.value.execute('actions.job.list', {repo, runId: 31, perPage: 1}, context());
  assert.equal(jobs.items[0].id, 41); assert.equal(jobs.hasMore, true);
});
test('issue pagination counts remote PR rows without exposing them', async () => {
  const p = provider([[{...fixtures.issue, pull_request: {}}, fixtures.issue]]);
  const page = await p.value.execute('issue.list', {repo, perPage: 2, page: 2}, context());
  assert.equal(page.items.length, 1); assert.equal(page.nextPage, 3);
});
test('404, rate limits and invalid parameters do not dispatch retries', async () => {
  for (const [status, code] of [['404', 'NOT_FOUND'], ['429', 'RATE_LIMITED']]) {
    const p = provider([{exitCode: 1, stdout: '', stderr: `HTTP ${status} ${token}`}]);
    await assert.rejects(p.value.execute('issue.get', {repo, number: 8}, context()), error => error.code === code && !error.message.includes(token));
    assert.equal(p.calls.length, 1);
  }
  const p = provider([]);
  await assert.rejects(p.value.execute('issue.get', {repo, number: 8, command: 'rm'}, context()), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(p.value.execute('repo.get', {repo: 'other/repository'}, context()), error => error.code === 'SCOPE_DENIED');
  assert.equal(p.calls.length, 0);
});
test('diff pagination is redacted and bound to both revisions', async () => {
  const p = provider([fixtures.pull, {exitCode: 0, stdout: `+${token}\n+safe`, stderr: ''}, fixtures.pull]);
  const result = await p.value.execute('pr.diff', {repo, number: 9, expectedHeadSha: fixtures.pull.head.sha, expectedBaseSha: fixtures.pull.base.sha, maxChars: 10}, context());
  assert.equal(result.truncated, true); assert.equal(result.nextOffset, 10); assert.ok(!result.text.includes(token));
  const changed = provider([fixtures.pull, {exitCode: 0, stdout: 'diff', stderr: ''}, {...fixtures.pull, head: {...fixtures.pull.head, sha: 'c'.repeat(40)}}]);
  await assert.rejects(changed.value.execute('pr.diff', {repo, number: 9, expectedHeadSha: fixtures.pull.head.sha, expectedBaseSha: fixtures.pull.base.sha}, context()), error => error.code === 'REVISION_CONFLICT');
});
test('PR creation confirms only when the returned head matches the reviewed SHA', async () => {
  const input = {repo, title: 'Fix build', body: 'Verified patch', head: 'fix/build', base: 'main', expectedHeadSha: fixtures.pull.head.sha, draft: true};
  const confirmed = provider([{object: {sha: input.expectedHeadSha}}, {...fixtures.pull, number: 10, html_url: 'https://github.com/example/repository/pull/10'}]);
  assert.deepEqual(await confirmed.value.execute('pr.create', input, context()), {
    state: 'confirmed', externalId: '10', url: 'https://github.com/example/repository/pull/10', evidenceRefs: []
  });
  const changed = provider([
    {object: {sha: input.expectedHeadSha}},
    {...fixtures.pull, number: 11, head: {...fixtures.pull.head, sha: 'c'.repeat(40)}, html_url: 'https://github.com/example/repository/pull/11'}
  ]);
  assert.deepEqual(await changed.value.execute('pr.create', input, context()), {
    state: 'unknown', externalId: '11', url: 'https://github.com/example/repository/pull/11', evidenceRefs: []
  });
  assert.equal(changed.calls.length, 2);
});
test('failed job log validates run ownership and caps text', async () => {
  const p = provider([fixtures.jobs.jobs[0], {exitCode: 0, stdout: `token=${token}\nerror`, stderr: ''}]);
  const log = await p.value.execute('actions.log.read', {repo, runId: 31, jobId: 41, maxChars: 5}, context());
  assert.equal(log.text.length, 5); assert.equal(log.truncated, true);
  assert.deepEqual(p.calls[1].args, ['run', 'view', '31', '--repo', repo, '--job', '41', '--log-failed']);
  const wrong = provider([{...fixtures.jobs.jobs[0], run_id: 32}]);
  await assert.rejects(wrong.value.execute('actions.log.read', {repo, runId: 31, jobId: 41}, context()), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(wrong.calls.length, 1);
});
test('write transport failure is unknown and never retried', async () => {
  const p = provider([fixtures.pull, new ProtocolError('TIMEOUT', token)]);
  const result = await p.value.execute('pr.comment', {repo, number: 9, body: 'comment'}, context());
  assert.deepEqual(result, {state: 'unknown', evidenceRefs: []}); assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1].stdin, JSON.stringify({body: 'comment'}));
});
test('stale issue revision and review head refuse writes', async () => {
  const p = provider([fixtures.issue, fixtures.pull]);
  await assert.rejects(p.value.execute('issue.label', {repo, number: 8, labels: ['bug'], expectedUpdatedAt: '2026-10-02T00:00:00Z'}, context()), error => error.code === 'REVISION_CONFLICT');
  await assert.rejects(p.value.execute('pr.review.comment', {repo, number: 9, body: 'note', commitId: 'c'.repeat(40), path: 'src/index.ts', line: 1}, context()), error => error.code === 'REVISION_CONFLICT');
  assert.equal(p.calls.length, 2);
});
test('cancellation and expired deadline fail before credentials or process', async () => {
  const p = provider([]), controller = new AbortController(); controller.abort();
  await assert.rejects(p.value.execute('repo.get', {repo}, {...context(), signal: controller.signal}), error => error.code === 'CANCELLED');
  await assert.rejects(p.value.execute('repo.get', {repo}, {...context(), deadline: '2000-01-01T00:00:00Z'}), error => error.code === 'TIMEOUT');
  assert.equal(p.calls.length, 0);
});
test('service rejects a late read from a provider that ignores cancellation', async () => {
  let resolve,signal;
  const service=new GitHubService({verification:'mock',execute:(_op,_input,bounded)=>{
    signal=bounded.signal;return new Promise(done=>{resolve=done;});
  }});
  const controller=new AbortController();
  const pending=service.execute('issue.get',{repo,number:8},{...context(),signal:controller.signal});
  const cancelled=assert.rejects(pending,error=>error.code==='CANCELLED');
  controller.abort();resolve(fixtures.issue);
  await cancelled;assert.equal(signal.aborted,true);
});
test('service bounds non-cooperating providers by deadline without claiming a write was stopped', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-05T00:00:00Z')});
  const signals=[];
  const service=new GitHubService({verification:'mock',execute:(_op,_input,bounded)=>{
    signals.push(bounded.signal);return new Promise(()=>{});
  }});
  const read=service.execute('issue.get',{repo,number:8},context());
  const expired=assert.rejects(read,error=>error.code==='TIMEOUT');
  t.mock.timers.tick(5000);await expired;
  assert.equal(signals[0].aborted,true);
  const write=service.execute('issue.comment',{repo,number:8,body:'synthetic note'},context());
  t.mock.timers.tick(5000);
  assert.deepEqual(await write,{state:'unknown',evidenceRefs:[]});
  assert.equal(signals[1].aborted,true);
  assert.equal(signals.length,2);
});
test('registered service keeps cancelled provider writes unknown and does not retry', async () => {
  let resolve,signal,calls=0;
  const tools=new Map();
  const dispose=register({register(tool){tools.set(tool.descriptor.name,tool);return ()=>tools.delete(tool.descriptor.name);}},
    {provider:{verification:'mock',execute:(_op,_input,bounded)=>{
      calls++;signal=bounded.signal;return new Promise(done=>{resolve=done;});
    }}});
  try {
    const controller=new AbortController();
    const pending=tools.get('github.issue.comment').execute({repo,number:8,body:'synthetic note'},
      {...context(),signal:controller.signal,taskId:'synthetic-task',runId:'synthetic-run',authorizationRef:'synthetic-grant',scopes:['github:write']});
    const unknown=assert.rejects(pending,error=>error.code==='RESULT_UNKNOWN');
    controller.abort();resolve({state:'confirmed',externalId:'synthetic',evidenceRefs:[]});
    await unknown;assert.equal(calls,1);assert.equal(signal.aborted,true);
    await assert.rejects(tools.get('github.issue.comment').execute({repo,number:8,body:'synthetic note'},
      {...context(),signal:controller.signal,taskId:'synthetic-task',runId:'synthetic-run',authorizationRef:'synthetic-grant',scopes:['github:write']}),error=>error.code==='CANCELLED');
    assert.equal(calls,1,'pre-cancelled calls do not invoke the provider');
  } finally {dispose();}
});
test('review publication rejects a changed base before dispatching POST', async () => {
  const p = provider([{...fixtures.pull, base: {...fixtures.pull.base, sha: 'c'.repeat(40)}}]);
  await assert.rejects(p.value.execute('pr.review.comment', {repo, number: 9, body: 'note',
    commitId: fixtures.pull.head.sha, expectedBaseSha: fixtures.pull.base.sha, path: 'src/index.ts', line: 1}, context()),
  error => error.code === 'REVISION_CONFLICT');
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].args[p.calls[0].args.indexOf('--method') + 1], 'GET');
});
test('register has read/write descriptors, strict scopes and idempotent disposal', async () => {
  const tools = new Map(); let removed = 0;
  const fake = new FakeGitHubProvider({'issue.label': {state: 'unknown', evidenceRefs: []}});
  const dispose = register({register(tool) {tools.set(tool.descriptor.name, tool); return () => {tools.delete(tool.descriptor.name); removed++;};}}, {provider: fake});
  assert.equal(tools.size, 13);
  const write = tools.get('github.issue.label');
  assert.equal(write.descriptor.sideEffect, 'external_write'); assert.equal(write.descriptor.idempotencySupport, false);
  assert.equal(tools.get('github.pr.get').descriptor.sideEffect, 'read');
  await assert.rejects(write.execute({repo, number: 8, labels: ['bug'], expectedUpdatedAt: fixtures.issue.updated_at}, {...context(), taskId: 't', runId: 'r', authorizationRef: '', scopes: ['github:write']}), error => error.code === 'SCOPE_DENIED');
  assert.equal(fake.calls.length, 0);
  await assert.rejects(write.execute({repo, number: 8, labels: ['bug'], expectedUpdatedAt: fixtures.issue.updated_at}, {...context(), taskId: 't', runId: 'r', authorizationRef: 'host-grant', scopes: ['github:write']}), error => error.code === 'RESULT_UNKNOWN');
  assert.equal(fake.calls.length, 1);
  dispose(); dispose(); assert.equal(removed, 13); assert.equal(tools.size, 0);
});
