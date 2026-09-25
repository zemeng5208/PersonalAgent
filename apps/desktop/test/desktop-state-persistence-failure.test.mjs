import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DesktopState} from '../electron/desktop-state.js';

for (const action of ['update', 'remember']) {
  test(`${action} keeps memory and disk unchanged after persistence failure`, () => {
    const root = fileURLToPath(new URL('../.cache/', import.meta.url));
    mkdirSync(root, {recursive: true});
    const directory = mkdtempSync(path.join(root, 'desktop-state-failure-'));
    const file = path.join(directory, 'settings.json');
    try {
      const store = new DesktopState(file);
      store.update({theme: 'light', hover: true});
      store.remember('orb', {x: 10, y: 20, width: 112, height: 112});
      const before = structuredClone(store.value);
      const saved = readFileSync(file, 'utf8');
      const change = () => action === 'update'
        ? store.update({hover: false})
        : store.remember('orb', {x: 200, y: 300, width: 112, height: 112});

      mkdirSync(file + '.tmp');
      assert.throws(change, error => ['EISDIR', 'EPERM', 'EACCES'].includes(error?.code));
      assert.deepEqual(store.value, before);
      assert.equal(readFileSync(file, 'utf8'), saved);
      assert.deepEqual(new DesktopState(file).value, before);

      rmSync(file + '.tmp', {recursive: true, force: true});
      change();
      assert.deepEqual(new DesktopState(file).value, store.value);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
}

test('initial namespace is published only after persistence succeeds', () => {
  const root = fileURLToPath(new URL('../.cache/', import.meta.url));
  mkdirSync(root, {recursive: true});
  const directory = mkdtempSync(path.join(root, 'desktop-identity-failure-'));
  const file = path.join(directory, 'settings.json');
  try {
    const store = new DesktopState(file);
    const before = structuredClone(store.value);
    mkdirSync(file + '.tmp');
    assert.throws(() => store.ensureHostUserNamespace(), error => ['EISDIR', 'EPERM', 'EACCES'].includes(error?.code));
    assert.deepEqual(store.value, before);
    rmSync(file + '.tmp', {recursive: true, force: true});
    const namespace = store.ensureHostUserNamespace();
    assert.equal(new DesktopState(file).ensureHostUserNamespace(), namespace);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
