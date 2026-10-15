// Exercises the production app. Test fixtures and synthetic audio stay here.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { runtimeEvidence } = require('./runtime-evidence');

const root = path.resolve(__dirname, '..');
const resultDir = path.join(root, 'test-results');

async function freePort() {
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

// Playwright's waitForFunction considers a Promise truthy before it settles.
// Poll asynchronous getStats from Node so only the decoded snapshot passes.
async function waitForDecodedAudioVideo(page) {
  const deadline = Date.now() + 30000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(async () => {
      const peer = window.__testPeer;
      if (!peer) return null;
      const reports = [...(await peer.getStats()).values()];
      const audio = reports.find(r => r.type === 'inbound-rtp' && r.kind === 'audio');
      const video = reports.find(r => r.type === 'inbound-rtp' && r.kind === 'video');
      if (peer !== window.__testPeer) return null;
      return { audioBytes: audio?.bytesReceived || 0, audioSamples: audio?.totalSamplesReceived || 0,
        audioEnergy: audio?.totalAudioEnergy || 0, videoFrames: video?.framesDecoded || 0,
        candidateTypes: reports.filter(r => r.type === 'local-candidate' || r.type === 'remote-candidate')
          .map(r => ({ type: r.type, address: r.address, port: r.port, protocol: r.protocol, candidateType: r.candidateType })) };
    });
    if (snapshot?.audioBytes > 2000 && snapshot.audioSamples > 0 && snapshot.videoFrames >= 3) return snapshot;
    await delay(250);
  }
  throw new Error(`Audio/video decoding timeout: ${JSON.stringify(snapshot)}`);
}

