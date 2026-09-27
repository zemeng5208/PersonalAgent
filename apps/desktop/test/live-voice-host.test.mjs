import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveVoiceHost} from '../electron/live-voice-host.js';

test('Live work shares desktop-panel and stopping audio never cancels an accepted Runtime task', async () => {
  let host, request, frameOptions, consumed, submitted, revoked=false, closed=false;
  const calls=[];
  const contents={id:7,mainFrame:{},isDestroyed:()=>false,send(_channel,message) {
    if (['start','stop'].includes(message.type)) queueMicrotask(()=>host.receive(
      {sender:contents,senderFrame:contents.mainFrame},{token:message.token,type:message.type==='start'?'ready':'stopped'}));
  }};
  const panel={webContents:contents,isDestroyed:()=>false,isVisible:()=>true};
  const source={subscribe(options) {frameOptions=options;return {ready:Promise.resolve(),closed:Promise.resolve(),unsubscribe(){}};},dispose:async()=>{}};
  host=createLiveVoiceHost({getPanel:()=>panel,config:{snapshot:()=>({configured:true}),current:()=>({})},
    microphoneHost:{authorize(){},revoke:async()=>{revoked=true;}},createSource:()=>source,
    createGateway:()=>({async connect(value) {request=value;return {sendAudio(){},interrupt(){},close:async()=>{closed=true;}};}}),
    client:{async call(op) {calls.push(op);return {taskId:'task-live'};}},readContext:()=>'{"tasks":[]}',
    onTaskSubmitted:value=>{submitted=value;},createConsumer:options=>{
      assert.equal(options.conversationId,'desktop-panel');
      return {consume(value) {consumed=value;return {result:options.client.call('task.submit',{goal:value.text}).then(()=>({replyText:'真实任务结果'})),stop:async()=>{}};}};
    },
  });
  await host.start();
  assert.equal(host.snapshot().status,'listening');
  assert.equal(await request.onTool('request_work',{goal:'合成任务'},'call_1'),'真实任务结果');
  assert.deepEqual(submitted,{taskId:'task-live',goal:'合成任务'});
  assert.equal(consumed.text,'合成任务');
  assert.ok(frameOptions.signal);
  await host.stop();
  assert.equal(consumed.signal.aborted,true);
  assert.equal(revoked,true);assert.equal(closed,true);
  assert.deepEqual(calls,['task.submit']);
  assert.equal(host.hasActive(),false);
});

test('normal turns remain listening, transcripts persist, lease renews and explicit stop prevents restart', async () => {
  let host, clock = Date.now(), request, renewal, leasedDeadline, connections = 0, token;
  const saved = [], schedules = new Set();
  const contents = {mainFrame:{},isDestroyed:()=>false,send(_channel,message) {
    token = message.token;
    if (['start','stop'].includes(message.type)) queueMicrotask(()=>host.receive(
      {sender:contents,senderFrame:contents.mainFrame},{token:message.token,type:message.type==='start'?'ready':'stopped'}));
  }};
  host = createLiveVoiceHost({getPanel:()=>({webContents:contents,isDestroyed:()=>false,isVisible:()=>true}),
    config:{snapshot:()=>({configured:true}),current:()=>({})},now:()=>clock,
    schedule(callback,ms) {renewal=callback;schedules.add(callback);return callback;},unschedule:handle=>schedules.delete(handle),
    microphoneHost:{authorize({deadline}) {leasedDeadline=deadline;},revoke:async()=>{}},
    createSource:()=>({subscribe:()=>({ready:Promise.resolve(),closed:Promise.resolve(),unsubscribe(){}}),dispose:async()=>{}}),
    createGateway:()=>({async connect(value) {request=value;connections++;return {sendAudio(){},interrupt(){},close:async()=>{}};}}),
    createConsumer:()=>({}),client:{},readContext:()=>'',onTaskSubmitted(){},onTranscript:message=>saved.push(message),
  });
  await host.start();
  assert.equal(Date.parse(leasedDeadline)-clock,120*60_000);
  for (let i=0;i<3;i++) {
    request.onEvent({type:'transcript',id:`u${i}`,role:'user',text:`第${i}轮`});
    request.onEvent({type:'audio',data:Uint8Array.of(0,0),responseId:`r${i}`});
    request.onEvent({type:'transcript',id:`a${i}`,role:'assistant',text:'继续听你说'});
    request.onEvent({type:'turn_complete'});
    host.receive({sender:contents,senderFrame:contents.mainFrame},{token,type:'drained'});
    assert.equal(host.snapshot().status,'listening');
    assert.equal(host.hasActive(),true);
  }
  assert.equal(saved.length,6);
  clock+=119*60_000;
  renewal();
  await new Promise(setImmediate);
  assert.equal(connections,2);
  assert.equal(host.snapshot().status,'listening');
  assert.ok(request.instructions.includes('第2轮'));
  const staleRenewal=renewal;
  await host.stop();
  staleRenewal();
  await new Promise(setImmediate);
  assert.equal(connections,2);
  assert.equal(host.snapshot().active,false);
  assert.equal(schedules.size,0);
});
