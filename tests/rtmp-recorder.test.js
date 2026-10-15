const test = require('node:test');
const assert = require('node:assert/strict');

let createRtmpRecorder;
test.before(async () => { ({ createRtmpRecorder } = await import('../src/renderer/rtmp-recorder.mjs')); });

const H264 = 'video/x-matroska;codecs=avc1,opus';
const VP8 = 'video/webm;codecs=vp8,opus';
const MiB = 1024 * 1024;
const turn = () => new Promise(resolve => setImmediate(resolve));
const restoredTests = new WeakSet();
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function blob(values, conversion) {
  const size = typeof values === 'number' ? values : values.length;
  return { size, reads: 0,
    arrayBuffer() {
      this.reads++;
      if (typeof conversion === 'function') return conversion();
      if (conversion) return conversion.promise;
      return Promise.resolve(typeof values === 'number' ? new ArrayBuffer(size) : Uint8Array.from(values).buffer);
    } };
}

function boundary(t, options = {}) {
  const instances = [], constructors = [], supported = options.supported || [H264, VP8];
  class Recorder {
    static isTypeSupported(mimeType) { return supported.includes(mimeType); }
    constructor(stream, settings) {
      constructors.push(settings.mimeType);
      if (options.constructorError?.(settings.mimeType)) throw new Error('encoder construction failed');
      this.stream = stream; this.settings = settings; this.state = 'inactive';
      this.starts = []; this.stops = 0; instances.push(this);
    }
    start(timeslice) {
      this.starts.push(timeslice);
      if (options.startError) throw new Error('hardware encoder unavailable');
      this.state = 'recording';
    }
    stop() {
      this.stops++; this.state = 'inactive';
      if (options.stopError) throw new Error('recorder stop failed');
      this.ondataavailable?.({ data: blob([255]) });
      this.onstop?.();
    }
    emit(data) { this.ondataavailable?.({ data }); }
    error(error = new Error('encoder failed')) { this.onerror?.({ error }); }
    unexpectedStop() { this.state = 'inactive'; this.onstop?.(); }
  }
  if (!restoredTests.has(t)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
    restoredTests.add(t);
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, 'MediaRecorder', previous);
      else delete globalThis.MediaRecorder;
    });
  }
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, writable: true, value: Recorder });
  const tracks = [{ kind: 'video', stops: 0, stop() { this.stops++; } },
    { kind: 'audio', stops: 0, stop() { this.stops++; } }];
  const stream = { getTracks: () => tracks, getVideoTracks: () => [tracks[0]], getAudioTracks: () => [tracks[1]] };
  const begins = [], appends = [], finishes = [], errors = [];
  const api = {
    beginRtmp(request) {
      begins.push(request);
      return options.begin ? options.begin(request, begins.length) : Promise.resolve({ generation: 'generation-1' });
    },
    appendRtmp(request) {
      appends.push(request);
      return options.append ? options.append(request, appends.length) : Promise.resolve({ generation: request.generation, sequence: request.sequence });
    },
    finishRtmp(request) {
      finishes.push(request);
      return options.finish ? options.finish(request) : Promise.resolve();
    },
  };
  const create = overrides => createRtmpRecorder({ stream, config: { rtmpEnabled: true, bitrateMbps: 6 },
    roomId: 'room-1', api, onError: value => { errors.push(value); options.onError?.(value); }, ...overrides });
  const recording = create();
  t.after(() => recording.dispose());
  return { recording, create, stream, tracks, constructors, instances, begins, appends, finishes, errors, api };
}

function clock(t) {
  let elapsed = 0;
  t.mock.method(globalThis.performance, 'now', () => elapsed);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return milliseconds => { elapsed += milliseconds; t.mock.timers.tick(milliseconds); };
}

test('records the borrowed mixed stream as VP8 with short slices and does not stop its tracks', async t => {
  const io = boundary(t);
  const start = io.recording.start();
  assert.equal(io.instances.length, 1, 'the recorder is owned before begin awaits the backend');
  assert.equal(io.recording.start(), start);
  assert.deepEqual(await start, { generation: 'generation-1', mimeType: VP8 });
  const recorder = io.instances[0];
  assert.equal(recorder.stream, io.stream);
  assert.deepEqual(recorder.settings, { mimeType: VP8, videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 128_000, videoKeyFrameIntervalDuration: 1000 });
  assert.deepEqual(recorder.starts, [100]);
  assert.deepEqual(io.begins, [{ roomId: 'room-1', mimeType: VP8 }]);
  io.recording.dispose(); io.recording.dispose();
  assert.equal(recorder.stops, 1);
  assert.equal(recorder.ondataavailable, null); assert.equal(recorder.onerror, null); assert.equal(recorder.onstop, null);
  assert.deepEqual(io.finishes, [{ generation: 'generation-1' }]);
  assert.ok(io.tracks.every(track => track.stops === 0));
  assert.equal(io.appends.length, 0, 'the final stop Blob must not be sent');
  assert.equal(io.errors.length, 0);
});

