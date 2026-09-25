import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDesktopCompetitionToolCatalog} from '../electron/competition-tool-catalog.js';

const source = fileURLToPath(new URL('../fixtures/agentarts/meeting-update.json', import.meta.url));
const content = readFileSync(source, 'utf8');
const cache = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(cache, {recursive: true});
const createWorkspaceReadTool = options => ({
  descriptor: {name: 'workspace.read_text', version: '1.0.0', sideEffect: 'read'},
  options,
});

test('Competition catalog selects only the readable fixed synthetic fixture and projects bounded content', async () => {
  const rootPath = mkdtempSync(path.join(cache, 'catalog-'));
  try {
    writeFileSync(path.join(rootPath, 'meeting-update.json'), content);
    const catalog = createDesktopCompetitionToolCatalog({rootPath, createWorkspaceReadTool});
    const signal = new AbortController().signal;
    const selection = {taskId: 'task-1', revision: 1, deadline: new Date(Date.now() + 60_000).toISOString(), signal};
    assert.equal(catalog.tool.options.maxReadBytes, 4096);
    assert.equal(await catalog.availability.available(selection), true);
    assert.equal(catalog.export.accepts({arguments: {path: 'meeting-update.json'}}), true);
    for (const args of [{path: '../private.json'}, {path: 'meeting-update.json', maxBytes: 4096}, {}]) {
      assert.equal(catalog.export.accepts({arguments: args}), false);
    }
    const result = {path: 'meeting-update.json', encoding: 'utf-8', byteLength: Buffer.byteLength(content), content};
    assert.deepEqual(await catalog.export.project({result, signal}), {content});
    await assert.rejects(catalog.export.project({result: {...result, content: 'private'}, signal}), /unavailable/);
    writeFileSync(path.join(rootPath, 'meeting-update.json'), 'changed');
    assert.equal(await catalog.availability.available(selection), false);
    await assert.rejects(catalog.export.project({result, signal}), /unavailable/);
    catalog.close();
    assert.equal(catalog.export.accepts({arguments: {path: 'meeting-update.json'}}), false);
  } finally { rmSync(rootPath, {recursive: true, force: true}); }
});

test('Competition catalog rejects cancelled, expired, and invalid task selection', async () => {
  const rootPath = mkdtempSync(path.join(cache, 'catalog-'));
  try {
    writeFileSync(path.join(rootPath, 'meeting-update.json'), content);
    const catalog = createDesktopCompetitionToolCatalog({rootPath, createWorkspaceReadTool});
    const controller = new AbortController();
    controller.abort();
    const selection = {taskId: 'task-1', revision: 1, deadline: new Date(Date.now() + 60_000).toISOString(), signal: controller.signal};
    assert.equal(await catalog.availability.available(selection), false);
    assert.equal(await catalog.availability.available({...selection, signal: new AbortController().signal, revision: 0}), false);
    assert.equal(await catalog.availability.available({...selection, signal: new AbortController().signal, deadline: new Date(0).toISOString()}), false);
  } finally { rmSync(rootPath, {recursive: true, force: true}); }
});
