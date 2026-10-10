import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('production startup without model configuration fails closed and never falls back to Fake',()=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PA_AGENT_')));
  env.PA_AGENT_HOST_MODE='agentarts';
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/main.mjs',import.meta.url))],{env,encoding:'utf8',timeout:15000});
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.equal(result.stderr,'Agent runtime startup failed: check trusted mode, model and credential configuration.\n');
});