test('uses Matroska H.264 only when VP8 is unsupported or its constructor fails before opening the backend', async t => {
  for (const settings of [{ supported: [H264] }, { constructorError: mimeType => mimeType === VP8 }]) {
    const io = boundary(t, settings);
    assert.deepEqual(await io.recording.start(), { generation: 'generation-1', mimeType: H264 });
    assert.deepEqual(io.begins, [{ roomId: 'room-1', mimeType: H264 }]);
    io.recording.dispose();
    assert.equal(io.errors.length, 0);
  }
});

test('a capability claim followed by start failure closes that generation without retrying', async t => {
  const io = boundary(t, { startError: true });
  assert.equal(await io.recording.start(), undefined);
  assert.deepEqual(io.constructors, [VP8]);
  assert.equal(io.begins.length, 1); assert.equal(io.finishes.length, 1);
  assert.equal(io.finishes[0].generation, 'generation-1');
  assert.match(io.errors[0], /hardware encoder unavailable.*网页广播继续/);
  assert.equal(io.instances[0].ondataavailable, null);
  assert.ok(io.tracks.every(track => track.stops === 0));
});

test('missing recording support reports an isolated failure without opening a backend', async t => {
  const io = boundary(t, { supported: [] });
  assert.equal(await io.recording.start(), undefined);
  assert.equal(io.begins.length, 0); assert.equal(io.instances.length, 0);
  assert.match(io.errors[0], /不支持.*媒体录制.*网页广播继续/);
  assert.ok(io.tracks.every(track => track.stops === 0));
});

test('disabled RTMP and disposal before start do not construct a recorder or call the backend', async t => {
  const io = boundary(t);
  io.recording.dispose();
  assert.equal(await io.recording.start(), undefined);
  const disabled = io.create({ config: { rtmpEnabled: false, bitrateMbps: 6 } });
  assert.equal(await disabled.start(), undefined); disabled.dispose();
  assert.equal(io.instances.length, 0); assert.equal(io.begins.length, 0); assert.equal(io.errors.length, 0);
});

test('preserves byte order and performs only one Blob conversion or IPC until matching ACK', async t => {
  const acks = [deferred(), deferred(), deferred()];
  const io = boundary(t, { append: (_request, count) => acks[count - 1].promise });
  await io.recording.start();
  const parts = [blob([1, 2, 3]), blob([4, 5]), blob([6])];
  for (const part of parts) io.instances[0].emit(part);
  await turn();
  assert.deepEqual(parts.map(part => part.reads), [1, 0, 0]); assert.equal(io.appends.length, 1);
  for (let index = 0; index < parts.length; index++) {
    const request = io.appends[index];
    assert.equal(request.generation, 'generation-1'); assert.equal(request.sequence, index);
    assert.deepEqual([...request.bytes], [[1, 2, 3], [4, 5], [6]][index]);
    acks[index].resolve({ generation: request.generation, sequence: request.sequence });
    await turn();
    assert.equal(io.appends.length, Math.min(index + 2, parts.length));
  }
  assert.equal(io.errors.length, 0);
});

test('zero-size events preserve sequence without converting or writing an empty Blob', async t => {
  const io = boundary(t); await io.recording.start();
  const empty = blob([]); io.instances[0].emit(empty); io.instances[0].emit(blob([7]));
  await turn();
  assert.equal(empty.reads, 0); assert.equal(io.appends.length, 1); assert.equal(io.appends[0].sequence, 0);
});

test('cancellation returns promptly during begin and closes a late generation exactly once', async t => {
  const begin = deferred(), io = boundary(t, { begin: () => begin.promise });
  const starting = io.recording.start();
  const recorder = io.instances[0], lateData = recorder.ondataavailable;
  io.recording.dispose();
  assert.equal(await starting, undefined);
  assert.equal(io.finishes.length, 0);
  begin.resolve({ generation: 'late-generation' }); await turn();
  lateData({ data: blob([1]) }); io.recording.dispose();
  assert.deepEqual(io.finishes, [{ generation: 'late-generation' }]);
  assert.equal(io.appends.length, 0); assert.equal(io.errors.length, 0);
  assert.equal(recorder.ondataavailable, null);
});

