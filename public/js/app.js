// Tolk: recognizes the speech in a shared screen or tab and shows it as translated subtitles, all in the browser.
import { LOCALES, I18N } from './i18n.js';
import * as plamo from './plamo.js';
import * as whisper from './whisper.js';

const FATAL_ERRORS = {
  'not-allowed': 'notAllowed',
  'service-not-allowed': 'serviceNotAllowed',
  'language-not-supported': 'langNotSupported',
  'audio-capture': 'audioCapture',
};
const STORAGE_KEY = 'screen-translator.v2';
const SHARE_URL = 'https://noxelwork.com/tolk';
const RESTART_DELAY_MS = 250;
const MAX_SOURCE_LINES = 2;
const MAX_CAPTION_LINES = 2;
const MAX_JOINED_TAIL = 10;
const MIN_HOLD_MS = 1500;
const MAX_HOLD_MS = 8000;
const HOLD_PER_WORD_MS = 280;
const MAX_LAG_MS = 8000;
const PIP_SIZE = { width: 720, height: 240 };
const BREAK_AFTER = /^[、。，．,.!?！？;；:：]+$/;
const NO_PIECE_START = /^[\s、。，．,.!?！？;；:：）」』]*/;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const supported = !document.documentElement.classList.contains('unsupported');
const $ = (id) => document.getElementById(id);
const uiSel = $('uiLang'), shareLink = $('shareLink');
const controls = $('controls'), srcSel = $('src'), tgtSel = $('tgt'), swapBtn = $('swap');
const engineInputs = [...document.querySelectorAll('[name="engine"]')];
const mtInputs = [...document.querySelectorAll('[name="mt"]')];
const plamoLink = $('plamoLink');
const stage = $('stage'), stageHome = $('stageHome'), pipNote = $('pipNote');
const actionBtn = $('action'), actionLabel = $('actionLabel'), statusEl = $('status');
const popBtn = $('pop'), unpopBtn = $('unpop'), clearBtn = $('clear');
const capTr = $('capTr'), capSrc = $('capSrc'), logEl = $('log'), clockEl = $('clock'), waveEl = $('wave');
const demoTr = $('demoTr'), demoSrc = $('demoSrc');

let ui = 'ja';
let status = { state: 'idle', key: '', vars: {} };
const translators = new Map(); // Chrome translators into the subtitle language, by source language
let stream = null;
let recognition = null;
let running = false;
let busy = false;
let blocked = false;
let checking = false;
let checked = false;
let pendingStep = null; // 'translator' | 'plamo' | 'speech' | 'whisper' | null
let progress = null; // null when not downloading, 0..1, or 'indeterminate'
let plamoCached = false;
let whisperCached = false;
let lastSrc = 'en'; // the spoken language last chosen by hand
let checkId = 0;
let session = 0;
let startedAt = 0;
let pipWindow = null;
let audioCtx = null;
let analyser = null;
let meterSource = null;
let meterToken = 0;
let demoIndex = 0;
let demoToken = 0;

const finals = [];
let translating = false;
let liveSrc = null;
const captions = [];
let captionRest = '';
let captionTimer = null;
let captionWin = window;
let holdUntil = 0;

const t = (key, vars = {}) => (I18N[ui][key] ?? I18N.en[key]).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
const htmlLang = (code) => (code === 'zh' ? 'zh-Hans' : code);
const auto = () => srcSel.value === 'auto';
const engine = () => engineInputs.find((input) => input.checked)?.value ?? 'chrome';
const mt = () => mtInputs.find((input) => input.checked)?.value ?? 'chrome';
// With automatic detection, the language last chosen is the likeliest, so its model is the one prepared before starting.
const pair = () => {
  const target = tgtSel.value;
  const source = !auto() ? srcSel.value : lastSrc !== target ? lastSrc : target === 'en' ? 'ja' : 'en';
  return { sourceLanguage: source, targetLanguage: target };
};
const locale = () => LOCALES.get(srcSel.value);
const stageWindow = () => stage.ownerDocument.defaultView;

