import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDesktopCompetitionToolCatalog} from '../electron/competition-tool-catalog.js';

const source = fileURLToPath(new URL('../fixtures/agentarts/meeting-update.json', import.meta.url));
const content = readFileSync(source, 'utf8');
const canonicalContent = content.replace(/\r\n/g, '\n');
const baseline = readFileSync(fileURLToPath(new URL('../fixtures/agentarts/meeting-baseline.json', import.meta.url)), 'utf8');
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
    writeFileSync(path.join(rootPath, 'meeting-baseline.json'), baseline);
    const catalog = createDesktopCompetitionToolCatalog({rootPath, createWorkspaceReadTool});
    const signal = new AbortController().signal;
    const selection = {taskId: 'task-1', revision: 1, deadline: new Date(Date.now() + 60_000).toISOString(), signal};
    assert.equal(catalog.tool.options.maxReadBytes, 4096);
    assert.equal(await catalog.availability.available(selection), true);
    const source = await catalog.readSyntheticMeetingSource();
    assert.deepEqual(source.meeting, {meetingId: 'mvp-meeting', revision: 2,
      start: '17:00', timezone: 'Asia/Shanghai'});
    assert.equal(source.sourceRevision, createHash('sha256').update(canonicalContent).digest('hex'));
    const initial = await catalog.readSyntheticMeetingBaseline();
    assert.deepEqual(initial.meeting, {meetingId: 'mvp-meeting', revision: 1,
      start: '15:00', timezone: 'Asia/Shanghai'});
    assert.equal(catalog.export.accepts({arguments: {path: 'meeting-update.json'}}), true);
    for (const args of [{path: '../private.json'}, {path: 'meeting-update.json', maxBytes: 4096}, {}]) {
      assert.equal(catalog.export.accepts({arguments: args}), false);
    }
    const result = {path: 'meeting-update.json', encoding: 'utf-8', byteLength: Buffer.byteLength(content), content};
    assert.deepEqual(await catalog.export.project({result, signal}), {content: canonicalContent});
    await assert.rejects(catalog.export.project({result: {...result, content: 'private'}, signal}), /unavailable/);
    const alternate = content === canonicalContent ? canonicalContent.replace(/\n/g, '\r\n') : canonicalContent;
    writeFileSync(path.join(rootPath, 'meeting-update.json'), alternate);
    assert.equal(await catalog.availability.available(selection), true);
    assert.deepEqual(await catalog.readSyntheticMeetingSource(), source);
    assert.deepEqual(await catalog.export.project({result: {...result, content: alternate,
      byteLength: Buffer.byteLength(alternate)}, signal}), {content: canonicalContent});
    writeFileSync(path.join(rootPath, 'meeting-update.json'), 'changed');
    assert.equal(await catalog.availability.available(selection), false);
    await assert.rejects(catalog.readSyntheticMeetingSource(), /unavailable/);
    writeFileSync(path.join(rootPath, 'meeting-baseline.json'), 'changed');
    await assert.rejects(catalog.readSyntheticMeetingBaseline(), /unavailable/);
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
