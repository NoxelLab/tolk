// Silero VAD cuts the shared audio into utterances and Whisper transcribes each one, as in transformers.js's moonshine-web example.
import { AutoModel, LogitsProcessorList, Tensor, pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm';

const RATE = 16000;
const FRAME = 512;
const PAD = 80 * 16;
const MIN_SILENCE = 400 * 16;
const MIN_SPEECH = 250 * 16;
const MAX_SAMPLES = 12 * RATE;
const MAX_PREV = Math.ceil(PAD / FRAME);
const EXPECTED_BYTES = 566e6;
const MAX_CHARS_PER_SECOND = 40;
const NOISE = /^(ご視聴ありがとうございました|ご清聴ありがとうございました|チャンネル登録(をお願いします|よろしくお願いします)?|thanks? (you )?(so much )?for watching|subtitles by .*)[.!。！]*$/i;

const sr = new Tensor('int64', [RATE], []);
const buffer = new Float32Array(MAX_SAMPLES);
const queue = [];
let vad = null;
let asr = null;
let loading = null;
let chain = Promise.resolve();
let state = null;
let active = false;
let draining = false;
let session = 0;
let language = null;
let pointer = 0;
let recording = false;
let postSpeech = 0;
let prev = [];

// transformers.js runs one inference at a time, so every call goes through one chain.
const run = (task) => (chain = chain.then(task, task));

function reset(overflow) {
  buffer.fill(0);
  pointer = 0;
  if (overflow?.length) {
    buffer.set(overflow);
    pointer = overflow.length;
  }
  recording = false;
  postSpeech = 0;
}

// transformers.js treats a missing language as English. To keep Whisper's own detection, decoding starts from
// <|startoftranscript|> alone, takes the likeliest language token, then forces a plain transcription.
function detecting(detected) {
  const { decoder_start_token_id, lang_to_id, task_to_id, no_timestamps_token_id, begin_suppress_tokens } = asr.model.generation_config;
  const languages = Object.entries(lang_to_id);
  const processors = new LogitsProcessorList();
  processors.push((ids, logits) => {
    const step = ids[0].length - 1;
    const scores = logits[0].data;
    if (step === 3) for (const token of begin_suppress_tokens) scores[token] = -Infinity;
    if (step > 2) return logits;
    let keep = step === 1 ? task_to_id.transcribe : no_timestamps_token_id;
    if (step === 0) {
      const [token, id] = languages.reduce((best, entry) => (scores[entry[1]] > scores[best[1]] ? entry : best));
      detected.language = token.slice(2, -2);
      keep = id;
    }
    scores.fill(-Infinity);
    scores[keep] = 0;
    return logits;
  });
  return { decoder_input_ids: [decoder_start_token_id], logits_processor: processors };
}

function dispatch(overflow) {
  const end = Math.min(pointer + PAD, buffer.length);
  const lead = prev.reduce((n, b) => n + b.length, 0);
  const audio = new Float32Array(lead + end);
  let offset = 0;
  for (const b of prev) {
    audio.set(b, offset);
    offset += b.length;
  }
  audio.set(buffer.subarray(0, end), offset);
  prev = [];
  reset(overflow);
  const id = session;
  const detected = {};
  run(() => asr(audio, language ? { language, task: 'transcribe' } : detecting(detected))).then(({ text }) => {
    const clean = text.trim();
    if (!clean || NOISE.test(clean) || clean.length > (audio.length / RATE) * MAX_CHARS_PER_SECOND) return;
    self.postMessage({ type: 'text', text: clean, language: detected.language, session: id });
  }).catch(() => {});
}

async function handle(chunk) {
  const id = session;
  const was = recording;
  const input = new Tensor('float32', chunk, [1, chunk.length]);
  const { stateN, output } = await run(() => vad({ input, sr, state }));
  if (!active || id !== session) return;
  state = stateN;
  const p = output.data[0];
  const speech = p > 0.3 || (was && p >= 0.1);
  if (!was && !speech) {
    prev.push(chunk);
    if (prev.length > MAX_PREV) prev.shift();
    return;
  }
  const room = buffer.length - pointer;
  if (chunk.length >= room) {
    buffer.set(chunk.subarray(0, room), pointer);
    pointer += room;
    dispatch(chunk.subarray(room));
    return;
  }
  buffer.set(chunk, pointer);
  pointer += chunk.length;
  if (speech) {
    recording = true;
    postSpeech = 0;
    return;
  }
  postSpeech += chunk.length;
  if (postSpeech < MIN_SILENCE) return;
  if (pointer < MIN_SPEECH) reset();
  else dispatch();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    try {
      await handle(queue.shift());
    } catch {}
  }
  draining = false;
}

async function load(model) {
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== 'progress') return;
    files.set(p.file, p.loaded);
    let loaded = 0;
    for (const n of files.values()) loaded += n;
    self.postMessage({ type: 'progress', ratio: Math.min(1, loaded / EXPECTED_BYTES) });
  };
  vad = await AutoModel.from_pretrained('onnx-community/silero-vad', { config: { model_type: 'custom' }, dtype: 'fp32', progress_callback });
  asr = await pipeline('automatic-speech-recognition', model, {
    device: 'webgpu',
    dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' },
    progress_callback,
  });
  await asr(new Float32Array(RATE), { language: 'en', task: 'transcribe' });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'load') {
    try {
      await (loading ??= load(data.model));
      self.postMessage({ type: 'ready' });
    } catch (e) {
      loading = null;
      self.postMessage({ type: 'error', message: e?.message ?? String(e) });
    }
  } else if (data.type === 'start') {
    session = data.session;
    language = data.language;
    state = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    prev = [];
    queue.length = 0;
    reset();
    active = true;
  } else if (data.type === 'stop') {
    active = false;
    queue.length = 0;
  } else if (data.type === 'audio' && active) {
    queue.push(data.buffer);
    drain();
  }
};
