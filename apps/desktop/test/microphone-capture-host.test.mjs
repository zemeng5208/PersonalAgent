import assert from 'node:assert/strict';
import test from 'node:test';
import {createMicrophoneCaptureHost} from '../electron/microphone-capture-host.js';

function fixture() {
  const commands = [];
  let lease;
  const contents = {mainFrame: {}, isDestroyed: () => false,
    send: (_channel, command) => commands.push(command)};
  const panel = {webContents: contents, isDestroyed: () => false, isVisible: () => true};
  const gate = {grant: options => {
    lease = options;
    return () => { const callback = lease?.onRevoke; lease = undefined; callback?.(); };
  }};
  const host = createMicrophoneCaptureHost({permissionGate: gate, getPanel: () => panel});
  const event = {sender: contents, senderFrame: contents.mainFrame};
  return {host, commands, event, contents, panel, lease: () => lease};
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

test('one explicit panel authorization shares one physical capture; last subscriber waits for track readback', async () => {
  const {host, commands, event, contents, lease} = fixture();
  const framesA = [], framesB = [];
  await assert.rejects(host.binding.start({onFrame: () => {}}), /明确启用/);
  host.authorize();
  const first = host.binding.start({onFrame: frame => framesA.push([...frame])});
  const second = host.binding.start({onFrame: frame => framesB.push([...frame])});
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'start');
  assert.ok(lease());
  const token = commands[0].token;
  assert.equal(host.receive({sender: contents, senderFrame: {}}, {type: 'ready', token,
    trackLive: true, sampleRate: 16000}), false);
  host.receive(event, {type: 'ready', token, trackLive: true, sampleRate: 16000});
  const [subA, subB] = await Promise.all([first, second]);
  assert.equal(host.snapshot().subscriberCount, 2);
  host.receive(event, {type: 'frame', token, data: Uint8Array.of(1, 2)});
  assert.deepEqual(framesA, [[1, 2]]);
  assert.deepEqual(framesB, [[1, 2]]);
  await subA.release();
  assert.equal(commands.length, 1);
  assert.equal(host.snapshot().subscriberCount, 1);
  const closing = subB.release();
  await tick();
  assert.equal(commands.at(-1).type, 'stop');
  assert.equal(host.snapshot().busy, true);
  host.receive(event, {type: 'stopped', token, tracksStopped: true});
  await closing;
  assert.deepEqual(host.snapshot().lastRelease, {stopped: true, verified: true, reason: 'released'});
  assert.equal(host.snapshot().busy, false);
});

test('permission revoke stops active capture and cannot claim release without stopped tracks', async () => {
  const {host, commands, event, lease} = fixture();
  let revoked = 0;
  host.authorize();
  const pending = host.binding.start({onFrame: () => {}, onRevoked: () => { revoked++; }});
  const token = commands[0].token;
  host.receive(event, {type: 'ready', token, trackLive: true, sampleRate: 16000});
  const sub = await pending;
  lease().onRevoke();
  await tick();
  assert.equal(revoked, 1);
  assert.equal(commands.at(-1).type, 'stop');
  host.receive(event, {type: 'stopped', token, tracksStopped: false});
  await assert.rejects(sub.release(), /track 未全部停止/);
  assert.equal(host.snapshot().lastRelease.verified, false);
});

test('two subscriptions using the same sink keep capture until both handles release', async () => {
  const {host, commands, event} = fixture();
  const sink = {onFrame: () => {}};
  host.authorize();
  const first = host.binding.start(sink);
  const second = host.binding.start(sink);
  const token = commands[0].token;
  host.receive(event, {type: 'ready', token, trackLive: true, sampleRate: 16000});
  const [a, b] = await Promise.all([first, second]);
  assert.equal(host.snapshot().subscriberCount, 2);
  await a.release();
  assert.equal(host.snapshot().subscriberCount, 1);
  assert.equal(commands.filter(command => command.type === 'stop').length, 0);
  const closing = b.release();
  await tick();
  assert.equal(commands.filter(command => command.type === 'stop').length, 1);
  host.receive(event, {type: 'stopped', token, tracksStopped: true});
  await closing;
  assert.equal(host.snapshot().lastRelease.verified, true);
});
