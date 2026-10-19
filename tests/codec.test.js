const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const h264 = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
const hevc = { mimeType: 'video/H265', clockRate: 90000, sdpFmtpLine: 'profile-id=1;tier-flag=0;level-id=93' };
const vp8 = { mimeType: 'video/VP8', clockRate: 90000 };
const repairs = [
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/red', clockRate: 90000 },
  { mimeType: 'video/ulpfec', clockRate: 90000 },
  { mimeType: 'video/flexfec-03', clockRate: 90000 },
];

function rtc(senderCodecs, receiverCodecs = [], extra = {}) {
  const context = vm.createContext({
    ...(senderCodecs === undefined ? {} : { RTCRtpSender: { getCapabilities: () => ({ codecs: senderCodecs }) } }),
    RTCRtpReceiver: { getCapabilities: () => ({ codecs: receiverCodecs }) },
    ...extra,
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'rtc.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(source, context, { filename: 'rtc.js' });
  return context;
}
function preference(rtcApi, selection) {
  let codecs;
  const result = rtcApi.preferCodec({ setCodecPreferences: value => { codecs = value; } }, selection);
  return { result, codecs };
}

test('HEVC uses sender capabilities and puts H264 and VP8 ahead of other fallback codecs', () => {
  const vp9 = { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' };
  const api = rtc([vp9, vp8, ...repairs, h264, hevc], [vp8, h264]);
  const { result, codecs } = preference(api, 'HEVC');
  assert.equal(codecs[0].mimeType, 'video/H265');
  assert.equal(codecs[1].mimeType, 'video/H264');
  assert.equal(codecs[2].mimeType, 'video/VP8');
  assert.equal(result.requested, 'HEVC');
  assert.equal(result.preferred, 'HEVC');
  assert.equal(result.applied, true);
  assert.equal(result.fallback, false);
});

test('HEVC preference preserves RTX, RED and FEC capabilities without changing fmtp dependencies', () => {
  const hevcPayload = { ...hevc, preferredPayloadType: 112 };
  const hevcRtx = { mimeType: 'video/rtx', clockRate: 90000, preferredPayloadType: 113, sdpFmtpLine: 'apt=112' };
  const codecs = [vp8, ...repairs, h264, hevcPayload, hevcRtx];
  const { codecs: selected } = preference(rtc(codecs), 'HEVC');
  assert.equal(selected.length, codecs.length);
  for (const repair of [...repairs, hevcRtx]) assert.equal(selected.includes(repair), true);
  assert.equal(selected.find(codec => codec.preferredPayloadType === 113).sdpFmtpLine, 'apt=112');
});

test('HEVC decode support alone cannot enable sending and falls back to H264', () => {
  const api = rtc([vp8, ...repairs, h264], [vp8, h264, hevc]);
  const { result, codecs } = preference(api, 'HEVC');
  assert.equal(codecs[0].mimeType, 'video/H264');
  assert.equal(codecs.some(codec => codec.mimeType === 'video/H265'), false);
  assert.equal(result.preferred, 'H264');
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, 'sender-unsupported');
  assert.match(result.message, /HEVC/);
});

test('capability detection keeps sending and receiving support separate', () => {
  const api = rtc([vp8, h264], [vp8, h264, hevc]);
  assert.equal(api.videoCodecSupport('send').hevc, false);
  assert.equal(api.videoCodecSupport('receive').hevc, true);
  assert.deepEqual(Array.from(api.videoCodecSupport('send').available), ['VP8', 'H264']);
});

test('a missing sender capability API reports uncertainty without using receiver support', () => {
  const api = rtc(undefined, [hevc, h264, vp8]);
  const result = api.preferCodec({ setCodecPreferences() { assert.fail('unknown capabilities must leave browser preferences alone'); } }, 'HEVC');
  assert.equal(result.applied, false);
  assert.equal(result.fallbackReason, 'capabilities-unavailable');
  assert.equal(api.videoCodecSupport('send').capabilitiesAvailable, false);
});

test('HEVC aliases normalize to HEVC and VP8 remains an explicit choice', () => {
  const api = rtc([vp8, h264, hevc]);
  assert.equal(preference(api, 'H265').result.preferred, 'HEVC');
  assert.equal(preference(api, 'VP8').codecs[0].mimeType, 'video/VP8');
});

test('a codec preference rejection is reported and leaves connection negotiation possible', () => {
  const api = rtc([hevc, h264, vp8]);
  const result = api.preferCodec({ setCodecPreferences() { throw new Error('codec unavailable'); } }, 'HEVC');
  assert.equal(result.applied, false);
  assert.equal(result.fallbackReason, 'preferences-rejected');
  assert.match(result.message, /协商|浏览器/);
});

test('negotiated codec parsing uses the accepted video section and skips repair codecs', () => {
  const api = rtc([hevc, h264, vp8]);
  const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2',
    'm=video 0 UDP/TLS/RTP/SAVPF 112', 'a=mid:closed', 'a=rtpmap:112 H265/90000',
    'm=video 9 UDP/TLS/RTP/SAVPF 97 96 98', 'a=mid:screen', 'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96', 'a=rtpmap:96 H264/90000', 'a=rtpmap:98 VP8/90000'].join('\r\n');
  assert.equal(api.negotiatedVideoCodec({ sdp }), 'H264');
  assert.equal(api.negotiatedVideoCodec({ sdp }, 'screen'), 'H264');
  assert.equal(api.negotiatedVideoCodec({ sdp }, 'closed'), '');
});

for (const { codec, payload, fmtp, expectedFmtp, bitrateMbps, newline } of [
  { codec: 'H265', payload: 112, fmtp: 'profile-id=1;tier-flag=0;level-id=93;x-google-max-bitrate=20000',
    expectedFmtp: 'profile-id=1;tier-flag=0;level-id=93;x-google-max-bitrate=15000;x-google-start-bitrate=15000', bitrateMbps: 15, newline: '\r\n' },
  { codec: 'H264', payload: 96, fmtp: 'packetization-mode=1;profile-level-id=42e01f;x-google-min-bitrate=30',
    expectedFmtp: 'packetization-mode=1;profile-level-id=42e01f;x-google-min-bitrate=30;x-google-start-bitrate=6000;x-google-max-bitrate=6000', bitrateMbps: 6, newline: '\n' },
  { codec: 'VP8', payload: 98, fmtp: '', expectedFmtp: 'x-google-start-bitrate=1000;x-google-max-bitrate=1000', bitrateMbps: 1, newline: '\r\n' },
  { codec: 'VP9', payload: 100, fmtp: 'profile-id=0', expectedFmtp: 'profile-id=0;x-google-start-bitrate=30000;x-google-max-bitrate=30000', bitrateMbps: 30, newline: '\n' },
  { codec: 'AV1', payload: 102, fmtp: 'profile=0;level-idx=5;tier=0',
    expectedFmtp: 'profile=0;level-idx=5;tier=0;x-google-start-bitrate=6000;x-google-max-bitrate=6000', bitrateMbps: 6, newline: '\r\n' },
]) test(`${codec} answer gets its bitrate budget while preserving transport and repair formats`, () => {
  const api = rtc([hevc, h264, vp8]);
  const prefix = ['v=0', 'a=group:BUNDLE audio screen', 'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:audio', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
    `m=video 9 UDP/TLS/RTP/SAVPF ${payload} 113 116 117 118`, 'a=mid:screen', 'a=recvonly',
    'a=ice-ufrag:fixture', 'a=ice-pwd:fixture-password', 'a=fingerprint:sha-256 00:11',
    `a=rtpmap:${payload} ${codec}/90000`];
  const suffix = [`a=rtcp-fb:${payload} transport-cc`, `a=rtcp-fb:${payload} nack pli`,
    'a=rtpmap:113 rtx/90000', `a=fmtp:113 apt=${payload}`, 'a=rtpmap:116 red/90000',
    'a=rtpmap:117 ulpfec/90000', 'a=rtpmap:118 flexfec-03/90000', 'a=fmtp:118 repair-window=10000000'];
  const sdp = [...prefix, ...(fmtp ? [`a=fmtp:${payload} ${fmtp}`] : []), ...suffix].join(newline);
  const description = Object.freeze({ type: 'answer', sdp });
  const result = api.withVideoBitrateBudget(description, bitrateMbps);
  assert.notEqual(result, description);
  assert.equal(result.type, 'answer');
  assert.equal(result.sdp, [...prefix, `a=fmtp:${payload} ${expectedFmtp}`, ...suffix].join(newline));
  assert.equal(description.sdp, sdp);
});

test('start bitrate replaces existing values without removing their spacing or maximum', () => {
  const api = rtc([hevc]);
  const description = { type: 'answer', sdp: ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 112',
    'a=rtpmap:112 H265/90000',
    'a=fmtp:112 profile-id=1; x-google-start-bitrate=1000 ;X-GOOGLE-START-BITRATE=2000;x-google-max-bitrate=9000', ''].join('\r\n') };
  const result = api.withVideoBitrateBudget(description, 15);
  assert.equal(result.sdp, ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000',
    'a=fmtp:112 profile-id=1; x-google-start-bitrate=15000 ;X-GOOGLE-START-BITRATE=15000;x-google-max-bitrate=9000', ''].join('\r\n'));
  assert.doesNotMatch(result.sdp, /x-google-min-bitrate/i);
  assert.equal(api.withVideoBitrateBudget(result, 15), result);
});

