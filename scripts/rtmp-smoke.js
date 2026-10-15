// Same-PC native RTMP acceptance. Run only from the main agent's serial desktop
// queue. Native getDisplayMedia / Windows loopback and the final production mixer
// remain real; only the microphone input is an explicit fixture. Hardware and
// software H.264 / HEVC all require decoded media, not a capability
// declaration. No RTMP receiver outputs to speakers.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeEvidence } = require('./runtime-evidence');

const root = path.resolve(__dirname, '..');
const packaged = !!process.env.LAN_CAST_EXECUTABLE;
const mediaRoot = packaged
  ? path.join(path.dirname(process.env.LAN_CAST_EXECUTABLE), 'resources', 'media')
  : path.join(root, 'vendor', 'media');
const binDir = path.join(mediaRoot, 'bin');
const ffmpeg = path.join(binDir, 'ffmpeg.exe');
const ffprobe = path.join(binDir, 'ffprobe.exe');
const profile = path.join(root, '.cache', `rtmp-${packaged ? 'packaged' : 'source'}-${Date.now()}-${process.pid}`);
const resultDir = path.join(root, 'test-results');
const reportFile = path.join(resultDir, `${packaged ? 'packaged-' : ''}rtmp-smoke.json`);
const settingsFile = path.join(profile, 'settings.json');
const execFileAsync = promisify(execFile);
const SYSTEM_HZ = 440, MIC_HZ = 880, SYSTEM_GAIN = 0.03, MIC_GAIN = 0.04;
const SAMPLE_RATE = 48000, WINDOW_SAMPLES = SAMPLE_RATE;
const decoders = new Set();
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

async function eventually(read, accept, label, timeout = 30000, stable = 1) {
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

// Invitations and private addresses stay in this process's variables. Even an
// FFmpeg/auth failure must not publish the current random viewing credentials.
function publicReport(value) {
  if (typeof value === 'string') return value
    .replace(/\b(?:rtmp|https?|wss?):\/\/[^\s"'<>]+/gi, '[session address redacted]')
    .replace(/\b(token|password|pin|generation)=[^\s&]+/gi, '$1=[redacted]');
  if (Array.isArray(value)) return value.map(publicReport);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['token', 'pin', 'localurl', 'forwardedurl', 'inviteurl', 'address', 'label', 'commandline'].includes(key.toLowerCase()))
    .map(([key, item]) => [key, publicReport(item)]));
  return value;
}

async function saveReport(report) {
  await fs.writeFile(reportFile, JSON.stringify(publicReport(report), null, 2));
}

async function freePort(except = []) {
  for (;;) {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    if (!except.includes(port) && port >= 1024) return port;
  }
}

async function portState(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish('OPEN'));
    socket.once('error', error => finish(error.code));
    socket.setTimeout(800, () => finish('TIMEOUT'));
  });
}

async function released(port) {
  return eventually(() => portState(port), value => value === 'ECONNREFUSED',
    `owned TCP listener ${port} remained open`, 15000, 2);
}

async function processSnapshot(ownedPids = []) {
  assert.ok(ownedPids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  // Read command lines only for confirmed application-owned native children.
  // The general tree inventory needs parent IDs, never unrelated credentials.
  const command = ownedPids.length
    ? `Get-CimInstance Win32_Process -Filter '${ownedPids.map(pid => `ProcessId = ${pid}`).join(' OR ')}' | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`
    : 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    command],
  { windowsHide: true, timeout: 12000, maxBuffer: 8 * 1024 * 1024 });
  const rows = JSON.parse(result.stdout.trim() || '[]');
  return Array.isArray(rows) ? rows : [rows];
}

async function ownedSidecars(application) {
  const parent = application.process()?.pid;
  assert.ok(Number.isSafeInteger(parent) && parent > 0, 'test application has no owned PID');
  const rows = await processSnapshot();
  const descendants = new Set([parent]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ParentProcessId) && !descendants.has(row.ProcessId)) {
      descendants.add(row.ProcessId); changed = true;
    }
  }
  const native = rows.filter(row => descendants.has(row.ProcessId) && /^(?:ffmpeg|mediamtx)\.exe$/i.test(row.Name));
  const details = native.length ? await processSnapshot(native.map(row => row.ProcessId)) : [];
  return details
    .map(row => ({ pid: row.ProcessId, name: row.Name.toLowerCase(), executablePath: row.ExecutablePath, commandLine: row.CommandLine }));
}

async function sidecarsGone(owned) {
  if (!owned.length) return;
  const expected = new Set(owned.map(row => row.pid));
  await eventually(async () => (await processSnapshot()).filter(row => expected.has(row.ProcessId)),
    rows => rows.length === 0, 'owned native subprocesses survived stop', 20000);
}

async function launch(errors, onLaunch) {
  progress('launch isolated production Electron host');
  const application = await _electron.launch({
    executablePath: process.env.LAN_CAST_EXECUTABLE || require('electron'), args: packaged ? [] : [root],
    env: { ...process.env, LAN_CAST_DATA_DIR: profile }, timeout: 30000
  });
  onLaunch(application);
  const host = await application.firstWindow();
  host.on('pageerror', error => errors.push({ page: 'host', message: error.message }));
  await host.waitForFunction(() => window.lan && document.querySelector('.source-card'));
  await application.evaluate(() => { globalThis.__rtmpAcceptanceWindows = []; });
  return { application, host };
}

async function setField(host, id, value) {
  await host.locator(`#${id}`).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function setSlider(host, id, value) {
  assert.equal(await host.locator(`#${id}`).isEnabled(), true);
  await setField(host, id, value);
  assert.equal(await host.locator(`#${id}`).inputValue(), String(value));
}

async function verifyLayout(application, host) {
  const win = await application.browserWindow(host), layouts = [];
  try {
    for (const [width, height] of [[1250, 900], [1024, 720]]) {
      await win.evaluate((window, size) => window.setSize(...size), [width, height]);
      await host.locator('#copy-rtmp').scrollIntoViewIfNeeded();
      const layout = await host.evaluate(() => {
        const button = document.querySelector('#copy-rtmp').getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
          copyTop: button.top, copyBottom: button.bottom };
      });
      assert.ok(layout.scrollWidth <= layout.width, 'host must not overflow horizontally');
      assert.ok(layout.copyTop >= 82 && layout.copyBottom <= layout.height, 'RTMP copy must be reachable inside its panel');
      layouts.push(layout);
      await host.screenshot({ path: path.join(resultDir, `${packaged ? 'packaged-' : ''}rtmp-${width}x${height}.png`) });
    }
  } finally { await win.evaluate(window => window.setSize(1250, 900)); await win.dispose(); }
  return layouts;
}