async function main() {
  await fs.mkdir(resultDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), scope: 'same-PC Electron host and isolated Chromium receiver', checks: [] };
  const check = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  const errors = [];
  const electron = await _electron.launch({
    executablePath: process.env.LAN_CAST_EXECUTABLE || require('electron'),
    args: process.env.LAN_CAST_EXECUTABLE ? [] : [root],
    env: { ...process.env, LAN_CAST_DATA_DIR: path.join(root, '.cache', 'smoke-profile'), ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 30000
  });
  try {
    Object.assign(report, await runtimeEvidence(electron));
    const host = await electron.firstWindow();
    host.on('pageerror', e => errors.push(e.message));
    // Network options load before microphone preferences and the source tab.
    // Wait for the completed initial source list before operating the GUI.
    await host.waitForFunction(() => window.lan && document.querySelector('.source-card'));
    const networks = await host.evaluate(() => window.lan.getNetworks());
    await host.evaluate(() => {
      window.__hostCandidates = [];
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct(target, args) {
          const peer = Reflect.construct(target, args);
          peer.addEventListener('icecandidate', ({ candidate }) => {
            if (candidate) window.__hostCandidates.push(candidate.toJSON());
          });
          return peer;
        }
      });
    });
    assert.ok(networks.some(n => n.address === '127.0.0.1'));
    await host.screenshot({ path: path.join(resultDir, 'host-idle.png') });

    // An independently animated, non-privileged native window is the capture fixture.
    await electron.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ width: 800, height: 500, title: 'LAN Cast capture test', webPreferences: { sandbox: true } });
      globalThis.__captureFixture = fixture;
      const html = '<html><body style="margin:0;background:#1367c5;color:white;font:32px Segoe UI;display:grid;place-items:center;height:100vh"><div>LAN CAST · 实际窗口采集<br><span id="clock"></span></div><script>setInterval(()=>{document.querySelector("#clock").textContent=Date.now();document.body.style.background=`hsl(${Date.now()/30%360},65%,35%)`},30)</script></body></html>';
      await fixture.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    });
    await host.locator('[data-source-tab="window"]').click();
    await host.locator('#refresh-sources').click();
    const source = host.locator('.source-card').filter({ hasText: 'LAN Cast capture test' });
    await source.waitFor();
    await source.click();
    await host.locator('#network').selectOption('127.0.0.1');
    await host.locator('#max-viewers').fill('5');
    await host.locator('#bitrate').fill('6');
    await host.locator('#microphone').uncheck();
    await host.locator('#forwarding-enabled').uncheck();
    await host.locator('#rtmp-enabled').uncheck();
    const port = await freePort();
    await host.locator('#port').fill(String(port));
    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#start').textContent.includes('停止'));
    await host.waitForFunction(() => document.querySelector('#preview').videoWidth > 0);
    const invite = await host.locator('#invite-link').inputValue();
    assert.match(invite, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    check('selected-window capture produces frames');
    await host.locator('#copy-link').click();
    assert.equal(await electron.evaluate(({ clipboard }) => clipboard.readText()), invite);
    assert.equal(await host.locator('#save-invite').count(), 0);
    assert.equal(await host.evaluate(() => typeof window.lan.saveInvite), 'undefined');
    check('copy web invitation through trusted IPC; URL export removed');

    // A separate session has no preload API, permissions or Node privileges.
    const receiverReady = electron.waitForEvent('window');
    const receiver = await electron.evaluate(async ({ BrowserWindow }, inviteUrl) => {
      const win = new BrowserWindow({ width: 1100, height: 800, webPreferences: { partition: 'receiver-test', sandbox: true, nodeIntegration: false, contextIsolation: true } });
      globalThis.__smokeWindows = [win];
      await win.loadURL(inviteUrl);
      return win.id;
    }, invite);
    const viewer = await receiverReady;
    assert.ok(viewer, `receiver window ${receiver} exists`);
    viewer.on('pageerror', e => errors.push(e.message));
    await viewer.addInitScript(() => {
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct(target, args) { const peer = Reflect.construct(target, args); window.__testPeer = peer; return peer; }
      });
    });
    await viewer.goto(invite);
    assert.equal(await viewer.evaluate(() => typeof window.lan), 'undefined');
    await viewer.locator('#watch').click();
    await viewer.waitForFunction(() => document.querySelector('#remote').videoWidth > 0, null, { timeout: 25000 });
    await viewer.waitForFunction(() => document.querySelector('#fps').textContent !== '—', null, { timeout: 12000 });
    const dimensions = await viewer.evaluate(() => ({ width: document.querySelector('#remote').videoWidth, height: document.querySelector('#remote').videoHeight }));
    report.windowCapture = dimensions;
    check('browser invitation authentication and WebRTC video decode');
    await viewer.screenshot({ path: path.join(resultDir, 'viewer-live.png') });

    await host.waitForFunction(() => document.querySelector('#viewer-count').textContent === '1');
    await host.screenshot({ path: path.join(resultDir, 'host-live.png') });
    const pin = await host.locator('#pin').textContent();
    const secondReady = electron.waitForEvent('window');
    const secondId = await electron.evaluate(async ({ BrowserWindow }, url) => {
      const win = new BrowserWindow({ width: 850, height: 700, webPreferences: { partition: 'receiver-second', sandbox: true } });
      globalThis.__smokeWindows.push(win);
      await win.loadURL(url);
      return win.id;
    }, `http://127.0.0.1:${port}/`);
    const second = await secondReady;
    assert.ok(second, `second viewer ${secondId} exists`);
    await second.goto(`http://127.0.0.1:${port}/`);
    await second.locator('#access-code').fill(pin);
    await second.locator('#watch').click();
    await second.waitForFunction(() => document.querySelector('#remote').videoWidth > 0, null, { timeout: 25000 });
    await host.waitForFunction(() => document.querySelector('#viewer-count').textContent === '2');
    check('two simultaneous viewers, token and PIN admission');

    const extraViewers = [];
    for (let index = 3; index <= 5; index++) {
      const ready = electron.waitForEvent('window');
      await electron.evaluate(async ({ BrowserWindow }, { url, index }) => {
        const win = new BrowserWindow({ width: 800, height: 650, webPreferences: { partition: `receiver-${index}`, sandbox: true } });
        globalThis.__smokeWindows.push(win); await win.loadURL(url);
      }, { url: invite, index });
      const page = await ready;
      page.on('pageerror', e => errors.push(e.message));
      await page.locator('#watch').click();
      await page.waitForFunction(() => document.querySelector('#remote').videoWidth > 0, null, { timeout: 25000 });
      extraViewers.push(page);
    }
    await host.waitForFunction(() => document.querySelector('#viewer-count').textContent === '5');
    check('five simultaneous viewers all decode captured video');

    await host.locator('#start').click();
    await viewer.waitForFunction(() => document.querySelector('#connection-text').textContent.includes('结束'));
    assert.equal(await viewer.evaluate(() => document.querySelector('#remote').srcObject), null);
    check('stop clears receiver media');

    await host.locator('[data-source-tab="screen"]').click();
    await host.locator('.source-card').first().click();
    const lanNetwork = networks.find(n => !n.local && !n.virtual);
    if (lanNetwork) await host.locator('#network').selectOption(lanNetwork.address);
    await host.locator('#resolution').selectOption('720');
    await host.locator('#fps').selectOption('60');
    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#start').textContent.includes('停止'));
    const nextInvite = await host.locator('#invite-link').inputValue();
    assert.notEqual(nextInvite, invite);
    await viewer.goto(nextInvite);
    await viewer.locator('#watch').click();
    await viewer.waitForFunction(() => document.querySelector('#remote').videoWidth > 0, null, { timeout: 25000 });
    const screenSize = await viewer.evaluate(() => ({ width: document.querySelector('#remote').videoWidth, height: document.querySelector('#remote').videoHeight }));
    assert.ok(screenSize.width <= 1280 && screenSize.height <= 720);
    report.screenCapture = { ...screenSize, fpsLimit: 60, bindAddress: lanNetwork?.address || '127.0.0.1' };
    check('full-screen 720p/60fps limit, selected LAN bind and renewed invitation in existing page');
    await host.locator('#start').click();
    await host.locator('#resolution').selectOption('1080');
    await host.locator('#fps').selectOption('30');

    // Substitute only the microphone input, keeping production capture, Opus,
    // SDP, UDP transport and receiver audio decoding unchanged.
    await host.evaluate(() => {
      window.__originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext();
        await audio.resume();
        const oscillator = audio.createOscillator(); oscillator.frequency.value = 440;
        const gain = audio.createGain(); gain.gain.value = 0.08;
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(gain); gain.connect(destination); oscillator.start();
        const track = destination.stream.getAudioTracks()[0];
        const originalStop = track.stop.bind(track);
        track.stop = () => { oscillator.stop(); void audio.close(); originalStop(); };
        return destination.stream;
      };
    });
    await host.locator('#microphone').check();
    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#start').textContent.includes('停止'));
    await viewer.goto(await host.locator('#invite-link').inputValue());
    await viewer.locator('#watch').click();
    await viewer.waitForFunction(() => document.querySelector('#connection-text').textContent === '正在观看', null, { timeout: 25000 });
    if (await viewer.locator('#enable-audio').isVisible()) await viewer.locator('#enable-audio').click();
    report.audio = await waitForDecodedAudioVideo(viewer);
    report.hostCandidates = await host.evaluate(() => window.__hostCandidates.map(c => c.candidate));
    assert.ok(report.audio.audioSamples > 0);
    await host.locator('#mute').click();
    assert.equal(await host.evaluate(() => document.querySelector('#preview').srcObject.getAudioTracks()[0].enabled), false);
    await host.locator('#mute').click();
    assert.equal(await host.evaluate(() => document.querySelector('#preview').srcObject.getAudioTracks()[0].enabled), true);
    check('synthetic microphone audio transmitted and decoded, broadcaster mute/unmute');
    await host.locator('#start').click();
    await host.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__originalGetUserMedia; });
    await host.locator('#microphone').uncheck();
    report.microphoneCapture = await host.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const count = stream.getAudioTracks().length;
        stream.getTracks().forEach(track => track.stop());
        return { available: true, trackCount: count };
      } catch (error) { return { available: false, reason: error.message }; }
    });

    report.pageErrors = errors;
    assert.deepEqual(errors, []);
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.passed = false;
    report.pageErrors = errors;
    report.error = error.stack;
    console.error(error);
    process.exitCode = 1;
    for (const [index, page] of (await electron.windows()).entries()) {
      await page.screenshot({ path: path.join(resultDir, `failure-${index}.png`) }).catch(() => {});
      const diagnostic = await page.evaluate(async () => ({
        notice: document.querySelector('#notice')?.textContent,
        sourceTab: document.querySelector('[data-source-tab].active')?.dataset.sourceTab,
        sources: [...document.querySelectorAll('.source-card')].map(card => card.title),
        state: document.querySelector('#connection-text')?.textContent,
        video: document.querySelector('video') ? { width: document.querySelector('video').videoWidth, paused: document.querySelector('video').paused,
          tracks: document.querySelector('video').srcObject?.getTracks().map(t => ({ kind: t.kind, readyState: t.readyState })) } : null,
        peer: window.__testPeer ? { state: window.__testPeer.connectionState,
          reports: [...(await window.__testPeer.getStats()).values()].filter(r => r.type === 'inbound-rtp').map(r => ({ kind: r.kind, bytesReceived: r.bytesReceived, framesDecoded: r.framesDecoded })) } : null
      })).catch(() => null);
      if (diagnostic) (report.diagnostics ||= []).push({ index, ...diagnostic });
    }
  } finally {
    await fs.writeFile(path.join(resultDir, process.env.LAN_CAST_EXECUTABLE ? 'packaged-smoke.json' : 'smoke.json'), JSON.stringify(report, null, 2));
    // These extra windows belong to the test. The production host normally has
    // a single window; close fixtures before exercising its save/quit handshake.
    await electron.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.getURL().endsWith('/src/renderer/index.html')) win.close();
      }
    }).catch(() => {});
    await electron.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
