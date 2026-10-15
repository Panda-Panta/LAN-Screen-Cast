const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(renderer, 'share.js'), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(attributes = '') {
    this.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
    this.checked = /\bchecked(?:\s|$)/.test(attributes);
    this.disabled = /\bdisabled(?:\s|$)/.test(attributes);
    this.hidden = /\bhidden(?:\s|$)/.test(attributes);
    this.textContent = ''; this.dataset = {}; this.listeners = new Map();
    this.classes = new Set((attributes.match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/).filter(Boolean));
    this.classList = { toggle: (name, force) => {
      const enabled = force == null ? !this.classes.has(name) : !!force;
      if (enabled) this.classes.add(name); else this.classes.delete(name);
      return enabled;
    } };
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type) { for (const listener of this.listeners.get(type) || []) listener({ target: this }); }
  removeAttribute(name) { delete this[name]; }
}

function harness() {
  const nodes = new Map();
  for (const match of html.matchAll(/<[a-z][a-z\d-]*\b([^>]*)>/gi)) {
    const id = match[1].match(/\bid="([^"]+)"/)?.[1];
    if (id) nodes.set(id, new Element(match[1]));
  }
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const id = match[1].match(/\bid="([^"]+)"/)?.[1];
    if (!id) continue;
    const options = [...match[2].matchAll(/<option\b([^>]*)>/gi)];
    const selected = options.find(option => /\bselected(?:\s|$)/.test(option[1])) || options[0];
    nodes.get(id).value = selected?.[1].match(/\bvalue="([^"]*)"/)?.[1] || '';
  }
  const forwarded = new Element('disabled');
  nodes.get('share-target').querySelector = selector => {
    assert.equal(selector, '[value="forwarded"]'); return forwarded;
  };
  nodes.get('share-target').value = 'local';
  nodes.get('network').value = '192.168.31.146';
  const copied = [], notices = [], changed = [];
  const lan = { copy: async text => { copied.push(text); } };
  const context = vm.createContext({
    document: { getElementById: id => {
      assert.ok(nodes.has(id), `Unknown GUI element ${id}`); return nodes.get(id);
    } },
    window: { lan },
    notify: (...args) => notices.push(args), onConfigChanged: config => changed.push(plain(config)),
  });
  vm.runInContext(`${source.replace(/^export /gm, '')}\nthis.controller = createShareController({ notify, onConfigChanged });`, context,
    { filename: 'share.js' });
  return { controller: context.controller, nodes, forwarded, copied, notices, changed, lan,
    $(id) { assert.ok(nodes.has(id)); return nodes.get(id); } };
}

function info(overrides = {}) {
  return { roomId: 'room-one', pin: '123456', localUrl: 'http://192.168.31.146:8765/',
    localInviteUrl: 'http://192.168.31.146:8765/#token=web-one', localQr: 'data:image/png;base64,LOCAL',
    forwardedUrl: 'http://10.204.238.19:9876/', forwardedInviteUrl: 'http://10.204.238.19:9876/#token=web-one',
    forwardedQr: 'data:image/png;base64,WAN', rtmp: { enabled: true, phase: 'waiting', codec: 'H.264/AAC',
      localUrl: 'rtmp://192.168.31.146:1935/live/session-one', forwardedUrl: 'rtmp://10.204.238.19:21935/live/session-one' },
    ...overrides };
}

function local(fixture, data = info()) {
  fixture.controller.show(data, { host: '192.168.31.146', rtmpEnabled: true });
  fixture.$('share-target').value = 'local'; fixture.$('share-target').emit('change');
}

