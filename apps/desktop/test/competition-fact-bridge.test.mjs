import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRuntimeApplication} from '@personal-agent/runtime/application';
import {createWorkspaceReadTool} from '@personal-agent/coding-tools';
import {createDesktopCompetitionToolCatalog} from '../electron/competition-tool-catalog.js';
import {createDesktopCompetitionFactBridge} from '../electron/competition-fact-bridge.js';

const cache = fileURLToPath(new URL('../.cache/', import.meta.url));
mkdirSync(cache, {recursive: true});

test('trusted Competition source correction survives Desktop restart without replaying writes', async () => {
  const directory = mkdtempSync(path.join(cache, 'fact-bridge-'));
  const runtimePath = path.join(directory, 'runtime.sqlite');
  const catalog = createDesktopCompetitionToolCatalog({
    rootPath: fileURLToPath(new URL('../fixtures/agentarts/', import.meta.url)),
    createWorkspaceReadTool,
  });
  const options = {catalog, runtimePath, userNamespace: 'desktop-test-user'};
  const run = async () => {
    const application = createRuntimeApplication({path: runtimePath, profile: 'huawei_ict_agentarts'});
    const bridge = createDesktopCompetitionFactBridge({...options, application});
    try { return await bridge.recover(); }
    finally { bridge.close(); application.close(); }
  };
  try {
    const first = await run();
    assert.equal(first.factRevision, 2);
    assert.ok(first.completedImpacts >= 1);
    const second = await run();
    assert.equal(second.factRevision, 2);
    assert.equal(second.completedImpacts, 0);
  } finally {
    catalog.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