async function installObservation(host) {
  await host.evaluate(({ micHz, micGain }) => {
    const nativeDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    const nativeMic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const NativeContext = window.AudioContext, NativeRecorder = window.MediaRecorder;
    const observation = window.__rtmpAcceptance = {
      stage: 'setup', syntheticMic: true, contextRole: 'production-mixer',
      displays: [], microphones: [], contexts: [], previews: [], recorders: [], viewers: [], rtmp: null,
      restore() {
        navigator.mediaDevices.getDisplayMedia = nativeDisplay;
        navigator.mediaDevices.getUserMedia = nativeMic;
        window.AudioContext = NativeContext; window.MediaRecorder = NativeRecorder;
      }
    };
    window.lan.onEvent(({ type, payload }) => {
      if (type === 'viewers') observation.viewers = payload;
      if (type === 'rtmp-state') observation.rtmp = payload;
      if (type === 'session-info' && payload.info?.rtmp) observation.rtmp = payload.info.rtmp;
    });
    window.AudioContext = new Proxy(NativeContext, {
      construct(target, args) {
        const context = Reflect.construct(target, args);
        observation.contexts.push({ context, stage: observation.stage, role: observation.contextRole });
        return context;
      }
    });
    window.MediaRecorder = new Proxy(NativeRecorder, {
      construct(target, args) {
        const recorder = Reflect.construct(target, args);
        observation.recorders.push({ stage: observation.stage, recorder, stream: args[0], mime: recorder.mimeType });
        return recorder;
      }
    });
    navigator.mediaDevices.getDisplayMedia = async constraints => {
      const stream = await nativeDisplay(constraints);
      observation.displays.push({ stage: observation.stage, constraints, tracks: [...stream.getTracks()] });
      return stream;
    };
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (!observation.syntheticMic || !constraints.audio || constraints.video) return nativeMic(constraints);
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
        stopped = true; oscillator.stop(); nativeStop(); void context.close();
      };
      observation.microphones.push({ stage: observation.stage, tracks: [...stream.getTracks()] });
      try { await context.resume(); return stream; }
      catch (error) { track.stop(); throw error; }
    };
  }, { micHz: MIC_HZ, micGain: MIC_GAIN });
}

async function fixtureWindow(application, htmlOrUrl, errors, kind) {
  const ready = application.waitForEvent('window', { timeout: 15000 });
  const id = await application.evaluate(async ({ BrowserWindow }, { url, kind }) => {
    const win = new BrowserWindow({ width: 850, height: 600, title: kind,
      webPreferences: { partition: 'rtmp-acceptance-fixtures', sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false } });
    globalThis.__rtmpAcceptanceWindows.push(win);
    if (kind !== 'RTMP Windows output fixture') win.webContents.setAudioMuted(true);
    // loadURL must precede awaiting the Playwright window event: an unnavigated
    // BrowserWindow is not yet surfaced by Playwright's Electron bridge.
    await win.loadURL(url);
    return win.id;
  }, { url: htmlOrUrl, kind });
  const page = await ready;
  page.on('pageerror', error => errors.push({ page: kind, message: error.message }));
  return { id, page };
}

