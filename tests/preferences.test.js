const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, validateConfig, validatePreferences } = require('../src/config');

test('RTMP preferences persist both ports, codec and acceleration while session secrets are discarded', () => {
  const settings = validatePreferences({host:'192.168.70.7',rtmpEnabled:true,rtmpPort:11935,advertisedRtmpPort:21935,
    rtmpCodec:'HEVC',rtmpAcceleration:'hardware',rtmpUrl:'rtmp://hidden',generation:'temporary',hardware:true});
  assert.equal(settings.rtmpPort,11935); assert.equal(settings.advertisedRtmpPort,21935);
  assert.equal(settings.rtmpCodec,'HEVC'); assert.equal(settings.rtmpAcceleration,'hardware');
  assert.equal(settings.rtmpUrl,undefined); assert.equal(settings.generation,undefined); assert.equal(settings.hardware,undefined);
  assert.deepEqual(validatePreferences(JSON.parse(JSON.stringify(settings))),settings);
});

test('preferences preserve an unfinished automatic WAN setup without needing a live interface', () => {
  assert.equal(typeof validatePreferences, 'function');
  const input = { ...DEFAULTS, host: '192.168.70.7', forwardingEnabled: true,
    autoRouterAddress: true, advertisedHost: '', codec: 'HEVC', networkName: 'Ethernet', arbitrary: 'discard' };
  const saved = validatePreferences(input);
  assert.equal(saved.forwardingEnabled, true);
  assert.equal(saved.autoRouterAddress, true);
  assert.equal(saved.advertisedHost, '');
  assert.equal(saved.codec, 'HEVC');
  assert.equal(saved.networkName, 'Ethernet');
  assert.equal(Object.hasOwn(saved, 'arbitrary'), false);
  assert.throws(() => validateConfig(saved, [{ address: input.host }]), /WAN/);
});

test('preferences reject invalid numeric and codec values while permitting stale saved IPv4', () => {
  assert.equal(typeof validatePreferences, 'function');
  assert.equal(validatePreferences({ ...DEFAULTS, host: '192.168.70.7', port: 9000 }).port, 9000);
  for (const value of [{ port: '' }, { codec: 'fake' }, { advertisedHost: 'javascript:1' },
    { autoRouterAddress: 'yes' }, { host: 'example.com' }, { bitrateMbps: 20, maxViewers: 5 }]) {
    assert.throws(() => validatePreferences({ ...DEFAULTS, host: '192.168.70.7', ...value }));
  }
});

test('older saved preferences and an empty draft receive compatible audio defaults', () => {
  const { systemAudio, systemVolume, micVolume, ...oldDefaults } = DEFAULTS;
  for (const input of [{}, { ...oldDefaults, host: '192.168.70.7', microphone: true, micDeviceId: 'saved-microphone' },
    { ...DEFAULTS, systemAudio: undefined, systemVolume: undefined, micVolume: undefined }]) {
    const saved = validatePreferences(input);
    assert.equal(saved.systemAudio, false);
    assert.equal(saved.systemVolume, 100);
    assert.equal(saved.micVolume, 100);
    assert.equal(saved.microphone, input.microphone === true);
    assert.equal(saved.micDeviceId, input.micDeviceId || '');
  }
});

test('saved audio preferences survive JSON round-trip alongside an unfinished WAN draft', () => {
  const input = { ...DEFAULTS, host: '192.168.70.7', forwardingEnabled: true, advertisedHost: '',
    systemAudio: true, systemVolume: '25', microphone: true, micVolume: '0', micDeviceId: 'physical-microphone',
    audioContext: 'discard', displayMediaId: 'discard', sourceId: 'discard' };
  const saved = validatePreferences(input);
  assert.equal(saved.systemAudio, true);
  assert.equal(saved.systemVolume, 25);
  assert.equal(saved.microphone, true);
  assert.equal(saved.micVolume, 0);
  assert.equal(saved.micDeviceId, 'physical-microphone');
  assert.equal(saved.forwardingEnabled, true);
  assert.equal(saved.advertisedHost, '');
  for (const field of ['audioContext', 'displayMediaId', 'sourceId']) assert.equal(Object.hasOwn(saved, field), false);
  assert.deepEqual(validatePreferences(JSON.parse(JSON.stringify(saved))), saved);
  assert.throws(() => validateConfig(saved, [{ address: input.host }]), /WAN/);
});

test('draft preferences enforce the same strict audio switch and volume validation as broadcast settings', () => {
  for (const systemAudio of ['true', 'false', 0, 1, null, {}, []]) {
    assert.throws(() => validatePreferences({ ...DEFAULTS, systemAudio }), /系统声音开关/);
  }
  for (const field of ['systemVolume', 'micVolume']) {
    for (const value of [-1, 101, 0.5, NaN, Infinity, true, false, null, '', ' ', '1e2', '0x64', '+10', '5%', {}, []]) {
      assert.throws(() => validatePreferences({ ...DEFAULTS, [field]: value }), /音量.*0–100.*整数/,
        `${field} must reject ${String(value)}`);
    }
    for (const value of [0, 100, '0', '100']) {
      assert.equal(validatePreferences({ ...DEFAULTS, [field]: value })[field], Number(value));
    }
  }
  assert.equal(validatePreferences({ ...DEFAULTS, microphone: 'true' }).microphone, false);
});
