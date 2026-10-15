const test = require('node:test');
const assert = require('node:assert/strict');
const { BroadcastSession } = require('../src/broadcast-session');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('cancel during pending listen closes the eventual listener and cannot publish it', async () => {
  const listen = deferred();
  const service = { listening: false, async start() { await listen.promise; this.listening = true; return { port: 8765 }; }, async stop() { this.listening = false; } };
  const session = new BroadcastSession(() => service);
  const started = session.start({});
  const rejected = assert.rejects(started, /取消/);
  await session.stop();
  listen.resolve();
  await rejected;
  assert.equal(service.listening, false);
  assert.equal(session.current, null);
  assert.equal(session.busy, false);
});

test('cancel during QR preparation releases listener and allows the next session', async () => {
  const preparation = deferred();
  const entered = deferred();
  const service = { listening: false, async start() { this.listening = true; return { port: 8765 }; }, async stop() { this.listening = false; } };
  const session = new BroadcastSession(() => service);
  const started = session.start({}, async info => { entered.resolve(); await preparation.promise; return info; });
  const rejected = assert.rejects(started, /取消/);
  await entered.promise;
  await session.stop();
  assert.equal(service.listening, false, 'stop releases an already listening pending service before QR completion');
  preparation.resolve();
  await rejected;
  assert.equal(service.listening, false);
  await session.start({});
  assert.equal(service.listening, true);
  await session.stop();
  assert.equal(service.listening, false);
});

test('duplicate starts and starts during port teardown are rejected', async () => {
  const released = deferred();
  const service = { async start() { return {}; }, stop() { return released.promise; } };
  const session = new BroadcastSession(() => service);
  await session.start({});
  await assert.rejects(session.start({}), /广播/);
  const stopped = session.stop();
  await assert.rejects(session.start({}), /广播/);
  released.resolve(); await stopped;
  assert.equal(session.current, null);
  assert.equal(session.busy, false);
});

test('failed native teardown stays owned, blocks a new audience and can be retried', async () => {
  let canExit = false, creations = 0;
  const service = { async start() { return {}; }, async stop() { if (!canExit) throw new Error('RTMP 子进程未能退出'); } };
  const session = new BroadcastSession(() => { creations++; return service; });
  await session.start({});
  await assert.rejects(session.stop(), /子进程未能退出/);
  assert.equal(session.current, null);
  assert.equal(session.retired, service);
  assert.equal(session.busy, true);
  await assert.rejects(session.start({ port: 8766 }), /广播/);
  assert.equal(creations, 1, 'changing ports must not bypass an unclosed broadcast');
  canExit = true;
  await session.stop();
  assert.equal(session.retired, null);
  assert.equal(session.busy, false);
  await session.start({});
  await session.stop();
});