for (const { maximum, expectedMaximum } of [
  { maximum: '9000', expectedMaximum: '9000' },
  { maximum: '30000', expectedMaximum: '15000' },
  { maximum: '0', expectedMaximum: '15000' },
  { maximum: '-1', expectedMaximum: '15000' },
  { maximum: '1.5', expectedMaximum: '15000' },
  { maximum: 'NaN', expectedMaximum: '15000' },
  { maximum: 'Infinity', expectedMaximum: '15000' },
]) test(`transport maximum ${maximum} stays within the configured budget`, () => {
  const api = rtc([hevc]);
  const prefix = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000'];
  const description = { type: 'answer', sdp: [...prefix,
    `a=fmtp:112 profile-id=1;x-google-max-bitrate=${maximum};level-id=93`].join('\r\n') };
  assert.equal(api.withVideoBitrateBudget(description, 15).sdp, [...prefix,
    `a=fmtp:112 profile-id=1;x-google-max-bitrate=${expectedMaximum};level-id=93;x-google-start-bitrate=15000`].join('\r\n'));
});

test('duplicate maximum parameters are each bounded while retaining a lower maximum', () => {
  const api = rtc([hevc]);
  const prefix = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000'];
  const description = { type: 'answer', sdp: [...prefix,
    'a=fmtp:112 profile-id=1; x-google-max-bitrate=40000 ;X-GOOGLE-MAX-BITRATE=9000;x-google-max-bitrate=NaN;level-id=93'].join('\r\n') };
  const result = api.withVideoBitrateBudget(description, 15);
  assert.equal(result.sdp, [...prefix,
    'a=fmtp:112 profile-id=1; x-google-max-bitrate=15000 ;X-GOOGLE-MAX-BITRATE=9000;x-google-max-bitrate=15000;level-id=93;x-google-start-bitrate=15000'].join('\r\n'));
  assert.doesNotMatch(result.sdp, /x-google-min-bitrate/i);
});

