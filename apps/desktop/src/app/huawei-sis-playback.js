/** Play only the WAV bytes sent by the trusted main process. */
export function mountHuaweiSisPlayback(bridge) {
  let current;

  async function finish(operation, type) {
    if (operation.finished) return;
    operation.finished = true;
    try { operation.source?.stop(); } catch {}
    operation.source?.disconnect();
    if (operation.context && operation.context.state !== 'closed') {
      try { await operation.context.close(); }
      catch { type = 'release_failed'; }
    }
    operation.audio?.fill(0);
    if (current === operation) current = undefined;
    bridge.report({type, id: operation.id});
  }

  async function start(command) {
    if (current || !command || typeof command.id !== 'string'
      || !(command.audio instanceof Uint8Array)) {
      if (typeof command?.id === 'string') bridge.report({type: 'error', id: command.id});
      return;
    }
    const operation = {id: command.id, audio: command.audio,
      finished: false, stopping: false};
    current = operation;
    try {
      operation.context = new AudioContext();
      const bytes = operation.audio.slice().buffer;
      const decoded = await operation.context.decodeAudioData(bytes);
      operation.audio.fill(0);
      if (operation.stopping || current !== operation) return void await finish(operation, 'stopped');
      operation.source = operation.context.createBufferSource();
      operation.source.buffer = decoded;
      operation.source.connect(operation.context.destination);
      operation.source.onended = () => {
        void finish(operation, operation.stopping ? 'stopped' : 'completed');
      };
      await operation.context.resume();
      if (operation.stopping || current !== operation) return void await finish(operation, 'stopped');
      operation.source.start();
    } catch { await finish(operation, operation.stopping ? 'stopped' : 'error'); }
  }

  const unsubscribe = bridge.onCommand(command => {
    if (command?.type === 'start') void start(command);
    else if (command?.type === 'stop' && current?.id === command.id) {
      current.stopping = true;
      void finish(current, 'stopped');
    }
  });
  const onVisibility = () => {
    if (document.hidden && current) {
      current.stopping = true;
      void finish(current, 'stopped');
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  const onPageHide = () => {
    if (current) {
      current.stopping = true;
      void finish(current, 'stopped');
    }
  };
  window.addEventListener('pagehide', onPageHide);
  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    if (current) {
      current.stopping = true;
      void finish(current, 'stopped');
    }
  };
}
