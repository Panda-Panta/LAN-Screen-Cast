// Real desktop verification of the 1.1 features. Only the router discovery
// boundary is replaced with deterministic WAN responses; no NAT claim is made.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeEvidence } = require('./runtime-evidence');

const root = path.resolve(__dirname, '..');
const resultDir = path.join(root, 'test-results');
const packaged = !!process.env.LAN_CAST_EXECUTABLE;
const profile = path.join(root, '.cache', `features-${packaged ? 'packaged' : 'source'}-${Date.now()}`);
const settingsFile = path.join(profile, 'settings.json');

async function freePort(host = '127.0.0.1') {
  const listener = net.createServer().listen(0, host);
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function eventually(read, accept, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await delay(150);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function launch() {
  const application = await _electron.launch({
    executablePath: process.env.LAN_CAST_EXECUTABLE || require('electron'),
    args: packaged ? [] : [root],
    env: { ...process.env, LAN_CAST_DATA_DIR: profile }, timeout: 30000
  });
  const host = await application.firstWindow();
  await host.waitForFunction(() => window.lan && document.querySelector('.source-card'));
  await host.locator('#rtmp-enabled').uncheck();
  await host.locator('.advanced > summary').click();
  return { application, host };
}

async function nativeClose(application) {
  const closed = application.waitForEvent('close', { timeout: 15000 });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
}

async function openViewer(application, invite, fallback = false) {
  const ready = application.waitForEvent('window');
  await application.evaluate(async ({ BrowserWindow }, { invite, fallback }) => {
    const win = new BrowserWindow({ width: 850, height: 700,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        partition: fallback ? 'features-h264' : 'features-hevc' } });
    globalThis.__featureWindows.push(win);
    await win.loadURL(invite);
  }, { invite, fallback });
  const page = await ready;
  await page.evaluate(fallbackOnly => {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args) {
        const peer = Reflect.construct(target, args);
        window.__featurePeer = peer;
        if (fallbackOnly) {
          const original = peer.createAnswer.bind(peer);
          peer.createAnswer = async (...answerArgs) => {
            const codecs = RTCRtpReceiver.getCapabilities('video').codecs
              .filter(codec => codec.mimeType.toLowerCase() !== 'video/h265');
            for (const transceiver of peer.getTransceivers()) {
              if (transceiver.receiver.track.kind === 'video') transceiver.setCodecPreferences(codecs);
            }
            return original(...answerArgs);
          };
        }
        return peer;
      }
    });
  }, fallback);
  await page.locator('#device-name').fill(fallback ? 'HEVC-disabled fixture' : 'HEVC fixture');
  await page.locator('#watch').click();
  return page;
}

async function videoStats(page) {
  return page.evaluate(async () => {
    const peer = window.__featurePeer;
    if (!peer) return null;
    const stats = await peer.getStats();
    if (peer !== window.__featurePeer) return null;
    const video = [...stats.values()].find(r => r.type === 'inbound-rtp' && r.kind === 'video');
    const codec = stats.get(video?.codecId);
    return { codec: codec?.mimeType || '', framesDecoded: video?.framesDecoded || 0,
      decoderImplementation: video?.decoderImplementation || '',
      powerEfficientDecoder: video?.powerEfficientDecoder,
      videoWidth: document.querySelector('#remote').videoWidth };
  });
}

async function hostHeaderStatus(host, port, authority) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: '/api/status', headers: { Host: authority } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.setTimeout(2000, () => request.destroy(new Error('HTTP status timeout')));
    request.on('error', reject);
  });
}

