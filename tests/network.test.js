const test = require('node:test');
const assert = require('node:assert/strict');
const network = import('../src/shared/network.mjs');

const config = Object.freeze({ forwardingEnabled: true, host: '192.168.31.146', advertisedHost: '10.23.4.5',
  advertisedPort: 8765, udpMin: 50000, udpMax: 50100 });
const candidate = Object.freeze({ candidate: 'candidate:24800213 1 UDP 2122260223 192.168.31.146 50020 typ host generation 0 ufrag abc network-id 1 network-cost 10',
  sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abc' });

test('mapped UDP candidate retains LAN candidate and same-port WAN srflx with related address', async () => {
  const { advertiseCandidate } = await network;
  const result = advertiseCandidate(candidate, config);
  assert.equal(result.length, 2);
  assert.equal(result[0], candidate);
  assert.match(result[1].candidate, /^candidate:[A-Za-z0-9+/]{1,32} 1 UDP \d+ 10\.23\.4\.5 50020 typ srflx raddr 192\.168\.31\.146 rport 50020 /);
  assert.match(result[1].candidate, /ufrag abc network-id 1 network-cost 10$/);
  assert.equal(result[1].sdpMid, '0');
  assert.equal(result[1].sdpMLineIndex, 0);
  assert.equal(result[1].usernameFragment, 'abc');
  const priority = Number(result[1].candidate.split(' ')[3]);
  assert.ok(priority > 0 && priority < Number(candidate.candidate.split(' ')[3]));
  assert.equal(candidate.candidate.includes('10.23.4.5'), false);
});

test('mapping is disabled or skipped for unsupported, malformed and nonmatching candidates', async () => {
  const { advertiseCandidate } = await network;
  assert.deepEqual(advertiseCandidate(candidate, { ...config, forwardingEnabled: false }), [candidate]);
  assert.deepEqual(advertiseCandidate(null, config), [null]);
  for (const line of ['', 'candidate:broken', candidate.candidate.replace('UDP', 'TCP'),
    candidate.candidate.replace('192.168.31.146', '192.168.31.147'),
    candidate.candidate.replace('192.168.31.146', 'some-id.local'),
    candidate.candidate.replace('192.168.31.146', 'fe80::1'),
    candidate.candidate.replace('50020', '49999'), candidate.candidate.replace('50020', '50101'),
    candidate.candidate.replace('typ host', 'typ srflx'), candidate.candidate.replace('2122260223', '4294967296'),
    candidate.candidate.replace('50020', '50020oops'), `${candidate.candidate}\r\na=ice-pwd:injection`]) {
    const input = { ...candidate, candidate: line };
    assert.deepEqual(advertiseCandidate(input, config), [input], line);
  }
  for (const advertisedHost of ['', '0.0.0.0', '127.0.0.1', '224.1.2.3', '255.255.255.255', 'http://10.1.2.3']) {
    assert.deepEqual(advertiseCandidate(candidate, { ...config, advertisedHost }), [candidate]);
  }
});

test('both UDP range endpoints can map without changing metadata', async () => {
  const { advertiseCandidate } = await network;
  for (const port of [50000, 50100]) {
    const input = { ...candidate, candidate: candidate.candidate.replace('50020', String(port)), sdpMid: 'audio', sdpMLineIndex: 1 };
    const mapped = advertiseCandidate(input, config)[1];
    assert.match(mapped.candidate, new RegExp(`10\\.23\\.4\\.5 ${port} typ srflx raddr 192\\.168\\.31\\.146 rport ${port}`));
    assert.equal(mapped.sdpMid, 'audio');
    assert.equal(mapped.sdpMLineIndex, 1);
  }
});

test('SDP and trickle publish identical mappings, keep media sections and are idempotent', async () => {
  const { advertiseCandidate, advertiseDescription } = await network;
  const expected = advertiseCandidate(candidate, config)[1].candidate;
  const sdp = `v=0\r\na=ice-ufrag:abc\r\na=ice-pwd:keep-original\r\na=fingerprint:sha-256 ORIGINAL\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=${candidate.candidate}\r\na=end-of-candidates\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\na=${candidate.candidate}\r\na=end-of-candidates\r\n`;
  const input = Object.freeze({ type: 'offer', sdp });
  const mapped = advertiseDescription(input, config);
  assert.equal(input.sdp, sdp);
  assert.equal(mapped.type, 'offer');
  assert.equal(mapped.sdp.split(`a=${expected}\r\n`).length - 1, 2);
  assert.ok(mapped.sdp.includes(`a=${candidate.candidate}\r\na=${expected}\r\na=end-of-candidates`));
  assert.ok(mapped.sdp.includes('a=ice-pwd:keep-original\r\na=fingerprint:sha-256 ORIGINAL'));
  assert.deepEqual(advertiseDescription(mapped, config), mapped);
  assert.equal(advertiseDescription(input, { ...config, forwardingEnabled: false }), input);
  const empty = { type: 'offer', sdp: 'v=0\na=ice-ufrag:abc\n' };
  assert.equal(advertiseDescription(empty, config), empty);
});