test('a rejected begin after cancellation cannot report a new failure or leave an unhandled rejection', async t => {
  const begin = deferred(), io = boundary(t, { begin: () => begin.promise });
  const starting = io.recording.start(); io.recording.dispose(); await starting;
  begin.reject(new Error('late begin failure')); await turn();
  assert.equal(io.finishes.length, 0); assert.equal(io.errors.length, 0);
});

test('a cancelled old begin cannot write to or finish a newer generation', async t => {
  const begin = deferred(), io = boundary(t, { begin: (_request, count) => count === 1 ? begin.promise : { generation: 'current-generation' } });
  const oldStart = io.recording.start(); io.recording.dispose(); await oldStart;
  const current = io.create(); await current.start();
  const currentRecorder = io.instances[1]; currentRecorder.emit(blob([2])); await turn();
  begin.resolve({ generation: 'old-generation' }); await turn();
  currentRecorder.emit(blob([3])); await turn();
  assert.deepEqual(io.appends.map(request => [request.generation, request.sequence]), [['current-generation', 0], ['current-generation', 1]]);
  assert.deepEqual(io.finishes, [{ generation: 'old-generation' }]); assert.equal(currentRecorder.state, 'recording');
  current.dispose(); assert.deepEqual(io.finishes.map(request => request.generation), ['old-generation', 'current-generation']);
});

for (const result of ['resolve', 'reject']) {
  test(`cancelling an in-flight Blob ignores its late ${result} and never converts queued Blobs`, async t => {
    const conversion = deferred(), io = boundary(t); await io.recording.start();
    const first = blob([1, 2], conversion), next = blob([3]);
    io.instances[0].emit(first); io.instances[0].emit(next);
    assert.equal(first.reads, 1); io.recording.dispose(); await turn();
    if (result === 'resolve') conversion.resolve(Uint8Array.from([1, 2]).buffer);
    else conversion.reject(new Error('late Blob failure'));
    await turn();
    assert.equal(next.reads, 0); assert.equal(io.appends.length, 0); assert.equal(io.finishes.length, 1); assert.equal(io.errors.length, 0);
  });
}

for (const result of ['resolve', 'reject']) {
  test(`cancelling an in-flight ACK ignores its late ${result} and cannot start the next IPC`, async t => {
    const ack = deferred(), io = boundary(t, { append: () => ack.promise }); await io.recording.start();
    const next = blob([2]); io.instances[0].emit(blob([1])); io.instances[0].emit(next); await turn();
    assert.equal(io.appends.length, 1); io.recording.dispose(); await turn();
    if (result === 'resolve') ack.resolve({ generation: 'generation-1', sequence: 0 });
    else ack.reject(new Error('late ACK failure'));
    await turn();
    assert.equal(next.reads, 0); assert.equal(io.appends.length, 1); assert.equal(io.errors.length, 0);
  });
}

test('single chunks above 4 MiB terminate the container before any conversion', async t => {
  const io = boundary(t); await io.recording.start(); const oversized = blob(4 * MiB + 1);
  io.instances[0].emit(oversized); io.instances[0].emit(blob([1])); await turn();
  assert.equal(oversized.reads, 0); assert.equal(io.appends.length, 0); assert.equal(io.instances[0].stops, 1);
  assert.equal(io.finishes.length, 1); assert.match(io.errors[0], /4 MiB.*网页广播继续/);
});

test('counts in-flight and queued Blob sizes immediately and ends instead of dropping an interior chunk', async t => {
  const conversion = deferred(), io = boundary(t); await io.recording.start();
  const first = blob(4 * MiB, conversion), second = blob(4 * MiB), overflowing = blob(1);
  io.instances[0].emit(first); io.instances[0].emit(second);
  assert.equal(io.errors.length, 0, 'exactly 8 MiB is allowed');
  io.instances[0].emit(overflowing); await turn();
  assert.match(io.errors[0], /8 MiB.*网页广播继续/);
  conversion.resolve(new ArrayBuffer(4 * MiB)); await turn();
  assert.equal(second.reads, 0); assert.equal(overflowing.reads, 0); assert.equal(io.appends.length, 0);
  assert.equal(io.finishes.length, 1);
});

test('matched ACK releases queue capacity so later 4 MiB slices can continue', async t => {
  const io = boundary(t); await io.recording.start();
  io.instances[0].emit(blob(4 * MiB)); await turn();
  io.instances[0].emit(blob(4 * MiB)); await turn();
  assert.deepEqual(io.appends.map(request => request.sequence), [0, 1]); assert.equal(io.errors.length, 0);
});

