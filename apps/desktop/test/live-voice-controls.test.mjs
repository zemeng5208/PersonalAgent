import test from 'node:test';
import assert from 'node:assert/strict';
import {mountLiveVoiceControls} from '../src/app/live-voice-controls.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

function fixture(t, invoke) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document;});
  const fields = Object.fromEntries(['live-key', 'live-workspace', 'live-hotkey', 'live-consent', 'live-save', 'live-config-result', 'summary']
    .map(name => [name, {value: '', checked: false, textContent: ''}]));
  fields['live-hotkey'].options = Array.from({length: 12}, (_, i) => ({value: `F${i + 1}`}));
  const listeners = new Map();
  const settings = {open: false, querySelector: selector => fields[selector.replace(/^#/, '')],
    addEventListener: (type, listener) => listeners.set(type, listener)};
  const status = {setAttribute() {}};
  let created = 0;
  globalThis.document = {createElement: () => created++ ? status : settings};
  const controls = mountLiveVoiceControls({querySelector: () => ({before() {}})}, invoke);
  return {fields, settings, status, controls, edit(name, value) {
    fields[name].value = value; listeners.get('input')();
  }, save: () => fields['live-save'].onclick()};
}

test('edits made during a pending save survive success and later host refresh', async t => {
  const pending = deferred(), calls = [];
  const f = fixture(t, (name, payload) => {calls.push({name, payload}); return pending.promise;});
  f.controls.render({workspaceId: 'before', hotkey: 'F8'});
  f.edit('live-workspace', 'submitted'); f.edit('live-key', 'synthetic-first-key');
  f.fields['live-consent'].checked = true; f.settings.open = true;
  const saving = f.save();
  assert.equal(f.fields['live-key'].value, '');
  f.edit('live-workspace', 'next-draft'); f.edit('live-key', 'synthetic-next-key');
  f.edit('live-hotkey', 'F6');
  pending.resolve(); await saving;
  f.controls.render({configured: true, workspaceId: 'submitted', hotkey: 'F8'});
  assert.equal(f.fields['live-workspace'].value, 'next-draft');
  assert.equal(f.fields['live-hotkey'].value, 'F6');
  assert.equal(f.fields['live-key'].value, 'synthetic-next-key');
  assert.equal(f.settings.open, true);
  assert.match(f.fields['live-config-result'].textContent, /新修改尚未保存/);
  assert.equal(calls[0].payload.apiKey, '', 'submitted credential is released when the request settles');
});

test('settled save with no later edits accepts host refresh and closes settings', async t => {
  const f = fixture(t, async () => {});
  f.edit('live-workspace', 'submitted'); f.settings.open = true;
  await f.save();
  f.controls.render({configured: true, workspaceId: 'host-readback', hotkey: 'F7'});
  assert.equal(f.fields['live-workspace'].value, 'host-readback');
  assert.equal(f.settings.open, false);
  assert.equal(f.fields['live-save'].disabled, false);
});

test('pending saves cannot be duplicated and retain their editing fields during refresh', async t => {
  const pending = deferred(); let calls = 0;
  const f = fixture(t, () => {calls++; return pending.promise;});
  f.controls.render({workspaceId: 'initial', hotkey: 'F8'});
  const saving = f.save(), repeated = f.save();
  f.controls.render({workspaceId: 'stale-readback', hotkey: 'F5'});
  assert.equal(calls, 1);
  assert.equal(f.fields['live-workspace'].value, 'initial');
  pending.resolve(); await Promise.all([saving, repeated]);
});

test('save failure keeps new edits and restores the save button without automatic retry', async t => {
  const pending = deferred(); let calls = 0;
  const f = fixture(t, () => {calls++; return pending.promise;});
  f.edit('live-workspace', 'submitted');
  const saving = f.save(); f.edit('live-workspace', 'retry-draft');
  pending.reject(Error('synthetic configuration error')); await saving;
  f.controls.render({workspaceId: 'old-host-value'});
  assert.equal(f.fields['live-workspace'].value, 'retry-draft');
  assert.equal(f.fields['live-save'].disabled, false);
  assert.equal(calls, 1);
});

test('concurrent toggle clicks submit one action and settle cleanly after failure', async t => {
  const pending = deferred(); let calls = 0;
  const f = fixture(t, () => {calls++; return calls === 1 ? pending.promise : Promise.resolve();});
  const toggling = f.controls.toggle(), repeated = f.controls.toggle();
  assert.equal(calls, 1);
  pending.reject(Error('synthetic connection error')); await Promise.all([toggling, repeated]);
  assert.equal(f.settings.open, true);
  assert.match(f.fields['live-config-result'].textContent, /synthetic connection error/);
  await f.controls.toggle(); assert.equal(calls, 2);
});
