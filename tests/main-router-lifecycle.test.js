const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { BroadcastSession } = require('../src/broadcast-session');
const { createDisplayMediaHandler } = require('../src/display-media');

const root = path.join(__dirname, '..');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

// Exercise the real main-process IPC orchestration and BroadcastSession. Native
// Electron, discovery, QR and disk boundaries are isolated; no GUI is opened.
async function mainHarness() {
  const handlers = new Map(), events = [], servers = [], queries = [];
  let window;
  class Server extends EventEmitter {
    constructor(config) {
      super();
      this.config = { ...config };
      this.roomId = `room-${servers.length + 1}`;
      this.token = `token-${servers.length + 1}`;
      this.pin = '123456';
      this.updates = [];
      servers.push(this);
    }
    async start() { return this.info(); }
    async stop() { if (this.stopError) throw this.stopError; this.stopped = true; }
    info() {
      const localUrl = `http://${this.config.host}:${this.config.port}/`;
      const forwardedUrl = `http://${this.config.advertisedHost}:${this.config.advertisedPort}/`;
      return { roomId: this.roomId, token: this.token, pin: this.pin,
        localUrl, localInviteUrl: `${localUrl}#token=${this.token}`,
        forwardedUrl, forwardedInviteUrl: `${forwardedUrl}#token=${this.token}` };
    }
    updateAdvertisedHost(address) {
      this.updates.push(address);
      this.config = { ...this.config, advertisedHost: address };
      return this.info();
    }
  }
  class Window {
    constructor() {
      window = this;
      this.webContents = {
        mainFrame: {}, getURL: () => 'file:///isolated-host.html',
        send: (_channel, event) => events.push(event),
        setWebRTCUDPPortRange() {}, setWebRTCIPHandlingPolicy() {},
        setWindowOpenHandler() {}, on() {},
      };
    }
    on() {} isDestroyed() { return false; } async loadFile() {} close() { this.closed = true; }
  }
  const mocks = {
    electron: {
      app: { setName() {}, setPath() {}, getPath: () => root,
        whenReady: () => Promise.resolve(), on() {}, quit() {} },
      BrowserWindow: Window,
      ipcMain: { handle: (channel, action) => handlers.set(channel, action) },
      desktopCapturer: { getSources: async () => [{ id: 'screen:1' }] },
      session: { defaultSession: { setPermissionCheckHandler() {},
        setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {} } },
      clipboard: {}, dialog: {}, Menu: { setApplicationMenu() {} },
      powerSaveBlocker: { start: () => 1, stop() {} },
    },
    'node:fs/promises': { mkdir: async () => {} },
    qrcode: { toDataURL: async url => `qr:${url}` },
    './config': { DEFAULTS: {}, listNetworks: () => [{ address: '192.168.1.2', local: false }],
      validateConfig: value => value, validatePreferences: value => value },
    './settings-store': { SettingsStore: class { async load() { return {}; } async save() {} async flush() {} } },
    './cast-server': { CastServer: Server }, './broadcast-session': { BroadcastSession },
    './display-media': { createDisplayMediaHandler },
    './trusted-page': { isLocalDocument: () => true },
    './router-discovery': { discoverRouterWan: input => {
      const pending = deferred(); queries.push({ ...pending, input }); return pending.promise;
    } },
  };
  const context = vm.createContext({ require: name => mocks[name] || require(name),
    __dirname: path.join(root, 'src'), process, console, setTimeout, clearTimeout, AbortController, URL });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8') + '\nglobalThis.finishCloseForTest = finishClose;', context, { filename: 'src/main.js' });
  await turn();
  const call = (name, ...args) => handlers.get(`lan:${name}`)({
    sender: window.webContents, senderFrame: window.webContents.mainFrame,
  }, ...args);
  const config = { host: '192.168.1.2', port: 8765, advertisedPort: 8765,
    advertisedHost: '10.0.0.20', forwardingEnabled: true, autoRouterAddress: true };
  const start = async (address = config.advertisedHost) => {
    const input = { ...config, advertisedHost: address };
    await call('select-source', 'screen:1', input);
    return call('start', input);
  };
  return { call, start, config, servers, queries, events, close: () => context.finishCloseForTest(), isClosed: () => window.closed === true };
}

