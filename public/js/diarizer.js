// Nemotron 3 Diarization tells the speakers of an utterance apart before Whisper transcribes it. Each utterance goes
// through the model as one chunk behind the speaker cache, which keeps the numbers given to earlier speakers.
import { SpeakerCache, concat } from './speaker-cache.js';

const RATE = 16000;
const N_FFT = 512;
const WINDOW = 400;
const HOP = 160;
const MELS = 128;
const HIDDEN = 512;
const SPEAKERS = 8;
const SUBSAMPLING = 8;
const MIN_TURN = 25; // in 10 ms frames; a shorter turn is too short to transcribe and joins its neighbours

// The NeMo log-mel front end: pre-emphasis, a symmetric Hann window of 400 samples centred in a 512-point FFT, and
// 128 Slaney mel bands of the power spectrum.
const hann = new Float64Array(N_FFT);
for (let i = 0; i < WINDOW; i++) hann[(N_FFT - WINDOW) / 2 + i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));

const LOG_STEP = Math.log(6.4) / 27;
const toMel = (hz) => (hz >= 1000 ? 15 + Math.log(hz / 1000) / LOG_STEP : hz / (200 / 3));
const toHz = (mel) => (mel >= 15 ? 1000 * Math.exp(LOG_STEP * (mel - 15)) : (200 / 3) * mel);
const edges = Array.from({ length: MELS + 2 }, (_, i) => toHz((toMel(RATE / 2) * i) / (MELS + 1)));
const bands = Array.from({ length: MELS }, (_, m) => {
  const [left, center, right] = edges.slice(m, m + 3);
  const weights = Array.from({ length: N_FFT / 2 + 1 }, (_, bin) => {
    const hz = (bin * RATE) / N_FFT;
    return Math.max(0, Math.min((hz - left) / (center - left), (right - hz) / (right - center))) * (2 / (right - left));
  });
  const start = weights.findIndex((w) => w > 0);
  return { start, weights: weights.slice(start, weights.findLastIndex((w) => w > 0) + 1) };
});

const BITS = Math.log2(N_FFT);
const reversed = Uint16Array.from({ length: N_FFT }, (_, i) => {
  let r = 0;
  for (let b = 0; b < BITS; b++) r = (r << 1) | ((i >> b) & 1);
  return r;
});
const cos = Float64Array.from({ length: N_FFT / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / N_FFT));
const sin = Float64Array.from({ length: N_FFT / 2 }, (_, i) => Math.sin((2 * Math.PI * i) / N_FFT));
const re = new Float64Array(N_FFT);
const im = new Float64Array(N_FFT);

// Power spectrum of the windowed frame starting at offset, left in re[0..N_FFT/2].
function power(signal, offset) {
  for (let i = 0; i < N_FFT; i++) re[i] = signal[offset + reversed[i]] * hann[reversed[i]];
  im.fill(0);
  for (let span = 2; span <= N_FFT; span <<= 1) {
    const half = span >> 1;
    const step = N_FFT / span;
    for (let start = 0; start < N_FFT; start += span) {
      for (let k = 0; k < half; k++) {
        const even = start + k;
        const odd = even + half;
        const c = cos[k * step];
        const s = sin[k * step];
        const oddRe = re[odd] * c + im[odd] * s;
        const oddIm = im[odd] * c - re[odd] * s;
        re[odd] = re[even] - oddRe;
        im[odd] = im[even] - oddIm;
        re[even] += oddRe;
        im[even] += oddIm;
      }
    }
  }
  for (let bin = 0; bin <= N_FFT / 2; bin++) re[bin] = re[bin] * re[bin] + im[bin] * im[bin];
}

// One frame per 10 ms, with windows centred on the frames (zero-padded by half an FFT at both ends).
function logMel(audio) {
  const frames = Math.floor(audio.length / HOP);
  const signal = new Float64Array(audio.length + N_FFT);
  signal[N_FFT / 2] = audio[0];
  for (let i = 1; i < audio.length; i++) signal[N_FFT / 2 + i] = audio[i] - 0.97 * audio[i - 1];
  const out = new Float32Array(frames * MELS);
  for (let f = 0; f < frames; f++) {
    power(signal, f * HOP);
    for (let m = 0; m < MELS; m++) {
      const { start, weights } = bands[m];
      let energy = 0;
      for (let k = 0; k < weights.length; k++) energy += re[start + k] * weights[k];
      out[f * MELS + m] = Math.log(energy + 2 ** -24);
    }
  }
  return { data: out, frames };
}

// The likeliest speaker of each 10 ms frame, if any is likelier than not, cut into turns. The audio between two turns
// is split in the middle of the pause. speaker is null when no one is clearly speaking.
function split(logits, length) {
  const runs = [];
  for (let f = 0; f < logits.length / SPEAKERS; f++) {
    let speaker = -1;
    let best = 0;
    for (let s = 0; s < SPEAKERS; s++) {
      if (logits[f * SPEAKERS + s] > best) {
        best = logits[f * SPEAKERS + s];
        speaker = s;
      }
    }
    if (speaker < 0) continue;
    const last = runs.at(-1);
    if (last?.speaker === speaker) last.end = f + 1;
    else runs.push({ speaker, start: f, end: f + 1 });
  }
  for (let i = 0; i < runs.length && runs.length > 1;) {
    if (runs[i].end - runs[i].start >= MIN_TURN) {
      i++;
      continue;
    }
    runs.splice(i, 1);
    const [prev, next] = [runs[i - 1], runs[i]];
    if (prev && next && prev.speaker === next.speaker) {
      prev.end = next.end;
      runs.splice(i, 1);
    }
    if (i > 0) i--;
  }
  if (!runs.length) return [{ start: 0, end: length, speaker: null }];
  let start = 0;
  return runs.map((run, i) => {
    const end = i + 1 < runs.length ? Math.round((run.end + runs[i + 1].start) / 2) * HOP : length;
    const turn = { start, end, speaker: run.speaker };
    start = end;
    return turn;
  });
}

export class Diarizer {
  #cache = new SpeakerCache();

  constructor(model, Tensor) {
    this.model = model;
    this.Tensor = Tensor;
  }

  reset() {
    this.#cache = new SpeakerCache();
  }

  // The speaker turns of an utterance, as ranges of its 16 kHz samples.
  async turns(audio) {
    const { Tensor } = this;
    const mel = logMel(audio);
    const cached = this.#cache.embeds;
    const before = cached.length / HIDDEN;
    const frames = Math.ceil(mel.frames / SUBSAMPLING);
    const total = before + frames;
    const out = await this.model({
      input_features: new Tensor('float32', mel.data, [1, mel.frames, MELS]),
      cached_embeds: new Tensor('float32', cached, [1, before, HIDDEN]),
      attention_mask: new Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
    });
    // The graph pads the sequence for its attention kernels, so only the real frames count.
    const logits = out.logits.data.subarray(0, total * SUBSAMPLING * SPEAKERS);
    this.#cache.update(concat(cached, out.chunk_embeds.data), logits, out.silence_embeds.data, frames);
    const first = before * SUBSAMPLING * SPEAKERS;
    return split(logits.subarray(first, first + Math.min(mel.frames, frames * SUBSAMPLING) * SPEAKERS), audio.length);
  }
}
