const test = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayMediaHandler } = require('../src/display-media');

function fixture({audioAllowed = false, platform = 'win32', getSources} = {}) {
  const frame = {};
  let selection = {id: 'screen:1:0', revision: 1, audioAllowed, frame};
  const source = {id: selection.id, name: 'Selected display'};
  const calls = [];
  const handler = createDisplayMediaHandler({getSelection: () => selection,
    getSources: getSources || (async () => {calls.push('getSources'); return [source];}), platform});
  return {frame, source, calls, setSelection: value => {selection = value;},
    request: overrides => new Promise(resolve => handler({frame, videoRequested: true, audioRequested: false, ...overrides}, resolve))};
}

test('display capture requests loopback only when the selected capture explicitly enables system audio', async () => {
  const disabled = fixture();
  assert.deepEqual(await disabled.request(), {video: disabled.source});
  assert.equal(await disabled.request({audioRequested: true}), null);
  assert.deepEqual(disabled.calls, ['getSources']);
  const enabled = fixture({audioAllowed: true});
  assert.deepEqual(await enabled.request({audioRequested: true}), {video: enabled.source, audio: 'loopback'});
  assert.deepEqual(await enabled.request(), {video: enabled.source});
});

test('display capture denies foreign frames, audio-only requests and unsupported system loopback', async () => {
  const ctx = fixture({audioAllowed: true});
  assert.equal(await ctx.request({frame: {}}), null);
  assert.equal(await ctx.request({videoRequested: false, audioRequested: true}), null);
  assert.deepEqual(ctx.calls, []);
  const unsupported = fixture({audioAllowed: true, platform: 'linux'});
  assert.equal(await unsupported.request({audioRequested: true}), null);
  assert.deepEqual(unsupported.calls, []);
});

test('a display or audio grant pending source lookup cannot reach a stopped or replaced selection', async () => {
  for (const replacement of [null, {id: 'screen:1:0', revision: 2, audioAllowed: true},
    {id: 'window:2:0', revision: 1, audioAllowed: true}]) {
    let release;
    const pending = new Promise(resolve => {release = resolve;});
    const ctx = fixture({audioAllowed: true, getSources: () => pending});
    const request = ctx.request({audioRequested: true});
    ctx.setSelection(replacement && {...replacement, frame: ctx.frame});
    release([ctx.source]);
    assert.equal(await request, null);
  }
});

test('failed or missing source lookup denies capture without exposing a replacement desktop', async () => {
  for (const getSources of [async () => [], async () => {throw new Error('lookup failed');}]) {
    const ctx = fixture({audioAllowed: true, getSources});
    assert.equal(await ctx.request({audioRequested: true}), null);
  }
});
