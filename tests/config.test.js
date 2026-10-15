const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, listNetworks, validateConfig, validatePreferences } = require('../src/config');

const networks = [{ address: '192.168.1.2', name: 'Ethernet' }];

test('new and missing codec settings default to HEVC hardware priority without retaining runtime fields', () => {
  assert.equal(DEFAULTS.codec, 'HEVC');
  assert.equal(DEFAULTS.rtmpCodec, 'HEVC');
  assert.equal(DEFAULTS.rtmpAcceleration, 'auto');
  const {rtmpEnabled,rtmpPort,advertisedRtmpPort,rtmpCodec,rtmpAcceleration,codec,...old} = DEFAULTS;
  const config = validateConfig({...old,host:networks[0].address,rtmpUrl:'rtmp://secret',ffmpegArgs:['-wrong']},networks);
  assert.equal(config.rtmpEnabled,true); assert.equal(config.rtmpPort,1935); assert.equal(config.advertisedRtmpPort,1935);
  assert.equal(config.codec,'HEVC'); assert.equal(config.rtmpCodec,'HEVC'); assert.equal(config.rtmpAcceleration,'auto');
  assert.equal(config.rtmpUrl,undefined); assert.equal(config.ffmpegArgs,undefined);
  for (const preferences of [{}, { codec: undefined, rtmpCodec: undefined, rtmpAcceleration: undefined }]) {
    const saved = validatePreferences(preferences);
    assert.equal(saved.codec, 'HEVC'); assert.equal(saved.rtmpCodec, 'HEVC'); assert.equal(saved.rtmpAcceleration, 'auto');
  }
});

test('explicit saved webpage and RTMP codec or acceleration preferences survive the new defaults', () => {
  for (const codec of ['auto', 'H264', 'VP8', 'HEVC']) {
    for (const rtmpCodec of ['H264', 'HEVC']) {
      for (const rtmpAcceleration of ['auto', 'hardware', 'software']) {
        const input = { codec, rtmpCodec, rtmpAcceleration };
        const saved = validatePreferences(input);
        const live = validateConfig({ ...saved, host: networks[0].address }, networks);
        for (const result of [saved, live]) {
          assert.equal(result.codec, codec);
          assert.equal(result.rtmpCodec, rtmpCodec);
          assert.equal(result.rtmpAcceleration, rtmpAcceleration);
        }
        assert.deepEqual(validatePreferences(JSON.parse(JSON.stringify(saved))), saved);
      }
    }
  }
  for (const codec of [null, '', false, 'hevc', 'HEVC -i secret']) {
    assert.throws(() => validatePreferences({ codec }), /编码格式/);
  }
});

test('RTMP ports, codec and acceleration use strict settings and independent TCP bindings', () => {
  const valid = {...DEFAULTS,host:networks[0].address,forwardingEnabled:true,advertisedHost:'10.2.3.4',advertisedPort:9000};
  for(const override of [{rtmpEnabled:'true'}, {rtmpPort:1023}, {rtmpPort:NaN}, {rtmpPort:'1935oops'}, {advertisedRtmpPort:65536},
    {rtmpPort:8765}, {advertisedRtmpPort:9000}, {rtmpCodec:'VP8'}, {rtmpAcceleration:'gpu'}, {rtmpCodec:null}]) {
    assert.throws(()=>validateConfig({...valid,...override},networks),/RTMP/);
  }
  for (const codec of ['H264','HEVC']) for (const acceleration of ['auto','hardware','software']) {
    const config = validateConfig({...valid,rtmpCodec:codec,rtmpAcceleration:acceleration,rtmpPort:'1935',advertisedRtmpPort:'11935'},networks);
    assert.equal(config.rtmpCodec,codec); assert.equal(config.rtmpAcceleration,acceleration);
    assert.equal(config.rtmpPort,1935); assert.equal(config.advertisedRtmpPort,11935);
  }
  assert.equal(validateConfig({...valid,rtmpEnabled:false,rtmpPort:8765},networks).rtmpEnabled,false);
});

