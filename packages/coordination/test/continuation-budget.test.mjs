import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseCoordinationContinuation, parseCoordinationToolProposal} from '../dist/index.js';

const limit = 1_048_576;
const continuation = result => ({proposalId: 'fixture', state: 'confirmed', result});
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const reject = value => assert.throws(() => parseCoordinationContinuation(value), error =>
  error.code === 'INVALID_ARGUMENT' && error.message === 'Invalid coordination result');

// One byte either side of the complete envelope, not merely result.length.
test('continuation budget includes the envelope and preserves exact byte boundary', () => {
  const overhead = bytes(continuation(''));
  const exact = continuation('x'.repeat(limit - overhead));
  assert.equal(bytes(exact), limit);
  assert.deepEqual(parseCoordinationContinuation(exact), exact);
  reject(continuation(exact.result + 'x'));
  reject({...exact, proposalId: 'fixture-longer'});
});

test('continuation counts UTF-8, escaped controls, lone surrogates and property names', () => {
  const overhead = bytes(continuation(''));
  for (const [character, width] of [['中', 3], ['😀', 4], ['\n', 2], ['\u0001', 6], ['\ud800', 6]]) {
    const count = Math.floor((limit - overhead) / width);
    const input = continuation(character.repeat(count));
    assert.ok(bytes(input) <= limit);
    assert.deepEqual(parseCoordinationContinuation(input), input);
    reject(continuation(input.result + character));
  }
  reject(continuation({['中'.repeat(350_000)]: null}));
  reject(continuation({['\u0001'.repeat(180_000)]: null}));
});

test('one shared budget rejects aggregate growth and stops before cloning the tail', () => {
  let tailInspected = false;
  const tail = new Proxy({}, {getPrototypeOf() { tailInspected = true; return Object.prototype; }});
  const value = {a: 'a'.repeat(530_000), b: 'b'.repeat(530_000), tail};
  reject(continuation(value));
  assert.equal(tailInspected, false);
  const leaf = 'x'.repeat(4_100);
  reject(continuation([Array(128).fill(leaf), Array(128).fill(leaf)]));
});

test('continuation preserves JSON identity, repeated values and isolated output', () => {
  const shared = {value: 1};
  const payload = JSON.parse('{"__proto__":{"safe":true},"constructor":"data"}');
  payload.values = [shared, shared, null, false, 1e30];
  const input = continuation(payload);
  const result = parseCoordinationContinuation(input);
  assert.deepEqual(result, input);
  assert.equal(Object.getPrototypeOf(result.result), Object.prototype);
  assert.equal(Object.hasOwn(result.result, '__proto__'), true);
  result.result.values[0].value = 99;
  assert.equal(shared.value, 1);
  assert.equal(result.result.values[1].value, 1);
  const proposal = {kind: 'tool_proposal', proposalId: 'fixture', toolName: 'read',
    toolVersion: '1', verification: 'mock', arguments: {values: [1, 2]}};
  assert.deepEqual(parseCoordinationToolProposal(proposal), proposal);
});

test('bounded continuation rejects non-JSON arrays, cycles and hostile reflection without invoking getters', () => {
  let getters = 0;
  const array = [1];
  Object.defineProperty(array, '0', {enumerable: true, get() { getters++; return 'secret'; }});
  const mapped = [1];
  mapped.map = () => { getters++; return []; };
  const sparse = Array(1);
  const extra = [1]; extra.extra = true;
  const cyclic = {}; cyclic.self = cyclic;
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = new Proxy({value: 1}, {getOwnPropertyDescriptor() { throw new Error('private-canary'); }});
  for (const value of [array, mapped, sparse, extra, cyclic, revoked.proxy, hostile,
    undefined, NaN, Infinity, 1n, new Date()]) reject(continuation(value));
  reject(revoked.proxy);
  assert.equal(getters, 0);
});
