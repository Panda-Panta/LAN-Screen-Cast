const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness(plans = [], options = {}) {
  const pcs = [], messages = [], states = [], timers = new Set();
  class Peer {
    constructor() {
      this.plan = plans.shift() || {};
      this.connectionState = 'new'; this.signalingState = 'stable'; this.remoteDescription = null;
      this.localCalls = 0; this.iceCalls = []; this.closed = false;
      pcs.push(this);
    }
    addTransceiver() { return { mid: '0', setCodecPreferences: codecs => { this.codecPreferences = codecs; }, sender: { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} } }; }
    createOffer() { return this.plan.offer || Promise.resolve({ type: 'offer', sdp: 'v=0\r\n' }); }
    async setLocalDescription(description) {
      this.localCalls++;
      if (this.closed) throw new Error('closed');
      this.signalingState = 'have-local-offer';
      this.localDescription = { toJSON: () => ({ ...description }) };
    }
    async setRemoteDescription(description) { await this.plan.answer; this.remoteDescription = description; this.signalingState = 'stable'; }
    async addIceCandidate(candidate) { this.iceCalls.push(candidate); if (this.closed) throw new Error('closed'); }
    getStats() { return this.plan.stats || Promise.resolve(new Map([
      ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264' }],
      ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', codecId: 'codec', timestamp: 1000, bytesSent: 100000, framesEncoded: 30 }],
    ])); }
    close() { this.closed = true; this.connectionState = 'closed'; }
  }
  const context = vm.createContext({
    RTCPeerConnection: Peer, crypto: { randomUUID }, Map, Promise, console,
    RTCRtpSender: { getCapabilities: () => ({ codecs: options.codecs || [
      { mimeType: 'video/VP8', clockRate: 90000 },
      { mimeType: 'video/H264', clockRate: 90000 },
      { mimeType: 'video/H265', clockRate: 90000 },
      { mimeType: 'video/rtx', clockRate: 90000 },
    ] }) },
    advertiseCandidate: candidate => [candidate, { ...candidate, candidate: 'mapped-candidate' }],
    advertiseDescription: description => ({ ...description, sdp: `${description.sdp}mapped-sdp` }),
    setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: callback => timers.delete(callback),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'rtc.js'), 'utf8').replace(/^export /gm, ''), context, { filename: 'rtc.js' });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'host-media.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class HostMedia', 'class HostMedia')
    + '\nglobalThis.Media = HostMedia;';
  vm.runInContext(source, context, { filename: 'host-media.js' });
  const video = { kind: 'video', stop() {} };
  const media = new context.Media({ getTracks: () => [video], getAudioTracks: () => [] }, { bitrateMbps: 6, fps: 30, codec: options.codec || 'auto' }, async (id, message) => messages.push({ id, ...message }), (id, state, message, codec) => states.push({ id, state, message, codec }));
  return { media, pcs, messages, states, timers };
}

test('a removed peer cannot apply a late offer to a closed connection', async () => {
  const offer = deferred();
  const { media, pcs } = harness([{ offer: offer.promise }]);
  const adding = media.add('viewer');
  await turn();
  media.remove('viewer');
  offer.resolve({ type: 'offer', sdp: 'v=0\r\n' });
  await adding.catch(() => {});
  assert.equal(pcs[0].localCalls, 0);
});

test('removal during remote description does not flush queued ICE into the old connection', async () => {
  const answer = deferred();
  const { media, pcs } = harness([{ answer: answer.promise }]);
  await media.add('viewer');
  const generation = media.peers.get('viewer').generation;
  await media.signal({ type: 'candidate', peerId: 'viewer', generation, candidate: { candidate: 'first' } });
  const applying = media.signal({ type: 'answer', peerId: 'viewer', generation, sdp: { type: 'answer', sdp: 'v=0' } });
  await turn();
  media.remove('viewer');
  answer.resolve(); await applying;
  assert.equal(pcs[0].iceCalls.length, 0);
});

