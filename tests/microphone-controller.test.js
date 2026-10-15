const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const controllerPath = path.join(root, 'src', 'renderer', 'microphone-controller.mjs');
function audioDevice(deviceId, label, groupId = deviceId) { return { kind: 'audioinput', deviceId, label, groupId }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
function track(kind = 'audio') {
  return { kind, readyState: 'live', stops: 0, stop() { this.stops++; this.readyState = 'ended'; } };
}
function stream(...tracks) { return { getTracks: () => [...tracks], getAudioTracks: () => tracks.filter(item => item.kind === 'audio') }; }
function mediaError(name, message = name) { return Object.assign(new Error(message), { name }); }

// This boundary fixture changes what enumeration exposes while a permission
// probe is live. It models a privacy-limited session; it is not a claim about
// the current Windows machine's permission persistence.
function privacyDevices({ persistentPermission = false } = {}) {
  const tracks = [];
  const listeners = new Set();
  const calls = { probes: 0, enumerations: 0, liveDuringEnumeration: [], constraints: [] };
  const boundary = {
    hardware: [audioDevice('default', 'Default microphone', 'usb'), audioDevice('communications', 'Communications microphone', 'usb'), audioDevice('usb-mic', 'USB microphone', 'usb')],
    granted: false, permissionError: null, enumerationError: null,
    emitDeviceChange() { for (const listener of [...listeners]) listener(); },
    get listenerCount() { return listeners.size; },
  };
  const mediaDevices = {
    async getUserMedia(constraints) {
      calls.probes++;
      calls.constraints.push(constraints);
      if (boundary.permissionError) throw boundary.permissionError;
      const audio = track();
      tracks.push(audio);
      if (persistentPermission) boundary.granted = true;
      return stream(audio);
    },
    async enumerateDevices() {
      calls.enumerations++;
      if (boundary.enumerationError) throw boundary.enumerationError;
      const live = tracks.some(track => track.readyState === 'live');
      calls.liveDuringEnumeration.push(live);
      return live || boundary.granted ? [...boundary.hardware] : [audioDevice('', '', '')];
    },
    addEventListener(type, listener) { if (type === 'devicechange') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'devicechange') listeners.delete(listener); },
  };
  return Object.assign(boundary, { mediaDevices, calls, tracks });
}

async function createController(options) {
  return (await import(pathToFileURL(controllerPath).href)).createMicrophoneController(options);
}

test('user refresh enumerates named physical microphones before releasing the permission probe', async () => {
  const boundary = privacyDevices();
  let devices;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onDevices: list => { devices = list; } });
  try {
    await controller.refresh({ requestPermission: true });
    assert.deepEqual(devices.map(({ deviceId, label }) => ({ deviceId, label })), [{ deviceId: 'usb-mic', label: 'USB microphone' }]);
    assert.deepEqual(boundary.calls.liveDuringEnumeration, [true]);
    assert.equal(boundary.tracks[0].readyState, 'ended');
    assert.deepEqual(boundary.calls.constraints, [{ audio: true, video: false }]);
  } finally { controller.dispose(); }
});

test('passive startup reports that device information requires a user permission action', async () => {
  const boundary = privacyDevices();
  const states = [];
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onState: state => states.push(state.status) });
  try {
    const state = await controller.refresh();
    assert.equal(state.status, 'permission-required');
    assert.match(state.message, /刷新/);
    assert.equal(state.selectionMissing, false, 'privacy masking is not proof that a saved device is disconnected');
    assert.equal(boundary.calls.probes, 0);
    assert.deepEqual(states, ['loading', 'permission-required']);
  } finally { controller.dispose(); }
});

test('aliases and duplicate IDs do not produce duplicate physical microphone choices', async () => {
  const boundary = privacyDevices();
  boundary.granted = true;
  boundary.hardware.push(audioDevice('usb-mic', 'Duplicate', 'usb'), audioDevice('another-mic', 'USB microphone', 'other'), { kind: 'videoinput', deviceId: 'camera', label: 'Camera' });
  let devices, selection;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, preferredId: 'communications', onDevices: (list, value) => { devices = list; selection = value; } });
  try {
    const state = await controller.refresh();
    assert.equal(state.status, 'ready');
    assert.deepEqual(devices.map(item => item.deviceId), ['usb-mic', 'another-mic']);
    assert.equal(selection, '');
    assert.equal(state.deviceCount, 2);
  } finally { controller.dispose(); }
});

