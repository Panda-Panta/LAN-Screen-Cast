// Real Windows output-loopback acceptance. Only the microphone input is a
// synthetic MediaStream; getDisplayMedia and the main capture handler stay real.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeEvidence } = require('./runtime-evidence');

const root = path.resolve(__dirname, '..');
const resultDir = path.join(root, 'test-results');
const packaged = !!process.env.LAN_CAST_EXECUTABLE;
const profile = path.join(root, '.cache', `system-audio-${packaged ? 'packaged' : 'source'}-${Date.now()}-${process.pid}`);
const settingsFile = path.join(profile, 'settings.json');
const SYSTEM_HZ = 440, MIC_HZ = 880;
const SYSTEM_GAIN = 0.03, MIC_GAIN = 0.04;
const reportFile = path.join(resultDir, `${packaged ? 'packaged-' : ''}system-audio-smoke.json`);
const execFileAsync = promisify(execFile);
let currentStep = 'not started';

function progress(message) {
  currentStep = message;
  console.log(`STEP ${new Date().toISOString()} ${message}`);
}

async function bounded(task, timeout, label) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeout} ms`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function saveReport(report) {
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
}

async function freePort() {
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function eventually(read, accept, label, timeout = 25000, stable = 1) {
  const deadline = Date.now() + timeout;
  let last, matches = 0;
  while (Date.now() < deadline) {
    last = await read();
    matches = accept(last) ? matches + 1 : 0;
    if (matches >= stable) return last;
    await delay(200);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function launch(errors, onLaunch) {
  progress('launch isolated Electron host');
  const application = await _electron.launch({
    executablePath: process.env.LAN_CAST_EXECUTABLE || require('electron'),
    args: packaged ? [] : [root],
    env: { ...process.env, LAN_CAST_DATA_DIR: profile }, timeout: 30000
  });
  // Retain ownership even if first-window initialization fails afterward.
  onLaunch(application);
  const host = await application.firstWindow();
  host.on('pageerror', error => errors.push({ page: 'host', message: error.message }));
  await host.waitForFunction(() => window.lan && document.querySelector('.source-card'));
  await host.locator('#rtmp-enabled').uncheck();
  await application.evaluate(() => { globalThis.__systemAcceptanceWindows = []; });
  return { application, host };
}

async function setSlider(host, id, value) {
  assert.equal(await host.locator(`#${id}`).isEnabled(), true, `${id} must remain usable in this scenario`);
  await host.locator(`#${id}`).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  assert.equal(await host.locator(`#${id}`).inputValue(), String(value));
  assert.match(await host.locator(`#${id}-value`).innerText(), new RegExp(`\\b${value}\\s*%`));
}

async function installHostObservation(host) {
  await host.evaluate(({ micHz, micGain }) => {
    const originalDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    const originalMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const originalContext = window.AudioContext;
    const observation = window.__systemAcceptance = {
      stage: '', syntheticMic: false, contextRole: 'production-mixer',
      displays: [], microphones: [], contexts: [], previews: [],
      restore() {
        navigator.mediaDevices.getDisplayMedia = originalDisplay;
        navigator.mediaDevices.getUserMedia = originalMic;
        window.AudioContext = originalContext;
      }
    };
    window.AudioContext = new Proxy(originalContext, {
      construct(target, args) {
        const context = Reflect.construct(target, args);
        observation.contexts.push({ context, stage: observation.stage, role: observation.contextRole });
        return context;
      }
    });
    navigator.mediaDevices.getDisplayMedia = async constraints => {
      // Observe the native result without replacing its stream or any track.
      const stream = await originalDisplay(constraints);
      observation.displays.push({ stage: observation.stage, constraints, stream, tracks: [...stream.getTracks()] });
      return stream;
    };
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!observation.syntheticMic || !constraints.audio || constraints.video) return originalMic(constraints);
      observation.contextRole = 'synthetic-microphone';
      let context;
      try { context = new AudioContext(); } finally { observation.contextRole = 'production-mixer'; }
      const oscillator = context.createOscillator(); oscillator.frequency.value = micHz;
      const gain = context.createGain(); gain.gain.value = micGain;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain); gain.connect(destination); oscillator.start();
      const stream = destination.stream, track = stream.getAudioTracks()[0];
      const nativeStop = track.stop.bind(track);
      let stopped = false;
      track.stop = () => {
        if (stopped) return;
        stopped = true;
        oscillator.stop(); nativeStop(); void context.close();
      };
      observation.microphones.push({ stage: observation.stage, stream, tracks: [...stream.getTracks()], context });
      try { await context.resume(); return stream; }
      catch (error) { track.stop(); throw error; }
    };
  }, { micHz: MIC_HZ, micGain: MIC_GAIN });
}

