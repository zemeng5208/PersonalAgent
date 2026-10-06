import test from 'node:test';
import assert from 'node:assert/strict';
import {mountWorkspaceControls} from '../src/app/workspace-controls.js';

function harness(t, invoke = async () => undefined) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;});
  const names = ['name','capabilities','select','node-status','select-node','select-file','project-status',
    'select-npm','cloud','write','command','project-code','project-label','authorize','revoke','status'];
  const fields = Object.fromEntries(names.map(name => [name, {checked: false, disabled: false, textContent: '',
    listeners: new Map(), attributes: new Map(), addEventListener(event, handler) {this.listeners.set(event, handler);},
    setAttribute(key, value) {this.attributes.set(key, value);}}]));
  const section = {setAttribute() {}, querySelector(selector) {return fields[/data-workspace="([^"]+)"/u.exec(selector)[1]];}};
  globalThis.document = {createElement: () => section};
  const controls = mountWorkspaceControls({append() {}}, invoke);
  const render = (coding = {}) => controls.render({coding: {configured: true, displayName: 'project',
    authorizationAvailable: true, projectScriptsAvailable: true, ...coding}});
  const change = (name, checked) => {fields[name].checked = checked; fields[name].listeners.get('change')?.();};
  return {fields, render, change, click: name => fields[name].listeners.get('click')()};
}

test('project execution consent requires separate command consent and clears when commands are deselected', t => {
  const ui = harness(t); ui.render();
  assert.equal(ui.fields['project-code'].disabled, true);
  ui.change('command', true);
  assert.equal(ui.fields['project-code'].disabled, false);
  assert.equal(ui.fields['project-code'].checked, false, 'command consent never implies project consent');
  ui.change('project-code', true); ui.change('command', false);
  assert.equal(ui.fields['project-code'].disabled, true);
  assert.equal(ui.fields['project-code'].checked, false);
});

test('host readback projects current consent while preserving deliberate unsaved changes', t => {
  const ui = harness(t);
  ui.render({cloudExportAllowed: true, writeAllowed: true, commandAllowed: true, projectCodeAllowed: true});
  assert.equal(ui.fields.write.checked, true); assert.equal(ui.fields.command.checked, true);
  assert.equal(ui.fields['project-code'].checked, true);
  ui.change('write', false);
  ui.render({cloudExportAllowed: true, writeAllowed: true, commandAllowed: true, projectCodeAllowed: true});
  assert.equal(ui.fields.write.checked, false);
  ui.render({cloudExportAllowed: false, writeAllowed: false, commandAllowed: false, projectCodeAllowed: false});
  assert.equal(ui.fields.command.checked, false); assert.equal(ui.fields['project-code'].checked, false);
});

test('saved workspace awaiting trusted assembly cannot authorize or claim malformed host readback', async t => {
  const calls = [];
  const ui = harness(t, async (action, input) => {calls.push({action, input}); return {coding: []};});
  ui.render({authorizationAvailable: false}); ui.change('cloud', true);
  assert.equal(ui.fields.authorize.disabled, true);
  await ui.click('authorize'); assert.equal(calls.length, 0);
  ui.render(); ui.change('cloud', true); await ui.click('authorize');
  assert.equal(calls.length, 1); assert.match(ui.fields.status.textContent, /未获确认/);
});

test('workspace controls retain pending feedback across host snapshots and accept settled readback', async t => {
  let resolve;
  const ui = harness(t, () => new Promise(done => {resolve = done;}));
  ui.render({reason: 'saved host state'});
  const pending = ui.click('select');
  assert.match(ui.fields.status.textContent, /等待本机宿主/);
  ui.render({displayName: 'new host name', nodeConfigured: true, reason: 'background host state'});
  assert.equal(ui.fields.name.textContent, '当前工作区：new host name', 'host fields still refresh while waiting');
  assert.match(ui.fields['node-status'].textContent, /Node：已选择/);
  assert.match(ui.fields.status.textContent, /等待本机宿主/);
  assert.equal(ui.fields.select.disabled, true);
  assert.equal(ui.fields.revoke.disabled, true);
  resolve({coding: {configured: true, displayName: 'confirmed workspace', reason: 'confirmed selection'}});
  await pending;
  assert.equal(ui.fields.status.textContent, 'confirmed selection');
  assert.equal(ui.fields.select.disabled, false);
  ui.render({reason: 'fresh host state'});
  assert.equal(ui.fields.status.textContent, 'fresh host state');
});

