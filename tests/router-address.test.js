const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.resolve('src/renderer/router-address.mjs')).href;
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test('an old interface query cannot overwrite the new WAN address', async () => {
  const { createRouterAddressController } = await import(moduleUrl);
  const first = deferred(); const received = [];
  let config = { enabled: true, automatic: true, host: '192.168.1.2' };
  let queries = 0;
  const controller = createRouterAddressController({ read: () => config,
    detect: () => ++queries === 1 ? first.promise : Promise.resolve({ supported: true, wanAddress: '10.0.0.2' }),
    cancel() {}, onAddress: address => received.push(address) });
  const old = controller.refresh();
  config = { ...config, host: '192.168.2.2' };
  await controller.changed();
  first.resolve({ supported: true, wanAddress: '10.0.0.1' }); await old;
  assert.deepEqual(received, ['10.0.0.2']); controller.dispose();
});

test('automatic polling is disabled in manual mode and unsupported queries preserve prior address', async () => {
  const { createRouterAddressController } = await import(moduleUrl);
  let config = { enabled: true, automatic: false, host: '192.168.1.2' };
  let queries = 0, interval, address = '10.0.0.9', status;
  const controller = createRouterAddressController({ read: () => config,
    detect: async () => { queries++; return { supported: false, message: 'manual required' }; }, cancel() {},
    onAddress: value => { address = value; }, onState: value => { status = value; },
    timers: { setInterval(fn) { interval = fn; return 1; }, clearInterval() {} } });
  controller.start(); await interval(); assert.equal(queries, 0);
  config = { ...config, automatic: true }; await controller.changed();
  assert.equal(queries, 1); assert.equal(address, '10.0.0.9');
  assert.equal(status.status, 'unsupported'); controller.dispose();
});

test('repeated refresh coalesces while querying and unsafe returned addresses never apply', async () => {
  const { createRouterAddressController } = await import(moduleUrl);
  const response = deferred(); let queries = 0, address;
  const controller = createRouterAddressController({ read: () => ({ enabled: true, automatic: true, host: '192.168.1.2' }),
    detect: () => { queries++; return response.promise; }, cancel() {}, onAddress: value => { address = value; } });
  const first = controller.refresh(), second = controller.refresh();
  response.resolve({ supported: true, wanAddress: '127.0.0.1' }); await Promise.all([first, second]);
  assert.equal(queries, 1); assert.equal(address, undefined); controller.dispose();
});
