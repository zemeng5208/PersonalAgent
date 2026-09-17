import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCoordinationToolProposal, parseCoordinationContinuation} from '../dist/index.js';

const data = () => JSON.parse('{"__proto__":{"label":"synthetic"},"nested":{"__proto__":{"enabled":true}},"constructor":"ordinary-json-key"}');

test('proposal copies preserve own JSON keys without changing prototypes on repeated parsing', () => {
  const input = {kind: 'tool_proposal', proposalId: 'synthetic-proposal', toolName: 'fixture.read',
    toolVersion: '1.0.0', arguments: data(), verification: 'mock'};
  const once = parseCoordinationToolProposal(input);
  const twice = parseCoordinationToolProposal(once);
  for (const result of [once, twice]) {
    assert.deepEqual(result.arguments, input.arguments);
    assert.equal(JSON.stringify(result.arguments), JSON.stringify(input.arguments));
    assert.equal(Object.getPrototypeOf(result.arguments), Object.prototype);
    assert.equal(Object.getPrototypeOf(result.arguments.nested), Object.prototype);
    assert.equal(Object.hasOwn(result.arguments, '__proto__'), true);
    assert.equal(Object.hasOwn(result.arguments.nested, '__proto__'), true);
    assert.equal(result.arguments.label, undefined);
  }
  once.arguments.__proto__.label = 'mutated-copy';
  assert.equal(input.arguments.__proto__.label, 'synthetic');
  assert.equal(twice.arguments.__proto__.label, 'synthetic');
});

test('confirmed continuation preserves special keys in nested array results', () => {
  const original = {proposalId: 'synthetic-proposal', state: 'confirmed', result: [data()]};
  const copy = parseCoordinationContinuation(original);
  assert.deepEqual(copy, original);
  assert.equal(Object.hasOwn(copy.result[0], '__proto__'), true);
  assert.equal(Object.getPrototypeOf(copy.result[0]), Object.prototype);
  assert.deepEqual(parseCoordinationContinuation(copy), original);
  copy.result[0].nested.__proto__.enabled = false;
  assert.equal(original.result[0].nested.__proto__.enabled, true);
});
