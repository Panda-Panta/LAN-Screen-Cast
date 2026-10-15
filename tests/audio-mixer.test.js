const test = require('node:test');
const assert = require('node:assert/strict');

let createAudioMixer, CaptureSession, CaptureCancelled;
test.before(async () => {
  ({ createAudioMixer } = await import('../src/renderer/audio-mixer.mjs'));
  ({ CaptureSession, CaptureCancelled } = await import('../src/renderer/capture-session.mjs'));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

class Track {
  constructor(kind, sample = 0) { this.kind = kind; this.sample = sample; this.enabled = true; this.readyState = 'live'; this.stops = 0; }
  stop() { this.stops++; this.readyState = 'ended'; }
  read() { return this.enabled && this.readyState === 'live' ? this.sample : 0; }
}
class Stream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
}

// Evaluates the connected graph, rather than just checking which methods were
// called. A source follows Web Audio's first-audio-track rule; track.enabled and
// a gain of zero independently silence that input.
class AudioNode {
  constructor(read = null) { this.inputs = []; this.outputs = []; this.readSource = read; this.disconnections = 0; }
  connect(destination) { this.outputs.push(destination); destination.inputs.push(this); return destination; }
  disconnect() {
    this.disconnections++;
    for (const output of this.outputs) output.inputs = output.inputs.filter(input => input !== this);
    this.outputs.length = 0;
  }
  read() { return this.readSource ? this.readSource() : this.inputs.reduce((sum, input) => sum + input.read(), 0); }
}

function boundary({ resume, closeError, failGain = false, failSource = false } = {}) {
  const contexts = [];
  class Context {
    constructor() {
      this.state = 'suspended'; this.resumeCalls = 0; this.closeCalls = 0;
      this.destination = new AudioNode(); this.nodes = []; this.sourceStreams = []; this.gains = [];
      contexts.push(this);
    }
    createMediaStreamDestination() {
      const destination = new AudioNode();
      const output = new Track('audio');
      output.read = () => output.enabled && output.readyState === 'live' ? destination.read() : 0;
      destination.stream = new Stream([output]);
      this.mixedDestination = destination; this.nodes.push(destination);
      return destination;
    }
    createMediaStreamSource(stream) {
      if (failSource) throw new Error('source creation failed');
      this.sourceStreams.push(stream);
      const source = new AudioNode(() => stream.getAudioTracks()[0]?.read() || 0);
      this.nodes.push(source); return source;
    }
    createGain() {
      if (failGain) throw new Error('gain creation failed');
      const node = new AudioNode(); node.gain = { value: 1 };
      node.read = () => node.inputs.reduce((sum, input) => sum + input.read(), 0) * node.gain.value;
      this.nodes.push(node); this.gains.push(node); return node;
    }
    resume() { this.resumeCalls++; return (resume ? resume.promise : Promise.resolve()).then(() => { if (this.state !== 'closed') this.state = 'running'; }); }
    close() {
      this.closeCalls++; this.state = 'closed';
      if (closeError === 'throw') throw new Error('close failed');
      return closeError === 'reject' ? Promise.reject(new Error('close failed')) : Promise.resolve();
    }
  }
  return { contexts, AudioContextCtor: Context, MediaStreamCtor: Stream };
}

function inputs({ system = false, microphone = false, endSystem = false } = {}) {
  const video = new Track('video'), systemTrack = new Track('audio', 0.8), microphoneTrack = new Track('audio', 0.2);
  if (endSystem) systemTrack.readyState = 'ended';
  return { video, systemTrack, microphoneTrack,
    displayStream: new Stream(system ? [video, systemTrack] : [video]),
    microphoneStream: microphone ? new Stream([microphoneTrack]) : null };
}
function stopped(...tracks) { for (const track of tracks) assert.equal(track.readyState, 'ended'); }
function closeTo(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should equal ${expected}`); }

test('video-only capture creates no AudioContext and excludes unrequested system audio', async () => {
  const io = boundary(), input = inputs({ system: true });
  const capture = new CaptureSession(() => {});
  const mixer = await createAudioMixer({ ...io, ...input, capture });
  assert.deepEqual(mixer.stream.getTracks(), [input.video]);
  assert.equal(io.contexts.length, 0);
  mixer.setSystemVolume(0); mixer.setMicrophoneVolume(100); mixer.setMicrophoneMuted(true);
  assert.equal(input.systemTrack.enabled, true, 'mixing must not alter the original playback track');
  mixer.dispose(); mixer.dispose();
  stopped(input.video, input.systemTrack);
  assert.equal(input.video.stops, 1); assert.equal(input.systemTrack.stops, 1);
});

test('system and microphone signals mix once with independent live volume and microphone mute', async () => {
  const io = boundary(), input = inputs({ system: true, microphone: true });
  const capture = new CaptureSession(() => {});
  const mixer = await createAudioMixer({ ...io, ...input, capture, systemAudio: true, systemVolume: 50, micVolume: 25 });
  const context = io.contexts[0], output = mixer.stream.getAudioTracks()[0];
  assert.deepEqual(mixer.stream.getVideoTracks(), [input.video]);
  assert.equal(mixer.stream.getAudioTracks().length, 1);
  assert.deepEqual(context.sourceStreams.map(stream => stream.getTracks()), [[input.systemTrack], [input.microphoneTrack]]);
  assert.equal(context.destination.inputs.length, 0, 'the capture graph must not play through local speakers');
  assert.equal(input.systemTrack.enabled, true); assert.equal(input.microphoneTrack.enabled, true);
  closeTo(output.read(), 0.45);
  mixer.setMicrophoneMuted(true); closeTo(output.read(), 0.4);
  assert.equal(output.enabled, true, 'microphone mute must not suppress system audio');
  mixer.setMicrophoneVolume(80); closeTo(output.read(), 0.4);
  mixer.setSystemVolume(25); closeTo(output.read(), 0.2);
  mixer.setMicrophoneMuted(false); closeTo(output.read(), 0.36);
  mixer.setSystemVolume(0); closeTo(output.read(), 0.16);
  mixer.dispose(); await capture.cancel();
  stopped(input.video, input.systemTrack, input.microphoneTrack, output);
  assert.equal(context.closeCalls, 1); assert.ok(context.nodes.every(node => node.outputs.length === 0));
});

test('microphone-only mute keeps the old output-track enabled semantics and restores its configured gain', async () => {
  const io = boundary(), input = inputs({ microphone: true });
  const capture = new CaptureSession(() => {});
  const mixer = await createAudioMixer({ ...io, ...input, capture, micVolume: 70 });
  const output = mixer.stream.getAudioTracks()[0];
  closeTo(output.read(), 0.14); assert.equal(output.enabled, true);
  mixer.setMicrophoneMuted(true); assert.equal(output.enabled, false); closeTo(output.read(), 0);
  mixer.setMicrophoneVolume(25); mixer.setSystemVolume(50); closeTo(output.read(), 0);
  mixer.setMicrophoneMuted(false); assert.equal(output.enabled, true); closeTo(output.read(), 0.05);
  await capture.cancel();
});

test('system-only capture remains audible when microphone mute is toggled', async () => {
  const io = boundary(), input = inputs({ system: true });
  const capture = new CaptureSession(() => {});
  const mixer = await createAudioMixer({ ...io, ...input, capture, systemAudio: true });
  const output = mixer.stream.getAudioTracks()[0];
  mixer.setMicrophoneMuted(true); closeTo(output.read(), 0.8); assert.equal(output.enabled, true);
  mixer.setSystemVolume(10); closeTo(output.read(), 0.08);
  mixer.setMicrophoneMuted(false); closeTo(output.read(), 0.08);
  await capture.cancel();
});

for (const endSystem of [false, true]) {
  test(`enabled system capture rejects ${endSystem ? 'an ended' : 'a missing'} system audio track and releases video`, async () => {
    const io = boundary(), input = inputs({ system: endSystem, endSystem });
    const capture = new CaptureSession(() => {});
    await assert.rejects(createAudioMixer({ ...io, ...input, capture, systemAudio: true }), /系统声音.*音轨/);
    stopped(input.video); assert.equal(io.contexts.length, 0);
  });
}

test('invalid initial volumes are rejected without opening a context or retaining capture tracks', async () => {
  for (const value of [-1, 101, 25.5, NaN, Infinity, '50', null]) {
    for (const field of ['systemVolume', 'micVolume']) {
      const io = boundary(), input = inputs({ system: true, microphone: true });
      const capture = new CaptureSession(() => {});
      await assert.rejects(createAudioMixer({ ...io, ...input, capture, systemAudio: true, [field]: value }), /音量|volume/i);
      stopped(input.video, input.systemTrack, input.microphoneTrack); assert.equal(io.contexts.length, 0);
    }
  }
});

test('invalid live volume changes cannot corrupt the current signal', async () => {
  const io = boundary(), input = inputs({ system: true, microphone: true });
  const capture = new CaptureSession(() => {});
  const mixer = await createAudioMixer({ ...io, ...input, capture, systemAudio: true, systemVolume: 50, micVolume: 25 });
  const output = mixer.stream.getAudioTracks()[0];
  for (const value of [-1, 101, 25.5, NaN, Infinity, '50', null, undefined]) {
    assert.throws(() => mixer.setSystemVolume(value), /音量|volume/i);
    assert.throws(() => mixer.setMicrophoneVolume(value), /音量|volume/i);
    closeTo(output.read(), 0.45);
  }
  await capture.cancel();
});

test('capture owns inputs, output and context before resume is scheduled', async () => {
  const resume = deferred(), io = boundary({ resume }), input = inputs({ system: true, microphone: true });
  const capture = new CaptureSession(() => {});
  const creating = createAudioMixer({ ...io, ...input, capture, systemAudio: true });
  const rejected = assert.rejects(creating, CaptureCancelled);
  const context = io.contexts[0], output = context.mixedDestination.stream.getAudioTracks()[0];
  for (const track of [input.video, input.systemTrack, input.microphoneTrack, output]) assert.ok(capture.tracks.has(track));
  assert.equal(context.resumeCalls, 0);
  const cancelling = capture.cancel();
  stopped(input.video, input.systemTrack, input.microphoneTrack, output);
  assert.equal(context.closeCalls, 1);
  await rejected; await cancelling;
  assert.equal(context.resumeCalls, 0, 'a cancelled session must not initiate a queued resume');
});

for (const lateResult of ['resolve', 'reject']) {
  test(`cancellation releases a pending resume immediately and ignores its late ${lateResult}`, async () => {
    const resume = deferred(), io = boundary({ resume }), input = inputs({ system: true, microphone: true });
    const capture = new CaptureSession(() => {});
    const creating = createAudioMixer({ ...io, ...input, capture, systemAudio: true });
    const rejected = assert.rejects(creating, CaptureCancelled);
    await turn();
    const context = io.contexts[0], output = context.mixedDestination.stream.getAudioTracks()[0];
    assert.equal(context.resumeCalls, 1);
    await capture.cancel(); await rejected;
    stopped(input.video, input.systemTrack, input.microphoneTrack, output);
    assert.equal(context.closeCalls, 1);
    if (lateResult === 'resolve') resume.resolve(); else resume.reject(new Error('late resume failed'));
    await turn(); await capture.cancel();
    assert.equal(context.state, 'closed'); assert.equal(context.closeCalls, 1);
    assert.equal(output.stops, 1);
  });
}

test('a failed resume releases every graph resource even when close itself rejects', async () => {
  const resume = deferred(), io = boundary({ resume, closeError: 'reject' });
  const input = inputs({ system: true, microphone: true }), capture = new CaptureSession(() => {});
  const creating = createAudioMixer({ ...io, ...input, capture, systemAudio: true });
  const rejected = assert.rejects(creating, /audio device failed/);
  await turn(); resume.reject(new Error('audio device failed')); await rejected; await turn();
  const context = io.contexts[0], output = context.mixedDestination.stream.getAudioTracks()[0];
  stopped(input.video, input.systemTrack, input.microphoneTrack, output);
  assert.equal(context.closeCalls, 1); assert.ok(context.nodes.every(node => node.outputs.length === 0));
  await capture.cancel(); assert.equal(context.closeCalls, 1);
});

for (const failure of ['failGain', 'failSource']) {
  test(`${failure} during graph preparation still closes context and releases the registered output`, async () => {
    const io = boundary({ [failure]: true, closeError: 'throw' }), input = inputs({ system: true });
    const capture = new CaptureSession(() => {});
    await assert.rejects(createAudioMixer({ ...io, ...input, capture, systemAudio: true }), /creation failed/);
    const context = io.contexts[0], output = context.mixedDestination.stream.getAudioTracks()[0];
    stopped(input.video, input.systemTrack, output);
    assert.equal(context.closeCalls, 1); assert.equal(context.resumeCalls, 0);
  });
}

test('late inputs belonging to a cancelled capture are stopped without touching a newer mixer', async () => {
  const oldCapture = new CaptureSession(() => {}); await oldCapture.cancel();
  const currentInput = inputs({ microphone: true }), currentIO = boundary();
  const currentCapture = new CaptureSession(() => {});
  const current = await createAudioMixer({ ...currentIO, ...currentInput, capture: currentCapture });
  const lateInput = inputs({ system: true, microphone: true }), lateIO = boundary();
  await assert.rejects(createAudioMixer({ ...lateIO, ...lateInput, capture: oldCapture, systemAudio: true }), CaptureCancelled);
  stopped(lateInput.video, lateInput.systemTrack, lateInput.microphoneTrack);
  assert.equal(lateIO.contexts.length, 0);
  assert.equal(currentInput.video.readyState, 'live'); assert.equal(currentInput.microphoneTrack.readyState, 'live');
  assert.equal(currentIO.contexts[0].state, 'running'); closeTo(current.stream.getAudioTracks()[0].read(), 0.2);
  await currentCapture.cancel();
});

test('repeated manual disposal and capture cancellation close resources only once', async () => {
  const io = boundary({ closeError: 'reject' }), input = inputs({ system: true, microphone: true });
  const capture = new CaptureSession(() => {});
  const mixer = await createAudioMixer({ ...io, ...input, capture, systemAudio: true });
  const output = mixer.stream.getAudioTracks()[0];
  mixer.dispose(); mixer.dispose(); await capture.cancel(); await turn();
  for (const track of [input.video, input.systemTrack, input.microphoneTrack, output]) assert.equal(track.stops, 1);
  assert.equal(io.contexts[0].closeCalls, 1);
  mixer.setSystemVolume(50); mixer.setMicrophoneVolume(50); mixer.setMicrophoneMuted(true);
  assert.equal(io.contexts[0].closeCalls, 1);
});