test('real IPv4 LAN interfaces precede virtual and loopback interfaces', () => {
  const result = listNetworks({
    'Virtual VPN': [{ address: '10.2.3.4', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
    Ethernet: [{ address: '192.168.1.2', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    IPv6: [{ address: 'fe80::1', family: 'IPv6', internal: false }]
  });
  assert.equal(result[0].address, '192.168.1.2');
  assert.equal(result.at(-1).address, '127.0.0.1');
  assert.equal(result.length, 3);
});

test('config rejects disappeared interfaces and malformed numeric values', () => {
  assert.throws(() => validateConfig({ ...DEFAULTS, host: '192.168.1.3' }, networks), /网卡/);
  for (const port of [0, 1023, 65536, 8765.5, '8765oops']) {
    assert.throws(() => validateConfig({ ...DEFAULTS, host: '192.168.1.2', port }, networks), /端口/);
  }
  assert.throws(() => validateConfig({ ...DEFAULTS, host: '192.168.1.2', maxViewers: 33 }, networks), /人数/);
  assert.throws(() => validateConfig({ ...DEFAULTS, host: '192.168.1.2', fps: 120 }, networks), /帧率/);
});

test('config validates UDP range and limits resolution and bitrate', () => {
  assert.throws(() => validateConfig({ ...DEFAULTS, host: '192.168.1.2', udpMin: 50100, udpMax: 50000 }, networks), /UDP/);
  assert.throws(() => validateConfig({ ...DEFAULTS, host: '192.168.1.2', resolution: '8K' }, networks), /分辨率/);
  assert.throws(() => validateConfig({ ...DEFAULTS, host: '192.168.1.2', bitrateMbps: Infinity }, networks), /码率/);
  const result = validateConfig({ ...DEFAULTS, host: '192.168.1.2', microphone: false, token: 'must-not-survive' }, networks);
  assert.equal(result.port, 8765);
  assert.equal(result.microphone, false);
  assert.equal(result.token, undefined);
});

test('100 Mbps network keeps aggregate video budget within 70 Mbps', () => {
  assert.throws(() => validateConfig({ ...DEFAULTS, host: '192.168.1.2', bitrateMbps: 15, maxViewers: 5 }, networks), /70 Mbps/);
  const config = validateConfig({ ...DEFAULTS, host: '192.168.1.2', bitrateMbps: 6, maxViewers: 5 }, networks);
  assert.equal(config.bitrateMbps * config.maxViewers, 30);
});

test('forwarding accepts a campus WAN IPv4 and an independently mapped TCP port', () => {
  const config = validateConfig({ ...DEFAULTS, host: '192.168.1.2', forwardingEnabled: true,
    advertisedHost: ' 10.23.4.5 ', advertisedPort: '80' }, networks);
  assert.equal(config.forwardingEnabled, true);
  assert.equal(config.advertisedHost, '10.23.4.5');
  assert.equal(config.advertisedPort, 80);
  const oldSettings = validateConfig({ ...DEFAULTS, host: '192.168.1.2', forwardingEnabled: undefined,
    advertisedHost: undefined, advertisedPort: undefined }, networks);
  assert.equal(oldSettings.forwardingEnabled, false);
  assert.equal(oldSettings.advertisedHost, '');
  assert.equal(oldSettings.advertisedPort, 8765);
});

test('forwarding rejects URLs, unsafe IPv4 addresses, invalid ports and loopback bindings', () => {
  const input = { ...DEFAULTS, host: '192.168.1.2', forwardingEnabled: true, advertisedHost: '10.23.4.5', advertisedPort: 8765 };
  for (const advertisedHost of ['', 'http://10.23.4.5', 'example.test', '0.0.0.0', '0.1.2.3', '127.0.0.1',
    '169.254.1.2', '224.1.2.3', '255.255.255.255', '240.1.2.3', '01.2.3.4', '10.2.3.4\n:1234', '::1']) {
    assert.throws(() => validateConfig({ ...input, advertisedHost }, networks), /一级|WAN|IPv4/);
  }
  for (const advertisedPort of [0, 65536, 80.5, '80oops', '0x50', true, null]) {
    assert.throws(() => validateConfig({ ...input, advertisedPort }, networks), /端口/);
  }
  assert.throws(() => validateConfig({ ...input, forwardingEnabled: 'true' }, networks), /转发/);
  assert.throws(() => validateConfig({ ...input, host: '127.0.0.1' }, [{ address: '127.0.0.1', local: true }]), /本机|转发/);
});

test('older broadcast configurations default to no system audio and full source volumes', () => {
  const { systemAudio, systemVolume, micVolume, ...oldDefaults } = DEFAULTS;
  assert.equal(systemAudio, false);
  assert.equal(systemVolume, 100);
  assert.equal(micVolume, 100);
  const result = validateConfig({ ...oldDefaults, host: '192.168.1.2', microphone: true }, networks);
  assert.equal(result.systemAudio, false);
  assert.equal(result.systemVolume, 100);
  assert.equal(result.micVolume, 100);
  assert.equal(result.microphone, true);
});

test('audio settings keep each source independent and normalize strict integer volumes', () => {
  for (const systemAudio of [false, true]) {
    for (const microphone of [false, true]) {
      const result = validateConfig({ ...DEFAULTS, host: '192.168.1.2', systemAudio, microphone,
        systemVolume: '0', micVolume: '100', systemAudioDeviceId: 'temporary-device', token: 'discard' }, networks);
      assert.equal(result.systemAudio, systemAudio);
      assert.equal(result.microphone, microphone);
      assert.equal(result.systemVolume, 0);
      assert.equal(result.micVolume, 100);
      assert.equal(Object.hasOwn(result, 'systemAudioDeviceId'), false);
      assert.equal(Object.hasOwn(result, 'token'), false);
    }
  }
  const result = validateConfig({ ...DEFAULTS, host: '192.168.1.2', systemAudio: true, microphone: 'true',
    systemVolume: 100, micVolume: 0 }, networks);
  assert.equal(result.microphone, false);
  assert.equal(result.systemVolume, 100);
  assert.equal(result.micVolume, 0);
});

test('audio settings reject nonboolean switches and malformed or out-of-range volumes', () => {
  const input = { ...DEFAULTS, host: '192.168.1.2' };
  for (const systemAudio of ['true', 'false', 0, 1, null, {}, []]) {
    assert.throws(() => validateConfig({ ...input, systemAudio }, networks), /系统声音开关/);
  }
  for (const field of ['systemVolume', 'micVolume']) {
    for (const value of [-1, 101, 0.5, NaN, Infinity, true, false, null, '', ' ', '1e2', '0x64', '+10', '5%', {}, []]) {
      assert.throws(() => validateConfig({ ...input, [field]: value }, networks), /音量.*0–100.*整数/,
        `${field} must reject ${String(value)}`);
    }
  }
  const result = validateConfig({ ...input, systemAudio: undefined, systemVolume: undefined, micVolume: undefined }, networks);
  assert.equal(result.systemAudio, false);
  assert.equal(result.systemVolume, 100);
  assert.equal(result.micVolume, 100);
});
