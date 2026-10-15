const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/settings-store');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function temporarySettings(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-cast-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, filename: path.join(directory, 'data', 'settings.json') };
}

test('an idle settings draft is persisted and read back by a fresh settings store', async t => {
  const { filename } = await temporarySettings(t);
  const store = new SettingsStore(filename, { defaults: { fps: 30, microphone: false } });
  await store.save({ roomName: 'idle edit', fps: 60, microphone: true });
  const reloaded = new SettingsStore(filename, { defaults: { fps: 30, microphone: false } });
  assert.deepEqual(await reloaded.load(), { roomName: 'idle edit', fps: 60, microphone: true });
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), { roomName: 'idle edit', fps: 60, microphone: true });
});

test('partial writes leave the previously saved JSON intact until atomic replacement', async t => {
  const { filename } = await temporarySettings(t);
  await new SettingsStore(filename).save({ roomName: 'previous' });
  const original = await fs.readFile(filename, 'utf8');
  const entered = deferred(), finish = deferred();
  const store = new SettingsStore(filename, { fs: {
    ...fs,
    writeFile: async (target, contents, encoding) => {
      await fs.writeFile(target, contents.slice(0, 8), encoding);
      entered.resolve();
      await finish.promise;
      await fs.writeFile(target, contents, encoding);
    },
  } });
  const saving = store.save({ roomName: 'new' });
  await entered.promise;
  try { assert.equal(await fs.readFile(filename, 'utf8'), original); }
  finally { finish.resolve(); await saving; }
  assert.deepEqual(await store.load(), { roomName: 'new' });
  assert.deepEqual(await fs.readdir(path.dirname(filename)), ['settings.json']);
});

test('concurrent saves remain ordered and close flush waits for the latest snapshot', async t => {
  const { filename } = await temporarySettings(t);
  const entered = deferred(), finish = deferred();
  let writes = 0;
  const store = new SettingsStore(filename, { fs: {
    ...fs,
    writeFile: async (...args) => {
      if (++writes === 1) { entered.resolve(); await finish.promise; }
      return fs.writeFile(...args);
    },
  } });
  const first = store.save({ roomName: 'older' });
  await entered.promise;
  const latest = { roomName: 'newest', nested: { microphone: true } };
  const second = store.save(latest);
  latest.roomName = 'mutation after enqueue';
  latest.nested.microphone = false;
  const closing = store.flush();
  try {
    assert.equal(await Promise.race([closing.then(() => 'closed'), turn().then(() => 'waiting')]), 'waiting');
    assert.equal(writes, 1, 'a queued save cannot begin while the preceding write is outstanding');
  } finally {
    finish.resolve();
    await Promise.all([first, second, closing]);
  }
  assert.deepEqual(await new SettingsStore(filename).load(), { roomName: 'newest', nested: { microphone: true } });
});

test('a failed replacement preserves the prior file and the next save recovers the queue', async t => {
  const { filename } = await temporarySettings(t);
  await new SettingsStore(filename).save({ roomName: 'previous' });
  let fail = true;
  const store = new SettingsStore(filename, { fs: {
    ...fs,
    rename: async (...args) => { if (fail) throw new Error('rename failed'); return fs.rename(...args); },
  } });
  await assert.rejects(store.save({ roomName: 'failed' }), /rename failed/);
  await assert.rejects(store.flush(), /rename failed/);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), { roomName: 'previous' });
  assert.deepEqual(await fs.readdir(path.dirname(filename)), ['settings.json']);
  fail = false;
  await store.save({ roomName: 'recovered' });
  await store.flush();
  assert.deepEqual(await store.load(), { roomName: 'recovered' });
});

test('missing or damaged settings fall back to defaults without changing the file', async t => {
  const { filename } = await temporarySettings(t);
  const defaults = { roomName: 'default', fps: 30 };
  const store = new SettingsStore(filename, { defaults });
  assert.deepEqual(await store.load(), { roomName: 'default', fps: 30 });
  await fs.mkdir(path.dirname(filename), { recursive: true });
  for (const contents of ['broken JSON', '["not settings"]', 'null']) {
    await fs.writeFile(filename, contents);
    assert.deepEqual(await store.load(), { roomName: 'default', fps: 30 });
    assert.equal(await fs.readFile(filename, 'utf8'), contents);
  }
  await fs.writeFile(filename, '{"roomName":"saved"}');
  assert.deepEqual(await store.load(), { roomName: 'saved', fps: 30 });
});