test('the GUI keeps web invitations and exposes RTMP without a shortcut exporter', () => {
  for (const id of ['invite-link', 'copy-link', 'plain-url', 'pin', 'qr', 'share-target', 'copy-code',
    'rtmp-enabled', 'rtmp-port', 'advertised-rtmp-port', 'rtmp-codec', 'rtmp-acceleration',
    'rtmp-link', 'copy-rtmp', 'rtmp-status']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /save-invite|观看快捷方式/);
  assert.doesNotMatch(source, /saveInvite|save-invite/);
  assert.match(html, /H\.264 \/ AAC/);
  assert.match(html, /播放器缓存/);
  assert.match(html, /value="HEVC"/);
  const fixture = harness();
  assert.equal(fixture.$('rtmp-enabled').checked, true);
  assert.equal(fixture.$('rtmp-port').value, '1935');
  assert.equal(fixture.$('rtmp-codec').value, 'HEVC');
  assert.equal(fixture.$('rtmp-acceleration').value, 'auto');
  assert.equal(fixture.$('codec').value, 'HEVC');
  for (const id of ['rtmp-codec', 'rtmp-acceleration']) assert.equal(fixture.$(id).classes.has('config-control'), true);
  assert.equal(fixture.$('copy-rtmp').disabled, true);
});

test('old settings gain RTMP defaults and explicit saved RTMP fields round-trip', () => {
  const fixture = harness();
  fixture.controller.loadSettings({});
  let config = plain(fixture.controller.getConfig());
  assert.equal(config.rtmpEnabled, true); assert.equal(config.rtmpPort, 1935); assert.equal(config.advertisedRtmpPort, 1935);
  assert.equal(config.rtmpCodec, 'HEVC'); assert.equal(config.rtmpAcceleration, 'auto');
  fixture.controller.loadSettings({ rtmpEnabled: false, rtmpPort: 1940, advertisedRtmpPort: 21940,
    rtmpCodec: 'H264', rtmpAcceleration: 'hardware',
    forwardingEnabled: true, advertisedHost: '10.204.238.19', advertisedPort: 9876, autoRouterAddress: false });
  config = plain(fixture.controller.getConfig());
  assert.deepEqual(config, { rtmpEnabled: false, rtmpPort: 1940, advertisedRtmpPort: 21940,
    rtmpCodec: 'H264', rtmpAcceleration: 'hardware',
    forwardingEnabled: true, advertisedHost: '10.204.238.19', advertisedPort: 9876, autoRouterAddress: false });
  assert.equal(fixture.$('rtmp-port-fields').hidden, true);
  assert.equal(fixture.$('advertised-rtmp-fields').hidden, true);
  assert.equal(fixture.$('advertised-host').readOnly, false);
});

test('RTMP changes notify auto-save and mapping includes only enabled protocols', async () => {
  const fixture = harness();
  fixture.$('advertised-host').value = '10.204.238.19';
  fixture.$('rtmp-port').value = '1940'; fixture.$('rtmp-port').emit('input');
  fixture.$('advertised-rtmp-port').value = '21940'; fixture.$('advertised-rtmp-port').emit('change');
  assert.equal(fixture.changed.at(-1).rtmpPort, 1940);
  assert.equal(fixture.changed.at(-1).advertisedRtmpPort, 21940);
  fixture.$('rtmp-codec').value = 'HEVC'; fixture.$('rtmp-codec').emit('change');
  fixture.$('rtmp-acceleration').value = 'software'; fixture.$('rtmp-acceleration').emit('change');
  assert.equal(fixture.changed.at(-1).rtmpCodec, 'HEVC');
  assert.equal(fixture.changed.at(-1).rtmpAcceleration, 'software');
  fixture.$('copy-mapping').emit('click'); await turn();
  assert.match(fixture.copied.at(-1), /RTMP TCP 21940 → 192\.168\.31\.146:1940/);
  assert.match(fixture.copied.at(-1), /RTMP 仅需 TCP/);
  assert.match(fixture.copied.at(-1), /UDP 50000–50100/);
  fixture.$('rtmp-enabled').checked = false; fixture.$('rtmp-enabled').emit('change');
  assert.equal(fixture.changed.at(-1).rtmpEnabled, false);
  assert.equal(fixture.$('rtmp-port-fields').hidden, true);
  assert.equal(fixture.$('advertised-rtmp-fields').hidden, true);
  assert.doesNotMatch(fixture.$('mapping-list').textContent, /RTMP/);
  assert.match(fixture.$('mapping-list').textContent, /TCP 8765/);
  assert.equal(fixture.$('copy-rtmp').disabled, true);
});