async function main() {
  await fs.mkdir(resultDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(),
    scope: 'same-PC production Electron GUI, physical microphone and real captured WebRTC video; WAN discovery response fixture, no NAT traversal',
    checks: [], passed: false };
  const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  let application, host;
  const errors = [];
  try {
    ({ application, host } = await launch());
    Object.assign(report, await runtimeEvidence(application));
    host.on('pageerror', error => errors.push(error.message));
    await host.locator('#network').selectOption('127.0.0.1');
    await host.locator('#codec').selectOption('HEVC');
    await host.locator('#resolution').selectOption('720');
    await host.locator('#fps').selectOption('60');
    await host.locator('#bitrate').fill('3');
    await host.locator('#max-viewers').fill('5');
    const port = await freePort();
    await host.locator('#port').fill(String(port));
    await host.locator('[data-source-tab="window"]').click();
    await host.locator('#room').fill('自动保存运行检查');
    await eventually(() => fs.readFile(settingsFile, 'utf8').then(JSON.parse).catch(() => null),
      settings => settings?.roomName === '自动保存运行检查' && settings.codec === 'HEVC'
        && settings.sourceType === 'window' && settings.port === port,
      'idle settings were not saved');
    check('all edited settings persist without starting a broadcast');

    await host.evaluate(() => {
      window.__micProbes = [];
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await getUserMedia(constraints); window.__micProbes.push(stream); return stream;
      };
    });
    await host.locator('#refresh-microphones').click();
    report.microphone = await eventually(() => host.evaluate(() => ({
      status: document.querySelector('#microphone-status').textContent,
      options: document.querySelector('#mic-device').options.length,
      probes: window.__micProbes.length,
      trackStates: window.__micProbes.flatMap(stream => stream.getTracks().map(track => track.readyState))
    })), state => state.probes > 0 && state.options > 1 && state.trackStates.every(value => value === 'ended'),
    'physical microphone refresh or cleanup did not complete');
    await host.locator('#microphone').check();
    await host.waitForFunction(() => document.querySelector('#mic-device').options.length > 1
      && document.querySelector('#microphone-status').textContent.startsWith('已读取'));
    const preferredMic = await host.locator('#mic-device option').nth(1).getAttribute('value');
    await host.locator('#mic-device').selectOption(preferredMic);
    await host.locator('#microphone').uncheck();
    check('real microphone refresh / enable succeeds, temporary probe tracks stop and device preference persists');

    // No 250 ms debounce wait: exercise the production close handshake itself.
    await host.locator('#room').fill('快速关闭仍保存');
    await nativeClose(application); application = null;
    const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.equal(saved.roomName, '快速关闭仍保存');
    assert.equal(saved.micDeviceId, preferredMic);
    assert.equal(saved.codec, 'HEVC');
    ({ application, host } = await launch());
    host.on('pageerror', error => errors.push(error.message));
    assert.equal(await host.locator('#room').inputValue(), saved.roomName);
    assert.equal(await host.locator('#codec').inputValue(), 'HEVC');
    assert.equal(await host.locator('#port').inputValue(), String(port));
    assert.equal(await host.locator('#mic-device').inputValue(), preferredMic);
    assert.equal(await host.locator('[data-source-tab="window"]').getAttribute('aria-selected'), 'true');
    check('native close immediately after edit flushes latest settings; restart restores codec / device / source category');

    report.codecCapabilities = await host.evaluate(() => ({
      send: RTCRtpSender.getCapabilities('video').codecs.map(codec => codec.mimeType),
      receive: RTCRtpReceiver.getCapabilities('video').codecs.map(codec => codec.mimeType)
    }));
    assert.ok(report.codecCapabilities.send.includes('video/H265'), 'this test PC must provide actual HEVC sending capability');
    await host.evaluate(() => {
      window.__featureHostPeers = [];
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct(target, args) {
          const peer = Reflect.construct(target, args); window.__featureHostPeers.push(peer); return peer;
        }
      });
    });
    await application.evaluate(async ({ BrowserWindow }) => {
      globalThis.__featureWindows = [];
      const fixture = new BrowserWindow({ width: 800, height: 500, title: 'HEVC broadcast fixture',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      globalThis.__featureWindows.push(fixture);
      await fixture.loadURL(`data:text/html,${encodeURIComponent('<html><body style="background:#1766ac;color:white;font:38px Segoe UI"><p>HEVC actual capture</p><p id="clock"></p><script>setInterval(()=>{document.querySelector("#clock").textContent=Date.now();document.body.style.background=`hsl(${Date.now()/50%360},60%,30%)`},40)</script></body></html>')}`);
    });
    await host.locator('#refresh-sources').click();
    await host.locator('.source-card').filter({ hasText: 'HEVC broadcast fixture' }).click();
    await host.locator('#fps').selectOption('30');
    await host.locator('#forwarding-enabled').uncheck();
    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#preview').videoWidth > 0);
    const invite = await host.locator('#invite-link').inputValue();
    const viewer = await openViewer(application, invite);
    viewer.on('pageerror', error => errors.push(error.message));
    report.hevc = await eventually(() => videoStats(viewer),
      stats => stats?.codec.toLowerCase() === 'video/h265' && stats.framesDecoded >= 3 && stats.videoWidth > 0,
      'actual HEVC decode did not complete', 35000);
    report.senderHevc = await eventually(() => host.evaluate(async () => {
      for (const peer of window.__featureHostPeers) {
        const reports = await peer.getStats();
        for (const value of reports.values()) {
          if (value.type === 'outbound-rtp' && value.kind === 'video'
              && reports.get(value.codecId)?.mimeType.toLowerCase() === 'video/h265') {
            return { codec: 'video/H265', framesEncoded: value.framesEncoded || 0,
              encoderImplementation: value.encoderImplementation || '', powerEfficientEncoder: value.powerEfficientEncoder };
          }
        }
      }
      return null;
    }), stats => stats?.framesEncoded >= 3, 'actual HEVC sender statistics missing');
    await host.waitForFunction(() => document.querySelector('#viewers').textContent.includes('实际编码 HEVC'));
    check('actual captured window is encoded as H.265 and the independent receiver decodes frames');

    const fallbackViewer = await openViewer(application, invite, true);
    fallbackViewer.on('pageerror', error => errors.push(error.message));
    report.fallback = await eventually(() => videoStats(fallbackViewer),
      stats => ['video/h264', 'video/vp8'].includes(stats?.codec.toLowerCase()) && stats.framesDecoded >= 3,
      'non-HEVC receiver fallback did not decode', 30000);
    await host.waitForFunction(() => [...document.querySelectorAll('.viewer-row')]
      .some(row => row.textContent.includes('HEVC-disabled fixture') && row.textContent.includes('已回落')));
    report.senderCodecDisplay = await host.locator('#viewers').innerText();
    await host.screenshot({ path: path.join(resultDir, `${packaged ? 'packaged-' : ''}hevc-live.png`) });
    check('receiver excluding H.265 decodes fallback video and sender GUI reports its actual codec / fallback');
    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#status-text').textContent === '尚未广播');

    const networks = await host.evaluate(() => window.lan.getNetworks());
    const network = networks.find(item => !item.local && !item.virtual) || networks.find(item => !item.local);
    assert.ok(network, 'WAN refresh fixture requires a real LAN interface');
    await application.evaluate(({ app }, address) => {
      const module = process.mainModule.require(`${app.getAppPath()}/src/router-discovery.js`);
      globalThis.__fixtureWan = address;
      module.discoverRouterWan = async () => globalThis.__fixtureWan
        ? { supported: true, wanAddress: globalThis.__fixtureWan, gateway: '192.168.31.1', method: 'WAN query fixture', message: 'WAN response fixture' }
        : { supported: false, gateway: '192.168.31.1', message: '路由器没有响应地址查询，请手动填写。' };
    }, '10.20.30.40');
    await host.locator('#network').selectOption(network.address);
    const lanPort = await freePort(network.address);
    await host.locator('#port').fill(String(lanPort));
    await host.locator('#forwarding-enabled').check();
    await host.locator('#auto-router-address').check();
    await host.locator('#advertised-port').fill('18888');
    await host.waitForFunction(() => document.querySelector('#advertised-host').value === '10.20.30.40');
    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#preview').videoWidth > 0);
    await host.locator('#share-target').selectOption('forwarded');
    const oldInvite = new URL(await host.locator('#invite-link').inputValue());
    const oldPin = await host.locator('#pin').textContent();
    const oldQr = await host.locator('#qr').getAttribute('src');
    assert.equal(oldInvite.hostname, '10.20.30.40');
    await application.evaluate(() => { globalThis.__fixtureWan = '10.20.30.41'; });
    await host.evaluate(address => window.lan.detectRouter(address), network.address);
    await host.waitForFunction(() => document.querySelector('#invite-link').value.startsWith('http://10.20.30.41:'));
    const newInvite = new URL(await host.locator('#invite-link').inputValue());
    assert.equal(newInvite.hash, oldInvite.hash);
    assert.equal(await host.locator('#pin').textContent(), oldPin);
    assert.notEqual(await host.locator('#qr').getAttribute('src'), oldQr);
    assert.equal(await hostHeaderStatus(network.address, lanPort, '10.20.30.41:18888'), 200);
    assert.equal(await hostHeaderStatus(network.address, lanPort, '10.20.30.40:18888'), 403);
    assert.equal(await hostHeaderStatus(network.address, lanPort, `${network.address}:${lanPort}`), 200);
    await eventually(() => fs.readFile(settingsFile, 'utf8').then(JSON.parse),
      settings => settings.advertisedHost === '10.20.30.41', 'new WAN address was not auto-saved');
    report.wanRefresh = { discoveryResponseFixture: true, tokenPreserved: true, pinPreserved: true,
      oldHostRejected: true, newHostAccepted: true, localHostAccepted: true, addressSaved: true };
    check('WAN response change updates live invite / QR and HTTP Host allowlist without changing token / PIN');
    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#status-text').textContent === '尚未广播');
    await application.evaluate(() => { globalThis.__fixtureWan = null; });
    await host.locator('#detect-router').click();
    await host.waitForFunction(() => document.querySelector('#router-status').textContent.includes('手动填写'));
    assert.equal(await host.locator('#advertised-host').inputValue(), '10.20.30.41');
    check('unsupported router response explains manual fallback and retains saved address');
    assert.deepEqual(errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack; report.pageErrors = errors;
    if (host && !host.isClosed()) {
      report.guiState = await host.evaluate(() => ({ notice: document.querySelector('#notice').textContent,
        status: document.querySelector('#status-text').textContent, viewers: document.querySelector('#viewers').textContent,
        microphone: document.querySelector('#microphone-status').textContent, router: document.querySelector('#router-status').textContent })).catch(() => null);
    }
    console.error(error); process.exitCode = 1;
  } finally {
    if (application) {
      await application.evaluate(({ BrowserWindow }) => {
        for (const win of globalThis.__featureWindows || []) if (!win.isDestroyed()) win.close();
      }).catch(() => {});
      await application.close().catch(() => {});
    }
    await fs.writeFile(path.join(resultDir, `${packaged ? 'packaged-' : ''}features-smoke.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