test('an unavailable saved microphone uses default visibly and recovers after hotplug', async () => {
  const boundary = privacyDevices();
  boundary.granted = true;
  let selection, currentState;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, preferredId: 'headset', onDevices: (_list, next) => { selection = next; }, onState: state => { currentState = state; } });
  try {
    await controller.refresh();
    assert.equal(selection, '');
    assert.equal(currentState.selectionMissing, true);
    assert.match(currentState.message, /默认/);
    boundary.hardware.push(audioDevice('headset', 'Headset'));
    boundary.emitDeviceChange();
    await turn();
    assert.equal(selection, 'headset');
    assert.equal(currentState.selectionMissing, false);
    assert.equal(boundary.calls.probes, 0, 'hotplug must not request a new permission probe');
  } finally { controller.dispose(); }
});

test('a new user selection supersedes the saved device without touching hardware', async () => {
  const boundary = privacyDevices();
  boundary.granted = true;
  boundary.hardware.push(audioDevice('headset', 'Headset'));
  let selection;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, preferredId: 'usb-mic', onDevices: (_list, next) => { selection = next; } });
  try {
    await controller.refresh();
    controller.setPreferred('headset');
    assert.equal(selection, 'headset');
    boundary.emitDeviceChange();
    await turn();
    assert.equal(selection, 'headset');
    controller.setPreferred('default');
    assert.equal(selection, '');
    assert.equal(boundary.calls.probes, 0);
  } finally { controller.dispose(); }
});

for (const [name, status] of [['NotAllowedError', 'permission-denied'], ['SecurityError', 'permission-denied'], ['NotFoundError', 'no-devices'], ['NotReadableError', 'device-unavailable'], ['UnexpectedError', 'error']]) {
  test(`a ${name} permission failure has explicit actionable state`, async () => {
    const boundary = privacyDevices();
    boundary.permissionError = mediaError(name, 'boundary failure');
    const controller = await createController({ mediaDevices: boundary.mediaDevices });
    try {
      const state = await controller.refresh({ requestPermission: true });
      assert.equal(state.status, status);
      assert.equal(state.errorName, name);
      assert.ok(state.message.length > 10);
      assert.equal(boundary.calls.enumerations, 0, 'a denied probe must not masquerade as successful device enumeration');
    } finally { controller.dispose(); }
  });
}

test('a successful permission action followed by no devices reports no-devices', async () => {
  const boundary = privacyDevices();
  boundary.hardware = [];
  let devices;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onDevices: list => { devices = list; } });
  try {
    const state = await controller.refresh({ requestPermission: true });
    assert.equal(state.status, 'no-devices');
    assert.deepEqual(devices, []);
    assert.equal(boundary.tracks[0].stops, 1);
  } finally { controller.dispose(); }
});

test('devicechange caused by a permission grant does not interrupt the user probe', async () => {
  const boundary = privacyDevices();
  const open = boundary.mediaDevices.getUserMedia;
  boundary.mediaDevices.getUserMedia = async constraints => {
    const probe = await open(constraints);
    boundary.emitDeviceChange();
    return probe;
  };
  let devices;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onDevices: list => { devices = list; } });
  try {
    const state = await controller.refresh({ requestPermission: true });
    await turn();
    assert.equal(state.status, 'ready');
    assert.deepEqual(devices.map(item => item.deviceId), ['usb-mic']);
    assert.equal(boundary.calls.probes, 1);
    assert.deepEqual(boundary.calls.liveDuringEnumeration, [true]);
    assert.equal(boundary.tracks[0].stops, 1);
  } finally { controller.dispose(); }
});

test('hotplug during enumeration rechecks devices with the same live permission probe', async () => {
  const boundary = privacyDevices();
  const entered = deferred(), firstEnumeration = deferred();
  const enumerate = boundary.mediaDevices.enumerateDevices;
  let count = 0;
  boundary.mediaDevices.enumerateDevices = async () => {
    const captured = await enumerate();
    if (++count === 1) { entered.resolve(); await firstEnumeration.promise; }
    return captured;
  };
  const results = [];
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onDevices: list => results.push(list.map(item => item.deviceId)) });
  const refreshed = controller.refresh({ requestPermission: true });
  await entered.promise;
  boundary.hardware = [audioDevice('headset', 'Headset')];
  boundary.emitDeviceChange();
  firstEnumeration.resolve();
  try {
    assert.equal((await refreshed).status, 'ready');
    await turn();
    assert.deepEqual(results, [['headset']]);
    assert.deepEqual(boundary.calls.liveDuringEnumeration, [true, true]);
    assert.equal(boundary.calls.probes, 1);
    assert.equal(boundary.tracks[0].stops, 1);
  } finally { firstEnumeration.resolve(); controller.dispose(); }
});

