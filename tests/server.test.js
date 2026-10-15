const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { WebSocket } = require('ws');
const { LanServer, validSignal } = require('../src/lan-server');

async function start(t, options = {}) {
  const server = new LanServer({ host: '127.0.0.1', port: 0, maxViewers: 2, roomName: '测试', ...options },
    { staticDir: path.join(__dirname, '../src/viewer') });
  const info = await server.start();
  t.after(() => server.stop());
  return { server, info, url: `http://127.0.0.1:${info.port}`, wsUrl: `ws://127.0.0.1:${info.port}/signal` };
}

async function connect(t, ctx, credential = { token: ctx.info.token }) {
  const ws = new WebSocket(ctx.wsUrl, { origin: ctx.url });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const next = message(ws);
  ws.send(JSON.stringify({ type: 'join', name: 'test viewer', ...credential }));
  return { ws, reply: await next };
}

function message(ws) {
  return Promise.race([
    once(ws, 'message').then(([data]) => JSON.parse(data.toString())),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('message timeout')), 2500); timer.unref(); })
  ]);
}

test('HTTP status never reveals credentials; unsafe hosts and private paths are denied', async t => {
  const ctx = await start(t);
  const status = await (await fetch(`${ctx.url}/api/status`)).json();
  assert.equal(status.roomName, '测试');
  assert.equal(status.token, undefined);
  assert.equal(status.pin, undefined);
  assert.equal((await fetch(`${ctx.url}/../main.js`)).status, 404);
  const unsafeStatus = await new Promise((resolve, reject) => {
    http.get(`${ctx.url}/api/status`, { headers: { Host: 'attacker.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(unsafeStatus, 403);
});

test('wrong credentials do not admit a viewer; correct PIN does', async t => {
  const ctx = await start(t);
  const bad = await connect(t, ctx, { pin: 'wrong' });
  assert.equal(bad.reply.type, 'error');
  assert.equal(ctx.server.viewers.length, 0);
  const good = await connect(t, ctx, { pin: ctx.info.pin });
  assert.equal(good.reply.type, 'joined');
  assert.equal(ctx.server.viewers.length, 1);
});

test('signaling reaches only its viewer and incoming identity cannot be forged', async t => {
  const ctx = await start(t);
  const one = await connect(t, ctx);
  const two = await connect(t, ctx);
  const received = message(one.ws);
  ctx.server.sendSignal(one.reply.peerId, { type: 'offer', generation: 'test-generation', sdp: { type: 'offer', sdp: 'v=0' } });
  assert.equal((await received).type, 'offer');
  const incoming = once(ctx.server, 'signal');
  one.ws.send(JSON.stringify({ type: 'answer', generation: 'test-generation', peerId: two.reply.peerId, arbitrary: 'must-not-survive', sdp: { type: 'answer', sdp: 'v=0', unsafe: 'must-not-survive' } }));
  const [signal] = await incoming;
  assert.equal(signal.peerId, one.reply.peerId);
  assert.equal(signal.type, 'answer');
  assert.equal(signal.arbitrary, undefined);
  assert.equal(signal.sdp.unsafe, undefined);
});

test('capacity rejects excess viewers and disconnect frees a slot', async t => {
  const ctx = await start(t, { maxViewers: 1 });
  const one = await connect(t, ctx);
  const two = await connect(t, ctx);
  assert.equal(two.reply.code, 'FULL');
  const left = once(ctx.server, 'viewer-left');
  one.ws.close();
  await left;
  const three = await connect(t, ctx);
  assert.equal(three.reply.type, 'joined');
});

test('cross-origin upgrades are rejected', async t => {
  const ctx = await start(t);
  const ws = new WebSocket(ctx.wsUrl, { origin: 'http://evil.example' });
  t.after(() => ws.terminate());
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
});

test('invalid JSON and unauthorized signals cannot reach broadcaster', async t => {
  const ctx = await start(t);
  let signals = 0;
  ctx.server.on('signal', () => signals++);
  const ws = new WebSocket(ctx.wsUrl, { origin: ctx.url });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const response = message(ws);
  ws.send('{bad json');
  assert.equal((await response).type, 'error');
  assert.equal(signals, 0);
});

test('stop notifies viewers, releases the port and rotates credentials on restart', async t => {
  const ctx = await start(t);
  const one = await connect(t, ctx);
  const ended = message(one.ws);
  await ctx.server.stop();
  assert.equal((await ended).type, 'ended');
  const restarted = await ctx.server.start();
  assert.notEqual(restarted.token, ctx.info.token);
  assert.notEqual(restarted.roomId, ctx.info.roomId);
  assert.equal(ctx.server.viewers.length, 0);
});

test('occupied port returns a useful error without retaining a server handle', async t => {
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const server = new LanServer({ host: '127.0.0.1', port: occupied.address().port, maxViewers: 1 });
  await assert.rejects(server.start(), /端口/);
  await server.stop();
});

test('stop releases a port even if a browser preconnect never sends HTTP headers', async t => {
  const ctx = await start(t);
  const socket = net.connect(ctx.info.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  await new Promise(resolve => setImmediate(resolve));
  const result = await Promise.race([
    ctx.server.stop().then(() => 'stopped'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 1000))
  ]);
  assert.equal(result, 'stopped');
});

test('forwarded and local invitations share credentials, while Host and Origin remain exact', async t => {
  const ctx = await start(t, { forwardingEnabled: true, advertisedHost: '10.23.4.5', advertisedPort: 9876 });
  assert.equal(ctx.info.localUrl, `${ctx.url}/`);
  assert.equal(ctx.info.localInviteUrl, `${ctx.url}/#token=${ctx.info.token}`);
  assert.equal(ctx.info.forwardedUrl, 'http://10.23.4.5:9876/');
  assert.equal(ctx.info.forwardedInviteUrl, `http://10.23.4.5:9876/#token=${ctx.info.token}`);
  assert.equal(ctx.info.url, ctx.info.forwardedUrl);
  assert.equal(ctx.info.inviteUrl, ctx.info.forwardedInviteUrl);
  const request = host => new Promise((resolve, reject) => {
    http.get(`${ctx.url}/api/status`, { headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await request('10.23.4.5:9876'), 200);
  for (const host of ['10.23.4.5:9877', '10.23.4.6:9876', 'attacker.example:9876']) assert.equal(await request(host), 403);
  const ws = new WebSocket(ctx.wsUrl, { origin: 'http://10.23.4.5:9876', headers: { Host: '10.23.4.5:9876' } });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const joined = message(ws);
  ws.send(JSON.stringify({ type: 'join', token: ctx.info.token }));
  assert.equal((await joined).type, 'joined');
  const rejected = new WebSocket(ctx.wsUrl, { origin: 'http://10.23.4.6:9876', headers: { Host: '10.23.4.5:9876' } });
  t.after(() => rejected.terminate());
  assert.match((await once(rejected, 'error'))[0].message, /403/);
});

test('forwarding disabled publishes only LAN addresses and does not admit a saved WAN origin', async t => {
  const ctx = await start(t, { forwardingEnabled: false, advertisedHost: '10.23.4.5', advertisedPort: 9876 });
  assert.equal(ctx.info.url, ctx.info.localUrl);
  assert.equal(ctx.info.inviteUrl, ctx.info.localInviteUrl);
  assert.equal(ctx.info.forwardedUrl, '');
  assert.equal(ctx.info.forwardedInviteUrl, '');
  const ws = new WebSocket(ctx.wsUrl, { origin: 'http://10.23.4.5:9876', headers: { Host: '10.23.4.5:9876' } });
  t.after(() => ws.terminate());
  assert.match((await once(ws, 'error'))[0].message, /403/);
});

test('signals require bounded generation and candidate fields', () => {
  const offer = { type: 'offer', generation: 'generation-1', sdp: { type: 'offer', sdp: 'v=0' } };
  assert.equal(validSignal(offer, ['offer']), true);
  for (const generation of [undefined, '', 'a'.repeat(129), 'bad\r\ngeneration', {}, 123]) {
    assert.equal(validSignal({ ...offer, generation }, ['offer']), false);
  }
  const ice = { type: 'candidate', generation: 'generation-1', candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0 } };
  assert.equal(validSignal(ice, ['candidate']), true);
  assert.equal(validSignal({ ...ice, candidate: null }, ['candidate']), true);
  for (const candidate of [{ candidate: '', sdpMid: 'x'.repeat(129) }, { candidate: '', sdpMLineIndex: -1 },
    { candidate: '', sdpMLineIndex: 64 }, { candidate: '', usernameFragment: 'x'.repeat(257) }, []]) {
    assert.equal(validSignal({ ...ice, candidate }, ['candidate']), false);
  }
  assert.equal(validSignal({ ...ice, candidate: undefined }, ['candidate']), false);
});

test('mapped TCP port 80 uses the browser canonical Host and Origin without an explicit port', async t => {
  const ctx = await start(t, { forwardingEnabled: true, advertisedHost: '10.23.4.5', advertisedPort: 80 });
  assert.equal(ctx.info.forwardedUrl, 'http://10.23.4.5/');
  assert.equal(ctx.info.forwardedInviteUrl, `http://10.23.4.5/#token=${ctx.info.token}`);
  const status = await new Promise((resolve, reject) => {
    http.get(`${ctx.url}/api/status`, { headers: { Host: '10.23.4.5' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 200);
  const ws = new WebSocket(ctx.wsUrl, { origin: 'http://10.23.4.5', headers: { Host: '10.23.4.5' } });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const joined = message(ws);
  ws.send(JSON.stringify({ type: 'join', pin: ctx.info.pin }));
  assert.equal((await joined).type, 'joined');
});

test('invalid forwarding metadata is rejected before any TCP listener is allocated', async t => {
  const service = new LanServer({ host: '127.0.0.1', port: 0, maxViewers: 1,
    forwardingEnabled: true, advertisedHost: 'evil.example', advertisedPort: 80 });
  t.after(() => service.stop());
  await assert.rejects(service.start(), /一级|IPv4/);
  assert.equal(service.server, null);
});

test('automatic media retry reports UDP diagnostics and immediately frees the slot', async t => {
  for (const reason of ['timeout', 'negotiation', 'failed']) {
    const ctx = await start(t, { maxViewers: 1 });
    const viewer = await connect(t, ctx);
    const response = message(viewer.ws);
    const closed = once(viewer.ws, 'close');
    const departed = [];
    ctx.server.on('viewer-left', peer => departed.push(peer.id));
    assert.equal(ctx.server.retry(viewer.reply.peerId, reason), true);
    assert.equal(ctx.server.viewers.length, 0, 'capacity is released before the close handshake finishes');
    assert.deepEqual(departed, [viewer.reply.peerId]);
    const signal = await response;
    assert.equal(signal.type, 'error');
    assert.equal(signal.code, 'RETRY');
    assert.match(signal.message, /媒体/);
    assert.match(signal.message, /UDP/);
    const replacement = await connect(t, ctx);
    assert.equal(replacement.reply.type, 'joined');
    assert.equal((await closed)[0], 1013);
    assert.deepEqual(departed, [viewer.reply.peerId], 'the close event does not emit a second departure');
  }
});

test('retry accepts only media reasons and leaves manual kick terminal', async t => {
  const ctx = await start(t, { maxViewers: 1 });
  const viewer = await connect(t, ctx);
  for (const reason of ['', undefined, 'AUTH', 'kicked', 'toString', {}]) {
    assert.equal(ctx.server.retry(viewer.reply.peerId, reason), false);
    assert.equal(ctx.server.viewers.length, 1);
  }
  assert.equal(ctx.server.retry('unknown-peer', 'timeout'), false);
  const response = message(viewer.ws);
  const closed = once(viewer.ws, 'close');
  ctx.server.kick(viewer.reply.peerId);
  const signal = await response;
  assert.equal(signal.type, 'kicked');
  assert.equal(signal.code, undefined);
  assert.equal((await closed)[0], 1008);
});
