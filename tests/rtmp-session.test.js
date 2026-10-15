const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { RtmpSession, MAX_CHUNK_BYTES } = require('../src/rtmp-session');
const { AudienceRegistry } = require('../src/audience');

const turn = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readerId = '10000000-0000-4000-8000-000000000001';
const publisherId = '20000000-0000-4000-8000-000000000002';
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

class FakeInput extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.writes = []; this.callbacks = []; this.mode = 'immediate'; }
  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    this.callbacks.push(callback);
    if (this.mode === 'immediate') queueMicrotask(() => callback());
    return this.mode !== 'drain';
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
class FakeProcess extends EventEmitter {
  constructor() { super(); this.stdin = new FakeInput(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.exitCode = null; this.signals = []; }
  kill(signal) { this.signals.push(signal); this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0)); return true; }
}

async function harness(t, { config = {}, dependencies = {}, timings = {}, selector } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-cast-rtmp-test-'));
  const audience = new AudienceRegistry(config.maxViewers || 2), children = [], calls = [], probes = [];
  const state = { connections: [], online: false, failedApi: false, now: 100000 };
  const session = new RtmpSession({ rtmpEnabled: true, host: '192.168.9.2', rtmpPort: 1935,
    forwardingEnabled: true, advertisedHost: '10.2.3.4', advertisedRtmpPort: 21935,
    maxViewers: 2, bitrateMbps: 6, fps: 30, rtmpCodec: 'H264', rtmpAcceleration: 'auto', ...config }, {
    audience, binDir: path.join(directory, 'fake-bin'), tempRoot: directory,
    timings: { pollMs: 50000, terminateMs: 5, killMs: 5, prepareTimeoutMs: 50,
      writeTimeoutMs: 60, authTimeoutMs: 100, monitorTimeoutMs: 100, ...timings },
    dependencies: {
      fs: { ...fs, access: async () => {} }, now: () => state.now,
      spawn: (executable, args, options) => { const child = new FakeProcess(); children.push({ executable, args, options, child }); return child; },
      selectEncoder: async (value, options) => {
        probes.push({ value, options });
        if (selector) return selector(value, options);
        return { codec: value.rtmpCodec, encoder: value.rtmpCodec === 'HEVC' ? 'hevc_nvenc' : 'h264_nvenc',
          hardware: true, label: `${value.rtmpCodec} NVENC`, args: ['-c:v', value.rtmpCodec === 'HEVC' ? 'hevc_nvenc' : 'h264_nvenc', '-bf', '0'] };
      },
      requestJson: async (url, options) => {
        calls.push({ url, options });
        if (state.failedApi) throw new Error('fixture API unavailable');
        const route = new URL(url).pathname;
        if (route === '/v3/info') return { version: 'v1.21.2' };
        if (route === '/v3/rtmp/conns/list') return { items: state.connections.map(item => ({ ...item })), pageCount: 1, itemCount: state.connections.length };
        if (route === '/v3/paths/list') return { items: state.online ? [{ name: session.streamPath, online: true,
          source: { id: publisherId, type: 'rtmpConn' }, tracks2: [{ codec: session.config.rtmpCodec === 'HEVC' ? 'H265' : 'H264' }, { codec: 'MPEG-4 Audio' }] }] : [] };
        const id = route.split('/').pop();
        if (route.includes('/get/')) {
          const item = state.connections.find(value => value.id === id);
          if (item) return { ...item };
          const error = new Error('not found'); error.statusCode = 404; throw error;
        }
        if (route.includes('/kick/')) { state.connections = state.connections.filter(value => value.id !== id); return { status: 'ok' }; }
        throw new Error(`Unexpected fixture route ${route}`);
      }, ...dependencies,
    },
  });
  t.after(async () => { await session.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { session, audience, children, calls, probes, state, directory };
}

function auth(session, input, { authPath = session.authPath, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: session.authServer.address().port,
      path: authPath, method, agent: false, headers: { 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject); request.end(JSON.stringify(input));
  });
}
function readRequest(session, id = readerId) {
  return { action: 'read', protocol: 'rtmp', path: session.streamPath, id, ip: '192.168.9.50', user: '', password: '' };
}
async function running(h) {
  const result = await h.session.begin({ mimeType: 'video/webm;codecs=vp8,opus' });
  h.state.online = true;
  await h.session._poll();
  return result.generation;
}

test('RTMP prepare exposes only one selected-interface stream and local authenticated control services', async t => {
  const h = await harness(t);
  await h.session.prepare();
  assert.equal(h.session.getInfo().phase, 'waiting');
  const config = JSON.parse(await fs.readFile(h.session.configPath, 'utf8'));
  assert.equal(config.rtmpAddress, '192.168.9.2:1935');
  assert.match(config.apiAddress, /^127\.0\.0\.1:\d+$/);
  assert.match(config.authHTTPAddress, /^http:\/\/127\.0\.0\.1:\d+\/authorize\//);
  assert.deepEqual(config.authHTTPExclude, []);
  assert.deepEqual(Object.keys(config.paths), [h.session.streamPath]);
  for (const name of ['rtsp', 'hls', 'webrtc', 'srt', 'moq', 'metrics', 'pprof', 'playback']) assert.equal(config[name], false, name);
  assert.equal(config.pathDefaults.overridePublisher, false);
  assert.equal(config.pathDefaults.maxReaders, 2);
  assert.equal(h.children[0].options.shell, false);
  assert.equal(h.children[0].options.windowsHide, true);
  assert.ok(h.calls.every(call => call.options.authorization.startsWith('Basic ') && call.url.startsWith('http://127.0.0.1:')));
});

test('RTMP ready waits for actual selected-codec media and reports the probed encoder', async t => {
  const h = await harness(t, { config: { rtmpCodec: 'HEVC', systemAudio: true } });
  const { generation } = await h.session.begin({ mimeType: 'video/webm;codecs=vp8,opus' });
  assert.match(generation, /^[a-f0-9-]{36}$/);
  assert.equal(h.session.getInfo().phase, 'starting');
  await h.session._poll();
  assert.equal(h.session.getInfo().phase, 'starting');
  h.state.online = true;
  await h.session._poll();
  assert.equal(h.session.getInfo().phase, 'ready');
  assert.equal(h.session.getInfo().codec, 'HEVC / AAC');
  assert.equal(h.session.getInfo().encoder, 'hevc_nvenc');
  assert.equal(h.session.getInfo().hardware, true);
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0].options.signal, h.session.abort.signal);
  const args = h.children[1].args;
  assert.equal(args[args.indexOf('-c:v') + 1], 'hevc_nvenc');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
});

