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
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function released(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const code = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve('OPEN'); });
      socket.once('error', error => resolve(error.code));
      socket.setTimeout(500, () => { socket.destroy(); resolve('TIMEOUT'); });
    });
    if (code === 'ECONNREFUSED') return;
    await delay(100);
  }
  throw new Error(`Port ${port} still listening after cleanup`);
}
async function idle(host) {
  await host.waitForFunction(() => document.querySelector('#status-text').textContent === '尚未广播');
}
async function screen(host) {
  await host.locator('[data-source-tab="screen"]').click();
  await host.locator('.source-card').first().click();
}
async function pendingMic(host) {
  await host.evaluate(() => {
    window.__nativeMic ||= navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__nativeDisplay ||= navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async constraints => {
      const stream = await window.__nativeDisplay(constraints);
      window.__preparingStream = stream; return stream;
    };
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.__resolveLateMic = resolve; });
    document.querySelector('#microphone').checked = true;
  });
  await host.locator('#start').click();
  await host.waitForFunction(() => typeof window.__resolveLateMic === 'function');
}
async function settleLateMic(host) {
  await host.evaluate(() => {
    window.__lateAudio = new AudioContext();
    const stream = window.__lateAudio.createMediaStreamDestination().stream;
    window.__lateTrack = stream.getAudioTracks()[0];
    window.__resolveLateMic(stream);
  });
  await host.waitForFunction(() => window.__lateTrack.readyState === 'ended');
  await host.evaluate(async () => {
    await window.__lateAudio.close();
    delete window.__resolveLateMic;
    navigator.mediaDevices.getUserMedia = window.__nativeMic;
    navigator.mediaDevices.getDisplayMedia = window.__nativeDisplay;
    document.querySelector('#microphone').checked = false;
  });
}

