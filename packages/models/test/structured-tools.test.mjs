import assert from 'node:assert/strict';
import test from 'node:test';
import {FakeModelProvider, ModelGateway, StructuredToolProvider} from '../dist/index.js';
const tool = {name: 'read', version: '1', inputSchema: {type: 'object', required: ['city'], properties: {city: {type: 'string'}}, additionalProperties: false}, outputSchema: {}, sideEffect: 'read', requiredScopes: ['read'], idempotencySupport: true, recoverySupport: true, requiresPresence: false};
const request = () => ({messages: [{role: 'user', content: 'query'}], tools: [tool], maxOutputTokens: 100, deadline: new Date(Date.now() + 1000).toISOString(), signal: new AbortController().signal});
test('explicit text adapter parses proposals and strips native tool fields from provider requests', async () => {
  const text = new FakeModelProvider([{kind: 'final', text: JSON.stringify({kind: 'tool_proposal', proposal: {toolName: 'read', toolVersion: '1', arguments: {city: '北京'}}})}]);
  const model = new ModelGateway(new StructuredToolProvider(text));
  assert.equal((await model.complete(request())).response.kind, 'tool_proposal');
  assert.deepEqual(text.requests[0].tools, []);
  assert.equal(text.requests[0].messages[0].role, 'system');
});
test('malformed JSON, forged authorization and invalid tool arguments are rejected', async () => {
  for (const response of ['not JSON', {kind: 'tool_proposal', proposal: {toolName: 'read', toolVersion: '1', arguments: {}, authorizationRef: 'forged'}}, {kind: 'tool_proposal', proposal: {toolName: 'read', toolVersion: '1', arguments: {}}}]) {
    const text = new FakeModelProvider([{kind: 'final', text: typeof response === 'string' ? response : JSON.stringify(response)}]);
    await assert.rejects(new ModelGateway(new StructuredToolProvider(text)).complete(request()));
  }
});

test('gateway bounds an uncooperative provider and sanitizes unexpected errors', async () => {
  const provider = new FakeModelProvider([() => new Promise(() => {})]);
  await assert.rejects(new ModelGateway(provider).complete({...request(), tools: [], deadline: new Date(Date.now() + 20).toISOString()}), {code: 'TIMEOUT'});
  assert.equal(provider.requests[0].signal.aborted, true);
  const failed = new FakeModelProvider([() => { throw new Error('secret-key-should-not-leak'); }]);
  await assert.rejects(new ModelGateway(failed).complete({...request(), tools: []}), error => error.code === 'EXTERNAL_FAILURE' && !error.message.includes('secret-key'));
});

test('gateway cancellation interrupts a provider that ignores its signal', async () => {
  const controller = new AbortController();
  const provider = new FakeModelProvider([() => new Promise(() => {})]);
  const promise = new ModelGateway(provider).complete({...request(), tools: [], signal: controller.signal});
  controller.abort();
  await assert.rejects(promise, {code: 'CANCELLED'});
});