test('RTMP authentication rejects arbitrary publishers, wrong paths and unauthenticated control', async t => {
  const h = await harness(t);
  await running(h);
  const publish = { action: 'publish', protocol: 'rtmp', path: h.session.streamPath, id: publisherId,
    ip: h.session.config.host, user: 'publisher', password: h.session.publisherPassword };
  assert.equal(await auth(h.session, publish), 204);
  assert.equal(await auth(h.session, { ...publish, ip: '192.168.9.50' }), 403);
  assert.equal(await auth(h.session, { ...publish, password: '' }), 403);
  assert.equal(await auth(h.session, { ...publish, path: 'another-stream' }), 403);
  assert.equal(await auth(h.session, { ...publish, id: readerId }), 403);
  assert.equal(await auth(h.session, { action: 'api', ip: '127.0.0.1', user: 'control', password: '' }), 403);
  assert.equal(await auth(h.session, { action: 'api', ip: '127.0.0.1', user: 'control', password: h.session.controlPassword }), 204);
  assert.equal(await auth(h.session, readRequest(h.session), { authPath: '/authorize/wrong' }), 403);
  assert.equal(h.audience.size, 0);
});

test('RTMP read admission shares the web capacity, is idempotent, and kick frees only its own slot', async t => {
  const h = await harness(t);
  await running(h);
  h.audience.admit('web-peer', { protocol: 'webrtc' });
  assert.equal(await auth(h.session, readRequest(h.session)), 204);
  assert.equal(await auth(h.session, readRequest(h.session)), 204);
  assert.equal(h.audience.size, 2);
  assert.equal(await auth(h.session, readRequest(h.session, publisherId)), 403);
  h.state.connections = [{ id: readerId, state: 'read', path: h.session.streamPath }];
  await h.session._poll();
  assert.equal(await h.session.kick(`rtmp:${readerId}`), true);
  assert.equal(h.audience.size, 1);
  assert.equal(h.audience.has('web-peer'), true);
  assert.ok(h.calls.some(call => call.options.method === 'POST' && call.url.includes(`/v3/rtmp/conns/kick/${readerId}`)));
});