function setStatus(state, key = '', vars = {}) {
  status = { state, key, vars };
  statusEl.dataset.state = state;
  statusEl.textContent = key ? t(key, vars) : '';
}

function detectLanguage(saved) {
  if (I18N[saved]) return saved;
  for (const tag of navigator.languages ?? [navigator.language]) {
    try {
      const { language, script } = new Intl.Locale(tag).maximize();
      const code = language === 'zh' && script === 'Hant' ? 'zh-Hant' : language;
      if (I18N[code]) return code;
    } catch {}
  }
  return 'en';
}

function applyLanguage(code) {
  ui = code;
  for (const doc of [document, pipWindow?.document]) {
    if (!doc) continue;
    doc.documentElement.lang = htmlLang(code);
    doc.documentElement.dir = code === 'ar' ? 'rtl' : 'ltr';
  }
  document.title = t('title');
  for (const root of [document, stage]) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  }
  stage.setAttribute('aria-label', t('stage'));
  shareLink.href = `https://x.com/intent/tweet?text=${encodeURIComponent(t('title'))}&url=${encodeURIComponent(SHARE_URL)}`;
  plamoLink.href = plamo.LICENSE_URL + (code === 'ja' ? 'ja' : 'en');
  plamoLink.textContent = code === 'ja' ? 'PLaMoコミュニティライセンス契約' : 'PLaMo Community License Agreement';
  uiSel.value = code;
  if (supported) {
    nameLanguages();
    setStatus(status.state, status.key, status.vars);
    render();
  } else {
    showDemo(0);
  }
}

function nameLanguages() {
  const lang = htmlLang(ui);
  const names = new Intl.DisplayNames([lang], { type: 'language' });
  for (const sel of [srcSel, tgtSel]) {
    for (const option of sel.options) {
      if (option.value === 'auto') {
        option.textContent = t('auto');
        continue;
      }
      const name = names.of(option.value);
      option.textContent = name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
    }
  }
}

function render() {
  const view = running ? 'live' : busy ? (progress === null ? 'starting' : 'download') : checked ? 'idle' : 'checking';
  stage.dataset.view = view;
  stage.dataset.mt = mt();
  stage.toggleAttribute('data-step', Boolean(pendingStep));
  stage.toggleAttribute('data-blocked', blocked);
  controls.disabled = running || busy;
  swapBtn.disabled = auto();
  srcSel.options[0].hidden = engine() !== 'whisper';
  actionBtn.disabled = busy || blocked;

  let icon = 'share';
  let label = t('start');
  if (view === 'starting') {
    icon = 'spin';
    label = t('starting');
  } else if (view === 'download') {
    icon = 'none';
    const p = Math.floor(progress * 10) * 10;
    if (pendingStep === 'plamo') label = typeof progress === 'number' ? t('downloadingPlamo', { p }) : t('loadingPlamo');
    else if (pendingStep === 'whisper') label = typeof progress === 'number' ? t('downloadingWhisper', { p }) : t('loadingWhisper');
    else label = typeof progress === 'number' ? t('downloadingModel', { p }) : t('downloadingSpeech');
  } else if (pendingStep) {
    icon = 'download';
    label = t({ speech: 'getSpeech', whisper: 'getWhisper', plamo: 'getPlamo', translator: 'getModel' }[pendingStep]);
  }
  actionBtn.dataset.icon = icon;
  actionLabel.textContent = label;
  actionBtn.classList.toggle('indeterminate', progress === 'indeterminate');
  actionBtn.style.setProperty('--progress', typeof progress === 'number' ? progress : 0);

  popBtn.hidden = !running || pipWindow !== null || !('documentPictureInPicture' in window);
  pipNote.hidden = pipWindow === null;
}