test('only active video payloads declared by their own media section get a start bitrate', () => {
  const api = rtc([hevc, h264, vp8]);
  const prefix = ['v=0', 'm=video 0 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000',
    'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=inactive', 'a=rtpmap:96 H264/90000',
    'm=video 9 UDP/TLS/RTP/SAVPF 98', 'a=rtpmap:98 VP8/90000',
    'a=rtpmap:112 H265/90000', 'a=fmtp:112 profile-id=1'];
  const description = { type: 'answer', sdp: prefix.join('\n') };
  assert.equal(api.withVideoBitrateBudget(description, 6).sdp, [
    'v=0', 'm=video 0 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000',
    'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=inactive', 'a=rtpmap:96 H264/90000',
    'm=video 9 UDP/TLS/RTP/SAVPF 98', 'a=rtpmap:98 VP8/90000', 'a=fmtp:98 x-google-start-bitrate=6000;x-google-max-bitrate=6000',
    'a=rtpmap:112 H265/90000', 'a=fmtp:112 profile-id=1'].join('\n'));
});

test('multiple active video sections keep their line endings and receive their own start hint', () => {
  const api = rtc([hevc, vp8]);
  const description = { type: 'answer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 112\r\na=rtpmap:112 H265/90000\r\nm=video 9 UDP/TLS/RTP/SAVPF 98\na=rtpmap:98 VP8/90000\n' };
  assert.equal(api.withVideoBitrateBudget(description, 6).sdp,
    'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 112\r\na=rtpmap:112 H265/90000\r\na=fmtp:112 x-google-start-bitrate=6000;x-google-max-bitrate=6000\r\nm=video 9 UDP/TLS/RTP/SAVPF 98\na=rtpmap:98 VP8/90000\na=fmtp:98 x-google-start-bitrate=6000;x-google-max-bitrate=6000\n');
});