test('RTMP pending admission expires only after control confirms no connection; established viewers survive TTL', async t => {
  const h = await harness(t);
  await running(h);
  await auth(h.session, readRequest(h.session));
  h.state.connections = [{ id: readerId, state: 'read', path: h.session.streamPath }];
  await h.session._poll();
  h.state.now += 1000;
  await h.session._poll();
  assert.equal(h.audience.size, 1);
  h.state.connections = [];
  await h.session._poll();
  assert.equal(h.audience.size, 0);
  await auth(h.session, readRequest(h.session, publisherId));
  h.state.now += 101;
  await h.session._poll();
  assert.equal(h.audience.size, 0);
  assert.ok(h.calls.some(call => call.url.includes(`/v3/rtmp/conns/get/${publisherId}`)));
});

test('RTMP monitor failure keeps capacity until it shuts down the native service', async t => {
  const h = await harness(t);
  await running(h);
  await auth(h.session, readRequest(h.session));
  h.state.connections = [{ id: readerId, state: 'read', path: h.session.streamPath }];
  await h.session._poll();
  h.state.failedApi = true;
  h.state.now += 50;
  await h.session._poll();
  assert.equal(h.audience.size, 1);
  h.state.now += 60;
  await h.session._poll();
  assert.equal(h.session.getInfo().phase, 'error');
  assert.equal(h.audience.size, 0);
  assert.deepEqual(h.children[0].child.signals, ['SIGTERM']);
});