test('devicechange enumeration errors are surfaced instead of silently discarded', async () => {
  const boundary = privacyDevices();
  boundary.granted = true;
  let state;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onState: value => { state = value; } });
  try {
    await controller.refresh();
    boundary.enumerationError = mediaError('NotAllowedError');
    boundary.emitDeviceChange();
    await turn();
    assert.equal(state.status, 'permission-denied');
    assert.equal(boundary.calls.probes, 0);
  } finally { controller.dispose(); }
});

test('a permission probe is released even when enumeration fails', async () => {
  const boundary = privacyDevices();
  boundary.enumerationError = new Error('Enumeration failed');
  const controller = await createController({ mediaDevices: boundary.mediaDevices });
  try {
    const state = await controller.refresh({ requestPermission: true });
    assert.equal(state.status, 'error');
    assert.equal(boundary.tracks[0].stops, 1);
  } finally { controller.dispose(); }
});

test('superseded enumeration cannot overwrite newer device choices', async () => {
  const boundary = privacyDevices();
  const entered = deferred(), firstEnumeration = deferred();
  let count = 0;
  boundary.mediaDevices.enumerateDevices = () => {
    if (++count === 1) { entered.resolve(); return firstEnumeration.promise; }
    return Promise.resolve([audioDevice('new-mic', 'New microphone')]);
  };
  const results = [];
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onDevices: list => results.push(list.map(item => item.deviceId)) });
  try {
    const first = controller.refresh();
    await entered.promise;
    await controller.refresh();
    assert.equal((await first).status, 'cancelled');
    firstEnumeration.resolve([audioDevice('old-mic', 'Old microphone')]);
    await turn();
    assert.deepEqual(results, [['new-mic']]);
  } finally { firstEnumeration.resolve([]); controller.dispose(); }
});

test('cancel settles a pending permission action promptly and stops every late track', async () => {
  const entered = deferred(), permission = deferred();
  const audio = track(), video = track('video');
  const boundary = privacyDevices();
  boundary.mediaDevices.getUserMedia = () => { entered.resolve(); return permission.promise; };
  const states = [], results = [];
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onDevices: list => results.push(list), onState: state => states.push(state.status) });
  const refreshed = controller.refresh({ requestPermission: true });
  await entered.promise;
  controller.cancel();
  try {
    assert.equal(await Promise.race([refreshed.then(state => state.status), turn().then(() => 'pending')]), 'cancelled');
    permission.resolve(stream(audio, video));
    await turn();
    assert.equal(audio.stops, 1);
    assert.equal(video.stops, 1);
    assert.deepEqual(results, []);
    assert.deepEqual(states, ['loading', 'cancelled']);
  } finally { permission.resolve(stream(audio, video)); controller.dispose(); }
});

test('cancel immediately stops a live probe while enumeration is still pending', async () => {
  const entered = deferred(), enumeration = deferred();
  const boundary = privacyDevices();
  boundary.mediaDevices.enumerateDevices = () => { entered.resolve(); return enumeration.promise; };
  let publications = 0;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onDevices: () => { publications++; } });
  const refreshed = controller.refresh({ requestPermission: true });
  await entered.promise;
  controller.cancel();
  try {
    assert.equal(boundary.tracks[0].stops, 1);
    assert.equal((await refreshed).status, 'cancelled');
    enumeration.resolve([audioDevice('stale-mic', 'Stale microphone')]);
    await turn();
    assert.equal(publications, 0);
  } finally { enumeration.resolve([]); controller.dispose(); }
});

