import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireHuaweiSisToken} from '../electron/huawei-iam-login.js';

const input = {region: 'cn-north-4', domainName: 'demo-account', username: 'personalagent-sis', password: 'fixture-secret'};
const now = Date.parse('2026-09-27T00:00:00Z');
const valid = {token: {project: {name: input.region, id: '0123456789abcdef0123456789abcdef'},
  user: {name: input.username}, expires_at: '2026-09-28T00:00:00.000000Z'}};
const reply = body => new Response(JSON.stringify(body), {status: 201, headers: {'x-subject-token': 'fixture-token'}});

test('IAM login uses fixed Huawei endpoint and regional project scope, returning only token configuration', async () => {
  const result = await acquireHuaweiSisToken(input, {now: () => now, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://iam.myhuaweicloud.com/v3/auth/tokens?nocatalog=true');
    assert.equal(init.redirect, 'error');
    const request = JSON.parse(init.body);
    assert.deepEqual(request.auth.scope, {project: {name: 'cn-north-4'}});
    assert.equal(request.auth.identity.password.user.password, input.password);
    return reply(valid);
  }});
  assert.deepEqual(result, {region: input.region, projectId: valid.token.project.id,
    iamToken: 'fixture-token', tokenExpiresAt: valid.token.expires_at});
  assert.ok(!JSON.stringify(result).includes(input.password));
});

test('IAM configuration rejects endpoint injection and does not send invalid credentials', async () => {
  let calls = 0;
  for (const invalid of [{...input, region: 'unknown'}, {...input, endpoint: 'https://example.invalid'},
    {...input, password: ''}]) {
    await assert.rejects(acquireHuaweiSisToken(invalid, {fetchImpl: async () => {calls++;}}), /请填写/);
  }
  assert.equal(calls, 0);
});

test('IAM rejects mismatched identity, project and expired or oversized responses without exposing bodies', async () => {
  const cases = [
    {...valid, token: {...valid.token, user: {name: 'someone-else'}}},
    {...valid, token: {...valid.token, project: {...valid.token.project, name: 'cn-east-3'}}},
    {...valid, token: {...valid.token, expires_at: '2020-01-01T00:00:00Z'}},
    {...valid, unexpected: 'x'.repeat(70_000)},
  ];
  for (const body of cases) await assert.rejects(acquireHuaweiSisToken(input,
    {now: () => now, fetchImpl: async () => reply(body)}), /项目令牌无效/);
});

test('IAM upstream errors stay sanitized and never retry', async () => {
  let calls = 0;
  await assert.rejects(acquireHuaweiSisToken(input, {fetchImpl: async () => {
    calls++; return new Response(input.password, {status: 401});
  }}), error => error.message.includes('IAM 登录失败') && !error.message.includes(input.password));
  assert.equal(calls, 1);
  await assert.rejects(acquireHuaweiSisToken(input, {fetchImpl: async () => {throw Error(input.password);}}), /无法连接华为 IAM/);
});
