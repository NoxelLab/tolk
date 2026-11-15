// Whisper large-v3-turbo transcribes in a module worker; the shared audio reaches it through an AudioWorklet.
const MODEL = 'onnx-community/whisper-large-v3-turbo';
const CACHE_KEY = `https://huggingface.co/${MODEL}/resolve/main/onnx/encoder_model_q4f16.onnx`;

export let ready = false;

let worker = null;
let pending = null; // the load in progress
let capture = null; // the audio being sent while listening
let session = 0;
let gpuSupport = null;
const worklets = new WeakMap();

export const hasWebGpu = () => (gpuSupport ??= navigator.gpu
  ? navigator.gpu.requestAdapter().then(Boolean, () => false)
  : Promise.resolve(false));

export async function isCached() {
  try {
    return Boolean(await (await caches.open('transformers-cache')).match(CACHE_KEY));
  } catch {
    return false;
  }
}

function settle(error) {
  const done = pending;
  pending = null;
  if (error) done?.reject(error);
  else done?.resolve();
}

function onMessage({ data }) {
  if (data.type === 'progress') pending?.onProgress(data.ratio);
  else if (data.type === 'ready') {
    ready = true;
    settle();
  } else if (data.type === 'error') settle(new Error(data.message));
  else if (data.type === 'text' && data.session === capture?.session) capture.onText(data.text, data.language);
}

export function load(onProgress) {
  if (!worker) {
    worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onMessage;
    worker.onerror = (e) => settle(new Error(e.message || 'Whisper could not start'));
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject, onProgress };
    worker.postMessage({ type: 'load', model: MODEL });
  });
}

export function unload() {
  stop();
  worker?.terminate();
  worker = null;
  ready = false;
  settle(new Error('Whisper was unloaded'));
}

// language is null to let Whisper detect the language of each utterance.
export async function listen(audioCtx, track, language, onText) {
  const id = ++session;
  if (!worklets.has(audioCtx)) {
    worklets.set(audioCtx, audioCtx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url)));
  }
  await worklets.get(audioCtx);
  if (id !== session) return;
  const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(audioCtx, 'tolk-capture', { numberOfOutputs: 0 });
  node.port.onmessage = ({ data }) => worker.postMessage({ type: 'audio', buffer: data }, [data.buffer]);
  worker.postMessage({ type: 'start', session: id, language: language === 'zh-Hant' ? 'zh' : language });
  source.connect(node);
  capture = { source, node, session: id, onText };
}

export function stop() {
  session++;
  if (!capture) return;
  capture.source.disconnect();
  capture.node.port.onmessage = null;
  capture = null;
  worker?.postMessage({ type: 'stop' });
}