async function main() {
  await fs.mkdir(resultDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), scope: 'same-PC production GUI with explicit device/IPC test boundaries', checks: [] };
  const check = text => { report.checks.push(text); console.log(`PASS ${text}`); };
  const app = await _electron.launch({
    executablePath: process.env.LAN_CAST_EXECUTABLE || require('electron'), args: process.env.LAN_CAST_EXECUTABLE ? [] : [root],
    env: { ...process.env, LAN_CAST_DATA_DIR: path.join(root, '.cache', 'gui-regressions-profile') }, timeout: 30000
  });
  const errors = [];
  try {
    Object.assign(report, await runtimeEvidence(app));
    const host = await app.firstWindow();
    host.on('pageerror', error => errors.push(error.message));
    await host.waitForFunction(() => document.querySelector('.source-card'));
    await host.locator('#network').selectOption('127.0.0.1');
    await host.locator('#forwarding-enabled').uncheck();
    await host.locator('#rtmp-enabled').uncheck();
    const port = await freePort();
    await host.locator('#port').fill(String(port));
    await app.evaluate(async ({ BrowserWindow }) => {
      globalThis.__regressionFixture = new BrowserWindow({ width: 600, height: 360, title: 'LAN lifecycle fixture', webPreferences: { sandbox: true } });
      await globalThis.__regressionFixture.loadURL('data:text/html,<title>LAN lifecycle fixture</title><body style="background:steelblue;color:white;font:32px sans-serif">窗口关闭回归</body>');
    });
    await host.locator('[data-source-tab="window"]').click();
    await host.locator('.source-card').filter({ hasText: 'LAN lifecycle fixture' }).click();
    await pendingMic(host);
    await app.evaluate(() => globalThis.__regressionFixture.close());
    await idle(host);
    assert.equal(await host.evaluate(() => window.__preparingStream.getVideoTracks()[0].readyState), 'ended');
    await settleLateMic(host);
    check('native window closes while microphone is pending; screen and late audio are released');

    await screen(host);
    await pendingMic(host);
    await host.locator('#start').click();
    await idle(host);
    assert.equal(await host.evaluate(() => window.__preparingStream.getTracks().every(track => track.readyState === 'ended')), true);
    await settleLateMic(host);
    check('cancel preparation releases real screen immediately and stops late microphone');

    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#preview').videoWidth > 0);
    await host.reload();
    await host.waitForFunction(() => document.querySelector('.source-card'));
    await released(port);
    await host.locator('#network').selectOption('127.0.0.1');
    await host.locator('#microphone').uncheck();
    await host.locator('#forwarding-enabled').uncheck();
    await host.locator('#port').fill(String(port));
    await host.locator('.source-card').first().click();
    await host.locator('#start').click();
    await host.waitForFunction(() => document.querySelector('#preview').videoWidth > 0);
    check('reload closes old listener and a new broadcast reuses the same port');

    await host.evaluate(() => { window.lan.onEvent(({ type, payload }) => { if (type === 'viewers') window.__testViewers = payload; }); });
    const invite = await host.locator('#invite-link').inputValue();
    const ready = app.waitForEvent('window');
    await app.evaluate(async ({ BrowserWindow }, url) => {
      globalThis.__regressionViewer = new BrowserWindow({ width: 1000, height: 760,
        webPreferences: { partition: 'gui-regression-viewer', sandbox: true, nodeIntegration: false, contextIsolation: true } });
      await globalThis.__regressionViewer.loadURL(url);
    }, invite);
    const viewer = await ready;
    viewer.on('pageerror', error => errors.push(error.message));
    await viewer.locator('#watch').click();
    await viewer.waitForFunction(() => document.querySelector('#connection-text').textContent === '正在观看');
    await host.evaluate(() => window.lan.retry(window.__testViewers[0].id, 'timeout'));
    await viewer.waitForFunction(() => document.querySelector('#connection-text').textContent.includes('重试'));
    await viewer.waitForFunction(() => document.querySelector('#connection-text').textContent === '正在观看');
    check('automatic media retry recovers and decodes frames again');
    await host.locator('.viewer-row button').first().click();
    await viewer.waitForFunction(() => document.querySelector('#remote').srcObject === null);
    await delay(1600);
    assert.equal(await host.locator('#viewer-count').textContent(), '0');
    assert.match(await viewer.locator('#connection-text').textContent(), /断开/);
    check('manual removal clears media and prevents automatic re-admission');

    await viewer.goto(`${new URL(invite).origin}/#token=${'z'.repeat(32)}`);
    await viewer.locator('.invite-import summary').click();
    await viewer.locator('#invite-address').fill(invite);
    await viewer.locator('#import-invite').click();
    await viewer.waitForFunction(hash => location.hash === hash, new URL(invite).hash);
    await viewer.locator('#watch').click();
    await viewer.waitForFunction(() => document.querySelector('#connection-text').textContent === '正在观看');
    check('paste/import a renewed invitation and decode video in the existing page');
    await host.locator('#start').click();
    await idle(host); await released(port);
    await viewer.waitForFunction(() => document.querySelector('#connection-text').textContent.includes('结束'));

    const networks = await host.evaluate(() => window.lan.getNetworks());
    const lan = networks.find(n => !n.local && !n.virtual);
    if (lan) {
      const alias = networks.find(n => n.address !== lan.address && /^(172|192|10)\./.test(n.address))?.address || lan.address;
      await host.locator('#network').selectOption(lan.address);
      await host.locator('#forwarding-enabled').check();
      await host.locator('#auto-router-address').uncheck();
      await host.locator('#advertised-host').fill(alias);
      await host.locator('#advertised-port').fill('18765');
      await host.locator('#start').click();
      await host.waitForFunction(() => document.querySelector('#status-text').textContent === '正在广播');
      const forwarded = await host.locator('#invite-link').inputValue();
      assert.equal(new URL(forwarded).hostname, alias);
      assert.equal(new URL(forwarded).port, '18765');
      await host.locator('#share-target').selectOption('local');
      const local = await host.locator('#invite-link').inputValue();
      assert.equal(new URL(local).hostname, lan.address);
      assert.equal(new URL(local).hash, new URL(forwarded).hash);
      assert.match(await host.locator('#mapping-list').textContent(), /UDP 50000–50100/);
      report.forwarding = { mode: 'GUI address/mapping preview using addresses owned by this PC; no real router traversal', localHost: lan.address, advertisedHost: alias };
      check('forwarding GUI switches LAN/WAN invitations and renders same-port UDP mapping');
      await host.locator('#start').click(); await idle(host);
    } else report.forwarding = { skipped: 'No physical LAN IPv4 available' };
    assert.deepEqual(errors, []);
    report.pageErrors = errors; report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.stack; report.pageErrors = errors;
    console.error(error); process.exitCode = 1;
    for (const [index, page] of (await app.windows()).entries()) {
      await page.screenshot({ path: path.join(resultDir, `gui-failure-${index}.png`) }).catch(() => {});
    }
  } finally {
    await fs.writeFile(path.join(resultDir, process.env.LAN_CAST_EXECUTABLE ? 'packaged-gui-regressions.json' : 'gui-regressions.json'), JSON.stringify(report, null, 2));
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.getURL().endsWith('/src/renderer/index.html')) win.close();
      }
    }).catch(() => {});
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
