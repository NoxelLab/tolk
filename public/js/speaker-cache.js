/*
 * Ported from speakerCache.ts of nemotron-diarization-web (https://github.com/khawjaahmad/nemotron-diarization-web).
 *
 * MIT License
 *
 * Copyright (c) 2026 Ahmad Waqar
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// The Arrival-Order Speaker Cache of Nemotron 3 Diarization: the strongest evidence of every speaker so far, plus a
// FIFO queue of the latest encoder frames. Each step attends to both, so speakers keep their numbers over time.
// The values are the streaming_config of the checkpoint's config.json.
const HIDDEN = 512;
const SPEAKERS = 8;
const SUBSAMPLING = 8;
const CACHE_LENGTH = 264;
const FIFO_LENGTH = 264;
const UPDATE_PERIOD = 222;
const SILENCE_FRAMES = 1;
const THRESHOLD = 0.25;
const LATEST_BOOST = 0.05;
const BUDGET = Math.floor(CACHE_LENGTH / SPEAKERS) - SILENCE_FRAMES;
const MIN_POSITIVE = Math.floor(BUDGET * 0.5);
const STRONG_FRAMES = Math.floor(BUDGET * 0.75);
const WEAK_FRAMES = Math.floor(BUDGET * 1.5);
const STRONG_BOOST = -2 * Math.log(0.5);
const WEAK_BOOST = -Math.log(0.5);

export const concat = (a, b) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

// Indices of the count largest values; ties go to the lower index.
function topK(values, count) {
  const order = Int32Array.from(values.keys());
  order.sort((a, b) => values[b] - values[a] || a - b);
  return order.slice(0, count);
}

// Speaker probabilities averaged down from the 10 ms logits to the encoder's 80 ms frames.
function pool(logits) {
  const frames = Math.floor(logits.length / SPEAKERS / SUBSAMPLING);
  const out = new Float32Array(frames * SPEAKERS);
  for (let f = 0; f < frames; f++) {
    for (let s = 0; s < SPEAKERS; s++) {
      let sum = 0;
      for (let k = 0; k < SUBSAMPLING; k++) sum += 1 / (1 + Math.exp(-logits[(f * SUBSAMPLING + k) * SPEAKERS + s]));
      out[f * SPEAKERS + s] = sum / SUBSAMPLING;
    }
  }
  return out;
}

// How well each frame shows each speaker alone: the log-odds that the speaker is active while every other one is
// silent. Frames the speaker is not active in, and weak frames of a speaker with enough strong ones, are ruled out.
function score(probs) {
  const frames = probs.length / SPEAKERS;
  const out = new Float32Array(probs.length);
  for (let f = 0; f < frames; f++) {
    const o = f * SPEAKERS;
    let others = 0;
    for (let s = 0; s < SPEAKERS; s++) others += Math.log(Math.max(1 - probs[o + s], THRESHOLD));
    for (let s = 0; s < SPEAKERS; s++) {
      const p = probs[o + s];
      out[o + s] = p <= 0.5
        ? -Infinity
        : Math.log(Math.max(p, THRESHOLD)) - Math.log(Math.max(1 - p, THRESHOLD)) + others - Math.log(0.5);
    }
  }
  for (let s = 0; s < SPEAKERS; s++) {
    let positive = 0;
    for (let f = 0; f < frames; f++) if (out[f * SPEAKERS + s] > 0) positive++;
    if (positive < MIN_POSITIVE) continue;
    for (let f = 0; f < frames; f++) if (out[f * SPEAKERS + s] <= 0) out[f * SPEAKERS + s] = -Infinity;
  }
  return out;
}

function boost(scores, count, amount) {
  const frames = scores.length / SPEAKERS;
  const column = new Float32Array(frames);
  for (let s = 0; s < SPEAKERS; s++) {
    for (let f = 0; f < frames; f++) column[f] = scores[f * SPEAKERS + s];
    for (const f of topK(column, count)) scores[f * SPEAKERS + s] += amount;
  }
}

// Keeps the CACHE_LENGTH most telling frames in their original order, with slots for silence reserved per speaker.
function compress(embeds, probs, silence) {
  const frames = probs.length / SPEAKERS;
  const scores = score(probs);
  for (let i = CACHE_LENGTH * SPEAKERS; i < scores.length; i++) scores[i] += LATEST_BOOST;
  boost(scores, STRONG_FRAMES, STRONG_BOOST);
  boost(scores, WEAK_FRAMES, WEAK_BOOST);

  const width = frames + SILENCE_FRAMES;
  const flat = new Float32Array(width * SPEAKERS);
  for (let s = 0; s < SPEAKERS; s++) {
    for (let f = 0; f < frames; f++) flat[s * width + f] = scores[f * SPEAKERS + s];
    flat.fill(Infinity, s * width + frames, (s + 1) * width);
  }
  const picked = topK(flat, CACHE_LENGTH);
  for (let i = 0; i < CACHE_LENGTH; i++) if (flat[picked[i]] === -Infinity) picked[i] = flat.length;
  picked.sort();

  // Silence slots and ruled-out picks take the silence embedding, with no speaker probability.
  const outEmbeds = new Float32Array(CACHE_LENGTH * HIDDEN);
  const outProbs = new Float32Array(CACHE_LENGTH * SPEAKERS);
  for (let i = 0; i < CACHE_LENGTH; i++) {
    const f = picked[i] === flat.length ? frames : Math.min(picked[i] % width, frames);
    if (f === frames) {
      outEmbeds.set(silence.subarray(0, HIDDEN), i * HIDDEN);
      continue;
    }
    outEmbeds.set(embeds.subarray(f * HIDDEN, (f + 1) * HIDDEN), i * HIDDEN);
    outProbs.set(probs.subarray(f * SPEAKERS, (f + 1) * SPEAKERS), i * SPEAKERS);
  }
  return [outEmbeds, outProbs];
}

export class SpeakerCache {
  #embeds = new Float32Array(0);
  #probs = new Float32Array(0);
  #fifo = new Float32Array(0);
  #compressed = false;

  // The frames the next step puts before its own: the speaker cache, then the FIFO queue.
  get embeds() {
    return concat(this.#embeds, this.#fifo);
  }

  // stepEmbeds is the encoder input of a step (the cached frames, then the chunk) and logits its speaker logits at
  // 10 ms; silence is the learned embedding for the silence slots.
  update(stepEmbeds, logits, silence, chunkFrames) {
    const cacheRows = this.#embeds.length / HIDDEN;
    const start = cacheRows + this.#fifo.length / HIDDEN;
    const probs = pool(logits);
    let fifo = concat(this.#fifo, stepEmbeds.subarray(start * HIDDEN, (start + chunkFrames) * HIDDEN));
    const queued = fifo.length / HIDDEN;
    if (queued > FIFO_LENGTH) {
      // At least UPDATE_PERIOD of the oldest frames move to the speaker cache, and as many as restore the queue's size.
      const popped = Math.min(Math.max(UPDATE_PERIOD, queued - FIFO_LENGTH), queued);
      const stored = this.#compressed ? this.#probs : probs.subarray(0, cacheRows * SPEAKERS);
      let embeds = concat(this.#embeds, fifo.subarray(0, popped * HIDDEN));
      let cacheProbs = concat(stored, probs.subarray(cacheRows * SPEAKERS, (cacheRows + popped) * SPEAKERS));
      fifo = fifo.slice(popped * HIDDEN);
      if (embeds.length / HIDDEN > CACHE_LENGTH) {
        [embeds, cacheProbs] = compress(embeds, cacheProbs, silence);
        this.#compressed = true;
      }
      this.#embeds = embeds;
      this.#probs = cacheProbs;
    }
    this.#fifo = fifo;
  }
}