async function createToneFixture(application, errors) {
  progress('create and load actual Windows output fixture');
  const html = `<!doctype html><html><head><title>Windows system-audio output fixture</title></head>
    <body style="background:#1367c5;color:white;font:28px Segoe UI;padding:30px">
    <p>Actual Windows output loopback fixture</p><p id="clock"></p><button id="tone-start">Start quiet ${SYSTEM_HZ} Hz output</button>
    <script>
    setInterval(() => { document.querySelector('#clock').textContent = Date.now(); document.body.style.background = 'hsl(' + Date.now()/40%360 + ',60%,30%)'; }, 40);
    window.__outputTone = null;
    document.querySelector('#tone-start').addEventListener('click', async () => {
      if (window.__outputTone) return;
      const context = new AudioContext();
      const oscillator = context.createOscillator(); oscillator.frequency.value = ${SYSTEM_HZ};
      const gain = context.createGain(); gain.gain.value = ${SYSTEM_GAIN};
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
      window.__outputTone = { context, oscillator, gain, stopped: false };
      await context.resume(); document.querySelector('#tone-start').textContent = 'Actual output tone running';
    });
    window.__stopOutputTone = async () => {
      const tone = window.__outputTone;
      if (!tone || tone.stopped) return;
      tone.stopped = true; tone.oscillator.stop(); await tone.context.close();
    };
    </script></body></html>`;
  const ready = application.waitForEvent('window');
  await application.evaluate(async ({ BrowserWindow }, url) => {
    const win = new BrowserWindow({ width: 800, height: 500, title: 'Windows system-audio output fixture',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    globalThis.__systemAcceptanceWindows.push(win);
    // Playwright reports an Electron window after its first navigation.
    await win.loadURL(url);
  }, `data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const page = await ready;
  page.on('pageerror', error => errors.push({ page: 'output fixture', message: error.message }));
  progress('start quiet actual Windows output tone');
  await page.locator('#tone-start').click();
  await eventually(() => page.evaluate(() => ({ state: window.__outputTone?.context.state,
    gain: window.__outputTone?.gain.gain.value, time: window.__outputTone?.context.currentTime })),
  value => value.state === 'running' && value.time > 0.1 && value.gain > 0, 'actual Windows output tone did not run');
  return page;
}

async function setOutputGain(page, value) {
  await page.evaluate(next => {
    const tone = window.__outputTone;
    tone.gain.gain.setValueAtTime(next, tone.context.currentTime);
  }, value);
}

async function openViewer(application, invite, errors) {
  progress('create and load production receiver page');
  const ready = application.waitForEvent('window');
  const id = await application.evaluate(async ({ BrowserWindow }, url) => {
    const win = new BrowserWindow({ width: 900, height: 700, webPreferences: {
      partition: 'system-audio-receiver', sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false
    } });
    // Suppress this receiver's local output before it has any incoming stream.
    // It must never feed its own received audio back into Windows loopback.
    win.webContents.setAudioMuted(true);
    globalThis.__systemAcceptanceWindows.push(win);
    await win.loadURL(url);
    return win.id;
  }, invite);
  const page = await ready;
  page.on('pageerror', error => errors.push({ page: 'receiver', message: error.message }));
  // The production viewer creates its peer on Watch, so install the observer
  // after initial load and before the real join action; no reload is needed.
  await page.evaluate(() => {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args) {
        const peer = Reflect.construct(target, args); window.__systemAudioPeer = peer; return peer;
      }
    });
  });
  assert.equal(await page.evaluate(() => typeof window.lan), 'undefined');
  await page.locator('#device-name').fill('Actual system-loopback receiver');
  progress('connect receiver through production Watch action');
  await page.locator('#watch').click();
  await page.evaluate(() => { document.querySelector('#remote').muted = true; });
  await page.waitForFunction(() => document.querySelector('#remote').videoWidth > 0
    && document.querySelector('#remote').srcObject?.getAudioTracks().some(track => track.readyState === 'live'), null, { timeout: 30000 });
  progress('install received-stream frequency analyser');
  await page.evaluate(async () => {
    const stream = document.querySelector('#remote').srcObject;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const analyser = context.createAnalyser(); analyser.fftSize = 16384; analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -120; analyser.maxDecibels = 0;
    const quiet = context.createGain(); quiet.gain.value = 0;
    source.connect(analyser); analyser.connect(quiet); quiet.connect(context.destination);
    window.__systemAudioAnalysis = { context, source, analyser, quiet };
    await context.resume();
  });
  assert.equal(await application.evaluate(({ BrowserWindow }, windowId) =>
    BrowserWindow.fromId(windowId).webContents.isAudioMuted(), id), true);
  return { page, id };
}

async function audioSnapshot(page) {
  return page.evaluate(async ({ systemHz, micHz }) => {
    const peer = window.__systemAudioPeer, analysis = window.__systemAudioAnalysis;
    if (!peer || !analysis) return null;
    const stats = await peer.getStats();
    if (peer !== window.__systemAudioPeer) return null;
    const reports = [...stats.values()];
    const audio = reports.find(value => value.type === 'inbound-rtp' && value.kind === 'audio');
    const video = reports.find(value => value.type === 'inbound-rtp' && value.kind === 'video');
    const wave = new Float32Array(analysis.analyser.fftSize);
    const spectrum = new Float32Array(analysis.analyser.frequencyBinCount);
    analysis.analyser.getFloatTimeDomainData(wave); analysis.analyser.getFloatFrequencyData(spectrum);
    const binHz = analysis.context.sampleRate / analysis.analyser.fftSize;
    const peak = (hz, radius = 10) => {
      let db = -120;
      for (let bin = Math.max(0, Math.floor((hz - radius) / binHz)); bin <= Math.ceil((hz + radius) / binHz); bin++) {
        if (Number.isFinite(spectrum[bin])) db = Math.max(db, spectrum[bin]);
      }
      return db;
    };
    const tone = hz => {
      const db = peak(hz), floorDb = Math.max(peak(hz - 80), peak(hz + 80));
      return { hz, db, amplitude: Math.pow(10, db / 20), prominenceDb: db - floorDb };
    };
    const remote = document.querySelector('#remote');
    return { contextState: analysis.context.state, sampleRate: analysis.context.sampleRate,
      fftSize: analysis.analyser.fftSize, rms: Math.sqrt(wave.reduce((sum, sample) => sum + sample * sample, 0) / wave.length),
      system: tone(systemHz), microphone: tone(micHz),
      audioSamples: audio?.totalSamplesReceived || 0, audioBytes: audio?.bytesReceived || 0,
      audioEnergy: audio?.totalAudioEnergy || 0, audioCodec: stats.get(audio?.codecId)?.mimeType || '',
      videoFrames: video?.framesDecoded || 0, videoWidth: remote.videoWidth,
      remoteMuted: remote.muted, audioTracks: remote.srcObject?.getAudioTracks().map(track => ({ readyState: track.readyState, enabled: track.enabled })) || [] };
  }, { systemHz: SYSTEM_HZ, micHz: MIC_HZ });
}

const present = tone => tone?.amplitude > 0.0001 && tone.prominenceDb >= 8;
const dropped = (tone, baseline) => tone.amplitude <= Math.max(0.00005, baseline.amplitude * 0.16);
const retained = (tone, baseline) => present(tone) && tone.amplitude >= baseline.amplitude * 0.55;

async function measure(page, predicate, label, previousSamples = 0) {
  progress(`measure: ${label}`);
  return eventually(() => audioSnapshot(page), snapshot => snapshot?.contextState === 'running'
    && snapshot.audioSamples >= previousSamples + 4800 && snapshot.audioBytes > 2000
    && snapshot.videoFrames >= 3 && snapshot.videoWidth > 0 && snapshot.remoteMuted
    && snapshot.audioTracks.length === 1 && snapshot.audioTracks[0].readyState === 'live'
    && predicate(snapshot), label, 30000, 3);
}

async function start(host, stage) {
  progress(`start ${stage}`);
  await host.evaluate(name => { window.__systemAcceptance.stage = name; }, stage);
  await host.locator('#start').click();
  await host.waitForFunction(() => document.querySelector('#status-text').textContent === '正在广播'
    && document.querySelector('#preview').videoWidth > 0, null, { timeout: 30000 });
  return host.evaluate(() => {
    const observation = window.__systemAcceptance;
    const preview = document.querySelector('#preview');
    observation.previews.push({ stage: observation.stage, tracks: [...preview.srcObject.getTracks()] });
    const display = observation.displays.filter(value => value.stage === observation.stage).at(-1);
    return { previewMuted: preview.muted, previewAudioCount: preview.srcObject.getAudioTracks().length,
      rawDisplay: display?.tracks.map(track => ({ kind: track.kind, readyState: track.readyState, label: track.label })),
      nativeConstraints: display?.constraints };
  });
}

async function stopAndCheck(host, viewer, stage) {
  progress(`stop and verify owned resources: ${stage}`);
  await host.locator('#start').click();
  await host.waitForFunction(() => document.querySelector('#status-text').textContent === '尚未广播');
  const cleanup = await eventually(() => host.evaluate(name => {
    const observation = window.__systemAcceptance;
    return { displays: observation.displays.filter(value => value.stage === name).flatMap(value => value.tracks.map(track => ({ kind: track.kind, state: track.readyState }))),
      rawMicrophones: observation.microphones.filter(value => value.stage === name).flatMap(value => value.tracks.map(track => track.readyState)),
      mixed: observation.previews.filter(value => value.stage === name).flatMap(value => value.tracks.map(track => ({ kind: track.kind, state: track.readyState }))),
      contexts: observation.contexts.filter(value => value.stage === name).map(value => ({ role: value.role, state: value.context.state })),
      previewCleared: document.querySelector('#preview').srcObject === null };
  }, stage), value => value.displays.length >= 2 && value.mixed.length >= 2 && value.contexts.some(context => context.role === 'production-mixer')
    && value.displays.every(track => track.state === 'ended') && value.mixed.every(track => track.state === 'ended')
    && value.rawMicrophones.every(state => state === 'ended') && value.contexts.every(context => context.state === 'closed')
    && value.previewCleared, `${stage}: native / raw / mixed tracks or audio contexts leaked`);
  await viewer.page.waitForFunction(() => document.querySelector('#remote').srcObject === null);
  await viewer.page.evaluate(async () => { await window.__systemAudioAnalysis?.context.close(); });
  return cleanup;
}

async function closeOwnedFixtures(application) {
  await bounded(application.evaluate(async () => {
    for (const win of globalThis.__systemAcceptanceWindows || []) {
      if (win.isDestroyed()) continue;
      // A failed first navigation can leave executeJavaScript pending forever.
      // Explicit audio cleanup gets a bounded chance, then destroy this owned
      // fixture regardless; never enumerate or close unrelated app windows.
      await Promise.race([
        win.webContents.executeJavaScript('(async () => { await window.__stopOutputTone?.(); await window.__systemAudioAnalysis?.context.close(); })()').catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 1500))
      ]);
      if (!win.isDestroyed()) win.destroy();
    }
    globalThis.__systemAcceptanceWindows = [];
  }), 7000, 'owned fixture cleanup');
}

async function nativeClose(application) {
  progress('native close flushes latest settings');
  const closed = application.waitForEvent('close', { timeout: 15000 });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
}

async function main() {
  await fs.mkdir(resultDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), passed: false, checks: [],
    scope: 'same-PC production Electron screen/window capture, real Windows output loopback, real WebRTC/Opus decode and frequency analysis; microphone-only input fixture in mixed scenario',
    fixtures: { system: { hz: SYSTEM_HZ, gain: SYSTEM_GAIN, output: 'native AudioContext.destination, not a synthetic display audio track' },
      microphone: { hz: MIC_HZ, gain: MIC_GAIN, boundary: 'getUserMedia audio-only' }, receiverLocalOutputMuted: true },
    measurements: {} };
  const errors = [];
  const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  let application, host, tonePage;
  try {
    assert.equal(process.platform, 'win32', 'this acceptance script requires real Windows output loopback');
    ({ application, host } = await launch(errors, value => { application = value; }));
    Object.assign(report, await runtimeEvidence(application));
    await host.locator('.advanced > summary').click();
    await host.locator('#network').selectOption('127.0.0.1');
    await host.locator('#port').fill(String(await freePort()));
    await host.locator('#forwarding-enabled').uncheck();
    await host.locator('#resolution').selectOption('720');
    await host.locator('#fps').selectOption('30');
    await host.locator('#bitrate').fill('3');
    await host.locator('#microphone').uncheck();
    await host.locator('#system-audio').check();
    await setSlider(host, 'system-volume', 100);
    await installHostObservation(host);
    tonePage = await createToneFixture(application, errors);
    await host.locator('[data-source-tab="window"]').click();
    await host.locator('#refresh-sources').click();
    await host.locator('.source-card').filter({ hasText: 'Windows system-audio output fixture' }).click();
    report.windowCapture = await start(host, 'window-system-only');
    assert.equal(report.windowCapture.previewMuted, true);
    assert.equal(report.windowCapture.previewAudioCount, 1);
    assert.ok(report.windowCapture.rawDisplay.some(track => track.kind === 'audio' && track.readyState === 'live'), 'native display result must contain real loopback audio');
    const windowViewer = await openViewer(application, await host.locator('#invite-link').inputValue(), errors);
    const first = report.measurements.windowSystem = await measure(windowViewer.page, value => present(value.system) && value.rms > 0.0001,
      'real Windows output frequency did not reach the window-capture receiver (check the active Windows output device / output mute)');
    check('selected-window capture includes actual Windows output loopback; receiver decodes samples and detects 440 Hz');
    await setOutputGain(tonePage, 0);
    const outputOff = report.measurements.outputFixtureOff = await measure(windowViewer.page, value => dropped(value.system, first.system),
      'muting the actual Windows output fixture did not remove its received frequency', first.audioSamples);
    await setOutputGain(tonePage, SYSTEM_GAIN);
    const restored = report.measurements.outputFixtureRestored = await measure(windowViewer.page, value => retained(value.system, first.system),
      'restoring the actual Windows output fixture did not restore its received frequency', outputOff.audioSamples);
    check('receiver frequency follows the actual output fixture off/on, proving the loopback signal path');
    await setSlider(host, 'system-volume', 50);
    const half = report.measurements.windowSystemHalfVolume = await measure(windowViewer.page,
      value => present(value.system) && value.system.amplitude < restored.system.amplitude * 0.8 && value.system.amplitude > restored.system.amplitude * 0.2,
      'system 50% slider did not reduce received tone amplitude', restored.audioSamples);
    await setSlider(host, 'system-volume', 100);
    await measure(windowViewer.page, value => retained(value.system, first.system), 'system volume restore failed', half.audioSamples);
    report.windowCleanup = await stopAndCheck(host, windowViewer, 'window-system-only');
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), windowViewer.id);
    check('system volume updates live; stopping releases native display, mixed audio and AudioContext');

    await host.evaluate(() => { window.__systemAcceptance.stage = 'screen-mixed'; window.__systemAcceptance.syntheticMic = true; });
    await host.locator('[data-source-tab="screen"]').click();
    await host.locator('.source-card').first().click();
    await host.locator('#microphone').check();
    await host.waitForFunction(() => !document.querySelector('#microphone-status').textContent.startsWith('正在'));
    assert.equal(await host.locator('#microphone').isChecked(), true, 'microphone fixture must remain enabled');
    await setSlider(host, 'mic-volume', 100);
    report.screenMixedCapture = await start(host, 'screen-mixed');
    assert.equal(report.screenMixedCapture.previewMuted, true);
    assert.equal(report.screenMixedCapture.previewAudioCount, 1, 'two inputs must produce one sent audio track');
    assert.ok(report.screenMixedCapture.rawDisplay.some(track => track.kind === 'audio' && track.readyState === 'live'));
    const mixedViewer = await openViewer(application, await host.locator('#invite-link').inputValue(), errors);
    const mixed = report.measurements.mixedBoth = await measure(mixedViewer.page,
      value => present(value.system) && present(value.microphone), 'both loopback and microphone frequencies were not decoded');
    check('full-screen capture mixes real system output and the distinct microphone input into one WebRTC audio track');
    await setSlider(host, 'system-volume', 0);
    const systemZero = report.measurements.mixedSystemZero = await measure(mixedViewer.page,
      value => dropped(value.system, mixed.system) && retained(value.microphone, mixed.microphone),
      'system 0% must remove only 440 Hz while preserving microphone 880 Hz', mixed.audioSamples);
    await setSlider(host, 'system-volume', 100);
    const bothAgain = report.measurements.mixedSystemRestored = await measure(mixedViewer.page,
      value => retained(value.system, mixed.system) && retained(value.microphone, mixed.microphone),
      'system gain restore did not recover both inputs', systemZero.audioSamples);
    await setSlider(host, 'mic-volume', 50);
    const micHalf = report.measurements.mixedMicrophoneHalfVolume = await measure(mixedViewer.page,
      value => retained(value.system, mixed.system) && present(value.microphone)
        && value.microphone.amplitude < bothAgain.microphone.amplitude * 0.8 && value.microphone.amplitude > bothAgain.microphone.amplitude * 0.2,
      'microphone 50% must reduce only its own frequency', bothAgain.audioSamples);
    await setSlider(host, 'mic-volume', 100);
    const preMute = await measure(mixedViewer.page, value => retained(value.system, mixed.system) && retained(value.microphone, mixed.microphone),
      'microphone volume restore failed', micHalf.audioSamples);
    await host.locator('#mute').click();
    const micMuted = report.measurements.mixedMicrophoneMuted = await measure(mixedViewer.page,
      value => retained(value.system, mixed.system) && dropped(value.microphone, mixed.microphone),
      'microphone mute must leave system output audible', preMute.audioSamples);
    assert.equal(await host.evaluate(() => document.querySelector('#preview').srcObject.getAudioTracks()[0].enabled), true,
      'microphone mute must not disable the mixed system audio track');
    await host.locator('#mute').click();
    report.measurements.mixedUnmuted = await measure(mixedViewer.page,
      value => retained(value.system, mixed.system) && retained(value.microphone, mixed.microphone),
      'unmute did not restore both decoded inputs', micMuted.audioSamples);
    report.mixedCleanup = await stopAndCheck(host, mixedViewer, 'screen-mixed');
    check('independent system/microphone gains and microphone mute preserve the other input; mixed capture releases all owned tracks/contexts');

    await tonePage.evaluate(async () => { await window.__stopOutputTone(); });
    report.outputFixtureClosed = await tonePage.evaluate(() => window.__outputTone.context.state === 'closed');
    assert.equal(report.outputFixtureClosed, true);
    await closeOwnedFixtures(application);
    await host.evaluate(() => { window.__systemAcceptance.restore(); });
    await setSlider(host, 'system-volume', 37);
    await setSlider(host, 'mic-volume', 61);
    await host.locator('#room').fill('系统声音关闭恢复验收');
    // Deliberately do not wait for the debounce: native close must flush edits.
    await nativeClose(application); application = null;
    const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.equal(saved.systemAudio, true); assert.equal(saved.systemVolume, 37); assert.equal(saved.micVolume, 61);
    ({ application, host } = await launch(errors, value => { application = value; }));
    assert.equal(await host.locator('#system-audio').isChecked(), true);
    assert.equal(await host.locator('#system-volume').inputValue(), '37');
    assert.equal(await host.locator('#mic-volume').inputValue(), '61');
    assert.equal(await host.locator('#room').inputValue(), '系统声音关闭恢复验收');
    assert.equal(await host.evaluate(() => document.querySelector('#preview').srcObject), null);
    report.settingsRestore = { systemAudio: saved.systemAudio, systemVolume: saved.systemVolume,
      micVolume: saved.micVolume, nativeCloseFlushed: true, reopenedIdle: true };
    check('native close immediately after edits persists system audio and both volumes; restart restores settings without starting capture');
    assert.deepEqual(errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack; report.failureStage = currentStep; report.pageErrors = errors;
    process.exitCode = 1; console.error(error);
    // Persist the failing run before attempting diagnostics or cleanup. Even a
    // crashed/unloaded renderer must not hide its original failure evidence.
    await saveReport(report);
    if (host && !host.isClosed()) report.guiState = await bounded(host.evaluate(() => ({
      notice: document.querySelector('#notice')?.textContent, status: document.querySelector('#status-text')?.textContent,
      microphone: document.querySelector('#microphone-status')?.textContent,
      systemAudio: document.querySelector('#system-audio')?.checked,
      systemVolume: document.querySelector('#system-volume')?.value, micVolume: document.querySelector('#mic-volume')?.value,
      sources: [...document.querySelectorAll('.source-card')].map(card => card.title),
      resources: window.__systemAcceptance ? {
        displayTracks: window.__systemAcceptance.displays.flatMap(value => value.tracks.map(track => ({ kind: track.kind, state: track.readyState }))),
        contexts: window.__systemAcceptance.contexts.map(value => ({ stage: value.stage, role: value.role, state: value.context.state }))
      } : null
    })), 2500, 'failure GUI diagnostics').catch(() => null);
  } finally {
    report.pageErrors = errors;
    if (!report.passed) await saveReport(report);
    progress('bounded cleanup of this test application and fixtures');
    const cleanup = async (label, task, timeout = 2500) => {
      try { return await bounded(task, timeout, label); }
      catch (error) {
        (report.cleanupErrors ||= []).push(error.message);
        report.passed = false; process.exitCode = 1;
      }
    };
    if (application) {
      if (tonePage && !tonePage.isClosed()) await cleanup('stop actual output tone',
        tonePage.evaluate(async () => { await window.__stopOutputTone?.(); }));
      if (host && !host.isClosed()) {
        await cleanup('stop owned production broadcast', host.evaluate(() => {
          const button = document.querySelector('#start');
          if (button && !button.disabled && /停止|取消准备/.test(button.textContent)) button.click();
        }));
        await cleanup('release observed host resources', host.evaluate(async () => {
          const observation = window.__systemAcceptance;
          if (!observation) return;
          for (const input of [...observation.displays, ...observation.microphones, ...observation.previews]) {
            for (const track of input.tracks) if (track.readyState !== 'ended') track.stop();
          }
          for (const value of observation.contexts) if (value.context.state !== 'closed') await value.context.close().catch(() => {});
          observation.restore();
        }));
      }
      await cleanup('close owned fixture windows', closeOwnedFixtures(application), 7500);
      try { await bounded(application.close(), 10000, 'close test application'); }
      catch (error) {
        (report.cleanupErrors ||= []).push(error.message); report.passed = false; process.exitCode = 1;
        // Only the exact process launched by this test is eligible for forced
        // cleanup. Its unique LAN_CAST_DATA_DIR separates it from the user's
        // existing 1.1 instance; do not kill by executable name.
        const child = application.process(), pid = child?.pid;
        if (Number.isSafeInteger(pid) && pid > 0 && child.exitCode === null && child.signalCode === null) {
          await cleanup('terminate owned test process tree',
            execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }), 6000);
        }
      }
    }
    if (errors.length) {
      report.passed = false;
      report.error ||= 'Renderer page errors occurred; see pageErrors.';
      process.exitCode = 1;
    }
    await saveReport(report);
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
