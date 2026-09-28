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

      // An owned directory at the staging filename makes the write fail on
      // Windows and Unix without changing permissions or the saved file.
      mkdirSync(file + '.tmp');
      assert.throws(change, error => ['EISDIR', 'EPERM', 'EACCES'].includes(error?.code));
      assert.deepEqual(store.value, before);
      assert.equal(readFileSync(file, 'utf8'), saved);
      assert.deepEqual(new DesktopState(file).value, before);

      // Once the obstruction is removed, the same operation can persist.
      rmSync(file + '.tmp', {recursive: true, force: true});
      change();
      assert.deepEqual(new DesktopState(file).value, store.value);
      if (action === 'update') assert.equal(store.value.settings.hover, false);
      else assert.deepEqual(store.value.windows.orb, {x: 200, y: 300, width: 112, height: 112});
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
}