test('a stuck Blob hits the 3-second deadline even when new chunks keep arriving', async t => {
  const advance = clock(t), conversion = deferred(), io = boundary(t); await io.recording.start();
  const next = blob([2]); io.instances[0].emit(blob([1], conversion));
  advance(2999); io.instances[0].emit(next); assert.equal(io.errors.length, 0);
  advance(1); assert.match(io.errors[0], /超过 3 秒.*网页广播继续/);
  conversion.resolve(Uint8Array.from([1]).buffer); await turn();
  assert.equal(io.appends.length, 0); assert.equal(next.reads, 0); assert.equal(io.finishes.length, 1);
});

test('the pending deadline includes the IPC ACK and does not continue after a late success', async t => {
  const advance = clock(t), ack = deferred(), io = boundary(t, { append: () => ack.promise }); await io.recording.start();
  io.instances[0].emit(blob([1])); io.instances[0].emit(blob([2])); await turn();
  advance(3000); assert.equal(io.errors.length, 1); assert.equal(io.instances[0].stops, 1);
  ack.resolve({ generation: 'generation-1', sequence: 0 }); await turn();
  assert.equal(io.appends.length, 1); assert.equal(io.finishes.length, 1);
});

for (const ack of [undefined, { generation: 'old-generation', sequence: 0 }, { generation: 'generation-1', sequence: 1 }]) {
  test(`an invalid ACK ${JSON.stringify(ack)} stops the continuous container`, async t => {
    const io = boundary(t, { append: () => ack }); await io.recording.start();
    const next = blob([2]); io.instances[0].emit(blob([1])); io.instances[0].emit(next); await turn();
    assert.equal(io.appends.length, 1); assert.equal(next.reads, 0);
    assert.match(io.errors[0], /确认不匹配.*网页广播继续/); assert.equal(io.finishes.length, 1);
  });
}

test('invalid Blob content cannot reach the backend despite a plausible advertised size', async t => {
  const io = boundary(t); await io.recording.start();
  io.instances[0].emit(blob(4, () => Promise.resolve(new ArrayBuffer(2)))); await turn();
  assert.equal(io.appends.length, 0); assert.match(io.errors[0], /分片内容无效.*网页广播继续/);
});

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'rejected' : 'throwing'} Blob conversion is isolated from the borrowed stream`, async t => {
    const io = boundary(t); await io.recording.start();
    io.instances[0].emit(blob(1, () => {
      if (asynchronous) return Promise.reject(new Error('Blob read failed'));
      throw new Error('Blob read failed');
    }));
    await turn(); assert.equal(io.appends.length, 0); assert.equal(io.finishes.length, 1);
    assert.match(io.errors[0], /Blob read failed.*网页广播继续/); assert.ok(io.tracks.every(track => track.stops === 0));
  });
  test(`${asynchronous ? 'rejected' : 'throwing'} backend write stops RTMP without sending following chunks`, async t => {
    const io = boundary(t, { append: () => {
      if (asynchronous) return Promise.reject(new Error('backend write failed'));
      throw new Error('backend write failed');
    } });
    await io.recording.start(); const next = blob([2]);
    io.instances[0].emit(blob([1])); io.instances[0].emit(next); await turn();
    assert.equal(io.appends.length, 1); assert.equal(next.reads, 0); assert.equal(io.finishes.length, 1);
    assert.match(io.errors[0], /backend write failed.*网页广播继续/);
  });
}

test('recording errors and unexpected stops report once, detach handlers, and retain no pending work', async t => {
  for (const event of ['error', 'unexpectedStop']) {
    const io = boundary(t); await io.recording.start();
    const recorder = io.instances[0], lateError = recorder.onerror;
    recorder[event](); lateError({ error: new Error('second failure') }); recorder.emit(blob([1]));
    await turn(); assert.equal(io.errors.length, 1); assert.equal(io.finishes.length, 1); assert.equal(io.appends.length, 0);
    assert.equal(recorder.ondataavailable, null); assert.ok(io.tracks.every(track => track.stops === 0));
  }
});

test('finish rejection, recorder stop failure, and a throwing error callback cannot prevent disposal', async t => {
  const io = boundary(t, { stopError: true, finish: () => Promise.reject(new Error('already stopped')),
    onError: () => { throw new Error('UI callback failed'); } });
  await io.recording.start(); io.instances[0].error(); io.recording.dispose(); await turn();
  assert.equal(io.instances[0].stops, 1); assert.equal(io.finishes.length, 1); assert.equal(io.errors.length, 1);
  assert.equal(io.instances[0].ondataavailable, null); assert.ok(io.tracks.every(track => track.stops === 0));
});
