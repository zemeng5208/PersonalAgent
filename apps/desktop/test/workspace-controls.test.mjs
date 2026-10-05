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
