const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../src/viewer/receiver-session.mjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

class Clock {
  time = 0; next = 0; tasks = new Map();
  set = (callback, delay) => { const id = ++this.next; this.tasks.set(id, { callback, time: this.time + delay }); return id; };
  clear = id => this.tasks.delete(id);
  tick(delay) {
    const target = this.time + delay;
    for (;;) {
      const pending = [...this.tasks].filter(([, task]) => task.time <= target).sort((a, b) => a[1].time - b[1].time)[0];
      if (!pending) break;
      const [id, task] = pending; this.time = task.time; this.tasks.delete(id); task.callback();
    }
    this.time = target;
  }
}
class Socket {
  readyState = 0; sent = []; closed = false;
  open() { this.readyState = 1; this.onopen?.({}); }
  send(value) { this.sent.push(JSON.parse(value)); }
  message(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.({}); }
}
class Peer {
  connectionState = 'new'; remoteDescription = null; localDescription = null; candidates = []; closed = false;
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate(value) { this.candidates.push(value); }
  async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
  async setLocalDescription(value) { this.localDescription = { ...value, toJSON() { return { type: this.type, sdp: this.sdp }; } }; }
  close() { this.closed = true; this.connectionState = 'closed'; }
  state(value) { this.connectionState = value; this.onconnectionstatechange?.(); }
}
async function harness(peerFactory) {
  const { ReceiverSession } = await modulePromise;
  const clock = new Clock(), sockets = [], peers = [], states = [], errors = [], tracks = [];
  let clears = 0;
  const session = new ReceiverSession({
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    createPeer: () => { const peer = peerFactory?.() || new Peer(); peers.push(peer); return peer; },
    setTimer: clock.set, clearTimer: clock.clear,
    onState: state => states.push(state), onError: value => errors.push(value),
    onClear: () => clears++, onTrack: (event, context) => tracks.push({ event, context }),
  });
  return { session, clock, sockets, peers, states, errors, tracks, get clears() { return clears; } };
}
const credentials = { token: 'old-token', pin: '', name: 'receiver' };
const offer = generation => ({ type: 'offer', generation, sdp: { type: 'offer', sdp: 'offer' } });

test('default browser timers preserve the Window receiver instead of using the session as this', async () => {
  const { ReceiverSession } = await modulePromise;
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const clock = new Clock();
  try {
    globalThis.setTimeout = function(callback, delay) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return clock.set(callback, delay);
    };
    globalThis.clearTimeout = function(timer) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      clock.clear(timer);
    };
    const session = new ReceiverSession({ createSocket: () => new Socket(), createPeer: () => new Peer() });
    assert.doesNotThrow(() => session.start(credentials));
    assert.equal(clock.tasks.size, 1);
    assert.doesNotThrow(() => session.stop());
    assert.equal(clock.tasks.size, 0);
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
});

test('viewer distinguishes authenticated, negotiating, connected and decoded video stages', async () => {
  const h = await harness(); h.session.start(credentials); h.sockets[0].open();
  h.sockets[0].message({ type: 'joined', roomName: 'test' }); await flush();
  assert.equal(h.states.at(-1).phase, 'admitted');
  h.sockets[0].message(offer('generation-1')); await flush();
  const peer = h.peers[0]; peer.state('connected');
  assert.equal(h.states.at(-1).phase, 'negotiating');
  h.session.noteVideoFrame(peer);
  assert.equal(h.states.at(-1).phase, 'watching');
  assert.equal(h.sockets[0].sent.at(-1).type, 'answer');
  h.session.stop('已断开连接');
});

test('first FULL admission is terminal, while FULL during recovery keeps retrying', async () => {
  const initial = await harness(); initial.session.start(credentials); initial.sockets[0].open();
  initial.sockets[0].message({ type: 'error', code: 'FULL', message: '人数已满' }); await flush();
  initial.clock.tick(60000);
  assert.equal(initial.sockets.length, 1); assert.equal(initial.session.desired, false);
  const recovery = await harness(); recovery.session.start(credentials); recovery.sockets[0].open(); recovery.sockets[0].close();
  recovery.clock.tick(1000); assert.equal(recovery.sockets.length, 2);
  recovery.sockets[1].open(); recovery.sockets[1].message({ type: 'error', code: 'FULL', message: '人数已满' }); await flush();
  assert.equal(recovery.session.desired, true); recovery.clock.tick(2000);
  assert.equal(recovery.sockets.length, 3); assert.equal(recovery.states.at(-1).phase, 'connecting');
  recovery.session.stop();
});

test('ended, kicked, authentication failure and user disconnect clear media and stop retrying', async () => {
  for (const message of [ { type: 'ended' }, { type: 'kicked' }, { type: 'error', code: 'AUTH', message: '观看码错误' } ]) {
    const h = await harness(); h.session.start(credentials); h.sockets[0].open();
    h.sockets[0].message(offer('generation-1')); await flush();
    h.sockets[0].message(message); await flush(); h.clock.tick(60000);
    assert.equal(h.session.desired, false); assert.equal(h.peers[0].closed, true);
    assert.equal(h.sockets.length, 1); assert.equal(h.states.at(-1).phase, 'terminal'); assert.ok(h.clears >= 2);
  }
  const h = await harness(); h.session.start(credentials); h.sockets[0].close(); h.session.stop(); h.clock.tick(60000);
  assert.equal(h.sockets.length, 1);
});

