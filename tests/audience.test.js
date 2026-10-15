const test = require('node:test');
const assert = require('node:assert/strict');
const { AudienceRegistry } = require('../src/audience');
const { LanServer } = require('../src/lan-server');
const { WebSocket } = require('ws');
const { once } = require('node:events');

test('both protocols consume one shared limit and repeated authentication is idempotent', () => {
  const registry = new AudienceRegistry(2), changed = [], joined = [], left = [];
  registry.on('changed', list => changed.push(list)); registry.on('joined', value => joined.push(value)); registry.on('left', value => left.push(value));
  assert.equal(registry.admit('web-1', { protocol: 'webrtc', name: 'Browser' }), true);
  assert.equal(registry.admit('rtmp:reader-1', { protocol: 'rtmp', name: 'Player' }), true);
  assert.equal(registry.admit('rtmp:reader-1', { protocol: 'rtmp' }), true);
  assert.equal(registry.admit('rtmp:reader-1', { protocol: 'webrtc' }), false);
  assert.equal(registry.admit('web-2', { protocol: 'webrtc' }), false);
  assert.equal(registry.size, 2); assert.equal(joined.length, 2); assert.equal(changed.length, 2);
  assert.equal(registry.remove('rtmp:reader-1'), true); assert.equal(registry.remove('rtmp:reader-1'), false);
  assert.equal(registry.admit('web-2', { protocol: 'webrtc' }), true);
  assert.equal(left.length, 1); assert.equal(registry.size, 2);
  const copy = registry.get('web-1'); copy.protocol = 'rtmp'; registry.viewers.length = 0;
  assert.equal(registry.get('web-1').protocol, 'webrtc'); assert.equal(registry.size, 2);
});

test('real web admission is denied while an RTMP reader occupies the last slot', async t => {
  const audience = new AudienceRegistry(1);
  const server = new LanServer({host:'127.0.0.1',port:0,maxViewers:1,roomName:'Shared capacity'}, {audience});
  t.after(() => server.stop());
  const info = await server.start();
  audience.admit('rtmp:reader', {protocol:'rtmp'});
  const join = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${info.port}/signal`, {origin:`http://127.0.0.1:${info.port}`});
    t.after(() => socket.terminate()); await once(socket, 'open');
    const message = once(socket, 'message'); socket.send(JSON.stringify({type:'join',token:info.token}));
    return JSON.parse((await message)[0]);
  };
  assert.equal((await join()).code, 'FULL');
  assert.equal((await fetch(`${info.localUrl}api/status`).then(r=>r.json())).viewers, 1);
  audience.remove('rtmp:reader');
  assert.equal((await join()).type, 'joined');
  assert.equal(server.viewers[0].protocol, 'webrtc');
});