test('RTMP never frees a still-playing slot when termination fails, and frees it on a later proven exit', async t => {
  const h = await harness(t);
  await running(h);
  await auth(h.session, readRequest(h.session));
  const server = h.children[0].child;
  server.kill = signal => { server.signals.push(signal); return false; };
  await assert.rejects(h.session.stop(), /子进程未能退出/);
  assert.deepEqual(server.signals, ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
  assert.equal(h.session.getInfo().phase, 'error');
  assert.equal(h.audience.size, 1);
  server.exitCode = 0;
  server.emit('exit', 0);
  assert.equal(h.audience.size, 0);
});

test('RTMP retains an unterminated encoder probe and retries cleanup on the next stop', async t => {
  const probe = new FakeProcess();
  probe.pid = 1234;
  probe.kill = () => false;
  const h = await harness(t, { selector: async (_config, options) => {
    options.onProcess(probe);
    throw new Error('RTMP 编码检查进程未能退出');
  } });
  await assert.rejects(h.session.begin({ mimeType: 'video/webm;codecs=vp8,opus' }), /未能退出/);
  assert.equal(h.session.ownedProcesses.has(probe), true);
  await assert.rejects(h.session.stop(), /子进程未能退出/);
  probe.kill = FakeProcess.prototype.kill;
  await h.session.stop();
  assert.equal(h.session.ownedProcesses.size, 0);
});

test('RTMP chunks are copied in order and ACK waits for both write callback and drain', async t => {
  const h = await harness(t);
  const generation = await running(h);
  const input = h.children[1].child.stdin;
  input.mode = 'drain';
  const data = new Uint8Array([1, 2, 3]);
  let settled = false;
  const first = h.session.append({ generation, sequence: 0, bytes: data }).then(value => { settled = true; return value; });
  data.fill(9);
  input.callbacks[0]();
  await turn();
  assert.equal(settled, false);
  input.emit('drain');
  assert.deepEqual(await first, { generation, sequence: 0 });
  input.mode = 'immediate';
  assert.deepEqual(await h.session.append({ generation, sequence: 1, bytes: new Uint8Array([4]) }), { generation, sequence: 1 });
  assert.deepEqual(Buffer.concat(input.writes), Buffer.from([1, 2, 3, 4]));
});

test('RTMP old generations are rejected without stopping the active generation', async t => {
  const h = await harness(t);
  const generation = await running(h);
  await assert.rejects(h.session.append({ generation: 'old-generation', sequence: 0, bytes: new Uint8Array([1]) }), /失效/);
  await assert.rejects(h.session.finish({ generation: 'old-generation' }), /失效/);
  assert.equal(h.session.getInfo().phase, 'ready');
  assert.deepEqual(await h.session.append({ generation, sequence: 0, bytes: new Uint8Array([2]) }), { generation, sequence: 0 });
});

for (const [name, input] of [
  ['wrong sequence', { sequence: 1, bytes: new Uint8Array([1]) }],
  ['noninteger sequence', { sequence: 0.1, bytes: new Uint8Array([1]) }],
  ['empty data', { sequence: 0, bytes: new Uint8Array() }],
  ['non-Uint8 data', { sequence: 0, bytes: new Uint16Array([1]) }],
  ['oversized data', { sequence: 0, bytes: new Uint8Array(MAX_CHUNK_BYTES + 1) }],
]) test(`RTMP ${name} ends the continuous container`, async t => {
  const h = await harness(t);
  const generation = await running(h);
  await assert.rejects(h.session.append({ generation, ...input }));
  assert.equal(h.session.getInfo().phase, 'error');
  assert.equal(h.children[1].child.stdin.writes.length, 0);
});

test('RTMP overlapping writes cancel both requests instead of accepting a missing or reordered chunk', async t => {
  const h = await harness(t);
  const generation = await running(h);
  h.children[1].child.stdin.mode = 'drain';
  const first = h.session.append({ generation, sequence: 0, bytes: new Uint8Array([1]) });
  const firstRejected = assert.rejects(first, /取消/);
  await assert.rejects(h.session.append({ generation, sequence: 0, bytes: new Uint8Array([2]) }), /重叠/);
  await firstRejected;
  assert.equal(h.session.getInfo().phase, 'error');
  assert.equal(h.children[1].child.stdin.writes.length, 1);
});

test('RTMP write stall is bounded and closes its native pipeline', async t => {
  const h = await harness(t, { timings: { writeTimeoutMs: 20 } });
  const generation = await running(h);
  h.children[1].child.stdin.mode = 'drain';
  await assert.rejects(h.session.append({ generation, sequence: 0, bytes: new Uint8Array([1]) }), /写入超过/);
  assert.equal(h.session.getInfo().phase, 'error');
  assert.deepEqual(h.children[1].child.signals, ['SIGTERM']);
});

test('RTMP preparation cancellation closes its listener and cannot spawn a late native server', async t => {
  const port = deferred();
  const h = await harness(t, { dependencies: { allocateLoopbackPort: () => port.promise } });
  const preparing = h.session.prepare();
  const rejected = assert.rejects(preparing, /取消/);
  for (let attempt = 0; attempt < 20 && !h.session.authServer?.listening; ++attempt) await pause(2);
  const address = h.session.authServer.address();
  const stopping = h.session.stop();
  port.resolve(12345);
  await stopping;
  await rejected;
  assert.equal(h.children.length, 0);
  assert.equal(h.session.getInfo().phase, 'stopped');
  assert.deepEqual(await fs.readdir(h.directory), []);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${address.port}/`, resolve);
    request.once('error', reject);
  }));
});

test('RTMP selector sees cancellation and late probe completion cannot spawn the encoder', async t => {
  const probe = deferred();
  const h = await harness(t, { selector: () => probe.promise });
  const beginning = h.session.begin({ mimeType: 'video/webm;codecs=vp8,opus' });
  const rejected = assert.rejects(beginning, /取消/);
  for (let attempt = 0; attempt < 20 && !h.probes.length; ++attempt) await pause(2);
  await h.session.stop();
  assert.equal(h.probes[0].options.signal.aborted, true);
  probe.resolve({ codec: 'H264', encoder: 'h264_nvenc', hardware: true, label: 'NVENC', args: ['-c:v', 'h264_nvenc'] });
  await rejected;
  assert.equal(h.children.length, 1);
});

test('RTMP unsupported MIME is rejected before starting native services', async t => {
  const h = await harness(t);
  await assert.rejects(h.session.begin({ mimeType: 'video/webm;codecs=vp9,opus' }), /不受支持/);
  await assert.rejects(h.session.begin({ mimeType: 'video/webm;codecs=vp8,opus -y' }), /不受支持/);
  assert.equal(h.children.length, 0);
});

test('RTMP state redacts native credentials and old links become unusable on finish', async t => {
  const h = await harness(t);
  const generation = await running(h);
  const info = h.session.getInfo();
  h.children[1].child.stderr.emit('data', Buffer.from(`error ${h.session.publishUrl} ${h.session.controlPassword}`));
  h.children[1].child.exitCode = 1;
  h.children[1].child.emit('exit', 1);
  await h.session.cleanupTask;
  const failed = h.session.getInfo();
  assert.equal(failed.phase, 'error');
  assert.equal(failed.localUrl, '');
  assert.ok(!failed.message.includes(h.session.publisherPassword));
  assert.ok(!failed.message.includes(h.session.controlPassword));
  assert.ok(!failed.message.includes(info.localUrl));
  assert.equal((await h.session.finish({ generation })).phase, 'error');
});

test('RTMP WAN updates retain the stream token and upload counts exclude the internal publisher', async t => {
  const h = await harness(t);
  await running(h);
  await auth(h.session, readRequest(h.session));
  const local = h.session.getInfo().localUrl;
  h.session.updateAdvertisedHost('10.2.3.9');
  assert.equal(h.session.getInfo().localUrl, local);
  assert.equal(h.session.getInfo().forwardedUrl, local.replace('192.168.9.2:1935', '10.2.3.9:21935'));
  h.state.connections = [{ id: readerId, state: 'read', path: h.session.streamPath, outboundBytes: 0 },
    { id: publisherId, state: 'publish', path: h.session.streamPath, outboundBytes: 10000000 }];
  await h.session._poll();
  h.state.now += 1000;
  h.state.connections[0].outboundBytes += 1000000;
  h.state.connections[1].outboundBytes += 10000000;
  await h.session._poll();
  assert.equal(h.session.getInfo().uploadMbps, 8);
});

test('RTMP disabled mode does not start or probe native services', async t => {
  const h = await harness(t, { config: { rtmpEnabled: false } });
  assert.equal((await h.session.prepare()).enabled, false);
  await assert.rejects(h.session.begin({ mimeType: 'video/webm;codecs=vp8,opus' }), /不可用/);
  assert.equal(h.children.length, 0);
  assert.equal(h.probes.length, 0);
});

test('video-only RTMP does not claim an AAC track', async t => {
  const h = await harness(t, { config: { microphone: false, systemAudio: false } });
  await running(h);
  assert.equal(h.session.getInfo().codec, 'H.264');
  assert.doesNotMatch(h.session.getInfo().message, /AAC/);
});
