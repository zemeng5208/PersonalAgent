import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {test} from 'node:test';
import {Client} from '@personal-agent/client';
import {createAgentArtsRuntimeApplication} from '@personal-agent/runtime/application';
import {createRuntimeClientTranscriptConsumer} from '@personal-agent/voice';

test('explicit transcript waits for Competition task completion through public Client', async () => {
  const base = new URL('../../.cache/voice-runtime-integration/', import.meta.url);
  await mkdir(base, {recursive: true});
  const directory = await mkdtemp(new URL('case-', base));
  const calls = [];
  const app = createAgentArtsRuntimeApplication({
    path: directory + '/runtime.sqlite',
    gatewayUrl: 'https://agentarts.example.test',
    runtimeName: 'synthetic-voice',
    invokeMode: 'published',
    authorizationProvider: {read: async () => 'Bearer synthetic-only'},
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({event: 'message', data: {
        text: 'Synthetic voice task completed', index: 0,
      }}), {status: 200, headers: {'content-type': 'application/json'}});
    },
  });
  try {
    const client = new Client(app);
    await client.connect();
    const consumer = createRuntimeClientTranscriptConsumer({
      client, conversationId: 'synthetic-voice', pollIntervalMs: 5,
    });
    assert.equal(calls.length, 0);
    const operation = consumer.consume({
      sessionId: 'synthetic-session', transcriptId: 'synthetic-transcript',
      text: 'Analyze synthetic data only', locale: 'en-US',
      deadline: new Date(Date.now() + 5000).toISOString(),
      signal: new AbortController().signal,
    });
    const reply = await operation.result;
    assert.match(reply.replyText, /Synthetic voice task completed/);
    assert.match(reply.replyText, /profile=huawei_ict_agentarts; verification=unverified/);
    assert.equal(reply.locale, 'en-US');
    assert.deepEqual(calls, [{query: 'Analyze synthetic data only'}]);
    const completed = app.readEvents().filter(event => event.type === 'task.completed');
    assert.equal(completed.length, 1);
    assert.equal(app.readEvents().some(event => event.type === 'task.failed'), false);
    await operation.stop('cancelled');
    assert.equal(calls.length, 1);
  } finally {
    app.close();
    await rm(directory, {recursive: true, force: true});
  }
});
