const test = require('node:test');
const assert = require('node:assert/strict');

const loadAutosave = () => import('../src/renderer/settings-autosave.mjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function timers() {
  let next = 0;
  const pending = new Map();
  return {
    setTimeout(callback) { const id = ++next; pending.set(id, callback); return id; },
    clearTimeout(id) { pending.delete(id); },
    run() { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(); },
  };
}

test('edits made without broadcasting persist the complete latest settings on close flush', async () => {
  const { createSettingsAutosave } = await loadAutosave();
  const clock = timers();
  let current = { roomName: 'first', fps: 30, microphone: false };
  const saved = [];
  const autosave = createSettingsAutosave({
    read: () => current, save: async config => saved.push(config), timers: clock,
  });
  autosave.schedule();
  current = { roomName: 'latest', fps: 60, microphone: true };
  autosave.schedule();
  assert.deepEqual(saved, [], 'editing only schedules a debounced write');
  await autosave.flush();
  assert.deepEqual(saved, [{ roomName: 'latest', fps: 60, microphone: true }]);
  clock.run();
  await Promise.resolve();
  assert.equal(saved.length, 1, 'close flush cancels its previous debounce timer');
});

test('the debounce saves a detached snapshot of the latest edit', async () => {
  const { createSettingsAutosave } = await loadAutosave();
  const clock = timers();
  const current = { roomName: 'first', nested: { enabled: false } };
  const saved = [];
  const autosave = createSettingsAutosave({ read: () => current, save: async config => saved.push(config), timers: clock });
  autosave.schedule();
  current.roomName = 'latest';
  current.nested.enabled = true;
  autosave.schedule();
  current.roomName = 'later mutation without an edit event';
  clock.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved, [{ roomName: 'latest', nested: { enabled: true } }]);
});

test('a close flush waits for older writes and leaves the newest settings persisted', async () => {
  const { createSettingsAutosave } = await loadAutosave();
  const clock = timers();
  const entered = deferred(), firstWrite = deferred();
  let current = { roomName: 'older' };
  let persisted = null, writes = 0;
  const autosave = createSettingsAutosave({
    read: () => current,
    save: async config => {
      if (++writes === 1) { entered.resolve(); await firstWrite.promise; }
      persisted = config;
    },
    timers: clock,
  });
  autosave.schedule();
  clock.run();
  await entered.promise;
  current = { roomName: 'newest' };
  autosave.schedule();
  const closed = autosave.flush();
  try {
    assert.equal(await Promise.race([closed.then(() => 'closed'), turn().then(() => 'waiting')]), 'waiting');
    assert.equal(persisted, null, 'the newer write cannot overtake the outstanding older write');
  } finally {
    firstWrite.resolve();
    await closed;
  }
  assert.deepEqual(persisted, { roomName: 'newest' });
});

test('a failed save reports the failure and a later valid edit can still persist', async () => {
  const { createSettingsAutosave } = await loadAutosave();
  const clock = timers();
  const states = [];
  const failure = new Error('disk is unavailable');
  let current = { roomName: 'failed' }, persisted = null;
  const autosave = createSettingsAutosave({
    read: () => current,
    save: async config => { if (config.roomName === 'failed') throw failure; persisted = config; },
    timers: clock, onState: state => states.push(state),
  });
  await assert.rejects(autosave.flush(), /disk is unavailable/);
  assert.equal(states.at(-1)?.status, 'error');
  assert.equal(states.at(-1).error, failure);
  current = { roomName: 'recovered' };
  autosave.schedule();
  clock.run();
  await turn();
  assert.deepEqual(persisted, { roomName: 'recovered' });
  assert.equal(states.at(-1)?.status, 'saved');
});

test('invalid edits cancel an uncommitted snapshot and do not throw from input listeners', async () => {
  const { createSettingsAutosave } = await loadAutosave();
  const clock = timers();
  let invalid = false, persisted = null;
  const states = [];
  const autosave = createSettingsAutosave({
    read: () => { if (invalid) throw new Error('settings draft is invalid'); return { roomName: 'valid' }; },
    save: async config => { persisted = config; }, timers: clock, onState: state => states.push(state),
  });
  autosave.schedule();
  invalid = true;
  assert.doesNotThrow(() => autosave.schedule());
  clock.run();
  await turn();
  assert.equal(persisted, null);
  assert.equal(states.at(-1)?.status, 'error');
  await assert.rejects(autosave.flush(), /settings draft is invalid/);
  invalid = false;
  await autosave.flush();
  assert.deepEqual(persisted, { roomName: 'valid' });
});

test('a completed older save does not announce saved while a newer edit is pending', async () => {
  const { createSettingsAutosave } = await loadAutosave();
  const clock = timers();
  const entered = deferred(), firstWrite = deferred();
  let current = { roomName: 'older' }, writes = 0;
  const states = [];
  const autosave = createSettingsAutosave({
    read: () => current,
    save: async () => { if (++writes === 1) { entered.resolve(); await firstWrite.promise; } },
    timers: clock, onState: state => states.push(state),
  });
  autosave.schedule();
  clock.run();
  await entered.promise;
  current = { roomName: 'newer' };
  autosave.schedule();
  firstWrite.resolve();
  await turn();
  assert.equal(states.at(-1)?.status, 'pending');
  clock.run();
  await turn();
  assert.equal(states.at(-1)?.status, 'saved');
});

test('cancel drops a debounce and dispose prevents future saves or UI callbacks', async () => {
  const { createSettingsAutosave } = await loadAutosave();
  const clock = timers();
  const saved = [], states = [];
  const autosave = createSettingsAutosave({
    read: () => ({ roomName: 'edited' }), save: async config => saved.push(config),
    timers: clock, onState: state => states.push(state),
  });
  autosave.schedule();
  autosave.cancel();
  clock.run();
  await turn();
  assert.deepEqual(saved, []);
  await autosave.flush();
  assert.deepEqual(saved, [{ roomName: 'edited' }]);
  autosave.dispose();
  const previousStates = states.length;
  autosave.schedule();
  clock.run();
  await autosave.flush();
  assert.equal(saved.length, 1);
  assert.equal(states.length, previousStates);
});