async function createTone(application, errors) {
  progress('create quiet actual Windows output tone and moving capture window');
  const html = `<!doctype html><html><head><title>RTMP Windows output fixture</title></head>
    <body style="background:#1263bd;color:white;font:28px Segoe UI;padding:30px">
    <p>Native RTMP capture fixture</p><p id="clock"></p><button id="tone-start">Start quiet ${SYSTEM_HZ} Hz output</button>
    <script>
    setInterval(() => { document.querySelector('#clock').textContent = Date.now(); document.body.style.background = 'hsl(' + Date.now()/40%360 + ',60%,30%)'; }, 40);
    document.querySelector('#tone-start').onclick = async () => {
      if (window.__outputTone) return;
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = ${SYSTEM_HZ}; gain.gain.value = ${SYSTEM_GAIN};
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
      window.__outputTone = { context, oscillator, gain, stopped: false };
      await context.resume(); document.querySelector('#tone-start').textContent = 'Actual Windows output running';
    };
    window.__stopOutputTone = async () => {
      const tone = window.__outputTone;
      if (!tone || tone.stopped) return;
      tone.stopped = true; tone.oscillator.stop(); await tone.context.close();
    };
    </script></body></html>`;
  const fixture = await fixtureWindow(application, `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, errors,
    'RTMP Windows output fixture');
  await fixture.page.locator('#tone-start').click();
  await eventually(() => fixture.page.evaluate(() => ({ state: window.__outputTone?.context.state,
    time: window.__outputTone?.context.currentTime })), value => value.state === 'running' && value.time > 0.1,
  'actual Windows output tone did not start');
  return fixture;
}

async function openViewer(application, invite, errors, { admitted = true } = {}) {
  progress(admitted ? 'join production web receiver beside RTMP' : 'attempt another web receiver at shared capacity');
  const viewer = await fixtureWindow(application, invite, errors, admitted ? 'RTMP companion web receiver' : 'capacity-denied web receiver');
  await viewer.page.evaluate(() => {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args) { const peer = Reflect.construct(target, args); window.__rtmpWebPeer = peer; return peer; }
    });
  });
  assert.equal(await viewer.page.evaluate(() => typeof window.lan), 'undefined');
  await viewer.page.locator('#device-name').fill(admitted ? 'RTMP companion web receiver' : 'Capacity must reject this receiver');
  await viewer.page.locator('#watch').click();
  await viewer.page.evaluate(() => { document.querySelector('#remote').muted = true; });
  if (admitted) await webFrames(viewer.page);
  else await viewer.page.waitForFunction(() => /人数|上限|已满/.test(document.querySelector('#error').textContent
    + document.querySelector('#connection-text').textContent), null, { timeout: 15000 });
  return viewer;
}

async function webFrames(page, previous = 0) {
  return eventually(() => page.evaluate(async () => {
    const peer = window.__rtmpWebPeer;
    if (!peer) return null;
    const stats = [...(await peer.getStats()).values()];
    const video = stats.find(row => row.type === 'inbound-rtp' && row.kind === 'video');
    const remote = document.querySelector('#remote');
    return { framesDecoded: video?.framesDecoded || 0, videoBytes: video?.bytesReceived || 0,
      width: remote.videoWidth, height: remote.videoHeight, receiverOutputMuted: remote.muted,
      audioTracks: remote.srcObject?.getAudioTracks().length || 0, peerState: peer.connectionState };
  }), value => value?.framesDecoded >= previous + 3 && value.videoBytes > 0 && value.width > 0
    && value.receiverOutputMuted && value.peerState === 'connected', 'web receiver did not decode simultaneous video', 30000, 2);
}

async function start(host, stage, { expectRtmp = true } = {}) {
  progress(`start production broadcast: ${stage}`);
  await host.evaluate(stage => {
    const observation = window.__rtmpAcceptance;
    observation.stage = stage; observation.rtmp = null;
  }, stage);
  await host.locator('#start').click();
  await host.waitForFunction(() => document.querySelector('#status-text').textContent === '正在广播'
    && document.querySelector('#preview').videoWidth > 0, null, { timeout: 30000 });
  if (expectRtmp) await host.waitForFunction(() => window.__rtmpAcceptance.rtmp?.phase === 'ready'
    && document.querySelector('#rtmp-link').value.startsWith('rtmp://')
    && !document.querySelector('#copy-rtmp').disabled, null, { timeout: 45000 });
  else await host.waitForFunction(() => window.__rtmpAcceptance.rtmp?.phase === 'error', null, { timeout: 30000 });
  return host.evaluate(stage => {
    const observation = window.__rtmpAcceptance, preview = document.querySelector('#preview');
    observation.previews.push({ stage, tracks: [...preview.srcObject.getTracks()] });
    const displays = observation.displays.filter(value => value.stage === stage);
    const recorder = observation.recorders.filter(value => value.stage === stage).at(-1);
    return { previewMuted: preview.muted, finalAudioTracks: preview.srcObject.getAudioTracks().length,
      nativeCaptureCalls: displays.length, nativeLoopbackPresent: displays.some(value => value.tracks.some(track => track.kind === 'audio' && track.readyState === 'live')),
      recorderMime: recorder?.mime || '', recorderUsesFinalStream: !!recorder && recorder.stream === preview.srcObject,
      rtmpPhase: observation.rtmp?.phase, rtmpCodec: observation.rtmp?.codec,
      rtmpEncoder: observation.rtmp?.encoder, rtmpHardware: observation.rtmp?.hardware };
  }, stage);
}

async function assertEncoder(host, capture, codec, hardware, sidecars) {
  assert.match(capture.rtmpCodec, codec === 'HEVC' ? /HEVC|H\.?265/i : /H\.?264/i);
  assert.equal(capture.rtmpHardware, hardware, 'RTMP must report the actual requested hardware/software mode');
  assert.match(capture.rtmpEncoder, /^[a-z0-9_]+$/i);
  const producer = sidecars.find(row => row.name === 'ffmpeg.exe' && row.commandLine?.includes(capture.rtmpEncoder));
  assert.ok(producer, 'running owned FFmpeg command must use the encoder shown in session state');
  const encoderPattern = new RegExp(`(?:-c:v|-codec:v|-vcodec)"?\\s+"?${capture.rtmpEncoder}(?:[\\s"]|$)`);
  assert.match(producer.commandLine, encoderPattern, 'actual publisher arguments must select the reported encoder');
  if (hardware) {
    assert.match(capture.rtmpEncoder, /(?:nvenc|qsv|amf|mf)$/i);
    if (/_mf$/i.test(capture.rtmpEncoder)) assert.match(producer.commandLine, /-hw_encoding"?\s+"?(?:1|true)(?:[\s"]|$)/i);
  } else {
    assert.doesNotMatch(capture.rtmpEncoder, /(?:nvenc|qsv|amf)$/i);
    if (/_mf$/i.test(capture.rtmpEncoder)) assert.match(producer.commandLine, /-hw_encoding"?\s+"?(?:0|false)(?:[\s"]|$)/i);
  }
  const status = await host.locator('#rtmp-status').textContent();
  assert.match(status, hardware ? /硬件/ : /软件/, 'GUI must state the actual encoder mode');
  return { codec, encoder: capture.rtmpEncoder, hardware,
    confirmedByOwnedPublisherArguments: true, statusStatesActualAcceleration: true };
}

async function hostViewers(host, expected) {
  return eventually(() => host.evaluate(() => ({ count: Number(document.querySelector('#viewer-count').textContent),
    protocols: window.__rtmpAcceptance.viewers.map(viewer => viewer.protocol),
    rtmp: window.__rtmpAcceptance.viewers.filter(viewer => viewer.protocol === 'rtmp').length })),
  value => value.count === expected && value.protocols.length === expected,
  `shared viewer count did not reach ${expected}`, 20000, 2);
}

function createDecoder(url, name, codec = 'H264') {
  progress(`start bundled FFmpeg RTMP decoder: ${name}`);
  const captureFile = path.join(profile, `${name}.mkv`);
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-y', '-rw_timeout', '8000000',
    '-rtmp_live', 'live', ...(codec === 'HEVC' ? ['-rtmp_enhanced_codecs', 'hvc1'] : []), '-i', url,
    '-map', '0:v:0', '-vf', 'showinfo', '-an', '-f', 'null', 'NUL',
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'matroska', captureFile],
  { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: binDir });
  const decoder = { child, captureFile, name, samples: 0, frames: 0, stderr: '', carry: Buffer.alloc(0),
    pcm: new Float32Array(SAMPLE_RATE * 3), closed: false, exitCode: null, spawnError: null };
  decoders.add(decoder);
  decoder.done = new Promise(resolve => {
    child.once('error', error => { decoder.spawnError = error.message; });
    child.once('close', (code, signal) => { decoder.closed = true; decoder.exitCode = code; decoder.signal = signal; resolve(); });
  });
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    const data = decoder.carry.length ? Buffer.concat([decoder.carry, chunk]) : chunk;
    const length = data.length - data.length % 4;
    for (let offset = 0; offset < length; offset += 4) decoder.pcm[decoder.samples++ % decoder.pcm.length] = data.readFloatLE(offset);
    decoder.carry = Buffer.from(data.subarray(length));
  });
  child.stderr.on('data', chunk => {
    const message = chunk.toString('utf8');
    // showinfo supplies actual decoder-frame evidence, independent of packets or
    // MIME capability. Keep only a bounded diagnostic tail, never the full log.
    decoder.frames += (message.match(/\bn:\s*\d+\s+pts:/g) || []).length;
    decoder.stderr = (decoder.stderr + message).slice(-65536);
  });
  return decoder;
}

function pcmEvidence(decoder) {
  const count = Math.min(decoder.samples, WINDOW_SAMPLES);
  if (!count) return { samples: decoder.samples, decodedFrames: decoder.frames, rms: 0, system: { amplitude: 0 }, microphone: { amplitude: 0 } };
  let squares = 0, systemSin = 0, systemCos = 0, micSin = 0, micCos = 0;
  const start = decoder.samples - count;
  for (let index = 0; index < count; index++) {
    const sample = decoder.pcm[(start + index) % decoder.pcm.length];
    if (!Number.isFinite(sample)) throw new Error('bundled RTMP decoder returned non-finite PCM');
    squares += sample * sample;
    const seconds = index / SAMPLE_RATE;
    systemSin += sample * Math.sin(2 * Math.PI * SYSTEM_HZ * seconds);
    systemCos += sample * Math.cos(2 * Math.PI * SYSTEM_HZ * seconds);
    micSin += sample * Math.sin(2 * Math.PI * MIC_HZ * seconds);
    micCos += sample * Math.cos(2 * Math.PI * MIC_HZ * seconds);
  }
  return { samples: decoder.samples, analysedSamples: count, decodedFrames: decoder.frames,
    rms: Math.sqrt(squares / count), system: { hz: SYSTEM_HZ, amplitude: 2 * Math.hypot(systemSin, systemCos) / count },
    microphone: { hz: MIC_HZ, amplitude: 2 * Math.hypot(micSin, micCos) / count } };
}

const present = tone => tone.amplitude > 0.0001;
const retained = (tone, previous) => tone.amplitude > previous.amplitude * 0.55 && tone.amplitude < previous.amplitude * 1.6;
const dropped = (tone, previous) => tone.amplitude < previous.amplitude * 0.2;

async function measure(decoder, predicate, label, after = decoder.samples) {
  return eventually(() => {
    if (decoder.closed) throw new Error(`${label}: RTMP decoder exited ${decoder.exitCode}: ${publicReport(decoder.stderr)}`);
    const evidence = pcmEvidence(decoder);
    return { ...evidence, decoderRunning: !decoder.closed };
  }, value => value.samples >= after + WINDOW_SAMPLES && value.decodedFrames >= 3 && value.rms > 0.0001 && predicate(value),
  label, 30000, 3);
}

async function closeDecoder(decoder) {
  if (!decoder || decoder.closed) return;
  // q gives FFmpeg a chance to finish the diagnostic Matroska copy. Escalation
  // targets only this exact ChildProcess PID, never all FFmpeg instances.
  decoder.child.stdin.write('q\n');
  try { await bounded(decoder.done, 4000, `graceful ${decoder.name} decoder close`); }
  catch {
    const child = decoder.child;
    if (!decoder.closed && Number.isSafeInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null) {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true });
    }
    await bounded(decoder.done, 6000, `owned ${decoder.name} decoder termination`);
  }
}

async function probeCapture(decoder, expectedVideoCodec = 'h264') {
  assert.equal(decoder.closed, true, 'finalize decoder capture before codec/frame probing');
  assert.equal(decoder.exitCode, 0, `decoder did not shut down cleanly: ${publicReport(decoder.stderr)}`);
  const result = await execFileAsync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=index,codec_name,codec_type,width,height,nb_read_frames,sample_rate,channels', '-of', 'json', decoder.captureFile],
  { windowsHide: true, shell: false, cwd: binDir, timeout: 20000, maxBuffer: 1024 * 1024 });
  const streams = JSON.parse(result.stdout).streams;
  const video = streams.find(row => row.codec_type === 'video'), audio = streams.find(row => row.codec_type === 'audio');
  assert.equal(video?.codec_name, expectedVideoCodec); assert.equal(audio?.codec_name, 'aac');
  assert.ok(Number(video.nb_read_frames) >= 3 && Number(audio.nb_read_frames) >= 3,
    `ffprobe must decode real ${expectedVideoCodec} and AAC frames`);
  assert.ok(video.width > 0 && video.height > 0 && Number(audio.sample_rate) > 0);
  return { streams, liveDecodedVideoFrames: decoder.frames, liveDecodedAudioSamples: decoder.samples,
    finalizedCapture: true, receiverSpeakerOutput: false };
}

async function expectDenied(url, name) {
  const decoder = createDecoder(url, name);
  try {
    await bounded(decoder.done, 15000, `${name}: unauthorized RTMP reader was not rejected`);
    assert.equal(decoder.spawnError, null);
    assert.equal(decoder.frames, 0); assert.equal(decoder.samples, 0);
    assert.notEqual(decoder.exitCode, 0, 'invalid/full RTMP read must fail rather than decode silently');
    return { rejected: true, decodedFrames: decoder.frames, decodedSamples: decoder.samples };
  } finally { await closeDecoder(decoder); }
}

async function stopAndCheck(host, stage, ports, sidecars, viewers = []) {
  progress(`stop and release production capture, listeners and native processes: ${stage}`);
  await host.locator('#start').click();
  await host.waitForFunction(() => document.querySelector('#status-text').textContent === '尚未广播');
  const cleanup = await eventually(() => host.evaluate(stage => {
    const observation = window.__rtmpAcceptance;
    return { displayStates: observation.displays.filter(value => value.stage === stage).flatMap(value => value.tracks.map(track => track.readyState)),
      mixedStates: observation.previews.filter(value => value.stage === stage).flatMap(value => value.tracks.map(track => track.readyState)),
      microphoneStates: observation.microphones.filter(value => value.stage === stage).flatMap(value => value.tracks.map(track => track.readyState)),
      contextStates: observation.contexts.filter(value => value.stage === stage).map(value => value.context.state),
      recorderStates: observation.recorders.filter(value => value.stage === stage).map(value => value.recorder.state),
      previewCleared: document.querySelector('#preview').srcObject === null,
      rtmpAddressCleared: document.querySelector('#rtmp-link').value === '',
      copyRtmpDisabled: document.querySelector('#copy-rtmp').disabled };
  }, stage), value => value.displayStates.length >= 2 && value.mixedStates.length >= 2
    && value.displayStates.every(state => state === 'ended') && value.mixedStates.every(state => state === 'ended')
    && value.microphoneStates.every(state => state === 'ended') && value.contextStates.every(state => state === 'closed')
    && value.recorderStates.every(state => state === 'inactive') && value.previewCleared && value.rtmpAddressCleared && value.copyRtmpDisabled,
  `${stage}: native capture / mixed stream / recorder / contexts were not all released`);
  for (const viewer of viewers) if (!viewer.page.isClosed()) await viewer.page.waitForFunction(() => document.querySelector('#remote').srcObject === null);
  for (const port of ports) await released(port);
  await sidecarsGone(sidecars);
  return { ...cleanup, listenersReleased: true, nativeProcessesReleased: true };
}

async function closeFixtures(application) {
  await bounded(application.evaluate(async () => {
    for (const win of globalThis.__rtmpAcceptanceWindows || []) {
      if (win.isDestroyed()) continue;
      await Promise.race([win.webContents.executeJavaScript('(async () => { await window.__stopOutputTone?.(); })()').catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 1500))]);
      if (!win.isDestroyed()) win.destroy();
    }
    globalThis.__rtmpAcceptanceWindows = [];
  }), 10000, 'owned fixture-window cleanup');
}

