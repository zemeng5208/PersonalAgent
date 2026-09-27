import {randomUUID} from 'node:crypto';

const MAX_WAV_BYTES = 12 * 1024 * 1024;
const STOP_MS = 5_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return {promise, resolve, reject};
}

/** One SIS WAV playback at a time, owned by the trusted panel and main process. */
export function createDesktopSisPlaybackHost({getPanel, now = Date.now, onDiagnostic = () => {}}) {
  let current;
  let disposed = false;
  let releaseUnknown = false;
  const report = phase => { try { onDiagnostic(phase); } catch {} };

  function finish(operation, kind) {
    if (operation.finished) return;
    operation.finished = true;
    clearTimeout(operation.deadlineTimer);
    clearTimeout(operation.stopTimer);
    operation.signal.removeEventListener('abort', operation.onAbort);
    operation.audio.fill(0);
    if (current === operation) current = undefined;
    report(kind);
    if (kind === 'completed') operation.result.resolve();
    else operation.result.reject(Error(kind === 'stopped'
      ? '语音播报已停止' : '语音播报未能确认完成'));
    if (kind !== 'release_failed') operation.stopped.resolve();
    else operation.stopped.reject(Error('语音播放资源释放未确认'));
  }

  function stop(operation) {
    if (operation.stopPromise) return operation.stopPromise;
    if (operation.finished) return releaseUnknown
      ? Promise.reject(Error('语音播放资源释放未确认')) : Promise.resolve();
    operation.stopPromise = operation.stopped.promise;
    try { operation.contents.send('desktop:voice-playback-command',
      {type: 'stop', id: operation.id}); }
    catch { releaseUnknown = true; finish(operation, 'release_failed'); }
    if (!operation.finished) {
      operation.stopTimer = setTimeout(() => {
        releaseUnknown = true;
        finish(operation, 'release_failed');
      }, STOP_MS);
      operation.stopTimer.unref?.();
    }
    return operation.stopPromise;
  }

  function playWav({audio, deadline, signal}) {
    if (disposed || releaseUnknown || current) throw Error('语音播放设备尚未释放');
    if (!(audio instanceof Uint8Array) || audio.byteLength < 44
      || audio.byteLength > MAX_WAV_BYTES
      || String.fromCharCode(...audio.subarray(0, 4)) !== 'RIFF'
      || String.fromCharCode(...audio.subarray(8, 12)) !== 'WAVE'
      || !(signal instanceof AbortSignal) || signal.aborted
      || !Number.isFinite(Date.parse(deadline)) || now() >= Date.parse(deadline)) {
      throw Error('语音 WAV 播放请求无效');
    }
    const panel = getPanel();
    if (!panel || panel.isDestroyed() || !panel.isVisible()
      || panel.webContents.isDestroyed()) throw Error('请先显示可信语音面板');
    const operation = {id: randomUUID(), contents: panel.webContents,
      audio: Uint8Array.from(audio), signal, result: deferred(), stopped: deferred(),
      finished: false, stopPromise: undefined};
    operation.onAbort = () => { void stop(operation).catch(() => {}); };
    current = operation;
    signal.addEventListener('abort', operation.onAbort, {once: true});
    operation.deadlineTimer = setTimeout(() => {
      void stop(operation).catch(() => {});
    }, Math.max(1, Date.parse(deadline) - now()));
    operation.deadlineTimer.unref?.();
    try { operation.contents.send('desktop:voice-playback-command',
      {type: 'start', id: operation.id, audio: operation.audio}); report('dispatched'); }
    catch { releaseUnknown = true; finish(operation, 'release_failed'); }
    if (signal.aborted && !operation.finished) operation.onAbort();
    return {result: operation.result.promise,
      stop: () => stop(operation)};
  }

  function receive(event, message) {
    const operation = current;
    if (!operation || event.sender !== operation.contents
      || event.senderFrame !== operation.contents.mainFrame
      || !message || Object.keys(message).length !== 2
      || message.id !== operation.id || operation.finished) return false;
    if (['decoding','resuming','started'].includes(message.type)) {
      report(message.type);
      return true;
    }
    if (message.type === 'completed') {
      finish(operation, 'completed');
      return true;
    }
    if (message.type === 'stopped') {
      finish(operation, 'stopped');
      return true;
    }
    if (message.type === 'error') {
      finish(operation, 'error');
      return true;
    }
    if (message.type === 'release_failed') {
      releaseUnknown = true;
      finish(operation, 'release_failed');
      return true;
    }
    return false;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (current) await stop(current);
    if (releaseUnknown) throw Error('语音播放资源释放未确认');
  }

  return {playWav, receive, dispose,
    stop: () => current ? stop(current) : releaseUnknown
      ? Promise.reject(Error('语音播放资源释放未确认')) : Promise.resolve()};
}