async function check() {
  const id = ++checkId;
  checking = true;
  render();

  let problem = null;
  let vars = {};
  let step = null;
  const unsupported = mt() === 'plamo' && [srcSel.value, tgtSel.value].find((code) => plamo.UNSUPPORTED.has(code));
  if (srcSel.value === tgtSel.value) {
    problem = 'sameLang';
  } else if (unsupported) {
    problem = 'plamoUnsupported';
    vars = { l: new Intl.DisplayNames([htmlLang(ui)], { type: 'language' }).of(unsupported) };
  } else {
    try {
      const translation = mt() === 'plamo'
        ? plamo.ready ? 'available' : (await plamo.isCached()) ? 'cached' : 'downloadable'
        : translators.has(pair().sourceLanguage) ? 'available' : await Translator.availability(pair());
      const speech = engine() === 'whisper'
        ? !(await whisper.hasWebGpu()) ? 'nogpu' : whisper.ready ? 'available' : (await whisper.isCached()) ? 'cached' : 'downloadable'
        : await SR.available({ langs: [locale()], processLocally: true });
      if (id !== checkId) return;
      plamoCached = translation === 'cached';
      whisperCached = speech === 'cached';
      if (translation === 'unavailable') problem = 'pairUnavailable';
      else if (speech === 'nogpu') problem = 'whisperNoGpu';
      else if (speech === 'unavailable') problem = 'localUnavailable';
      else if (translation !== 'available') step = mt() === 'plamo' ? 'plamo' : 'translator';
      else if (speech !== 'available') step = engine() === 'whisper' ? 'whisper' : 'speech';
    } catch (e) {
      if (id !== checkId) return;
      problem = 'checkFailed';
      vars = { e: e.message };
    }
  }

  checking = false;
  checked = true;
  pendingStep = step;
  blocked = Boolean(problem);
  if (problem) setStatus('error', problem, vars);
  else if (step) setStatus('note', 'firstDownload');
  else setStatus('ready', 'ready');
  render();
  // A model already saved in the browser loads without asking, since nothing is downloaded.
  if ((step === 'plamo' && plamoCached) || (step === 'whisper' && whisperCached)) prepare();
}

async function prepare() {
  busy = true;
  const cached = (pendingStep === 'plamo' && plamoCached) || (pendingStep === 'whisper' && whisperCached);
  progress = pendingStep === 'speech' || cached ? 'indeterminate' : 0;
  render();
  try {
    if (pendingStep === 'plamo') {
      setStatus('busy', plamoCached ? 'loadingPlamo' : 'downloadingPlamo', { p: 0 });
      await plamo.load((ratio) => {
        if (plamoCached) return;
        progress = ratio;
        const p = Math.floor(ratio * 10) * 10;
        if (status.vars.p !== p) setStatus('busy', 'downloadingPlamo', { p });
        render();
      });
    } else if (pendingStep === 'whisper') {
      setStatus('busy', whisperCached ? 'loadingWhisper' : 'downloadingWhisper', { p: 0 });
      await whisper.load((ratio) => {
        if (whisperCached) return;
        progress = ratio;
        const p = Math.floor(ratio * 10) * 10;
        if (status.vars.p !== p) setStatus('busy', 'downloadingWhisper', { p });
        render();
      });
    } else if (pendingStep === 'translator') {
      setStatus('busy', 'preparingModel');
      const translator = await Translator.create({
        ...pair(),
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            progress = e.loaded;
            const p = Math.floor(e.loaded * 10) * 10;
            if (status.key !== 'downloadingModel' || status.vars.p !== p) setStatus('busy', 'downloadingModel', { p });
            render();
          });
        },
      });
      translators.set(pair().sourceLanguage, translator);
    } else {
      setStatus('busy', 'downloadingSpeech');
      const installed = await SR.install({ langs: [locale()], processLocally: true });
      if (!installed) throw new Error(t('installFailed'));
    }
  } catch (e) {
    busy = false;
    progress = null;
    setStatus('error', 'prepareFailed', { e: e.message });
    render();
    return;
  }
  busy = false;
  progress = null;
  await check();
}

