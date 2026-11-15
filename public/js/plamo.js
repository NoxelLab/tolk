// PLaMo 3 Translate 0.8B, run in the browser by wllama (llama.cpp on WebGPU or multithreaded WASM).
const WLLAMA = 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.13.0/esm';
const MODEL = { repo: 'pfnet/plamo-3-translate-0.8b-GGUF', file: 'plamo-3-translate-0.8b-Q4_K_M.gguf' };
const CODES = { zh: 'zh-hans', 'zh-Hant': 'zh-hant' };
const HISTORY = 2;

export const LICENSE_URL = 'https://plamo.preferredai.jp/info/plamo-community-license-';
export const UNSUPPORTED = new Set(['pt', 'tr', 'uk']);
export let ready = false;

let wllama = null;
const history = [];

async function getWllama() {
  if (!wllama) {
    const { Wllama } = await import(`${WLLAMA}/index.js`);
    wllama = new Wllama({ default: `${WLLAMA}/wasm/wllama.wasm` }, { suppressNativeLog: true });
  }
  return wllama;
}

export async function isCached() {
  const entries = await (await getWllama()).cacheManager.list();
  return entries.some((entry) => entry.name.endsWith(`_${MODEL.file}`));
}

export async function load(onProgress) {
  const instance = await getWllama();
  await instance.loadModelFromHF(MODEL, {
    n_ctx: 4096,
    progressCallback: ({ loaded, total }) => onProgress(total ? loaded / total : 0),
  });
  ready = instance === wllama;
}

export function unload() {
  const instance = wllama;
  wllama = null;
  ready = false;
  instance?.exit().catch(() => {});
}

export function resetHistory() {
  history.length = 0;
}

// PFML3 prompt as rendered by the model's chat template; the last few pairs keep terms and tone consistent.
// Without a source language, the model works it out from the text.
export async function translate(text, source, target) {
  const from = source && (CODES[source] ?? source);
  const to = CODES[target] ?? target;
  const turn = (tag, lang, body) => `<|plamo:tag|>${tag}${lang ? `<|plamo:key|>lang<|plamo:val|>${lang}` : ''}<|plamo:msg|>${body}`;
  let prompt = '<|plamo:tag|>dataset<|plamo:msg|>translation';
  for (const [input, output] of history) prompt += turn('input', from, input) + turn('output', to, output);
  prompt += turn('input', from, text) + turn('output', to, '');
  const res = await wllama.createCompletion({
    prompt,
    max_tokens: 512,
    temperature: 0,
    stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
  });
  const out = res.choices[0].text.trim();
  if (!out) throw new Error('empty translation');
  history.push([text, out]);
  if (history.length > HISTORY) history.shift();
  return out;
}
