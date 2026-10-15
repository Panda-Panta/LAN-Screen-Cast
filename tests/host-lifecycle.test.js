const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));

function track(kind = 'video') {
  const listeners = new Map();
  return {
    kind, readyState: 'live', enabled: true, stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; },
    end() { this.readyState = 'ended'; for (const listener of listeners.get('ended') || []) listener(); },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    applyConstraints() { return Promise.resolve(); }, getSettings() { return { width: 1280, height: 720 }; },
  };
}
function stream(...tracks) {
  return { getTracks: () => [...tracks], getVideoTracks: () => tracks.filter(item => item.kind === 'video'), getAudioTracks: () => tracks.filter(item => item.kind === 'audio'), addTrack: item => tracks.push(item) };
}

// Exercise the real renderer orchestration with fake device/IPC boundaries. No
// Electron process, permissions dialog or production test-only hook is needed.
// Mixing is an isolated boundary here; audio-mixer.test.js verifies the graph.
async function hostHarness({ microphone = true, systemAudio = false, systemTrack, getMicrophone, getMixer, saveSettings, rtmpEnabled = false, rtmpStart } = {}) {
  const source = track();
  const display = stream(source, ...(systemTrack ? [systemTrack] : []));
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, hidden: false, disabled: false, textContent: '', srcObject: null, options: [], children: [],
      classList: { toggle() {}, add() {}, remove() {} },
      querySelector() { return { textContent: '' }; },
      addEventListener() {}, removeAttribute() {}, replaceChildren() {}, append() {},
    });
    return elements.get(id);
  }
  const values = { network: '127.0.0.1', port: '8765', room: 'Test', resolution: '1080', fps: '30', bitrate: '6', 'max-viewers': '5', 'mic-device': '', codec: 'auto', 'udp-min': '50000', 'udp-max': '50100', 'system-volume': '100', 'mic-volume': '100' };
  for (const [id, value] of Object.entries(values)) element(id).value = value;
  element('microphone').checked = microphone;
  element('system-audio').checked = systemAudio;
  let remoteStops = 0;
  const calls = { get remoteStops() { return remoteStops; }, retries: [], kicks: [], media: [], displayRequests: [], recorders: [] };
  const share = { getConfig: () => ({ forwardingEnabled: false, advertisedHost: '', advertisedPort: 8765, rtmpEnabled }), loadSettings() {}, show() {}, clear() {}, updateRtmp() {} };
  class Media {
    constructor(value, config, sendSignal, onPeerState) { this.stream = value; this.onPeerState = onPeerState; calls.media.push(this); }
    stop() { this.stream.getTracks().forEach(item => item.stop()); }
    mute() {} remove() {} stats() { return Promise.resolve({ total: 0 }); }
  }
  const context = vm.createContext({
    console, setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout, setInterval: (...args) => setInterval(...args).unref(), clearInterval, Promise, Set, Map,
    HostMedia: Media, createShareController: () => share,
    createRtmpRecorder: value => { const recorder = { ...value, disposes: 0, start: rtmpStart || (async () => ({generation:'rtmp'})), dispose() { this.disposes++; } }; calls.recorders.push(recorder); return recorder; },
    createAudioMixer: getMixer || (async ({ displayStream, microphoneStream }) => {
      for (const item of microphoneStream?.getAudioTracks() || []) displayStream.addTrack(item);
      return { stream: displayStream, setSystemVolume() {}, setMicrophoneVolume() {}, setMicrophoneMuted() {}, dispose() {} };
    }),
    document: { getElementById: element, createElement: () => element(Symbol()), querySelectorAll: () => [], querySelector: () => ({ classList: { toggle() {} } }) },
    Option: function(text, value) { return { text, value }; },
    window: { addEventListener() {}, lan: {
      selectSource: async () => {}, start: async () => ({ roomId:'room',url: 'http://127.0.0.1:8765/', inviteUrl: 'http://127.0.0.1:8765/#token=test', pin: '123456', qr: 'data:image/png;base64,' }),
      stop: async () => { remoteStops++; }, saveSettings: saveSettings || (() => Promise.resolve()), onEvent(listener) { calls.event = listener; },
      kick: async id => calls.kicks.push(id), retry: async (id, reason) => calls.retries.push({ id, reason }),
    } },
    navigator: { mediaDevices: { getDisplayMedia: async constraints => { calls.displayRequests.push(constraints); return display; }, getUserMedia: getMicrophone || (async () => stream(track('audio'))), addEventListener() {} } },
  });
  for (const name of ['capture-session.mjs', 'microphone-controller.mjs', 'settings-autosave.mjs', 'router-address.mjs']) {
    const helper = path.join(root, 'src', 'renderer', name);
    Object.assign(context, await import(pathToFileURL(helper).href));
  }
  const code = fs.readFileSync(path.join(root, 'src', 'renderer', 'host.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^void init\(\)\.catch.*$/m, '')
    + '\nselected = { id: "window:1", name: "Test" }; globalThis.startCapture = startBroadcast; globalThis.stopCapture = stopBroadcast;';
  vm.runInContext(code, context, { filename: 'host.js' });
  return { source, display, context, calls, element };
}

test('source ending while microphone permission is pending releases immediately and stops late audio', async () => {
  const entered = deferred(), microphone = deferred();
  const lateAudio = track('audio');
  const harness = await hostHarness({ getMicrophone: () => { entered.resolve(); return microphone.promise; } });
  const started = harness.context.startCapture();
  await entered.promise;
  harness.source.end();
  await turn();
  try {
    assert.ok(harness.calls.remoteStops > 0, 'source-ended must stop the server before microphone permission resolves');
    assert.equal(harness.element('preview').srcObject, null);
  } finally {
    microphone.resolve(stream(lateAudio));
    await started;
    await harness.context.stopCapture();
  }
  assert.equal(lateAudio.readyState, 'ended');
  assert.ok(lateAudio.stops > 0, 'late microphone tracks belong to the cancelled capture');
});

test('stop during pending microphone permission releases the screen and settles capture promptly', async () => {
  const entered = deferred(), microphone = deferred();
  const lateAudio = track('audio');
  const harness = await hostHarness({ getMicrophone: () => { entered.resolve(); return microphone.promise; } });
  const started = harness.context.startCapture();
  await entered.promise;
  await harness.context.stopCapture();
  try {
    assert.equal(harness.source.readyState, 'ended', 'screen must not stay captured during a pending permission request');
    assert.ok(harness.calls.remoteStops > 0);
    assert.equal(await Promise.race([started.then(() => 'settled'), turn().then(() => 'pending')]), 'settled');
  } finally {
    microphone.resolve(stream(lateAudio));
    await started;
    await harness.context.stopCapture();
  }
  assert.equal(lateAudio.readyState, 'ended');
});

test('cancelled mixed capture stops native system audio while a microphone request is pending', async () => {
  const entered = deferred(), microphone = deferred(), systemTrack = track('audio'), lateAudio = track('audio');
  const harness = await hostHarness({ systemAudio: true, systemTrack,
    getMicrophone: () => { entered.resolve(); return microphone.promise; } });
  const started = harness.context.startCapture();
  await entered.promise;
  await harness.context.stopCapture();
  assert.equal(systemTrack.readyState, 'ended', 'native loopback must stop without waiting for microphone permission');
  assert.equal(harness.source.readyState, 'ended');
  assert.equal(await Promise.race([started.then(() => 'settled'), turn().then(() => 'pending')]), 'settled');
  microphone.resolve(stream(lateAudio));
  await started; await turn();
  assert.equal(lateAudio.readyState, 'ended');
  assert.equal(harness.calls.media.length, 0);
});

test('missing native system audio reports failure before opening the microphone or broadcasting', async () => {
  let microphoneRequests = 0;
  const harness = await hostHarness({ systemAudio: true,
    getMicrophone: async () => { microphoneRequests++; return stream(track('audio')); } });
  await harness.context.startCapture();
  assert.equal(microphoneRequests, 0);
  assert.equal(harness.calls.media.length, 0);
  assert.equal(harness.source.readyState, 'ended');
  assert.equal(harness.element('preview').srcObject, null);
  assert.match(harness.element('notice').textContent, /未取得系统声音音轨/);
  assert.equal(harness.calls.displayRequests[0].audio.echoCancellation, false);
});

test('microphone loss while mixing is pending cancels preparation instead of starting a silent broadcast', async () => {
  const entered = deferred(), mixer = deferred(), audio = track('audio');
  const harness = await hostHarness({ getMicrophone: async () => stream(audio),
    getMixer: () => { entered.resolve(); return mixer.promise; } });
  const started = harness.context.startCapture();
  await entered.promise;
  audio.end(); await turn();
  try {
    assert.equal(harness.source.readyState, 'ended', 'device loss must release video without waiting for AudioContext.resume');
    assert.equal(await Promise.race([started.then(() => 'settled'), turn().then(() => 'pending')]), 'settled');
    assert.equal(harness.calls.media.length, 0);
    assert.match(harness.element('notice').textContent, /麦克风.*准备.*停止/);
  } finally {
    mixer.resolve({ stream: harness.display });
    await started; await harness.context.stopCapture();
  }
});

test('a pending settings save does not block source-ended cleanup or stop controls', async () => {
  const entered = deferred(), saved = deferred();
  const harness = await hostHarness({ microphone: false, saveSettings: () => { entered.resolve(); return saved.promise; } });
  const started = harness.context.startCapture();
  await entered.promise;
  harness.source.end();
  await turn();
  try {
    assert.ok(harness.calls.remoteStops > 0, 'settings persistence must not hold the live capture lifecycle');
    assert.equal(harness.element('preview').srcObject, null);
  } finally {
    saved.resolve();
    await started;
    await harness.context.stopCapture();
  }
});

test('late audio from a cancelled prepare cannot replace or stop the next live session', async () => {
  const entered = deferred(), microphone = deferred();
  const lateAudio = track('audio'), nextAudio = track('audio');
  let requests = 0;
  const harness = await hostHarness({ getMicrophone: () => {
    if (++requests === 1) { entered.resolve(); return microphone.promise; }
    return Promise.resolve(stream(nextAudio));
  } });
  const first = harness.context.startCapture();
  await entered.promise;
  await harness.context.stopCapture();
  // This fixture represents selecting a fresh native video track for the next
  // capture; Chromium supplies a fresh track on each getDisplayMedia request.
  harness.source.readyState = 'live';
  await harness.context.startCapture();
  assert.equal(harness.element('preview').srcObject, harness.display);
  microphone.resolve(stream(lateAudio));
  await first; await turn();
  assert.equal(lateAudio.readyState, 'ended');
  assert.equal(nextAudio.readyState, 'live');
  assert.equal(harness.element('preview').srcObject, harness.display);
  await harness.context.stopCapture();
});

test('automatic media timeout, negotiation error and failure use retry instead of a terminal kick', async () => {
  const harness = await hostHarness({ microphone: false });
  await harness.context.startCapture();
  try {
    for (const state of ['timeout', 'error', 'failed']) harness.calls.media[0].onPeerState(`viewer-${state}`, state);
    await turn();
    assert.deepEqual(harness.calls.retries, [
      { id: 'viewer-timeout', reason: 'timeout' },
      { id: 'viewer-error', reason: 'negotiation' },
      { id: 'viewer-failed', reason: 'failed' },
    ]);
    assert.deepEqual(harness.calls.kicks, [], 'automatic media failures must preserve receiver reconnection');
  } finally { await harness.context.stopCapture(); }
});

test('pending RTMP encoding preparation leaves the web broadcast usable and cancels immediately', async () => {
  const preparing = deferred();
  const harness = await hostHarness({ microphone: false, rtmpEnabled: true, rtmpStart: () => preparing.promise });
  await harness.context.startCapture();
  assert.equal(harness.element('preview').srcObject, harness.display);
  assert.equal(harness.calls.recorders[0].stream, harness.calls.media[0].stream);
  assert.equal(harness.source.readyState, 'live');
  await harness.context.stopCapture();
  assert.equal(harness.calls.recorders[0].disposes, 1);
  assert.equal(harness.source.readyState, 'ended');
  preparing.resolve({ generation: 'late' });
  await turn();
  assert.equal(harness.element('preview').srcObject, null);
});

for (const phase of ['error', 'stopped']) test(`RTMP ${phase} disposes its recorder immediately without stopping web media`, async () => {
  const harness = await hostHarness({ microphone: false, rtmpEnabled: true });
  await harness.context.startCapture();
  try {
    harness.calls.event({ type: 'rtmp-state', payload: { roomId: 'old-room', phase } });
    assert.equal(harness.calls.recorders[0].disposes, 0, 'old room events must not affect this recorder');
    harness.calls.event({ type: 'rtmp-state', payload: { roomId: 'room', phase } });
    assert.equal(harness.calls.recorders[0].disposes, 1);
    assert.equal(harness.source.readyState, 'live');
    assert.equal(harness.element('preview').srcObject, harness.display);
    assert.equal(harness.calls.remoteStops, 0);
  } finally { await harness.context.stopCapture(); }
});