async function start() {
  audioCtx ??= new AudioContext({ sampleRate: 16000 });
  audioCtx.resume().catch(() => {});
  busy = true;
  setStatus('busy', 'pickScreen');
  render();

  // Keep Tolk in front after a tab is shared, so the subtitles can be popped out right away.
  const controller = 'CaptureController' in window ? new CaptureController() : undefined;
  try {
    controller?.setFocusBehavior?.('focus-capturing-application');
  } catch {}
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      controller,
    });
  } catch (e) {
    if (e.name === 'NotAllowedError') stop('cancelled');
    else stop('shareFailed', 'error', { e: e.message });
    return;
  }

  const current = stream;
  const [track] = stream.getAudioTracks();
  if (!track) {
    stop('noAudio', 'error');
    return;
  }
  stream.getVideoTracks().forEach((t) => t.stop());
  track.addEventListener('ended', () => stop('ended', 'note'));

  try {
    if (mt() === 'plamo') {
      if (!plamo.ready) await plamo.load(() => {});
    } else if (!translators.has(pair().sourceLanguage)) {
      translators.set(pair().sourceLanguage, await Translator.create(pair()));
    }
    if (engine() === 'whisper' && !whisper.ready) await whisper.load(() => {});
  } catch (e) {
    if (stream === current) stop('modelFailed', 'error', { e: e.message });
    return;
  }
  if (stream !== current) return;

  busy = false;
  running = true;
  plamo.resetHistory();
  session++;
  startedAt = Date.now();
  setStatus('live', 'live');
  startMeter(track);
  render();
  if (engine() === 'whisper') {
    whisper.listen(audioCtx, track, auto() ? null : srcSel.value, (text, language) => {
      if (running) commit(text, language);
    }).catch((e) => stop('srFailed', 'error', { e: e.message }));
  } else listen(track);
}

function stop(key = 'stopped', state = 'ready', vars = {}) {
  running = false;
  busy = false;
  recognition?.abort();
  recognition = null;
  whisper.stop();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  stopMeter();
  pipWindow?.close();
  clearCaptions();
  setStatus(state, key, vars);
  render();
}

function listen(track) {
  const rec = new SR();
  recognition = rec;
  rec.lang = locale();
  rec.continuous = true;
  rec.interimResults = true;
  rec.processLocally = true;

  const begin = () => {
    if (!running || recognition !== rec) return;
    try {
      rec.start(track);
    } catch (e) {
      stop('srFailed', 'error', { e: e.message });
    }
  };

  rec.onresult = (e) => {
    if (recognition !== rec) return;
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (result.isFinal) commit(result[0].transcript.trim());
      else text += result[0].transcript;
    }
    if (text.trim()) showSource(text.trim());
  };
  rec.onerror = (e) => {
    if (recognition !== rec) return;
    if (FATAL_ERRORS[e.error]) stop(FATAL_ERRORS[e.error], 'error');
  };
  rec.onend = () => setTimeout(begin, RESTART_DELAY_MS);

  begin();
}

const WAVE_BARS = 32;
const WAVE_STEP_MS = 60;
const waveBars = Array.from({ length: WAVE_BARS }, () => waveEl.appendChild(document.createElement('i')));

function startMeter(track) {
  try {
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    meterSource = audioCtx.createMediaStreamSource(new MediaStream([track]));
    meterSource.connect(analyser);
  } catch {
    analyser = null;
  }
  runMeter();
}

