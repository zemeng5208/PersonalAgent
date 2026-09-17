const TARGET_SAMPLE_RATE = 16_000;
const MAX_CAPTURE_MS = 60_000;

function validSampleRate(value) {
  return Number.isFinite(value) && value >= TARGET_SAMPLE_RATE && value <= 384_000;
}

export function resampleMonoToPcm16(chunks, sourceSampleRate) {
  if (!Array.isArray(chunks) || chunks.length === 0 || !validSampleRate(sourceSampleRate)) {
    throw Error('没有可用的语音音频');
  }
  let sourceLength = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Float32Array) || chunk.length === 0) throw Error('语音音频格式无效');
    sourceLength += chunk.length;
  }
  const source = new Float32Array(sourceLength);
  let offset = 0;
  for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.length; }
  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(sourceLength / ratio);
  if (outputLength <= 0) throw Error('语音片段太短');
  const pcm = new Uint8Array(outputLength * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.min(sourceLength, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += source[cursor];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(index * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
  }
  source.fill(0);
  return pcm;
}

export function createPushToTalkCapture({
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  onLimit = () => {},
} = {}) {
  let stream;
  let context;
  let source;
  let processor;
  let mutedOutput;
  let timer;
  let chunks = [];
  let frames = 0;
  let running = false;

  function release(wipe = true) {
    running = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (processor) processor.onaudioprocess = null;
    try { source?.disconnect(); } catch { /* Already disconnected. */ }
    try { processor?.disconnect(); } catch { /* Already disconnected. */ }
    try { mutedOutput?.disconnect(); } catch { /* Already disconnected. */ }
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    void context?.close?.();
    stream = undefined;
    context = undefined;
    source = undefined;
    processor = undefined;
    mutedOutput = undefined;
    if (wipe) {
      for (const chunk of chunks) chunk.fill(0);
      chunks = [];
      frames = 0;
    }
  }

  async function start() {
    if (running) throw Error('语音采集已开始');
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function' || typeof AudioContextClass !== 'function') {
      throw Error('当前环境无法采集麦克风');
    }
    chunks = [];
    frames = 0;
    stream = await mediaDevices.getUserMedia({
      audio: {channelCount: 1, sampleRate: TARGET_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true, autoGainControl: true},
      video: false,
    });
    context = new AudioContextClass({latencyHint: 'interactive'});
    if (!validSampleRate(context.sampleRate) || typeof context.createScriptProcessor !== 'function') {
      release();
      throw Error('当前环境无法转换麦克风音频');
    }
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    mutedOutput = context.createGain();
    mutedOutput.gain.value = 0;
    const maximumFrames = Math.floor(context.sampleRate * MAX_CAPTURE_MS / 1_000);
    processor.onaudioprocess = event => {
      if (!running || frames >= maximumFrames) return;
      const input = event.inputBuffer.getChannelData(0);
      const length = Math.min(input.length, maximumFrames - frames);
      if (length <= 0) return;
      const copy = new Float32Array(length);
      copy.set(input.subarray(0, length));
      chunks.push(copy);
      frames += length;
    };
    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(context.destination);
    running = true;
    timer = setTimeout(() => onLimit(), MAX_CAPTURE_MS);
  }

  async function stop() {
    if (!running) throw Error('当前没有语音采集');
    const captured = chunks;
    const sampleRate = context.sampleRate;
    release(false);
    try {
      return {audio: resampleMonoToPcm16(captured, sampleRate)};
    } finally {
      for (const chunk of captured) chunk.fill(0);
      chunks = [];
      frames = 0;
    }
  }

  function cancel() { release(true); }

  return Object.freeze({start, stop, cancel, get active() { return running; }});
}