test('candidate overflow closes the offending peer without relying on its UI callback', async () => {
  const { media, pcs, states } = harness();
  await media.add('viewer');
  const generation = media.peers.get('viewer').generation;
  for (let index = 0; index < 129; index++) await media.signal({ type: 'candidate', peerId: 'viewer', generation, candidate: { candidate: `candidate-${index}` } });
  assert.equal(media.peers.size, 0);
  assert.equal(pcs[0].closed, true);
  assert.equal(states.filter(item => item.state === 'error').length, 1);
});

test('the negotiation timeout covers pending offer creation and releases the peer', async () => {
  const offer = deferred();
  const { media, pcs, timers, states } = harness([{ offer: offer.promise }]);
  const adding = media.add('viewer');
  await turn();
  try {
    assert.equal(timers.size, 1, 'the timer must start when a viewer is admitted, before slow WebRTC calls');
    [...timers][0]();
    assert.equal(media.peers.size, 0);
    assert.equal(pcs[0].closed, true);
    assert.equal(states.at(-1).state, 'timeout');
  } finally {
    media.stop(); offer.resolve({ type: 'offer', sdp: 'v=0' }); await adding.catch(() => {});
  }
});

test('an old generation cannot add ICE and a late old error cannot mark the replacement as failed', async () => {
  const answer = deferred();
  const { media, pcs, states } = harness([{ answer: answer.promise }]);
  await media.add('viewer');
  const oldGeneration = media.peers.get('viewer').generation;
  const oldAnswer = media.signal({ type: 'answer', peerId: 'viewer', generation: oldGeneration, sdp: { type: 'answer', sdp: 'v=0' } });
  await turn();
  await media.add('viewer');
  answer.reject(new Error('old answer failed')); await oldAnswer;
  await media.signal({ type: 'candidate', peerId: 'viewer', generation: oldGeneration, candidate: { candidate: 'stale' } });
  assert.equal(pcs[1].iceCalls.length, 0);
  assert.equal(states.filter(item => item.state === 'error').length, 0);
  media.stop();
});

test('advertised candidates and description are used only for outbound signaling', async () => {
  const { media, pcs, messages } = harness();
  await media.add('viewer');
  pcs[0].onicecandidate({ candidate: { toJSON: () => ({ candidate: 'original-candidate', sdpMid: '0' }) } });
  await turn();
  assert.equal(messages.find(item => item.type === 'offer').sdp.sdp, 'v=0\r\nmapped-sdp');
  assert.deepEqual(messages.filter(item => item.type === 'candidate').map(item => item.candidate.candidate), ['original-candidate', 'mapped-candidate']);
  assert.equal(pcs[0].localDescription.toJSON().sdp, 'v=0\r\n');
  media.stop();
});

test('an HEVC request negotiates H264 with a receiver that does not accept HEVC and reports the fallback', async () => {
  const { media, pcs, states } = harness([], { codec: 'HEVC' });
  await media.add('viewer');
  try {
    const generation = media.peers.get('viewer').generation;
    await media.signal({ type: 'answer', peerId: 'viewer', generation, sdp: { type: 'answer', sdp:
      'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\na=mid:0\r\na=rtpmap:96 H264/90000\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:98 VP8/90000\r\n' } });
    pcs[0].connectionState = 'connected';
    pcs[0].onconnectionstatechange();
    const stats = await media.stats();
    assert.equal(stats.connected, 1);
    assert.equal(stats.codecs[0].requested, 'HEVC');
    assert.equal(stats.codecs[0].negotiated, 'H264');
    assert.equal(stats.codecs[0].actual, 'H264');
    assert.equal(stats.codecs[0].fallback, true);
    assert.equal(stats.codecs[0].fallbackReason, 'not-negotiated');
    assert.match(stats.codecs[0].message, /HEVC.*H\.264|HEVC.*H264/);
    assert.equal(states.some(state => state.codec?.negotiated === 'H264'), true);
  } finally { media.stop(); }
});