test('invalid budgets and non-answer descriptions retain the original object', () => {
  const api = rtc([hevc]);
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 112\r\na=rtpmap:112 H265/90000\r\n';
  const answer = Object.freeze({ type: 'answer', sdp });
  for (const bitrate of [undefined, null, false, '', '15', '15;injected=1', 0, -1, 31, 1.5, NaN, Infinity, -Infinity]) {
    assert.equal(api.withVideoBitrateBudget(answer, bitrate), answer);
  }
  for (const description of [null, undefined, {}, { type: 'offer', sdp }, { type: 'pranswer', sdp }, { type: 'answer', sdp: null }]) {
    assert.equal(api.withVideoBitrateBudget(description, 15), description);
  }
});

test('absent media codecs, rejected or invalid ports, and inactive sessions stay untouched', () => {
  const api = rtc([hevc]);
  for (const lines of [
    ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2'],
    ['v=0', 'm=video 0 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000'],
    ['v=0', 'm=video invalid UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000'],
    ['v=0', 'm=video 65536 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000'],
    ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:112 H265/90000'],
    ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 unknown/90000'],
    ['v=0', 'a=inactive', 'm=video 9 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000'],
    ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 112', 'a=inactive', 'a=rtpmap:112 H265/90000'],
    ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 112', 'a=rtpmap:112 H265/90000', 'a=fmtp:112 x-google-start-bitrate=15000;x-google-max-bitrate=15000'],
  ]) {
    const description = Object.freeze({ type: 'answer', sdp: lines.join('\r\n') });
    assert.equal(api.withVideoBitrateBudget(description, 15), description);
  }
});

test('outbound stats report the actual HEVC encoder rather than a later RTX report', async () => {
  const api = rtc([hevc, h264, vp8]);
  const reports = new Map([
    ['hevc', { id: 'hevc', type: 'codec', mimeType: 'video/H265', sdpFmtpLine: 'profile-id=1' }],
    ['rtx', { id: 'rtx', type: 'codec', mimeType: 'video/rtx' }],
    ['screen', { id: 'screen', type: 'outbound-rtp', kind: 'video', codecId: 'hevc', timestamp: 1000,
      bytesSent: 123456, framesEncoded: 30, framesPerSecond: 30, encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', powerEfficientEncoder: true }],
    ['repair', { id: 'repair', type: 'outbound-rtp', kind: 'video', codecId: 'rtx', timestamp: 1000, bytesSent: 20 }],
  ]);
  const stats = await api.videoStats({ getStats: async () => reports }, null, 'outbound-rtp');
  assert.equal(stats.codec, 'H265');
  assert.equal(stats.codecLabel, 'HEVC / H.265');
  assert.equal(stats.previous.frames, 30);
  assert.equal(stats.encoderImplementation, 'MediaFoundationVideoEncodeAccelerator');
  assert.equal(stats.powerEfficientEncoder, true);
});

test('inbound HEVC stats expose actual decoded frames and retain a false power efficiency report', async () => {
  const api = rtc([hevc]);
  const reports = new Map([
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H265' }],
    ['screen', { id: 'screen', type: 'inbound-rtp', kind: 'video', codecId: 'codec', timestamp: 2000,
      bytesReceived: 9000, framesDecoded: 60, decoderImplementation: 'D3D11VideoDecoder', powerEfficientDecoder: false }],
  ]);
  const stats = await api.videoStats({ getStats: async () => reports });
  assert.equal(stats.codec, 'H265');
  assert.equal(stats.previous.frames, 60);
  assert.equal(stats.decoderImplementation, 'D3D11VideoDecoder');
  assert.equal(stats.powerEfficientDecoder, false);
});