async function nativeClose(application) {
  const closed = application.waitForEvent('close', { timeout: 15000 });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
}

async function nativeHashes() {
  const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  return { ffmpegSha256: await hash(ffmpeg), ffprobeSha256: await hash(ffprobe),
    manifestSha256: await hash(path.join(mediaRoot, 'manifest.json')), binariesFromCurrentCandidate: true };
}

async function main() {
  await fs.mkdir(resultDir, { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  const report = { startedAt: new Date().toISOString(), passed: false, checks: [],
    scope: 'same-PC production native selected-window capture and real Windows output loopback, final mixed MediaStream, bundled MediaMTX/FFmpeg RTMP hardware/software H.264 and HEVC with actual video/AAC decode alongside a production web receiver; explicit synthetic microphone input only',
    fixtures: { system: { hz: SYSTEM_HZ, gain: SYSTEM_GAIN, output: 'actual AudioContext.destination -> Windows output loopback' },
      microphone: { hz: MIC_HZ, gain: MIC_GAIN, boundary: 'getUserMedia audio-only input' },
      receiverLocalOutputMuted: true }, measurements: {} };
  const errors = [];
  const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  let application, host, tone, conflictServer;
  const observedSidecars = [];
  try {
    assert.equal(process.platform, 'win32', 'RTMP audio acceptance requires native Windows output loopback');
    report.receiverRuntime = await nativeHashes();
    ({ application, host } = await launch(errors, value => { application = value; }));
    Object.assign(report, await runtimeEvidence(application)); report.appVersion = report.version;
    assert.equal(await host.locator('#save-invite').count(), 0);
    assert.equal(await host.evaluate(() => typeof window.lan.saveInvite), 'undefined');
    for (const method of ['beginRtmp', 'appendRtmp', 'finishRtmp']) assert.equal(await host.evaluate(name => typeof window.lan[name], method), 'function');
    check('URL-file export control and preload API are absent; limited RTMP IPC is present');
    await host.locator('.advanced > summary').click();
    await host.locator('#network').selectOption('127.0.0.1');
    const webPort = await freePort(), rtmpPort = await freePort([webPort]), forwardedRtmpPort = 21935;
    await host.locator('#port').fill(String(webPort));
    await host.locator('#rtmp-enabled').check();
    await host.locator('#rtmp-port').fill(String(rtmpPort));
    await host.locator('#rtmp-codec').selectOption('H264');
    await host.locator('#rtmp-acceleration').selectOption('hardware');
    await setField(host, 'advertised-rtmp-port', forwardedRtmpPort);
    await host.locator('#forwarding-enabled').uncheck();
    await host.locator('#resolution').selectOption('720');
    await host.locator('#fps').selectOption('30');
    await host.locator('#codec').selectOption('VP8');
    await host.locator('#bitrate').fill('3');
    await host.locator('#max-viewers').fill('2');
    await installObservation(host);
    await host.locator('#system-audio').check();
    await host.locator('#microphone').check();
    await host.waitForFunction(() => !document.querySelector('#microphone-status').textContent.startsWith('正在'));
    assert.equal(await host.locator('#microphone').isChecked(), true);
    await setSlider(host, 'system-volume', 100); await setSlider(host, 'mic-volume', 100);
    tone = await createTone(application, errors);
    await host.locator('[data-source-tab="window"]').click();
    await host.locator('#refresh-sources').click();
    await host.locator('.source-card').filter({ hasText: 'RTMP Windows output fixture' }).click();

    report.mixedCapture = await start(host, 'mixed-h264-hardware');
    assert.equal(report.mixedCapture.previewMuted, true); assert.equal(report.mixedCapture.finalAudioTracks, 1);
    assert.equal(report.mixedCapture.nativeCaptureCalls, 1); assert.equal(report.mixedCapture.nativeLoopbackPresent, true);
    assert.equal(report.mixedCapture.recorderUsesFinalStream, true);
    report.layouts = await verifyLayout(application, host);
    const firstUrl = await host.locator('#rtmp-link').inputValue(), firstInvite = await host.locator('#invite-link').inputValue();
    assert.equal(new URL(firstUrl).protocol, 'rtmp:'); assert.equal(new URL(firstUrl).hostname, '127.0.0.1');
    assert.equal(Number(new URL(firstUrl).port), rtmpPort);
    await host.locator('#copy-rtmp').click();
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), firstUrl);
    await host.locator('#copy-link').click();
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), firstInvite);
    assert.equal(new URL(firstInvite).protocol, 'http:');
    check('web and RTMP addresses are separately copyable; RTMP recorder uses the same final mixed stream and one native capture');
    const copySidecars = await ownedSidecars(application); observedSidecars.push(...copySidecars);
    assert.ok(copySidecars.some(row => row.name === 'ffmpeg.exe') && copySidecars.some(row => row.name === 'mediamtx.exe'),
      'both bundled native producer subprocesses must belong to this application');
    for (const child of copySidecars) assert.equal(path.normalize(child.executablePath).toLowerCase(),
      path.join(binDir, child.name).toLowerCase(), 'native producer must execute the candidate bundled binary');
    report.h264HardwareEncoder = await assertEncoder(host, report.mixedCapture, 'H264', true, copySidecars);

    const decoder = createDecoder(firstUrl, 'mixed-h264-hardware');
    const both = report.measurements.bothInputs = await measure(decoder,
      value => present(value.system) && present(value.microphone), 'real loopback and microphone did not arrive as decoded RTMP PCM');
    const companion = await openViewer(application, firstInvite, errors);
    report.webDecode = await webFrames(companion.page);
    const full = await hostViewers(host, 2); assert.equal(full.rtmp, 1);
    const deniedWeb = await openViewer(application, firstInvite, errors, { admitted: false });
    report.capacity = { maxViewers: 2, concurrent: full.count, rtmpViewers: full.rtmp, webViewers: full.count - full.rtmp,
      extraWebDenied: true, extraRtmp: await expectDenied(firstUrl, 'capacity-denied') };
    await hostViewers(host, 2);
    check('production webpage decodes video alongside RTMP; shared two-viewer limit rejects a third viewer through both protocols');

    await tone.page.evaluate(() => { window.__outputTone.gain.gain.setValueAtTime(0, window.__outputTone.context.currentTime); });
    const outputOff = report.measurements.actualOutputOff = await measure(decoder,
      value => dropped(value.system, both.system) && retained(value.microphone, both.microphone),
      'stopping actual Windows output must remove only decoded 440 Hz');
    await tone.page.evaluate(gain => { window.__outputTone.gain.gain.setValueAtTime(gain, window.__outputTone.context.currentTime); }, SYSTEM_GAIN);
    const outputOn = report.measurements.actualOutputRestored = await measure(decoder,
      value => retained(value.system, both.system) && retained(value.microphone, both.microphone),
      'restoring actual Windows output must restore only its RTMP frequency', outputOff.samples);
    await setSlider(host, 'system-volume', 0);
    const systemZero = report.measurements.systemZero = await measure(decoder,
      value => dropped(value.system, both.system) && retained(value.microphone, both.microphone),
      'system 0% must preserve microphone 880 Hz', outputOn.samples);
    await setSlider(host, 'system-volume', 100);
    const restored = report.measurements.systemRestored = await measure(decoder,
      value => retained(value.system, both.system) && retained(value.microphone, both.microphone),
      'system volume restore did not recover RTMP inputs', systemZero.samples);
    await setSlider(host, 'mic-volume', 50);
    const micHalf = report.measurements.microphoneHalf = await measure(decoder,
      value => retained(value.system, restored.system) && present(value.microphone)
        && value.microphone.amplitude < restored.microphone.amplitude * 0.85 && value.microphone.amplitude > restored.microphone.amplitude * 0.2,
      'microphone 50% must reduce only its own decoded frequency', restored.samples);
    await setSlider(host, 'mic-volume', 100);
    const beforeMute = await measure(decoder, value => retained(value.system, both.system) && retained(value.microphone, both.microphone),
      'microphone volume restore failed', micHalf.samples);
    await host.locator('#mute').click();
    const muted = report.measurements.microphoneMuted = await measure(decoder,
      value => retained(value.system, both.system) && dropped(value.microphone, both.microphone),
      'microphone mute must leave the real system output audible', beforeMute.samples);
    assert.equal(await host.evaluate(() => document.querySelector('#preview').srcObject.getAudioTracks()[0].enabled), true);
    await host.locator('#mute').click();
    report.measurements.unmuted = await measure(decoder,
      value => retained(value.system, both.system) && retained(value.microphone, both.microphone),
      'microphone unmute did not restore both RTMP frequencies', muted.samples);
    check('actual RTMP PCM follows Windows output off/on, independent system/microphone gains and microphone mute');

    await closeDecoder(decoder); report.codecs = await probeCapture(decoder);
    report.h264HardwareEncoder.actualDecodedVideoFrames = Number(report.codecs.streams.find(stream => stream.codec_type === 'video').nb_read_frames);
    await hostViewers(host, 1);
    const replacement = createDecoder(firstUrl, 'replacement-reader');
    await measure(replacement, value => present(value.system) && present(value.microphone), 'released RTMP slot could not be reused');
    await hostViewers(host, 2);
    const rtmpIndex = await host.evaluate(() => window.__rtmpAcceptance.viewers.findIndex(viewer => viewer.protocol === 'rtmp'));
    assert.ok(rtmpIndex >= 0);
    await host.locator('.viewer-row').nth(rtmpIndex).locator('button').click();
    await bounded(replacement.done, 12000, 'GUI RTMP kick did not terminate reader');
    await hostViewers(host, 1);
    report.webDecodeAfterKick = await webFrames(companion.page, report.webDecode.framesDecoded);
    check('RTMP reader exit releases capacity; replacement reader can join and GUI kick releases it without interrupting web video');
    report.mixedCleanup = await stopAndCheck(host, 'mixed-h264-hardware', [webPort, rtmpPort], copySidecars, [companion, deniedWeb]);
    check('stop releases native capture/mixer/recorder, both TCP listeners and application-owned native subprocesses');

    await host.locator('#rtmp-codec').selectOption('H264');
    await host.locator('#rtmp-acceleration').selectOption('software');
    report.softwareCapture = await start(host, 'h264-software');
    assert.equal(report.softwareCapture.nativeCaptureCalls, 1); assert.equal(report.softwareCapture.recorderUsesFinalStream, true);
    const secondUrl = await host.locator('#rtmp-link').inputValue(), secondInvite = await host.locator('#invite-link').inputValue();
    assert.notEqual(new URL(secondUrl).pathname, new URL(firstUrl).pathname, 'restart must rotate random RTMP path');
    assert.notEqual(new URL(secondInvite).hash, new URL(firstInvite).hash, 'restart must rotate web token');
    report.oldRtmp = await expectDenied(firstUrl, 'old-session-denied');
    await deniedWeb.page.goto(firstInvite);
    await deniedWeb.page.locator('#watch').click();
    await deniedWeb.page.waitForFunction(() => /观看码|邀请|认证/.test(document.querySelector('#error').textContent
      + document.querySelector('#connection-text').textContent), null, { timeout: 15000 });
    assert.equal(await deniedWeb.page.evaluate(() => document.querySelector('#remote').srcObject), null);
    const softwareSidecars = await ownedSidecars(application); observedSidecars.push(...softwareSidecars);
    report.h264SoftwareEncoder = await assertEncoder(host, report.softwareCapture, 'H264', false, softwareSidecars);
    const software = createDecoder(secondUrl, 'h264-software');
    report.measurements.software = await measure(software, value => present(value.system) && present(value.microphone),
      'production software H.264/AAC encoder did not decode both audio inputs');
    await closeDecoder(software); report.softwareCodecs = await probeCapture(software);
    report.h264SoftwareEncoder.actualDecodedVideoFrames = Number(report.softwareCodecs.streams.find(stream => stream.codec_type === 'video').nb_read_frames);
    await hostViewers(host, 0);
    report.softwareCleanup = await stopAndCheck(host, 'h264-software', [webPort, rtmpPort], softwareSidecars);
    check('restart rotates both invitations and rejects old addresses; explicitly selected software H.264/AAC produces real decoded video and both audio inputs');

    await host.locator('#rtmp-codec').selectOption('HEVC');
    await host.locator('#rtmp-acceleration').selectOption('hardware');
    report.hevcCapture = await start(host, 'hevc-hardware');
    assert.equal(report.hevcCapture.nativeCaptureCalls, 1); assert.equal(report.hevcCapture.recorderUsesFinalStream, true);
    const hevcSidecars = await ownedSidecars(application); observedSidecars.push(...hevcSidecars);
    report.hevcHardwareEncoder = await assertEncoder(host, report.hevcCapture, 'HEVC', true, hevcSidecars);
    const hevc = createDecoder(await host.locator('#rtmp-link').inputValue(), 'hevc-hardware', 'HEVC');
    report.measurements.hevc = await measure(hevc, value => present(value.system) && present(value.microphone),
      'production hardware HEVC/AAC RTMP did not decode both audio inputs');
    await closeDecoder(hevc); report.hevcCodecs = await probeCapture(hevc, 'hevc');
    report.hevcHardwareEncoder.actualDecodedVideoFrames = Number(report.hevcCodecs.streams.find(stream => stream.codec_type === 'video').nb_read_frames);
    await hostViewers(host, 0);
    report.hevcCleanup = await stopAndCheck(host, 'hevc-hardware', [webPort, rtmpPort], hevcSidecars);
    check('hardware HEVC RTMP is encoded by the reported running hardware encoder and actually decoded as HEVC/AAC with both audio inputs');

    await host.locator('#rtmp-acceleration').selectOption('software');
    report.hevcSoftwareCapture = await start(host, 'hevc-software');
    assert.equal(report.hevcSoftwareCapture.nativeCaptureCalls, 1); assert.equal(report.hevcSoftwareCapture.recorderUsesFinalStream, true);
    const hevcSoftwareSidecars = await ownedSidecars(application); observedSidecars.push(...hevcSoftwareSidecars);
    report.hevcSoftwareEncoder = await assertEncoder(host, report.hevcSoftwareCapture, 'HEVC', false, hevcSoftwareSidecars);
    const hevcSoftware = createDecoder(await host.locator('#rtmp-link').inputValue(), 'hevc-software', 'HEVC');
    report.measurements.hevcSoftware = await measure(hevcSoftware, value => present(value.system) && present(value.microphone),
      'production software HEVC/AAC RTMP did not decode both audio inputs');
    await closeDecoder(hevcSoftware); report.hevcSoftwareCodecs = await probeCapture(hevcSoftware, 'hevc');
    report.hevcSoftwareEncoder.actualDecodedVideoFrames = Number(report.hevcSoftwareCodecs.streams.find(stream => stream.codec_type === 'video').nb_read_frames);
    await hostViewers(host, 0);
    report.hevcSoftwareCleanup = await stopAndCheck(host, 'hevc-software', [webPort, rtmpPort], hevcSoftwareSidecars);
    check('explicit software HEVC preserves the requested codec and decodes actual video/AAC with both audio inputs');

    progress('occupy RTMP port with this test listener to verify failure isolation');
    await host.locator('#rtmp-codec').selectOption('H264');
    await host.locator('#rtmp-acceleration').selectOption('auto');
    conflictServer = net.createServer(socket => socket.destroy());
    conflictServer.listen(rtmpPort, '127.0.0.1'); await once(conflictServer, 'listening');
    report.conflictCapture = await start(host, 'rtmp-port-conflict', { expectRtmp: false });
    assert.equal(await host.locator('#copy-rtmp').isEnabled(), false);
    assert.equal(await host.locator('#rtmp-link').inputValue(), '');
    assert.ok((await host.locator('#rtmp-status').textContent()).trim(), 'failed RTMP requires visible status');
    const conflictViewer = await openViewer(application, await host.locator('#invite-link').inputValue(), errors);
    report.conflictWebDecode = await webFrames(conflictViewer.page);
    const failedSidecars = await ownedSidecars(application); observedSidecars.push(...failedSidecars);
    report.conflictCleanup = await stopAndCheck(host, 'rtmp-port-conflict', [webPort], failedSidecars, [conflictViewer]);
    assert.equal(await portState(rtmpPort), 'OPEN', 'app stop must not close the independently owned conflict fixture');
    await new Promise(resolve => conflictServer.close(resolve)); conflictServer = null; await released(rtmpPort);
    check('RTMP port conflict shows unavailable status and clears its address while production web video keeps working');

    await tone.page.evaluate(async () => { await window.__stopOutputTone(); });
    report.outputFixtureClosed = await tone.page.evaluate(() => window.__outputTone.context.state === 'closed');
    assert.equal(report.outputFixtureClosed, true);
    await closeFixtures(application);
    await host.evaluate(() => { window.__rtmpAcceptance.restore(); });
    await setField(host, 'rtmp-port', rtmpPort);
    await setField(host, 'advertised-rtmp-port', forwardedRtmpPort);
    await host.locator('#rtmp-codec').selectOption('HEVC');
    await host.locator('#rtmp-acceleration').selectOption('hardware');
    await host.locator('#rtmp-enabled').uncheck();
    await host.locator('#room').fill('RTMP 设置关闭恢复验收');
    progress('native close immediately after edits; verify RTMP settings flush');
    await nativeClose(application); application = null;
    const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.equal(saved.rtmpEnabled, false); assert.equal(saved.rtmpPort, rtmpPort); assert.equal(saved.advertisedRtmpPort, forwardedRtmpPort);
    assert.equal(saved.rtmpCodec, 'HEVC'); assert.equal(saved.rtmpAcceleration, 'hardware');
    assert.equal(Object.keys(saved).some(key => /token|pin|generation|roomId|rtmpUrl/i.test(key)), false, 'settings must not persist session credentials');
    ({ application, host } = await launch(errors, value => { application = value; }));
    assert.equal(await host.locator('#rtmp-enabled').isChecked(), false);
    assert.equal(await host.locator('#rtmp-port').inputValue(), String(rtmpPort));
    assert.equal(await host.locator('#advertised-rtmp-port').inputValue(), String(forwardedRtmpPort));
    assert.equal(await host.locator('#rtmp-codec').inputValue(), 'HEVC');
    assert.equal(await host.locator('#rtmp-acceleration').inputValue(), 'hardware');
    assert.equal(await host.locator('#room').inputValue(), 'RTMP 设置关闭恢复验收');
    assert.equal(await host.locator('#status-text').textContent(), '尚未广播');
    await released(webPort); await released(rtmpPort);
    assert.equal((await ownedSidecars(application)).length, 0);
    report.settingsRestore = { rtmpEnabled: saved.rtmpEnabled, localPortRestored: true, mappedPortRestored: true,
      codec: saved.rtmpCodec, acceleration: saved.rtmpAcceleration,
      nativeCloseFlushed: true, reopenedIdle: true, sessionCredentialsNotSaved: true };
    report.nativeProcesses = { observedProducerProcesses: observedSidecars.length, ownedProcessTree: true, allObservedProcessesReleased: true };
    check('native close flushes RTMP switch/local/mapped ports/codec/acceleration, restart restores them idle and no session credentials are saved');
    assert.deepEqual(errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack; report.failureStage = currentStep; report.pageErrors = errors;
    process.exitCode = 1; console.error(publicReport(error.stack || error.message));
    await saveReport(report);
    if (host && !host.isClosed()) report.guiState = await bounded(host.evaluate(() => ({
      notice: document.querySelector('#notice')?.textContent, status: document.querySelector('#status-text')?.textContent,
      rtmpStatus: document.querySelector('#rtmp-status')?.textContent, rtmpPhase: window.__rtmpAcceptance?.rtmp?.phase,
      viewerCount: document.querySelector('#viewer-count')?.textContent,
      resources: window.__rtmpAcceptance ? {
        displays: window.__rtmpAcceptance.displays.flatMap(value => value.tracks.map(track => ({ kind: track.kind, state: track.readyState }))),
        recorders: window.__rtmpAcceptance.recorders.map(value => ({ stage: value.stage, mime: value.mime, state: value.recorder.state })),
        contexts: window.__rtmpAcceptance.contexts.map(value => ({ stage: value.stage, role: value.role, state: value.context.state }))
      } : null
    })), 2500, 'failure GUI diagnostics').catch(() => null);
  } finally {
    progress('bounded cleanup of exact owned decoder/application processes and fixture windows');
    const cleanup = async (label, task, timeout = 5000) => {
      try { return await bounded(task, timeout, label); }
      catch (error) { (report.cleanupErrors ||= []).push(error.message); report.passed = false; process.exitCode = 1; }
    };
    for (const decoder of decoders) await cleanup(`close owned ${decoder.name} decoder`, closeDecoder(decoder), 12000);
    if (conflictServer) await cleanup('close owned conflict listener', new Promise(resolve => conflictServer.close(resolve)));
    if (application) {
      if (tone && !tone.page.isClosed()) await cleanup('stop actual output tone', tone.page.evaluate(async () => { await window.__stopOutputTone?.(); }));
      if (host && !host.isClosed()) {
        await cleanup('stop owned production broadcast', host.evaluate(() => {
          const button = document.querySelector('#start');
          if (button && !button.disabled && /停止|取消准备/.test(button.textContent)) button.click();
        }));
        await cleanup('release observed owned media resources', host.evaluate(async () => {
          const observation = window.__rtmpAcceptance;
          if (!observation) return;
          for (const value of [...observation.displays, ...observation.microphones, ...observation.previews])
            for (const track of value.tracks) if (track.readyState !== 'ended') track.stop();
          for (const value of observation.contexts) if (value.context.state !== 'closed') await value.context.close().catch(() => {});
          observation.restore();
        }));
      }
      await cleanup('close owned fixture windows', closeFixtures(application), 11000);
      try { await bounded(application.close(), 10000, 'close isolated test application'); }
      catch (error) {
        (report.cleanupErrors ||= []).push(error.message); report.passed = false; process.exitCode = 1;
        const child = application.process(), pid = child?.pid;
        if (Number.isSafeInteger(pid) && pid > 0 && child.exitCode === null && child.signalCode === null)
          await cleanup('terminate exact owned test process tree', execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
            { timeout: 5000, windowsHide: true }), 6000);
      }
    }
    if (observedSidecars.length) await cleanup('verify all observed native producers exited', sidecarsGone(observedSidecars), 25000);
    report.pageErrors = errors;
    if (errors.length) { report.passed = false; report.error ||= 'Renderer page errors occurred; see pageErrors.'; process.exitCode = 1; }
    await saveReport(report);
    console.log(JSON.stringify(publicReport({ passed: report.passed, version: report.version, checks: report.checks,
      encoders: { h264Hardware: report.h264HardwareEncoder, h264Software: report.h264SoftwareEncoder,
        hevcHardware: report.hevcHardwareEncoder, hevcSoftware: report.hevcSoftwareEncoder },
      error: report.error, failureStage: report.failureStage, guiState: report.guiState,
      cleanupErrors: report.cleanupErrors, pageErrors: report.pageErrors,
      reportFile: path.relative(root, reportFile) }), null, 2));
  }
}

main().catch(error => { console.error(publicReport(error.stack || error.message)); process.exitCode = 1; });
