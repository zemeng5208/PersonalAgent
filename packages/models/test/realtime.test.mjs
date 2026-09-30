import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {QwenRealtimeModelGateway} from '../dist/realtime.js';

class Socket extends EventEmitter {
  static current;
  readyState = 0; bufferedAmount = 0; sent = [];
  constructor(url, options) {super(); Socket.current = this; this.url = url; this.options = options;
    queueMicrotask(() => {this.readyState = 1; this.emit('open');});}
  send(value) {const data = JSON.parse(value); this.sent.push(data);
    if (data.type === 'session.update') queueMicrotask(() => this.receive({type:'session.updated'}));}
  receive(value) {this.emit('message', Buffer.from(JSON.stringify(value)));}
  close() {this.readyState = 3; queueMicrotask(() => this.emit('close'));}
  terminate() {this.close();}
}
async function connected(onTool = async () => 'ok') {
  const controller = new AbortController(), events = [];
  const gateway = new QwenRealtimeModelGateway({workspaceId:'test-space',apiKey:'not-a-real-key'}, Socket);
  const session = await gateway.connect({signal:controller.signal,deadline:new Date(Date.now()+30000).toISOString(),
    instructions:'PersonalAgent',tools:[{name:'request_work',description:'work',parameters:{type:'object'}}],
    onEvent:event=>events.push(event),onTool});
  return {session,socket:Socket.current,events,controller};
}

test('native PCM uses the fixed endpoint and interruption drops stale response audio', async () => {
  const f = await connected();
  assert.equal(new URL(f.socket.url).hostname, 'test-space.cn-beijing.maas.aliyuncs.com');
  assert.equal(f.socket.url.includes('not-a-real-key'),false);
  assert.equal(f.socket.options.followRedirects,false);
  assert.deepEqual(f.socket.sent[0].session.modalities,['text','audio']);
  f.session.sendAudio(Uint8Array.of(0,1));
  assert.equal(f.socket.sent.at(-1).type,'input_audio_buffer.append');
  f.socket.receive({type:'response.created',response:{id:'r1'}});
  f.socket.receive({type:'response.audio.delta',response_id:'r1',delta:'AAE='});
  f.socket.receive({type:'input_audio_buffer.speech_started'});
  f.socket.receive({type:'response.audio.delta',response_id:'r1',delta:'AAE='});
  assert.equal(f.events.filter(e=>e.type==='audio').length,1);
  assert.equal(f.events.at(-1).type,'interrupted');
  await f.session.close();
});

test('a repeated tool call does not execute twice and cancellation suppresses its late reply', async () => {
  let count = 0, resolve;
  const f = await connected(() => {count++; return new Promise(yes=>{resolve=yes;});});
  const call={type:'response.function_call_arguments.done',call_id:'call_1',name:'request_work',arguments:'{"goal":"hello"}'};
  f.socket.receive(call); f.socket.receive(call);
  await new Promise(setImmediate);
  assert.equal(count,1);
  f.controller.abort();
  resolve('finished');
  await new Promise(setImmediate);
  assert.equal(f.socket.sent.some(e=>e.type==='conversation.item.create'),false);
  await f.session.close();
});

test('unregistered cloud tools close the session without execution or raw error exposure', async () => {
  let called=false;
  const f=await connected(async()=>{called=true;return 'ok';});
  f.socket.receive({type:'response.function_call_arguments.done',call_id:'x',name:'shell',arguments:'{}'});
  await new Promise(setImmediate);
  assert.equal(called,false);
  assert.equal(f.events.at(-1).type,'error');
  assert.equal(f.socket.readyState,3);
});