test('non-ready RTMP states never copy while the web invitation remains usable', async () => {
  const fixture = harness(); local(fixture);
  for (const phase of ['preparing', 'waiting', 'starting', 'error', 'stopped']) {
    fixture.controller.updateRtmp({ roomId: 'room-one', enabled: true, phase,
      message: phase === 'error' ? '编码服务启动失败' : '' });
    assert.equal(fixture.$('copy-rtmp').disabled, true, phase);
    assert.equal(fixture.$('copy-link').disabled, false, phase);
    assert.equal(fixture.$('copy-code').disabled, false, phase);
    fixture.$('copy-rtmp').emit('click'); await turn();
    assert.equal(fixture.copied.length, 0, 'programmatic events must also enforce readiness');
    assert.equal(fixture.$('rtmp-status').classes.has('error'), phase === 'error');
  }
  fixture.$('copy-link').emit('click'); await turn();
  assert.equal(fixture.copied.at(-1), info().localInviteUrl);
});

test('LAN and WAN selection switches both share addresses and copies the current ready RTMP URL', async () => {
  const fixture = harness(); const data = info();
  local(fixture, data);
  fixture.controller.updateRtmp({ roomId: data.roomId, ...data.rtmp, phase: 'ready' });
  assert.equal(fixture.$('rtmp-link').value, data.rtmp.localUrl);
  assert.equal(fixture.$('invite-link').value, data.localInviteUrl);
  assert.equal(fixture.$('qr').src, data.localQr);
  assert.equal(fixture.$('copy-rtmp').disabled, false);
  fixture.$('copy-rtmp').emit('click'); await turn();
  assert.equal(fixture.copied.at(-1), data.rtmp.localUrl);
  fixture.$('share-target').value = 'forwarded'; fixture.$('share-target').emit('change');
  assert.equal(fixture.$('rtmp-link').value, data.rtmp.forwardedUrl);
  assert.equal(fixture.$('invite-link').value, data.forwardedInviteUrl);
  assert.equal(fixture.$('plain-url').textContent, data.forwardedUrl);
  assert.equal(fixture.$('qr').src, data.forwardedQr);
  fixture.$('copy-rtmp').emit('click'); fixture.$('copy-code').emit('click'); await turn();
  assert.equal(fixture.copied.at(-2), data.rtmp.forwardedUrl);
  assert.equal(fixture.copied.at(-1), `${data.forwardedUrl}\n观看码：123456`);
});

test('ready RTMP without the selected WAN address stays unavailable until an address arrives', async () => {
  const fixture = harness(); const data = info();
  data.rtmp = { ...data.rtmp, phase: 'ready', forwardedUrl: '' };
  fixture.controller.show(data, { host: '192.168.31.146' });
  assert.equal(fixture.$('share-target').value, 'forwarded');
  assert.equal(fixture.$('rtmp-link').value, '');
  assert.equal(fixture.$('copy-rtmp').disabled, true);
  assert.equal(fixture.$('copy-link').disabled, false);
  fixture.$('copy-rtmp').emit('click'); await turn();
  assert.equal(fixture.copied.length, 0);
  fixture.controller.updateRtmp({ roomId: data.roomId, forwardedUrl: 'rtmp://10.204.238.20:21935/live/session-one' });
  assert.equal(fixture.$('copy-rtmp').disabled, false);
  fixture.$('copy-rtmp').emit('click'); await turn();
  assert.equal(fixture.copied.at(-1), 'rtmp://10.204.238.20:21935/live/session-one');
});