// Runs on the window that currently shows the stage, so a visible picture-in-picture window keeps it going.
// The waveform scrolls the loudest level of each step in from the end, so silence shows as a flat line.
function runMeter() {
  const token = ++meterToken;
  const samples = analyser && new Float32Array(analyser.fftSize);
  const levels = new Array(WAVE_BARS).fill(0);
  let peak = 0;
  let stepAt = 0;
  let shown = '';
  const tick = () => {
    if (token !== meterToken) return;
    if (samples) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      peak = Math.max(peak, Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6));
      if (Date.now() - stepAt >= WAVE_STEP_MS) {
        stepAt = Date.now();
        levels.shift();
        levels.push(peak);
        peak = 0;
        levels.forEach((level, i) => { waveBars[i].style.transform = `scaleY(${Math.max(.1, level).toFixed(2)})`; });
      }
    }
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (text !== shown) clockEl.textContent = shown = text;
    stageWindow().requestAnimationFrame(tick);
  };
  tick();
}

function stopMeter() {
  meterToken++;
  meterSource?.disconnect();
  meterSource = null;
  analyser = null;
  for (const bar of waveBars) bar.style.removeProperty('transform');
  audioCtx?.suspend().catch(() => {});
}

function showSource(text) {
  if (!liveSrc) {
    liveSrc = document.createElement('p');
    liveSrc.dir = 'auto';
    capSrc.append(liveSrc);
    while (capSrc.childElementCount > MAX_SOURCE_LINES) capSrc.firstElementChild.remove();
  }
  liveSrc.textContent = text;
}

const wordsOf = (text) => new Intl.Segmenter(tgtSel.value, { granularity: 'word' }).segment(text);

function splitCaption(text) {
  const probe = document.createElement('p');
  probe.style.cssText = `position: absolute; visibility: hidden; width: ${capTr.clientWidth}px`;
  capTr.append(probe);
  probe.textContent = 'あ';
  const limit = probe.offsetHeight * (MAX_CAPTION_LINES + .5);
  const fits = (s) => {
    probe.textContent = s;
    return probe.offsetHeight <= limit;
  };
  let end = text.length;
  if (!fits(text)) {
    let natural = 0;
    end = 0;
    for (const { segment, index } of wordsOf(text)) {
      if (end && !fits(text.slice(0, index + segment.length))) break;
      end = index + segment.length;
      if (BREAK_AFTER.test(segment)) natural = end;
    }
    if (natural * 2 >= end) end = natural;
  }
  probe.remove();
  end += text.slice(end).match(NO_PIECE_START)[0].length;
  const rest = text.slice(end).trim();
  if (rest.length <= MAX_JOINED_TAIL) return [text.trim(), ''];
  return [text.slice(0, end).trim(), rest];
}

function queueCaption(text) {
  captions.push(text);
  scheduleCaption();
}

const readTime = (text) => [...wordsOf(text)].filter((s) => s.isWordLike).length * HOLD_PER_WORD_MS;

// Timers run on the window that shows the stage: a hidden tab is throttled, a visible picture-in-picture window is not.
function scheduleCaption() {
  if (captionTimer || !(captionRest || captions.length)) return;
  captionWin = stageWindow();
  captionTimer = captionWin.setTimeout(showCaption, Math.max(0, holdUntil - Date.now()));
}

function cancelCaptionTimer() {
  if (!captionTimer) return false;
  try {
    captionWin.clearTimeout(captionTimer);
  } catch {}
  captionTimer = null;
  return true;
}

function showCaption() {
  captionTimer = null;
  while (captions.length > 1 && readTime(`${captionRest} ${captions.join(' ')}`) > MAX_LAG_MS) captions.shift();
  const [chunk, rest] = splitCaption(captionRest || captions.shift());
  captionRest = rest;
  const line = document.createElement('p');
  line.dir = 'auto';
  line.textContent = chunk;
  capTr.replaceChildren(line);
  holdUntil = Date.now() + Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, readTime(chunk)));
  scheduleCaption();
}

function clearCaptions() {
  cancelCaptionTimer();
  captions.length = 0;
  captionRest = '';
  holdUntil = 0;
  liveSrc = null;
  capTr.replaceChildren();
  capSrc.replaceChildren();
}

