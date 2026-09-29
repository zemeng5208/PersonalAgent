import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductToolsComposition} from '../electron/product-tools-composition.js';
import * as weather from '@personal-agent/weather';

const context = () => ({taskId: 'test', revision: 1, deadline: new Date(Date.now() + 60000).toISOString(),
  signal: new AbortController().signal});
const tool = name => ({descriptor: {name, version: '1.0.0', sideEffect: 'read'}, execute: async () => ({ok: true})});
test('actual public weather register and real provider construct without network calls', () => {
  const provider = new weather.OpenMeteoProvider();
  const composition = createProductToolsComposition({modules: {weather}, connectors: {
    weather: {enabled: true, options: {provider}, available: () => true},
  }});
  assert.equal(composition.tools[0].descriptor.name, 'weather.forecast');
  assert.equal(composition.tools[0].descriptor.sideEffect, 'read');
  assert.deepEqual(composition.tools[0].descriptor.requiredScopes, ['weather:read']);
  composition.close();
});
test('no implicit providers, workspace, write tools, or cloud exports', () => {
  const composition = createProductToolsComposition();
  assert.deepEqual(composition.tools, []);
  assert.deepEqual(composition.competitionToolExports, []);
  assert.ok(composition.unavailable.some(item => item.capability === 'workspace'));
  composition.close();
});
test('registered connector uses runtime tool and dynamic availability; mock is rejected', async () => {
  let online = true;
  let disposed = 0;
  const modules = {weather: {register(host) {
    const unregister = host.register(tool('weather.forecast'));
    return () => { disposed++; unregister(); };
  }}};
  const connectors = {weather: {enabled: true, options: {provider: {verification: 'mock'}}, available: () => online}};
  assert.equal(createProductToolsComposition({modules, connectors}).tools.length, 0);
  connectors.weather.options.provider.verification = 'conditional';
  const composition = createProductToolsComposition({modules, connectors});
  assert.equal(composition.tools.length, 1);
  assert.equal(await composition.competitionToolAvailability[0].available(context()), true);
  online = false;
  assert.equal(await composition.competitionToolAvailability[0].available(context()), false);
  assert.deepEqual(composition.competitionToolExports, []);
  composition.close(); composition.close();
  assert.equal(disposed, 1);
  assert.throws(() => composition.tools[0].execute({}, context()), /closed/);
});
test('workspace writes and command factories need explicit approval and trusted configuration', () => {
  const calls = [];
  const factory = name => options => { calls.push({name, options}); return tool(name); };
  const modules = {coding: {
    createWorkspaceReadTool: factory('workspace.read_text'),
    createWorkspaceListTool: factory('workspace.list_entries'),
    createWorkspacePatchPreviewTool: factory('workspace.preview_text_patch'),
    createWorkspacePatchStageTool: factory('workspace.stage_text_patch'),
    createWorkspacePatchApplyTool: factory('workspace.apply_text_patch'),
    createWorkspaceCommandTool: factory('workspace.run_allowed_command'),
  }};
  const workspace = {approved: true, options: {rootPath: 'approved'}, available: () => true};
  assert.equal(createProductToolsComposition({modules, workspace}).tools.length, 3);
  Object.assign(workspace, {writeApproved: true, commandApproved: true,
    apply: {recoveryRootPath: 'recovery', powerShellPath: 'powershell', recoveryAccessVerified: true, rootPath: 'wrong'},
    command: {recipes: [{id: 'test', executable: 'trusted', args: []}], rootPath: 'wrong'}});
  const composition = createProductToolsComposition({modules, workspace});
  assert.equal(composition.tools.length, 6);
  assert.ok(calls.every(call => call.options.rootPath === 'approved'));
  composition.close();
});
test('invalid export fails and disposes setup; export stops after close', async () => {
  let disposed = 0;
  const modules = {weather: {register(host) { host.register(tool('weather.forecast')); return () => disposed++; }}};
  const connectors = {weather: {enabled: true, options: {provider: {verification: 'conditional'}}, available: () => true}};
  assert.throws(() => createProductToolsComposition({modules, connectors, exports: [{}]}), /export policy/);
  assert.equal(disposed, 1);
  const policy = {toolName: 'weather.forecast', toolVersion: '1.0.0', exportPolicyVersion: 'approved-v1',
    accepts: () => true, project: async () => ({summary: 'public'})};
  const composition = createProductToolsComposition({modules, connectors, exports: [policy]});
  assert.deepEqual(await composition.competitionToolExports[0].project(context()), {summary: 'public'});
  composition.close();
  assert.equal(composition.competitionToolExports[0].accepts({}), false);
  await assert.rejects(composition.competitionToolExports[0].project(context()), /unavailable/);
});