test('old room state and late events after clear cannot resurrect a previous invitation', async () => {
  const fixture = harness(); const data = info(); local(fixture, data);
  fixture.controller.updateRtmp({ roomId: 'old-room', enabled: true, phase: 'ready', localUrl: 'rtmp://old/path' });
  assert.equal(fixture.$('rtmp-link').value, data.rtmp.localUrl);
  assert.equal(fixture.$('copy-rtmp').disabled, true);
  fixture.controller.clear();
  fixture.controller.updateRtmp({ roomId: data.roomId, ...data.rtmp, phase: 'ready' });
  assert.equal(fixture.$('rtmp-link').value, '');
  assert.equal(fixture.$('invite-link').value, '');
  assert.equal(fixture.$('copy-rtmp').disabled, true);
  fixture.controller.show(info({ roomId: 'room-two', rtmp: { ...data.rtmp, phase: 'starting', localUrl: 'rtmp://new/path' } }), {});
  fixture.controller.updateRtmp({ roomId: data.roomId, ...data.rtmp, phase: 'ready' });
  assert.equal(fixture.$('copy-rtmp').disabled, true);
  fixture.$('share-target').value = 'local'; fixture.$('share-target').emit('change');
  assert.equal(fixture.$('rtmp-link').value, 'rtmp://new/path');
  fixture.$('copy-rtmp').emit('click'); await turn();
  assert.equal(fixture.copied.length, 0);
});

test('WAN refresh updates URLs while preserving the last RTMP media state and selected network', () => {
  const fixture = harness(); const data = info();
  fixture.controller.show(data, { host: '192.168.31.146' });
  fixture.controller.updateRtmp({ roomId: data.roomId, ...data.rtmp, phase: 'ready', message: '媒体已就绪' });
  const readyStatus = fixture.$('rtmp-status').textContent;
  const withoutRtmp = { ...data, forwardedInviteUrl: 'http://10.204.238.20:9876/#token=web-one' };
  delete withoutRtmp.rtmp;
  fixture.controller.updateSession(withoutRtmp);
  assert.equal(fixture.$('copy-rtmp').disabled, false);
  assert.equal(fixture.$('rtmp-status').textContent, readyStatus);
  assert.match(readyStatus, /媒体已就绪/);
  fixture.controller.updateSession({ ...withoutRtmp, rtmp: { ...data.rtmp, phase: 'waiting',
    forwardedUrl: 'rtmp://10.204.238.20:21935/live/session-one' } });
  assert.equal(fixture.$('share-target').value, 'forwarded');
  assert.equal(fixture.$('rtmp-link').value, 'rtmp://10.204.238.20:21935/live/session-one');
  assert.equal(fixture.$('invite-link').value, withoutRtmp.forwardedInviteUrl);
  assert.equal(fixture.$('copy-rtmp').disabled, false);
  assert.equal(fixture.$('rtmp-status').dataset.phase, 'ready');
  fixture.controller.updateSession(info({ roomId: 'old-room' }));
  assert.equal(fixture.$('rtmp-link').value, 'rtmp://10.204.238.20:21935/live/session-one');
});

test('WAN availability refresh changes the target option without selecting a different available network', () => {
  const fixture = harness(); const data = info({ forwardedInviteUrl: '', forwardedUrl: '', forwardedQr: '' });
  fixture.controller.show(data, {});
  assert.equal(fixture.forwarded.disabled, true);
  assert.equal(fixture.$('share-target').value, 'local');
  fixture.controller.updateSession(info());
  assert.equal(fixture.forwarded.disabled, false);
  assert.equal(fixture.$('share-target').value, 'local');
  fixture.$('share-target').value = 'forwarded'; fixture.$('share-target').emit('change');
  fixture.controller.updateSession(data);
  assert.equal(fixture.forwarded.disabled, true);
  assert.equal(fixture.$('share-target').value, 'local');
});

