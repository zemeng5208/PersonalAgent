import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {createDesktopVoiceInput} from '../electron/voice-input.js';
import {createVoicePcmFrameSourcePort} from '@personal-agent/voice';

const sourceText = await readFile(new URL('../electron/main.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.js', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
let transcriptCallback;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onTranscript') transcriptCallback = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(declaration('initializeSisVoice'));
assert.ok(transcriptCallback);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return {promise, resolve};
};

function fixture({stopFails = false} = {}) {
  const recognition = deferred(), entered = deferred();
  let visible = true, sink, recognitionRequest, recognitionStops = 0, revokes = 0;
  const drafts = [], calls = [];
  const contents = {id: 42, isDestroyed: () => false, send: (channel, payload) => drafts.push({channel, ...payload})};
  const panel = {isVisible: () => visible, isDestroyed: () => false, webContents: contents};
  const context = {panel, wakeQuitUnknown: false, wakeVoice: undefined, Promise, Error,
    publish: () => calls.push('publish'),
    liveVoice: {stop: async () => calls.push('live-stop')},
    sisPlaybackHost: {stop: async () => calls.push('playback-stop')},
    microphoneCaptureHost: {revoke: async () => { calls.push('panel-revoke'); revokes++; }},
  };
  vm.createContext(context);
  vm.runInContext(declaration('stopWakeVoice').getText(ast) + '\n' + declaration('stopPanelVoice').getText(ast), context);
  const deliver = vm.runInContext('(' + transcriptCallback + ')', context);
  const source = createVoicePcmFrameSourcePort({async start(value) { sink = value; return {async release() {}}; }});
  const input = createDesktopVoiceInput({source,
    microphoneHost: {authorize() {}, snapshot: () => ({subscriberCount: 0}), revoke: async () => { revokes++; }},
    client: {call() { assert.fail('panel voice lifecycle cannot submit or cancel a Runtime task'); }},
    enabled: true, inputMode: 'dictation', onTranscript: deliver,
    speechPorts: {recognition: {recognize(value) {
      recognitionRequest = value; entered.resolve();
      return {result: recognition.promise, async stop() {
        recognitionStops++; calls.push('recognition-stop');
        if (stopFails) throw Error('synthetic private ASR release failure');
      }};
    }}, output: {speak() { assert.fail('dictation does not speak'); }}, dispose: async () => {}},
  });
  context.voiceInput = input;
  return {input, recognition, entered, drafts, calls, context,
    setVisible(value) { visible = value; },
    async begin() { await input.beginCapture(42); sink.onFrame(new Uint8Array(3200)); },
    stopPanel: () => context.stopPanelVoice(),
    get request() { return recognitionRequest; }, get stops() { return recognitionStops; }, get revokes() { return revokes; },
  };
}

test('normal visible manual SIS dictation still fills a draft without task submission or cancellation', async () => {
  const f = fixture();
  await f.begin();
  const finishing = f.input.finishCapture(42);
  await f.entered.promise;
  f.recognition.resolve({text: '正常听写草稿', locale: 'zh-CN'});
  const result = await finishing;
  assert.equal(result.text, '正常听写草稿');
  assert.equal(f.drafts.length, 1);
  assert.equal(f.drafts[0].channel, 'desktop:dictation-result');
  assert.equal(f.drafts[0].text, '正常听写草稿');
  await f.stopPanel();
  assert.equal(f.input.hasActive(), false);
  await f.input.dispose();
});

test('hiding during manual SIS recognition cancels ASR and reopening cannot receive the late draft', async () => {
  const f = fixture();
  await f.begin();
  const finishing = f.input.finishCapture(42);
  const rejected = assert.rejects(finishing);
  await f.entered.promise;
  f.setVisible(false);
  await f.stopPanel();
  const afterHide = {aborted: f.request.signal.aborted, stops: f.stops, active: f.input.hasActive()};
  f.setVisible(true);
  f.recognition.resolve({text: '旧录音迟到草稿', locale: 'zh-CN'});
  await rejected;
  assert.deepEqual(afterHide, {aborted: true, stops: 1, active: false});
  assert.equal(f.drafts.length, 0);
  assert.ok(f.calls.includes('live-stop') && f.calls.includes('playback-stop') && f.calls.includes('panel-revoke'));
  await f.input.dispose();
});

test('hiding while still recording cancels the manual capture without attempting ASR', async () => {
  const f = fixture();
  await f.begin();
  f.setVisible(false);
  await f.stopPanel();
  assert.equal(f.input.hasActive(), false);
  assert.equal(f.request, undefined);
  assert.equal(f.drafts.length, 0);
  await f.input.dispose();
});

test('ASR release failure remains a failed panel stop while Live, playback and microphone cleanup still run', async () => {
  const f = fixture({stopFails: true});
  await f.begin();
  const finishing = f.input.finishCapture(42);
  const rejected = assert.rejects(finishing, /释放未确认|取消/);
  await f.entered.promise;
  f.setVisible(false);
  const stopping = f.stopPanel();
  const stopRejected = assert.rejects(stopping, /释放未确认/);
  // A noncooperative result settles late; the real Manager cancellation still owns it.
  f.recognition.resolve({text: '失败释放后的旧草稿', locale: 'zh-CN'});
  await stopRejected;
  await rejected;
  assert.equal(f.request.signal.aborted, true);
  assert.equal(f.stops, 1);
  assert.equal(f.drafts.length, 0);
  assert.ok(f.calls.includes('live-stop') && f.calls.includes('playback-stop') && f.calls.includes('panel-revoke'));
  await f.input.dispose();
});