test('HEVC is only marked as actual after outbound stats identify the encoder codec', async () => {
  const reports = new Map([
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H265' }],
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', codecId: 'codec', timestamp: 1000,
      bytesSent: 100000, framesEncoded: 30, encoderImplementation: 'hardware encoder', powerEfficientEncoder: true }],
  ]);
  const { media, pcs, states } = harness([{ stats: Promise.resolve(reports) }], { codec: 'HEVC' });
  await media.add('viewer');
  try {
    assert.equal(states.some(state => state.codec?.actual === 'HEVC'), false);
    pcs[0].connectionState = 'connected';
    const stats = await media.stats();
    assert.equal(stats.codecs[0].actual, 'HEVC');
    assert.equal(stats.codecs[0].phase, 'actual');
    assert.equal(stats.codecs[0].fallback, false);
    assert.equal(stats.codecs[0].encoderImplementation, 'hardware encoder');
    assert.equal(stats.codecs[0].powerEfficientEncoder, true);
    assert.equal(stats.codecs[0].framesEncoded, 30);
  } finally { media.stop(); }
});

test('an accepted HEVC answer followed by H264 frames reports an observed codec change without blaming the receiver', async () => {
  const { media, pcs } = harness([], { codec: 'HEVC' });
  await media.add('viewer');
  try {
    const generation = media.peers.get('viewer').generation;
    await media.signal({ type: 'answer', peerId: 'viewer', generation, sdp: { type: 'answer', sdp:
      'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 112 96\r\na=mid:0\r\na=rtpmap:112 H265/90000\r\na=rtpmap:96 H264/90000\r\n' } });
    pcs[0].connectionState = 'connected';
    const stats = await media.stats();
    assert.equal(stats.codecs[0].negotiated, 'HEVC');
    assert.equal(stats.codecs[0].actual, 'H264');
    assert.equal(stats.codecs[0].fallbackReason, 'different-actual-codec');
    assert.doesNotMatch(stats.codecs[0].message, /未协商|接收端/);
  } finally { media.stop(); }
});

test('an outbound HEVC codec with zero encoded frames is still awaiting actual video transmission', async () => {
  const reports = new Map([
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H265' }],
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', codecId: 'codec', timestamp: 1000, bytesSent: 0, framesEncoded: 0 }],
  ]);
  const { media, pcs } = harness([{ stats: Promise.resolve(reports) }], { codec: 'HEVC' });
  await media.add('viewer');
  try {
    pcs[0].connectionState = 'connected';
    const stats = await media.stats();
    assert.equal(stats.codecs[0].actual, '');
    assert.equal(stats.codecs[0].phase, 'preference');
  } finally { media.stop(); }
});

test('a replaced generation cannot publish its late codec answer', async () => {
  const answer = deferred();
  const { media, states } = harness([{ answer: answer.promise }], { codec: 'HEVC' });
  await media.add('viewer');
  const generation = media.peers.get('viewer').generation;
  const applying = media.signal({ type: 'answer', peerId: 'viewer', generation, sdp: { type: 'answer', sdp:
    'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=rtpmap:96 H264/90000\r\n' } });
  await turn();
  await media.add('viewer');
  answer.resolve(); await applying;
  try {
    assert.equal(states.some(state => state.codec?.negotiated === 'H264'), false);
    const stats = await media.stats();
    assert.equal(stats.codecs[0].negotiated, '');
    assert.equal(stats.codecs[0].actual, '');
  } finally { media.stop(); }
});

test('a replaced generation cannot publish late HEVC stats or change its replacement codec', async () => {
  const pending = deferred();
  const { media, pcs, states } = harness([{ stats: pending.promise }], { codec: 'HEVC' });
  await media.add('viewer');
  pcs[0].connectionState = 'connected';
  const sampling = media.stats();
  await turn();
  await media.add('viewer');
  pending.resolve(new Map([
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H265' }],
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', codecId: 'codec', timestamp: 1000, bytesSent: 100000, framesEncoded: 30 }],
  ]));
  try {
    const stats = await sampling;
    assert.equal(stats.connected, 0);
    assert.equal(stats.codecs.some(codec => codec.actual === 'HEVC'), false);
    assert.equal(states.some(state => state.codec?.actual === 'HEVC'), false);
    assert.equal((await media.stats()).codecs[0].actual, '');
  } finally { media.stop(); }
});
