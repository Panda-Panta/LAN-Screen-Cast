const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LanServer } = require('../src/lan-server');

async function status(port, host) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/status`, { headers: { Host: host } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
}

test('live WAN refresh preserves invitation credentials and replaces allowed network origins', async t => {
  const server = new LanServer({ host: '127.0.0.1', port: 0, maxViewers: 5,
    forwardingEnabled: true, advertisedHost: '10.20.30.40', advertisedPort: 8765, roomName: 'test' });
  t.after(() => server.stop());
  const before = await server.start();
  assert.equal(typeof server.updateAdvertisedHost, 'function');
  const after = server.updateAdvertisedHost('10.20.30.41');
  assert.equal(after.pin, before.pin);
  assert.equal(after.token, before.token);
  assert.equal(after.roomId, before.roomId);
  assert.equal(after.localInviteUrl, before.localInviteUrl);
  assert.equal(after.forwardedInviteUrl, `http://10.20.30.41:8765/#token=${before.token}`);
  assert.equal(await status(before.port, '10.20.30.41:8765'), 200);
  assert.equal(await status(before.port, '10.20.30.40:8765'), 403);
  assert.equal(await status(before.port, `127.0.0.1:${before.port}`), 200);
  assert.equal(server.allowedOrigins.has('http://10.20.30.41:8765'), true);
  assert.equal(server.allowedOrigins.has('http://10.20.30.40:8765'), false);
  assert.throws(() => server.updateAdvertisedHost('javascript:1'));
  assert.equal(server.config.advertisedHost, '10.20.30.41');
  await server.stop();
  assert.throws(() => server.updateAdvertisedHost('10.20.30.42'));
});
