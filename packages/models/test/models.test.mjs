import assert from 'node:assert/strict';
import test from 'node:test';
import {FakeModelProvider, ModelCapabilityRegistry, ModelGateway, PanguModelProvider, UnavailableModelProvider, validateToolProposal} from '../dist/index.js';

const deadline = '2099-01-01T00:00:00.000Z';
const request = (overrides = {}) => ({
  messages: [{role: 'user', content: 'hello'}],
  tools: [],
  maxOutputTokens: 20,
  deadline,
  signal: new AbortController().signal,
  ...overrides,
});

test('FakeModelProvider returns explicit deployment and records a sanitized request', async () => {
  const provider = new FakeModelProvider([{kind: 'final', text: 'hello'}], {provider: 'fake', deployment: 'fixture-a', model: 'fixture-model'});
  const gateway = new ModelGateway(provider);
  const result = await gateway.complete(request());
  assert.equal(result.response.text, 'hello');
  assert.equal(result.deployment.deployment, 'fixture-a');
  assert.equal(result.deployment.model, 'fixture-model');
  assert.equal(result.deployment.verification, 'mock');
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].signal.aborted, false);
});

test('tool requests require declared tool calling and structured output capabilities', async () => {
  const provider = new FakeModelProvider([{kind: 'final', text: 'unused'}], {
    capabilities: {text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false},
  });
  const gateway = new ModelGateway(provider);
  const descriptor = {name: 'fixture.read', version: '1.0.0', inputSchema: {type: 'object'}, outputSchema: {type: 'object'}, sideEffect: 'read', requiredScopes: [], idempotencySupport: true, recoverySupport: true, requiresPresence: false};
  await assert.rejects(gateway.complete(request({tools: [descriptor]})), {code: 'UNSUPPORTED_CAPABILITY'});
  assert.equal(provider.requests.length, 0);
});

test('unavailable Pangu is explicit and never silently replaced by Fake', async () => {
  const gateway = new ModelGateway(new PanguModelProvider());
  await assert.rejects(gateway.complete(request()), {code: 'UNSUPPORTED_CAPABILITY'});
  assert.equal(gateway.deployment.provider, 'pangu');
  assert.equal(gateway.deployment.verification, 'conditional');
  const unavailable = new UnavailableModelProvider();
  await assert.rejects(new ModelGateway(unavailable).complete(request()), {code: 'UNSUPPORTED_CAPABILITY'});
});

test('tool proposal rejects model-supplied authorization fields', () => {
  assert.throws(() => validateToolProposal({toolName: 'fixture.read', toolVersion: '1.0.0', arguments: {}, scopeRef: 'forged'}), {code: 'UNAUTHORIZED'});
});

test('capability probe is recorded before a gateway is enabled', async () => {
  const provider = new FakeModelProvider([{kind: 'final', text: 'unused'}]);
  const registry = new ModelCapabilityRegistry();
  const deployment = await registry.probe(provider, {probe: async () => ({text: true, streaming: false, toolCalling: false, structuredOutput: false, vision: false})});
  assert.equal(deployment.capabilities.toolCalling, false);
  assert.equal(registry.get('fake', 'fake-deployment', 'fake-model').capabilities.toolCalling, false);
  await assert.rejects(new ModelGateway(provider, deployment).complete(request({tools: [{name: 'fixture.read', version: '1.0.0', inputSchema: {type: 'object'}, outputSchema: {type: 'object'}, sideEffect: 'read', requiredScopes: [], idempotencySupport: true, recoverySupport: true, requiresPresence: false}]})), {code: 'UNSUPPORTED_CAPABILITY'});
});
