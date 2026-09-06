import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryAuthorizationPolicy } from '../dist/index.js';

const base = {
  authorizationRef: 'auth-1',
  taskId: 'task-1',
  toolName: 'weather.forecast',
  scopes: ['weather:read'],
  expiresAt: '2026-09-05T13:00:00.000Z',
};

test('grant is bound to task, tool, scopes and expiry', () => {
  const policy = new InMemoryAuthorizationPolicy();
  policy.grant(base);
  assert.deepEqual(policy.authorize({
    authorizationRef: 'auth-1',
    taskId: 'task-1',
    toolName: 'weather.forecast',
    requiredScopes: ['weather:read'],
    now: Date.parse('2026-09-05T12:00:00.000Z'),
  }), {scopes: ['weather:read']});
  assert.throws(() => policy.authorize({...base, requiredScopes: ['weather:write'], now: Date.parse('2026-09-05T12:00:00.000Z')}), {code: 'SCOPE_DENIED'});
  assert.throws(() => policy.authorize({...base, taskId: 'task-2', requiredScopes: [], now: Date.parse('2026-09-05T12:00:00.000Z')}), {code: 'UNAUTHORIZED'});
  assert.throws(() => policy.authorize({...base, requiredScopes: [], now: Date.parse(base.expiresAt)}), {code: 'UNAUTHORIZED'});
});

test('limited grants are consumed only by successful authorization checks', () => {
  const policy = new InMemoryAuthorizationPolicy();
  policy.grant({...base, maxUses: 1});
  assert.throws(() => policy.authorize({...base, requiredScopes: ['missing'], now: Date.parse('2026-09-05T12:00:00.000Z')}), {code: 'SCOPE_DENIED'});
  policy.authorize({...base, requiredScopes: ['weather:read'], now: Date.parse('2026-09-05T12:00:00.000Z')});
  assert.equal(policy.get('auth-1').usesRemaining, 0);
  assert.throws(() => policy.authorize({...base, requiredScopes: [], now: Date.parse('2026-09-05T12:00:00.000Z')}), {code: 'UNAUTHORIZED'});
});

test('revocation takes effect immediately and grants reject malformed input', () => {
  const policy = new InMemoryAuthorizationPolicy();
  policy.grant(base);
  assert.equal(policy.revoke('auth-1'), true);
  assert.equal(policy.get('auth-1'), undefined);
  assert.throws(() => policy.authorize({...base, requiredScopes: [], now: Date.parse('2026-09-05T12:00:00.000Z')}), {code: 'UNAUTHORIZED'});
  assert.throws(() => policy.grant({...base, authorizationRef: ' '}), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => policy.grant({...base, scopes: []}), {code: 'INVALID_ARGUMENT'});
  assert.throws(() => policy.grant({...base, maxUses: 0}), {code: 'INVALID_ARGUMENT'});
});
