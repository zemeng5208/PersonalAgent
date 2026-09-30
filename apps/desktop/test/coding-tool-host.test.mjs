import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createDesktopCodingToolHost, listPendingCodingHelpers} from '../electron/coding-tool-host.js';

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'desktop-coding-host-'));
  const workspaceRoot = path.join(base, 'workspace');
  const recoveryRootPath = path.join(base, 'recovery');
  mkdirSync(workspaceRoot);
  mkdirSync(recoveryRootPath);
  const powerShellPath = path.join(base, 'pwsh.exe');
  writeFileSync(powerShellPath, 'test fixture');
  t.after(() => rmSync(base, {recursive: true, force: true}));
  return {base, workspaceRoot, recoveryRootPath, powerShellPath};
}

const fakeFactory = options => ({descriptor: {name: 'workspace.apply_text_patch',
  version: '1.0.0', sideEffect: 'local_write'}, options,
execute: () => 'delegated'});
const options = value => ({...value, authorizedWorkspaceRoot: value.workspaceRoot,
  createWorkspacePatchApplyTool: fakeFactory, inspectAcl: () => {}});

test('host fixes all patch paths and closes availability', {skip: process.platform !== 'win32'}, t => {
  const paths = fixture(t);
  const host = createDesktopCodingToolHost(options(paths));
  assert.equal(host.tools.length, 1);
  assert.equal(host.tools[0].execute(), 'delegated');
  assert.equal(host.available(), true);
  host.close();
  assert.equal(host.available(), false);
  assert.throws(() => host.tools[0].execute(), /closed/);
});

test('host rejects workspace changes, nested recovery roots and unresolved helpers', {skip: process.platform !== 'win32'}, t => {
  const paths = fixture(t);
  const host = createDesktopCodingToolHost(options(paths));
  const other = path.join(paths.base, 'other');
  mkdirSync(other);
  assert.throws(() => createDesktopCodingToolHost({...options(paths), authorizedWorkspaceRoot: other}),
    /fixed Desktop authorization/);
  const nested = path.join(paths.workspaceRoot, 'recovery');
  mkdirSync(nested);
  assert.throws(() => createDesktopCodingToolHost({...options(paths), recoveryRootPath: nested}),
    /separate/);
  writeFileSync(path.join(paths.recoveryRootPath, 'unknown.inflight'), 'unresolved');
  assert.deepEqual(listPendingCodingHelpers(paths.recoveryRootPath), ['unknown.inflight']);
  assert.equal(host.available(), false);
  assert.throws(() => host.tools[0].execute(), /reconciliation/);
  assert.throws(() => createDesktopCodingToolHost(options(paths)), /reconciliation/);
});

test('host refuses an unverified ACL and unexpected public tool', {skip: process.platform !== 'win32'}, t => {
  const paths = fixture(t);
  assert.throws(() => createDesktopCodingToolHost({...options(paths), inspectAcl: () => {throw Error('unsafe');}}),
    /unsafe/);
  assert.throws(() => createDesktopCodingToolHost({...options(paths),
    createWorkspacePatchApplyTool: () => ({descriptor: {name: 'other'}})}),
  /Unexpected coding patch tool/);
});

test('ACL drift and replacement of pinned recovery or PowerShell paths stop invocation',
  {skip: process.platform !== 'win32'}, t => {
    const paths = fixture(t);
    let aclSecure = true;
    const host = createDesktopCodingToolHost({...options(paths),
      inspectAcl: () => { if (!aclSecure) throw Error('ACL changed'); }});
    aclSecure = false;
    assert.equal(host.available(), false);
    assert.throws(() => host.tools[0].execute(), /reconciliation/);
    aclSecure = true;
    renameSync(paths.recoveryRootPath, `${paths.recoveryRootPath}-old`);
    mkdirSync(paths.recoveryRootPath);
    assert.equal(host.available(), false);

    const next = fixture(t);
    const second = createDesktopCodingToolHost(options(next));
    renameSync(next.powerShellPath, `${next.powerShellPath}.old`);
    writeFileSync(next.powerShellPath, 'replacement');
    assert.equal(second.available(), false);
    assert.throws(() => second.tools[0].execute(), /reconciliation/);

    const thirdPaths = fixture(t);
    const third = createDesktopCodingToolHost(options(thirdPaths));
    renameSync(thirdPaths.workspaceRoot, `${thirdPaths.workspaceRoot}-old`);
    mkdirSync(thirdPaths.workspaceRoot);
    assert.equal(third.available(), false);
  });
