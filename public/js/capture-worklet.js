// Passes the shared audio on in frames of 512 samples, the size Silero VAD takes at 16 kHz.
const FRAME = 512;

registerProcessor('tolk-capture', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME);
    this.filled = 0;
  }

  process([input]) {
    const samples = input[0];
    for (let i = 0; samples && i < samples.length;) {
      const take = Math.min(samples.length - i, FRAME - this.filled);
      this.frame.set(samples.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === FRAME) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME);
        this.filled = 0;
      }
    }
    return true;
  }
});
