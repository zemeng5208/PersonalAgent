import test from 'node:test';
import assert from 'node:assert/strict';
import {readCapabilityDirectory} from '../electron/capability-directory.js';

test('capability read distinguishes an empty directory from an unavailable or failed operation', async () => {
  const empty = await readCapabilityDirectory({call: async () => ({manifests: [], health: []})});
  assert.equal(empty.status.state, 'loaded');
  assert.deepEqual(empty.manifests, []);

  const unavailable = await readCapabilityDirectory({call: async () => {
    throw Object.assign(new Error('not negotiated'), {code: 'UNSUPPORTED_CAPABILITY'});
  }});
  assert.equal(unavailable.status.state, 'unavailable');
  assert.match(unavailable.status.reason, /未公布/);

  const failed = await readCapabilityDirectory({call: async () => {
    throw Object.assign(new Error('secret-canary'), {code: 'TIMEOUT'});
  }});
  assert.equal(failed.status.state, 'error');
  assert.match(failed.status.reason, /TIMEOUT/);
  assert.doesNotMatch(failed.status.reason, /secret-canary/);
});

test('admin shows only reported capability health and preserves unavailable and error states', async t => {
  const original = new Map(['window', 'document', 'matchMedia'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const element = () => ({dataset: {}, textContent: '', addEventListener() {},
    setAttribute() {}, insertBefore() {}});
  globalThis.window = {addEventListener() {}};
  globalThis.document = {createElement: element};
  globalThis.matchMedia = () => ({matches: false, addEventListener() {}});
  const {mountAdmin} = await import('../src/features/admin/view.js');
  const nodes = new Map(['.admin-bar', '#admin-close', 'nav', '#admin-search',
    '.main', '#page-title', '#connection', '#content', '#error'].map(key => [key, element()]));
  const root = {innerHTML: '', querySelector: key => nodes.get(key) ?? null,
    querySelectorAll: () => []};
  const escape = value => String(value).replace(/[&<>"']/g,
    char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const render = mountAdmin(root, async () => {}, escape);
  const base = {tasks: [], approvals: [], capabilities: [], health: [], connection: 'fixture'};
  const html = () => nodes.get('#content').innerHTML;

  render({...base, capabilityDirectory: {state: 'unavailable', reason: '未公布'},
    adminNavigation: {page: 'capabilities', revision: 1}});
  assert.match(html(), /未公布/);
  assert.doesNotMatch(html(), /Runtime 已确认返回空能力目录/);
  assert.match(html(), /data-jump="models"/);

  render({...base, capabilityDirectory: {state: 'loaded', reason: 'Runtime 已返回空能力目录'},
    adminNavigation: {page: 'capabilities', revision: 2}});
  assert.match(html(), /Runtime 已确认返回空能力目录/);

  render({...base, capabilities: [{name: 'fixture.read', version: '1', sideEffect: 'read',
    requiredScopes: ['fixture:read']}], health: [{id: 'fixture.read', state: 'degraded',
    reason: '<not-ready>'}], capabilityDirectory: {state: 'loaded', reason: '已公布 1 项'},
    adminNavigation: {page: 'capabilities', revision: 3}});
  assert.match(html(), /降级/);
  assert.match(html(), /&lt;not-ready&gt;/);
  assert.doesNotMatch(html(), /data-tone="ready"/);

  render({...base, capabilityDirectory: {state: 'error', reason: '能力目录读取失败（TIMEOUT）'},
    adminNavigation: {page: 'connections', revision: 4}});
  assert.match(html(), /role="alert"/);
  assert.match(html(), /能力目录读取失败/);
  assert.doesNotMatch(html(), /Runtime 未报告连接健康项/);
});