const successfulQuery = address => ({ supported: true, wanAddress: address, method: 'upnp' });

test('a WAN query from a stopped broadcast cannot update its replacement on the same NIC', async t => {
  const harness = await mainHarness();
  t.after(() => harness.call('stop'));
  await harness.start();
  const oldQuery = harness.call('detect-router', harness.config.host);
  await harness.call('stop');
  await harness.start('10.0.0.21');
  harness.queries[0].resolve(successfulQuery('10.0.0.19'));
  const result = await oldQuery;
  assert.equal(harness.servers[0].stopped, true);
  assert.equal(harness.servers[1].config.advertisedHost, '10.0.0.21');
  assert.equal(harness.servers[1].updates.length, 0);
  assert.equal(result.cancelled, true, 'renderer must also reject the stale WAN result');
  assert.equal(harness.events.some(event => event.type === 'session-info'), false);
});

test('an idle WAN query cannot update a broadcast started while its response was pending', async t => {
  const harness = await mainHarness();
  t.after(() => harness.call('stop'));
  const oldQuery = harness.call('detect-router', harness.config.host);
  await harness.start('10.0.0.21');
  harness.queries[0].resolve(successfulQuery('10.0.0.19'));
  const result = await oldQuery;
  assert.equal(harness.servers[0].config.advertisedHost, '10.0.0.21');
  assert.equal(harness.servers[0].updates.length, 0);
  assert.equal(result.cancelled, true, 'renderer must also reject the stale WAN result');
  assert.equal(harness.events.some(event => event.type === 'session-info'), false);
});

test('a current WAN query updates only its original live broadcast and keeps its credentials', async t => {
  const harness = await mainHarness();
  t.after(() => harness.call('stop'));
  const before = await harness.start();
  const currentQuery = harness.call('detect-router', harness.config.host);
  harness.queries[0].resolve(successfulQuery('10.0.0.22'));
  const result = await currentQuery;
  assert.equal(result.supported, true);
  assert.notEqual(result.cancelled, true);
  assert.equal(harness.servers[0].config.advertisedHost, '10.0.0.22');
  assert.deepEqual(harness.servers[0].updates, ['10.0.0.22']);
  const updated = harness.events.find(event => event.type === 'session-info').payload.info;
  assert.equal(updated.roomId, before.roomId);
  assert.equal(updated.token, before.token);
  assert.equal(updated.pin, before.pin);
  assert.equal(updated.localQr, before.localQr);
  assert.equal(updated.forwardedQr, `qr:http://10.0.0.22:8765/#token=${before.token}`);
});

test('old broadcast events cannot overwrite the replacement viewer list or media signals', async t => {
  const harness = await mainHarness();
  t.after(() => harness.call('stop'));
  await harness.start();
  const old = harness.servers[0];
  await harness.call('stop'); await harness.start();
  harness.events.length = 0;
  for (const type of ['viewer-joined', 'viewer-left', 'viewers', 'signal', 'rtmp-state']) old.emit(type, { roomId: old.roomId });
  assert.equal(harness.events.length, 0);
  harness.servers[1].emit('viewers', [{ id: 'current' }]);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].type, 'viewers');
});

test('a rejected window teardown can be retried after the native owner exits', async () => {
  const harness = await mainHarness();
  await harness.start();
  harness.servers[0].stopError = new Error('RTMP child is still alive');
  await assert.rejects(harness.close(), /still alive/);
  assert.equal(harness.isClosed(), false);
  assert.equal(harness.events.at(-1).type, 'close-error');
  harness.servers[0].stopError = null;
  await harness.close();
  assert.equal(harness.isClosed(), true);
});
