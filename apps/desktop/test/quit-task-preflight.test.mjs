import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const main = readFileSync(process.env.QUIT_PREFLIGHT_MAIN_SOURCE || new URL('../electron/main.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let callback;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'app.on'
    && node.arguments[0]?.getText(ast) === "'before-quit'") callback = node.arguments[1].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
const declaration = name => ast.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === name).getText(ast);
const tick = () => new Promise(resolve => setImmediate(resolve));

// Verbatim main callbacks; explicit Fake app, Runtime count and resource ports.
function fixture({count = 0, startup = 'ready', voiceFailure = false, liveUnknown = false} = {}) {
  const calls = [];
  let exited = false, voiceUnavailable = false, wakeUnavailable = false, context, beforeQuit;
  const voiceInput = {hasActive: () => false, async beginCapture() {
    if (voiceUnavailable) throw Error('disposed voice'); return {status: 'listening'};
  }, async dispose() {calls.push('voice-dispose');voiceUnavailable = true;
    if (voiceFailure) throw Error('unknown voice release');}};
  const wakeVoice = {hasActive: () => false, async enable() {
    if (wakeUnavailable) throw Error('disposed wake');return {phase: 'listening'};
  }, async dispose() {calls.push('wake-dispose');wakeUnavailable = true;}};
  const app = {isQuitting: false, quit() {
    calls.push('app-quit');const event = {prevented: false, preventDefault() {this.prevented = true;}};
    beforeQuit(event);if (!event.prevented) exited = true;
  }};
  const optional = ['referenceHost','proactiveHost','todoHost','notepadHost','mailHost','localLaya','mailConfig',
    'p5DeviceNotificationHost','p5Cognition','p5SystemObservationSource','knowledgeWatchHost','modelApiHost',
    'privateConsumption','privateMemory','learningStore','knowledgeSourceConfig','goalCloudHost','calendarMeetingHost',
    'mailAnalysisHost','competitionFactBridge','runtime','competitionCatalog','productTools','codingWorkspace',
    'publicReferenceConsent','feedsHost','syntheticRepairHost','microphonePermissionGate','runtimeConnection','tray'];
  context = vm.createContext({...Object.fromEntries(optional.map(key => [key, undefined])),
    Promise, Error, setTimeout, clearTimeout, clearInterval, console, app, voiceInput, wakeVoice,
    runtimeStartup: {snapshot: () => ({state: startup})}, runtimeApplication: {activeTaskCount: count,
      close() {calls.push('runtime-close');}}, runtimeError: '', runtimeClosed: false,
    wakeQuitHandled: false, wakeQuitUnknown: false, wakeDisposal: undefined,
    voiceDisposed: false, voiceDisposal: undefined, voiceDisposalFailed: false,
    microphoneCaptureHost: {snapshot: () => ({busy: false})},
    liveVoice: liveUnknown ? {hasActive: () => true, async stop() {
      calls.push('live-stop');return {active: true, reason: 'Live 音频资源释放未确认'};
    }} : undefined,
    localServicesStopped: false, localServicesStopping: false, referenceClosed: false,
    todoClosed: false, notepadClosed: false, coordinationWatchInputs: new Map(), publicSkillSources: new Map(),
    poll: undefined, eventPoll: undefined, stopP5DeviceTelemetry() {calls.push('telemetry-stop');},
    globalShortcut: {unregisterAll() {calls.push('unregister-shortcuts');}},
    publish() {calls.push('publish');},
  });
  for (const name of ['stopWakeVoice','disposeWakeForQuit','reportPanelVoiceFailure']) {
    vm.runInContext(declaration(name), context);
  }
  beforeQuit = vm.runInContext(callback, context);
  return {context, calls, app, get exited() {return exited;}, voiceInput, wakeVoice};
}

test('an already active task refuses quit before permanent voice or wake disposal', async () => {
  const f = fixture({count: 1});f.app.quit();await tick();await tick();
  assert.equal(f.exited, false);assert.match(f.context.runtimeError, /Runtime 仍有活动任务/);
  assert.equal(f.context.app.isQuitting, false);
  assert.equal(f.calls.includes('voice-dispose'), false);assert.equal(f.calls.includes('wake-dispose'), false);
  assert.equal(f.calls.includes('telemetry-stop'), false);assert.equal(f.calls.includes('runtime-close'), false);
  assert.equal((await f.voiceInput.beginCapture()).status, 'listening');
  assert.equal((await f.wakeVoice.enable()).phase, 'listening');
});

test('a task finishing does not resume a refused quit; the next explicit quit closes normally', async () => {
  const f = fixture({count: 1});f.app.quit();await tick();f.context.runtimeApplication.activeTaskCount = 0;
  await tick();assert.equal(f.exited, false);assert.equal(f.calls.includes('voice-dispose'), false);
  f.app.quit();await tick();await tick();await tick();assert.equal(f.exited, true);
  assert.equal(f.calls.filter(call => call === 'wake-dispose').length, 1);
  assert.equal(f.calls.filter(call => call === 'voice-dispose').length, 1);
  assert.equal(f.calls.filter(call => call === 'runtime-close').length, 1);
});

test('a zero-task quit retains the original cleanup sequence', async () => {
  const f = fixture();f.app.quit();await tick();await tick();await tick();
  assert.equal(f.exited, true);assert.equal(f.context.voiceDisposed, true);
  assert.equal(f.context.wakeQuitHandled, true);assert.equal(f.context.runtimeClosed, true);
  assert.ok(f.calls.indexOf('wake-dispose') < f.calls.indexOf('voice-dispose'));
  assert.ok(f.calls.indexOf('voice-dispose') < f.calls.indexOf('runtime-close'));
});

test('Runtime startup guard keeps precedence over active-task preflight', async () => {
  const f = fixture({count: 1, startup: 'starting'});f.app.quit();await tick();
  assert.equal(f.exited, false);assert.equal(f.context.runtimeError, 'Runtime 正在连接，请稍后退出');
  assert.equal(f.calls.includes('wake-dispose'), false);assert.equal(f.calls.includes('voice-dispose'), false);
});

test('the original final task guard still catches work that appears during cleanup', async () => {
  const f = fixture();f.context.wakeVoice = undefined;f.context.voiceInput = undefined;
  f.context.stopP5DeviceTelemetry = () => {f.context.runtimeApplication.activeTaskCount = 1;};
  f.app.quit();await tick();assert.equal(f.exited, false);
  assert.match(f.context.runtimeError, /Runtime 仍有活动任务/);assert.equal(f.calls.includes('runtime-close'), false);
});

test('unknown Live release still blocks quit without recursively retrying it', async () => {
  const f = fixture({liveUnknown: true});f.context.wakeVoice = undefined;f.context.voiceInput = undefined;
  f.app.quit();await tick();assert.equal(f.exited, false);
  assert.equal(f.calls.filter(call => call === 'app-quit').length, 1);
  assert.equal(f.context.liveVoice.hasActive(), true);assert.equal(f.context.runtimeError, 'Live 音频资源释放未确认');
});

test('unknown SIS release stays blocked and does not repeat permanent disposal', async () => {
  const f = fixture({voiceFailure: true});f.context.wakeVoice = undefined;
  f.app.quit();await tick();assert.equal(f.exited, false);assert.equal(f.context.voiceDisposalFailed, true);
  f.app.quit();await tick();assert.equal(f.exited, false);
  assert.equal(f.calls.filter(call => call === 'voice-dispose').length, 1);
  assert.equal(f.context.runtimeError, '语音资源释放未确认');
});