test('late probe from an old refresh cannot affect a new device list or live broadcast track', async () => {
  const entered = deferred(), permission = deferred();
  const lateAudio = track(), broadcastAudio = track();
  const boundary = privacyDevices();
  boundary.granted = true;
  boundary.mediaDevices.getUserMedia = () => { entered.resolve(); return permission.promise; };
  const results = [];
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onDevices: list => results.push(list.map(item => item.deviceId)) });
  const first = controller.refresh({ requestPermission: true });
  await entered.promise;
  try {
    await controller.refresh();
    assert.equal((await first).status, 'cancelled');
    permission.resolve(stream(lateAudio));
    await turn();
    assert.equal(lateAudio.readyState, 'ended');
    assert.equal(broadcastAudio.readyState, 'live');
    assert.deepEqual(results, [['usb-mic']]);
  } finally { permission.resolve(stream(lateAudio)); controller.dispose(); broadcastAudio.stop(); }
});

test('dispose removes devicechange listeners and releases permission streams arriving after unload', async () => {
  const entered = deferred(), permission = deferred();
  const audio = track();
  const boundary = privacyDevices();
  boundary.mediaDevices.getUserMedia = () => { entered.resolve(); return permission.promise; };
  const states = [];
  const controller = await createController({ mediaDevices: boundary.mediaDevices, onState: state => states.push(state.status) });
  const refreshed = controller.refresh({ requestPermission: true });
  await entered.promise;
  assert.equal(boundary.listenerCount, 1);
  controller.dispose();
  try {
    assert.equal(boundary.listenerCount, 0);
    assert.equal((await refreshed).status, 'disposed');
    permission.resolve(stream(audio));
    await turn();
    assert.equal(audio.stops, 1);
    assert.deepEqual(states, ['loading']);
    boundary.emitDeviceChange();
    assert.equal((await controller.refresh({ requestPermission: true })).status, 'disposed');
    assert.equal(boundary.calls.enumerations, 0);
  } finally { permission.resolve(stream(audio)); controller.dispose(); }
});

test('broadcast preparation blocks refresh probes and devicechange work', async () => {
  const boundary = privacyDevices();
  const controller = await createController({ mediaDevices: boundary.mediaDevices, getBusy: () => true });
  try {
    assert.equal((await controller.refresh({ requestPermission: true })).status, 'busy');
    boundary.emitDeviceChange();
    await turn();
    assert.equal(boundary.calls.probes, 0);
    assert.equal(boundary.calls.enumerations, 0);
  } finally { controller.dispose(); }
});

test('a probe arriving after broadcast preparation begins is released without enumeration', async () => {
  const boundary = privacyDevices();
  const entered = deferred(), permission = deferred(), audio = track();
  let busy = false, publications = 0;
  boundary.mediaDevices.getUserMedia = () => { entered.resolve(); return permission.promise; };
  const controller = await createController({ mediaDevices: boundary.mediaDevices, getBusy: () => busy, onDevices: () => { publications++; } });
  const refreshed = controller.refresh({ requestPermission: true });
  await entered.promise;
  busy = true;
  permission.resolve(stream(audio));
  try {
    assert.equal((await refreshed).status, 'busy');
    assert.equal(audio.stops, 1);
    assert.equal(boundary.calls.enumerations, 0);
    assert.equal(publications, 0);
  } finally { permission.resolve(stream(audio)); controller.dispose(); }
});

test('hardware is not opened when loading-state publication starts a broadcast', async () => {
  const boundary = privacyDevices();
  let busy = false;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, getBusy: () => busy, onState: state => { if (state.status === 'loading') busy = true; } });
  try {
    assert.equal((await controller.refresh({ requestPermission: true })).status, 'busy');
    assert.equal(boundary.calls.probes, 0);
    assert.equal(boundary.calls.enumerations, 0);
  } finally { controller.dispose(); }
});

test('unsupported media APIs are reported without throwing to the event handler', async () => {
  const controller = await createController({ mediaDevices: {} });
  try {
    const state = await controller.refresh({ requestPermission: true });
    assert.equal(state.status, 'unsupported');
    assert.match(state.message, /麦克风/);
  } finally { controller.dispose(); }
});

test('saved microphone ID survives a privacy-limited startup until a user grants access', async () => {
  const boundary = privacyDevices();
  let selection;
  const controller = await createController({ mediaDevices: boundary.mediaDevices, preferredId: 'usb-mic', onDevices: (_list, next) => { selection = next; } });
  try {
    await controller.refresh();
    assert.equal(boundary.calls.probes, 0, 'startup must not activate the microphone');
    await controller.refresh({ requestPermission: true });
    assert.equal(selection, 'usb-mic', 'a masked startup list must not discard the saved microphone ID');
  } finally { controller.dispose(); }
});