test('late SDP work, track and socket callbacks from an old invitation cannot change the new session', async () => {
  const pending = deferred();
  const firstPeer = new Peer(); firstPeer.setRemoteDescription = async value => { await pending.promise; firstPeer.remoteDescription = value; };
  let created = 0; const h = await harness(() => ++created === 1 ? firstPeer : new Peer());
  h.session.start(credentials); const oldSocket = h.sockets[0]; oldSocket.open(); oldSocket.message(offer('old-generation')); await flush();
  const lateTrack = firstPeer.ontrack, lateClose = oldSocket.onclose;
  h.session.start({ ...credentials, token: 'new-token' }); const newSocket = h.sockets[1]; newSocket.open();
  pending.resolve(); await flush(); lateTrack({ streams: [] }); lateClose({}); await flush();
  assert.equal(oldSocket.sent.some(message => message.type === 'answer'), false);
  assert.equal(newSocket.sent[0].token, 'new-token'); assert.equal(h.tracks.length, 0);
  assert.equal(h.sockets.length, 2); assert.equal(h.session.desired, true);
  h.session.stop();
});

test('terminal messages cancel pending SDP immediately even when the server then closes its socket', async () => {
  for (const message of [{ type: 'ended' }, { type: 'kicked' }, { type: 'error', code: 'AUTH', message: '观看码错误' }]) {
    const pending = deferred(), peer = new Peer();
    peer.setRemoteDescription = async value => { await pending.promise; peer.remoteDescription = value; };
    const h = await harness(() => peer); h.session.start(credentials); h.sockets[0].open();
    h.sockets[0].message(offer('pending-generation')); await flush();
    h.sockets[0].message(message); h.sockets[0].close(); await flush();
    assert.equal(h.session.desired, false); assert.equal(h.states.at(-1).phase, 'terminal');
    pending.resolve(); await flush(); h.clock.tick(60000);
    assert.equal(h.sockets.length, 1); assert.equal(h.sockets[0].sent.some(value => value.type === 'answer'), false);
  }
});

test('host RETRY cancels pending SDP immediately and preserves credentials and viewer intent', async () => {
  const pending = deferred(), peer = new Peer();
  peer.setRemoteDescription = async value => { await pending.promise; peer.remoteDescription = value; };
  const h = await harness(() => peer); h.session.start(credentials); h.sockets[0].open();
  h.sockets[0].message(offer('pending-generation')); await flush();
  h.sockets[0].message({ type: 'error', code: 'RETRY', message: '检查 UDP 媒体端口转发' }); await flush();
  assert.equal(h.session.desired, true); assert.equal(h.states.at(-1).phase, 'retrying');
  assert.equal(peer.closed, true); assert.equal(h.sockets[0].closed, true);
  assert.match(h.states.at(-1).detail, /UDP/);
  pending.resolve(); await flush(); h.clock.tick(1000); h.sockets[1].open();
  assert.deepEqual(h.sockets[1].sent[0], { type: 'join', ...credentials });
  assert.equal(h.sockets[0].sent.some(value => value.type === 'answer'), false);
  h.session.stop();
});

test('ICE connecting does not cancel the negotiation deadline', async () => {
  const h = await harness(); h.session.start(credentials); h.sockets[0].open();
  h.sockets[0].message({ type: 'joined' }); h.sockets[0].message(offer('connecting-generation')); await flush();
  h.peers[0].state('connecting'); h.clock.tick(24999);
  assert.equal(h.sockets[0].closed, false); h.clock.tick(1);
  assert.equal(h.sockets[0].closed, true); assert.equal(h.states.at(-1).phase, 'retrying');
  assert.match(h.states.at(-1).detail, /UDP/); h.session.stop();
});

test('remote ICE queues are bounded and drained only for their matching generation', async () => {
  const h = await harness(); h.session.start(credentials); h.sockets[0].open();
  const candidate = { candidate: 'candidate:1 1 udp 1234 192.168.1.2 50000 typ host' };
  h.sockets[0].message({ type: 'candidate', generation: 'old-generation', candidate });
  h.sockets[0].message({ type: 'candidate', generation: 'new-generation', candidate });
  h.sockets[0].message(offer('new-generation')); await flush();
  assert.deepEqual(h.peers[0].candidates, [candidate]);
  h.session.stop();
  const flood = await harness(); flood.session.start(credentials); flood.sockets[0].open();
  for (let i = 0; i < 129; i++) flood.sockets[0].message({ type: 'candidate', generation: 'pending', candidate });
  await flush();
  assert.equal(flood.sockets[0].closed, true); assert.match(flood.errors.at(-1), /候选/);
  flood.session.stop();
});

test('admission and missing video timeouts recover, but no timer resurrects a stopped session', async () => {
  const h = await harness(); h.session.start(credentials); h.clock.tick(15000);
  assert.equal(h.sockets[0].closed, true); assert.equal(h.states.at(-1).phase, 'retrying');
  h.clock.tick(1000); h.sockets[1].open(); h.sockets[1].message({ type: 'joined' }); h.sockets[1].message(offer('generation-2')); await flush();
  h.peers[0].state('connected'); h.clock.tick(25000);
  assert.equal(h.sockets[1].closed, true); assert.match(h.states.at(-1).detail, /UDP/);
  h.session.stop(); const count = h.sockets.length; h.clock.tick(120000); assert.equal(h.sockets.length, count);
});