function commit(text, language = srcSel.value) {
  if (!text) return;
  showSource(text);
  liveSrc.lang = language;
  liveSrc = null;

  const item = document.createElement('li');
  const source = document.createElement('p');
  const translated = document.createElement('p');
  source.dir = translated.dir = 'auto';
  source.lang = language;
  translated.lang = tgtSel.value;
  source.textContent = text;
  translated.className = 'pending';
  item.append(source, translated);
  const pinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  logEl.append(item);
  if (pinned) logEl.scrollTop = logEl.scrollHeight;

  const id = session;
  finals.push({
    text,
    language,
    done(out) {
      translated.classList.remove('pending');
      translated.textContent = out ?? t('untranslated');
      if (out !== null && running && id === session) queueCaption(out);
    },
  });
  pump();
}

async function pump() {
  if (translating) return;
  translating = true;
  while (finals.length) {
    const job = finals.shift();
    let out = null;
    try {
      out = await translateText(job.text, job.language);
    } catch {}
    job.done(out);
  }
  translating = false;
}

async function translateText(text, source) {
  if (source === tgtSel.value) return text;
  if (mt() === 'plamo') return plamo.translate(text, auto() ? null : source, tgtSel.value);
  if (!translators.has(source)) {
    // A download needs a click, so mid-session only languages already in the browser can be translated.
    const options = { sourceLanguage: source, targetLanguage: tgtSel.value };
    if ((await Translator.availability(options)) !== 'available') throw new Error(`${source} is not downloaded`);
    translators.set(source, await Translator.create(options));
  }
  return translators.get(source).translate(text);
}

function languageChanged() {
  for (const translator of translators.values()) translator.destroy();
  translators.clear();
  plamo.resetHistory();
  if (!auto()) lastSrc = srcSel.value;
  capSrc.lang = auto() ? '' : srcSel.value;
  capTr.lang = tgtSel.value;
  savePrefs({ src: srcSel.value, tgt: tgtSel.value });
  check();
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function savePrefs(changes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...changes }));
  } catch {}
}

function initControls(prefs) {
  srcSel.add(new Option('auto', 'auto'));
  for (const sel of [srcSel, tgtSel]) {
    for (const code of LOCALES.keys()) sel.add(new Option(code, code));
  }
  const own = new Intl.Locale(navigator.language).maximize();
  const ownCode = own.script === 'Hant' ? 'zh-Hant' : own.language;
  const defaultTgt = LOCALES.has(ownCode) ? ownCode : 'en';
  tgtSel.value = LOCALES.has(prefs.tgt) ? prefs.tgt : defaultTgt;
  const chrome = engineInputs.find((input) => input.value === 'chrome');
  chrome.disabled = !SR.available;
  const chosen = chrome.disabled || prefs.engine === 'whisper' ? 'whisper' : 'chrome';
  engineInputs.find((input) => input.value === chosen).checked = true;
  lastSrc = LOCALES.has(prefs.src) ? prefs.src : tgtSel.value === 'en' ? 'ja' : 'en';
  const wantsAuto = chosen === 'whisper' && (prefs.src === 'auto' || !prefs.src);
  srcSel.value = wantsAuto ? 'auto' : lastSrc;
  capSrc.lang = auto() ? '' : srcSel.value;
  capTr.lang = tgtSel.value;
  mtInputs.find((input) => input.value === (prefs.mt === 'plamo' ? 'plamo' : 'chrome')).checked = true;
}

