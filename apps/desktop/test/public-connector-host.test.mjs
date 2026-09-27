import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicConnectorHost} from '../electron/public-connector-host.js';
import {OpenMeteoProvider} from '@personal-agent/weather';
import {OpenAlexProvider} from '@personal-agent/research';

test('public providers assemble without calls and only publish bounded public result fields', async () => {
  let calls = 0;
  const fetchImpl = async () => {calls++; throw Error('Unexpected network call');};
  const host = createPublicConnectorHost({weatherProvider:new OpenMeteoProvider({fetchImpl}),
    researchProvider:new OpenAlexProvider({fetchImpl})});
  try {
    assert.deepEqual(host.tools.map(tool => tool.descriptor.name), ['weather.forecast','research.search']);
    assert.equal(calls, 0);
    const policy = host.competitionToolExports.find(item => item.toolName === 'research.search');
    const context = {signal:new AbortController().signal, result:{results:[{
      record:{contentRef:'Public paper | https://doi.org/example',source:'research',accountRef:'private-account'},
      publishedAt:'2026-09-27T00:00:00.000Z',publishedTimeKind:'date_only',freshness:'fresh',ageMs:0,
    }],cache:{state:'stale',fetchedAt:'2026-09-27T00:00:00.000Z',ageMs:5,ttlMs:1,
      lastError:{code:'EXTERNAL_FAILURE',message:'private error payload',retryable:true}}}};
    const result = await policy.project(context);
    assert.equal(result.results[0].citation, context.result.results[0].record.contentRef);
    assert.equal(result.cache.state, 'stale');
    assert.doesNotMatch(JSON.stringify(result), /private|accountRef|message/);
    host.close();
    assert.equal(policy.accepts({}), false);
    await assert.rejects(policy.project(context), /unavailable/);
  } finally {host.close();}
});
