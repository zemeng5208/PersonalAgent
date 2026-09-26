/** Panel-only capture. The main process initiates and owns every session. */
export function mountMicrophoneCapture(bridge) {
  let current;

  async function stop(session) {
    if (session.stopping) return session.stopping;
    session.cancelled = true;
    session.stopping = (async () => {
      try { await session.acquire; } catch {}
      session.node?.port.close();
      session.node?.disconnect();
      session.source?.disconnect();
      session.gain?.disconnect();
      session.stream?.getTracks().forEach(track => track.stop());
      try { if (session.context && session.context.state !== 'closed') await session.context.close(); }
      catch { /* The stopped receipt below must report the failed close. */ }
      const tracksStopped = (!session.stream || session.stream.getTracks().every(track => track.readyState === 'ended'))
        && (!session.context || session.context.state === 'closed');
      if (current === session) current = undefined;
      bridge.report({type: 'stopped', token: session.token, tracksStopped});
    })();
    return session.stopping;
  }

  async function start(token) {
    if (current) { bridge.report({type: 'error', token}); return; }
    const session = {token, cancelled: false};
    current = session;
    try {
      session.acquire = navigator.mediaDevices.getUserMedia({video: false, audio: {
        channelCount: 1, sampleRate: 16_000, echoCancellation: false,
        noiseSuppression: false, autoGainControl: false,
      }});
      session.stream = await session.acquire;
      if (session.cancelled) return void await stop(session);
      const tracks = session.stream.getAudioTracks();
      if (tracks.length !== 1 || tracks[0].readyState !== 'live') throw Error('Microphone track is unavailable');
      tracks[0].addEventListener('ended', () => {
        if (!session.cancelled) { bridge.report({type: 'error', token}); void stop(session); }
      }, {once: true});
      session.context = new AudioContext({sampleRate: 16_000});
      if (session.context.sampleRate !== 16_000) throw Error('16 kHz capture is unavailable');
      await session.context.audioWorklet.addModule(new URL('./microphone-worklet.js', import.meta.url));
      if (session.cancelled) return void await stop(session);
      session.source = session.context.createMediaStreamSource(session.stream);
      session.node = new AudioWorkletNode(session.context, 'personal-agent-pcm16');
      session.gain = session.context.createGain();
      session.gain.gain.value = 0;
      session.node.port.onmessage = event => {
        if (session.cancelled || current !== session || !(event.data instanceof ArrayBuffer)) return;
        const data = new Uint8Array(event.data);
        if (data.byteLength !== 3200) { bridge.report({type: 'error', token}); void stop(session); return; }
        bridge.report({type: 'frame', token, data});
        data.fill(0);
      };
      session.node.onprocessorerror = () => { bridge.report({type: 'error', token}); void stop(session); };
      session.source.connect(session.node).connect(session.gain).connect(session.context.destination);
      await session.context.resume();
      if (session.cancelled) return void await stop(session);
      bridge.report({type: 'ready', token, trackLive: tracks[0].readyState === 'live',
        sampleRate: session.context.sampleRate});
    } catch {
      bridge.report({type: 'error', token});
      await stop(session);
    }
  }

  const unsubscribe = bridge.onCommand(command => {
    if (!command || typeof command.token !== 'string') return;
    if (command.type === 'start') void start(command.token);
    else if (command.type === 'stop' && current?.token === command.token) void stop(current);
  });
  const onVisibility = () => { if (document.hidden && current) void stop(current); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => { if (current) void stop(current); });
  return () => { unsubscribe(); document.removeEventListener('visibilitychange', onVisibility); if (current) void stop(current); };
}