async function popOut() {
  try {
    const pip = await documentPictureInPicture.requestWindow(PIP_SIZE);
    pip.document.documentElement.lang = document.documentElement.lang;
    pip.document.documentElement.dir = document.documentElement.dir;
    pip.document.title = 'Tolk';
    // The picture-in-picture document has no base URL of its own, so the stylesheets are linked by their full URL.
    pip.document.head.append(
      ...[...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => Object.assign(link.cloneNode(), { href: link.href })),
    );
    pip.document.body.className = 'pip';
    pip.document.body.append(stage);
    pip.addEventListener('pagehide', () => {
      stageHome.prepend(stage);
      pipWindow = null;
      stageMoved();
    });
    pipWindow = pip;
    stageMoved();
  } catch (e) {
    setStatus('error', 'popFailed', { e: e.message });
  }
}

function stageMoved() {
  if (cancelCaptionTimer()) scheduleCaption();
  if (running) runMeter();
  render();
}

// The demo shows speech in another language turning into subtitles in the display language.
function demoPair(i) {
  return [(ui === 'en' ? I18N.ja : I18N.en).demo[i], I18N[ui].demo[i]];
}

function showDemo(i) {
  demoToken++;
  demoIndex = i;
  const [source, translation] = demoPair(i);
  demoSrc.lang = ui === 'en' ? 'ja' : 'en';
  demoSrc.textContent = source;
  demoTr.lang = htmlLang(ui);
  demoTr.textContent = translation;
}

function playDemo() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    for (;;) {
      const token = demoToken;
      await wait(2600);
      if (token !== demoToken) continue;
      const next = (demoIndex + 1) % I18N[ui].demo.length;
      const [source, translation] = demoPair(next);
      let typed = '';
      for (const { segment, isWordLike } of new Intl.Segmenter(demoSrc.lang, { granularity: 'word' }).segment(source)) {
        typed += segment;
        if (!isWordLike) continue;
        demoSrc.textContent = typed;
        await wait(160);
        if (token !== demoToken) break;
      }
      if (token !== demoToken) continue;
      demoSrc.textContent = source;
      await wait(300);
      if (token !== demoToken) continue;
      demoIndex = next;
      demoTr.textContent = translation;
      demoTr.animate([{ opacity: 0, transform: 'translateY(.15em)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
  })();
}

const prefs = loadPrefs();
for (const code of LOCALES.keys()) {
  const option = new Option(I18N[code].name, code);
  option.lang = htmlLang(code);
  uiSel.add(option);
}
uiSel.addEventListener('change', () => {
  applyLanguage(uiSel.value);
  savePrefs({ ui: uiSel.value });
});

if (supported) {
  initControls(prefs);
  applyLanguage(detectLanguage(prefs.ui));
  actionBtn.addEventListener('click', () => {
    if (checking || busy || running) return;
    if (pendingStep) prepare();
    else start();
  });
  srcSel.addEventListener('change', languageChanged);
  tgtSel.addEventListener('change', languageChanged);
  for (const input of engineInputs) {
    input.addEventListener('change', () => {
      savePrefs({ engine: engine() });
      // Whisper detects the spoken language by itself, so it starts on automatic detection; Chrome needs a language.
      if (engine() === 'whisper') srcSel.value = 'auto';
      else {
        whisper.unload();
        if (auto()) srcSel.value = lastSrc;
      }
      languageChanged();
    });
  }
  for (const input of mtInputs) {
    input.addEventListener('change', () => {
      savePrefs({ mt: mt() });
      plamo.resetHistory();
      if (mt() !== 'plamo') plamo.unload();
      check();
    });
  }
  swapBtn.addEventListener('click', () => {
    [srcSel.value, tgtSel.value] = [tgtSel.value, srcSel.value];
    swapBtn.toggleAttribute('data-flip');
    languageChanged();
  });
  popBtn.addEventListener('click', popOut);
  unpopBtn.addEventListener('click', () => pipWindow?.close());
  for (const button of [$('stop'), $('stop2')]) button.addEventListener('click', () => stop());
  clearBtn.addEventListener('click', () => logEl.replaceChildren());
  check();
} else {
  applyLanguage(detectLanguage(prefs.ui));
  playDemo();
}
