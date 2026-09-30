class Pcm16Frames extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(1600);
    this.used = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const left = channels[0];
    const right = channels[1];
    for (let i = 0; i < left.length; i++) {
      const sample = Math.max(-1, Math.min(1, right ? (left[i] + right[i]) / 2 : left[i]));
      this.frame[this.used++] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      if (this.used === this.frame.length) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(1600);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor('personal-agent-pcm16', Pcm16Frames);
