/** Streaming PCM output; no model credentials or network access in the renderer. */
export function mountLiveVoicePlayback(bridge, AudioContextClass = globalThis.AudioContext) {
  let current;
  const clear = record => {
    for (const source of record.sources) {source.onended = null; try {source.stop();} catch {} source.disconnect();}
    record.sources.clear(); record.nextAt = record.context.currentTime;
  };
  async function stop(record) {
    if (current === record) current = undefined;
    clear(record);
    try {await record.context.close(); bridge.report({token: record.token, type: 'stopped'});}
    catch {bridge.report({token: record.token, type: 'error'});}
  }
  const unsubscribe = bridge.onCommand(async message => {
    const {token, type} = message ?? {};
    if (typeof token !== 'string') return;
    if (type === 'start') {
      if (current) {bridge.report({token, type: 'error'}); return;}
      try {
        const context = new AudioContextClass({sampleRate: 24000, latencyHint: 'interactive'});
        const record = {token, context, sources: new Set(), nextAt: 0, drain: false};
        current = record;
        await context.resume();
        if (current !== record) return;
        if (context.state !== 'running') throw Error();
        bridge.report({token, type: 'ready'});
      } catch {bridge.report({token, type: 'error'});}
      return;
    }
    const record = current;
    if (!record || record.token !== token) {
      if (type === 'stop') bridge.report({token, type: 'stopped'});
      return;
    }
    if (type === 'stop') {await stop(record); return;}
    if (type === 'clear') {clear(record); return;}
    if (type === 'drain') {
      record.drain = true;
      if (!record.sources.size) bridge.report({token, type: 'drained'});
      return;
    }
    if (type !== 'audio') return;
    try {
      const bytes = message.data;
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > 384000) throw Error();
      if (record.nextAt - record.context.currentTime > 15) throw Error();
      const audio = record.context.createBuffer(1, bytes.length / 2, 24000);
      const samples = audio.getChannelData(0), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      const source = record.context.createBufferSource();
      source.buffer = audio; source.connect(record.context.destination); record.sources.add(source); record.drain = false;
      source.onended = () => {source.disconnect(); record.sources.delete(source);
        if (current === record && record.drain && !record.sources.size) bridge.report({token, type: 'drained'});};
      const at = Math.max(record.nextAt, record.context.currentTime + 0.015);
      source.start(at); record.nextAt = at + audio.duration;
    } catch {bridge.report({token, type: 'error'}); await stop(record);}
  });
  return () => {unsubscribe(); if (current) void stop(current);};
}