test('workspace controls preserve unconfirmed feedback until explicit successful retry', async t => {
  let resolve, reject;
  const ui = harness(t, () => new Promise((done, fail) => {resolve = done; reject = fail;}));
  ui.render();
  const failed = ui.click('select');
  reject(Error('synthetic private host detail'));
  await failed;
  const failure = ui.fields.status.textContent;
  assert.match(failure, /操作未完成/);
  ui.render({displayName: 'updated host', reason: 'background success claim'});
  assert.equal(ui.fields.name.textContent, '当前工作区：updated host');
  assert.equal(ui.fields.status.textContent, failure);
  assert.doesNotMatch(ui.fields.status.textContent, /private|background success/);
  assert.equal(ui.fields.select.disabled, false);
  const retry = ui.click('select');
  assert.match(ui.fields.status.textContent, /等待本机宿主/);
  resolve({coding: []});
  await retry;
  assert.match(ui.fields.status.textContent, /结果未获确认/);
  ui.render({reason: 'another background success claim'});
  assert.match(ui.fields.status.textContent, /结果未获确认/);
  const confirmed = ui.click('select');
  resolve({coding: {configured: true, displayName: 'confirmed', reason: 'confirmed retry'}});
  await confirmed;
  assert.equal(ui.fields.status.textContent, 'confirmed retry');
  ui.render({reason: 'fresh host after retry'});
  assert.equal(ui.fields.status.textContent, 'fresh host after retry');
});

test('permission drafts explain unchanged host authority without invoking until explicit readback', async t => {
  const calls = [];
  let resolve;
  const ui = harness(t, (action, input) => {
    calls.push({action, input}); return new Promise(done => {resolve = done;});
  });
  const current = {cloudExportAllowed: true, writeAllowed: true, writeAvailable: true,
    reason: '当前工作区已授权'};
  ui.render(current);
  ui.change('write', false);
  assert.match(ui.fields.status.textContent, /权限选择尚未生效/);
  assert.match(ui.fields.status.textContent, /当前工作区已授权/);
  assert.match(ui.fields.capabilities.textContent, /写入：可用/);
  assert.equal(calls.length, 0);
  ui.render(current);
  assert.equal(ui.fields.write.checked, false);
  assert.match(ui.fields.status.textContent, /权限选择尚未生效/);
  ui.change('cloud', false);
  assert.equal(ui.fields.authorize.disabled, true);
  assert.match(ui.fields.status.textContent, /撤销授权/);
  assert.equal(calls.length, 0);
  ui.change('cloud', true);
  const pending = ui.click('authorize');
  assert.match(ui.fields.status.textContent, /等待本机宿主/);
  assert.doesNotMatch(ui.fields.status.textContent, /尚未生效/);
  ui.render(current);
  assert.match(ui.fields.status.textContent, /等待本机宿主/);
  resolve({coding: []}); await pending;
  ui.change('command', true); ui.render(current);
  assert.match(ui.fields.status.textContent, /未获确认/);
  assert.doesNotMatch(ui.fields.status.textContent, /尚未生效/);
  const retry = ui.click('authorize');
  resolve({coding: {configured: true, displayName: 'project', authorizationAvailable: true,
    cloudExportAllowed: true, writeAllowed: false, commandAllowed: true, reason: '更新授权已确认'}});
  await retry;
  assert.equal(ui.fields.status.textContent, '更新授权已确认');
  assert.equal(ui.fields.write.checked, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].input.writeAllowed, false);
  ui.change('write', true);
  assert.match(ui.fields.status.textContent, /权限选择尚未生效/);
  assert.match(ui.fields.status.textContent, /更新授权已确认/);
  assert.equal(calls.length, 2);
});