test('disabled RTMP does not expose a URL or interfere with web invitation copying', async () => {
  const fixture = harness(); const data = info();
  data.rtmp = { ...data.rtmp, enabled: false, phase: 'ready' }; local(fixture, data);
  assert.equal(fixture.$('rtmp-link').value, '');
  assert.equal(fixture.$('copy-rtmp').disabled, true);
  assert.match(fixture.$('rtmp-status').textContent, /已关闭/);
  fixture.$('copy-rtmp').emit('click'); fixture.$('copy-link').emit('click'); await turn();
  assert.deepEqual(fixture.copied, [data.localInviteUrl]);
});

test('copy failure reports the operation error without disabling the usable web invitation', async () => {
  const fixture = harness(); const data = info(); local(fixture, data);
  fixture.controller.updateRtmp({ roomId: data.roomId, ...data.rtmp, phase: 'ready' });
  fixture.lan.copy = async () => { throw new Error('剪贴板暂不可用'); };
  fixture.$('copy-rtmp').emit('click'); await turn();
  assert.deepEqual(fixture.notices.at(-1), ['剪贴板暂不可用', true]);
  assert.equal(fixture.$('copy-link').disabled, false);
  assert.equal(fixture.$('copy-rtmp').disabled, false);
});

test('ready state shows actual HEVC hardware encoding instead of requested H264 settings', async () => {
  const fixture = harness(); const data = info();
  fixture.controller.show(data, { rtmpCodec: 'H264', rtmpAcceleration: 'auto' });
  fixture.controller.updateRtmp({ roomId: data.roomId, phase: 'ready', codec: 'HEVC / AAC', encoder: 'hevc_nvenc', hardware: true });
  const status = fixture.$('rtmp-status').textContent;
  assert.match(status, /HEVC \/ AAC/); assert.match(status, /hevc_nvenc/); assert.match(status, /硬件编码/);
  assert.match(status, /Enhanced RTMP/); assert.match(status, /播放器需要支持 HEVC/);
  assert.doesNotMatch(status, /H\.264|软件|回落/);
  fixture.$('copy-rtmp').emit('click'); await turn();
  assert.match(fixture.notices.at(-1)[0], /支持 Enhanced RTMP \/ HEVC/);
});

test('auto software fallback is explicit while a requested software mode is not called a fallback', () => {
  for (const rtmpAcceleration of ['auto', 'software']) {
    const fixture = harness(); const data = info();
    fixture.controller.show(data, { rtmpCodec: 'H264', rtmpAcceleration });
    fixture.controller.updateRtmp({ roomId: data.roomId, phase: 'ready', codec: 'H264 / AAC', encoder: 'h264_mf', hardware: false });
    const status = fixture.$('rtmp-status').textContent;
    assert.match(status, /H264 \/ AAC/); assert.match(status, /h264_mf/); assert.match(status, /软件编码/);
    if (rtmpAcceleration === 'auto') assert.match(status, /没有可用硬件编码器，已回落/);
    else assert.doesNotMatch(status, /回落|没有可用硬件/);
  }
});

test('unknown encoding status and direct video copying do not claim hardware success', () => {
  const fixture = harness(); const data = info();
  fixture.controller.show(data, { rtmpCodec: 'HEVC', rtmpAcceleration: 'hardware' });
  fixture.controller.updateRtmp({ roomId: data.roomId, phase: 'ready', codec: '', encoder: '', hardware: undefined });
  assert.match(fixture.$('rtmp-status').textContent, /实际编码待确认/);
  assert.match(fixture.$('rtmp-status').textContent, /加速状态待确认/);
  assert.doesNotMatch(fixture.$('rtmp-status').textContent, /HEVC|硬件编码/);
  fixture.controller.updateRtmp({ roomId: data.roomId, phase: 'ready', codec: 'H264 / AAC', encoder: 'copy', hardware: false });
  assert.match(fixture.$('rtmp-status').textContent, /copy · 视频直接复制/);
  assert.doesNotMatch(fixture.$('rtmp-status').textContent, /软件编码|回落|硬件编码/);
});
