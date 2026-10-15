// NSIS portable launchers do not forward Electron's inspector stderr to
// Playwright. Verify this launcher through its own loopback browser endpoint.
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const asar = require('@electron/asar');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const assert = require('node:assert/strict');
const { sourceEvidence } = require('./source-fingerprint');
const { verifyMediaDirectory } = require('./media-evidence');
const executable = path.join(root, 'release', `LAN-Screen-Cast-${version}-win-x64.exe`);

function safeDiagnostic(value) {
  return String(value).replace(/\b(?:rtmps?|https?):\/\/[^\s"'<>]+/gi, '[session address redacted]')
    .replace(/\b(token|password|pin|generation)=[^\s&]+/gi, '$1=[redacted]');
}

async function freePort(except = []) {
  for (;;) {
    const listener = net.createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    if (!except.includes(port)) return port;
  }
}

async function released(port) {
  const deadline = Date.now() + 15000;
  let closed = 0;
  while (Date.now() < deadline) {
    const state = await new Promise(resolve => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      let done = false;
      const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
      socket.once('connect', () => finish('OPEN'));
      socket.once('error', error => finish(error.code));
      socket.setTimeout(800, () => finish('TIMEOUT'));
    });
    closed = state === 'ECONNREFUSED' ? closed + 1 : 0;
    if (closed === 2) return;
    await delay(150);
  }
  throw new Error('Portable stop did not release its owned TCP listener');
}

async function decodeFrames(ffmpeg, url) {
  const decoder = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-rw_timeout', '5000000',
    '-rtmp_live', 'live', '-rtmp_enhanced_codecs', 'hvc1', '-i', url, '-an', '-frames:v', '3', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], {
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostics = '', timer;
  decoder.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-256000); });
  decoder.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-256000); });
  try {
    const code = await Promise.race([
      new Promise((resolve, reject) => { decoder.once('error', reject); decoder.once('close', resolve); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Bundled portable RTMP decoding timed out')), 25000); })
    ]);
    const frames = Math.max(0, ...[...output.matchAll(/^frame=(\d+)\s*$/gm)].map(match => Number(match[1])));
    // Diagnostics may contain the invitation. Keep them out of public evidence.
    const safeDiagnostics = safeDiagnostic(diagnostics).slice(-2000);
    assert.equal(code, 0, `Bundled portable FFmpeg could not decode its own RTMP stream: ${safeDiagnostics}`);
    assert.ok(frames >= 3, 'Bundled portable FFmpeg did not decode three RTMP video frames');
    return frames;
  } finally {
    clearTimeout(timer);
    if (decoder.exitCode === null && decoder.pid) {
      try { execFileSync('taskkill.exe', ['/PID', String(decoder.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* Process exited during cleanup. */ }
    }
  }
}

function processSnapshot(ownedPids = []) {
  assert.ok(ownedPids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  // The global tree inventory excludes command lines. Read potentially secret
  // publisher arguments only after proving ownership by the portable launcher.
  const command = ownedPids.length
    ? `Get-CimInstance Win32_Process -Filter '${ownedPids.map(pid => `ProcessId = ${pid}`).join(' OR ')}' | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`
    : 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress';
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, encoding: 'utf8', timeout: 12000, maxBuffer: 8 * 1024 * 1024 });
  const rows = JSON.parse(output.trim() || '[]');
  return Array.isArray(rows) ? rows : [rows];
}

async function verifyPublisher(page, launcherPid, mediaDirectory, state) {
  assert.ok(Number.isSafeInteger(launcherPid) && launcherPid > 0, 'Portable launcher has no owned process');
  assert.match(state.encoder, /^(?:hevc_(?:nvenc|qsv|amf|mf)|libkvazaar)$/);
  assert.equal(typeof state.hardware, 'boolean', 'Portable RTMP must report its actual acceleration');
  const descendants = new Set([launcherPid]);
  const rows = processSnapshot();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (descendants.has(row.ParentProcessId) && !descendants.has(row.ProcessId)) {
      descendants.add(row.ProcessId); changed = true;
    }
  }
  const producers = rows.filter(row => descendants.has(row.ProcessId) && /^ffmpeg\.exe$/i.test(row.Name));
  const details = producers.length ? processSnapshot(producers.map(row => row.ProcessId)) : [];
  const expectedExecutable = path.resolve(mediaDirectory, 'bin', 'ffmpeg.exe').toLowerCase();
  const producer = details.find(row => typeof row.ExecutablePath === 'string'
    && path.resolve(row.ExecutablePath).toLowerCase() === expectedExecutable
    && new RegExp(`(?:-c:v|-codec:v|-vcodec)"?\\s+"?${state.encoder}(?:[\\s"]|$)`).test(row.CommandLine || ''));
  assert.ok(producer, 'Extracted owned FFmpeg publisher must actually select the reported HEVC encoder');
  if (state.hardware) {
    assert.match(state.encoder, /(?:nvenc|qsv|amf|mf)$/);
    if (state.encoder === 'hevc_mf') assert.ok(/-hw_encoding"?\s+"?(?:1|true)(?:[\s"]|$)/i.test(producer.CommandLine),
      'Owned Media Foundation publisher must enable hardware encoding');
  } else {
    assert.match(state.encoder, /^(?:hevc_mf|libkvazaar)$/);
    if (state.encoder === 'hevc_mf') assert.ok(/-hw_encoding"?\s+"?(?:0|false)(?:[\s"]|$)/i.test(producer.CommandLine),
      'Owned Media Foundation publisher must select software encoding');
  }
  assert.match(await page.locator('#rtmp-status').textContent(), state.hardware ? /硬件/ : /软件/,
    'Portable GUI must state the actual acceleration, including software fallback');
  return { confirmedByOwnedPublisherArguments: true, statusStatesActualAcceleration: true };
}

async function main() {
  const debugPort = await freePort();
  const report = { ...sourceEvidence(), version, executableSha256: crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex'),
    startedAt: new Date().toISOString(), scope: 'normal single-file portable launcher with temporary loopback CDP', passed: false };
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env,
      LAN_CAST_DATA_DIR: path.join(root, '.cache', `portable-launch-profile-${Date.now()}-${process.pid}`) }
  });
  let browser;
  try {
    const deadline = Date.now() + 40000;
    let endpoint;
    while (Date.now() < deadline) {
      endpoint = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(800) })
        .then(response => response.ok ? response.json() : null).catch(() => null);
      if (endpoint?.webSocketDebuggerUrl) break;
      if (child.exitCode !== null) throw new Error(`Portable launcher exited early: ${child.exitCode}`);
      await delay(250);
    }
    if (!endpoint?.webSocketDebuggerUrl) throw new Error('Portable launcher did not expose its browser endpoint');
    browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    let page;
    const pageDeadline = Date.now() + 15000;
    while (Date.now() < pageDeadline) {
      page = browser.contexts().flatMap(context => context.pages())
        .find(candidate => candidate.url().endsWith('/src/renderer/index.html'));
      if (page) break;
      await delay(100);
    }
    if (!page) throw new Error('No broadcast GUI from the portable runtime');
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    report.guiUrl = page.url();
    const asarMatch = /^([\s\S]*[\\/]app\.asar)[\\/]src[\\/]renderer[\\/]index\.html$/i.exec(fileURLToPath(page.url()));
    if (!asarMatch) throw new Error('Portable GUI did not come from an embedded app.asar');
    const embeddedAsar = asarMatch[1];
    report.version = JSON.parse(asar.extractFile(embeddedAsar, 'package.json')).version;
    report.embeddedAsarSha256 = crypto.createHash('sha256').update(await fs.readFile(embeddedAsar)).digest('hex');
    report.embeddedExecutableSha256 = crypto.createHash('sha256')
      .update(await fs.readFile(path.resolve(path.dirname(embeddedAsar), '..', 'LAN Screen Cast.exe'))).digest('hex');
    const candidate = JSON.parse(await fs.readFile(path.join(root, 'test-results', 'bundle-verification.json'), 'utf8'));
    if (report.version !== version || report.embeddedAsarSha256 !== candidate.asarSha256) {
      throw new Error('Portable payload is not the verified candidate application');
    }
    const embeddedMedia = path.join(path.dirname(embeddedAsar), 'media');
    report.nativeMedia = verifyMediaDirectory(embeddedMedia, { expectedDirectory: path.join(root, 'vendor', 'media') });
    assert.deepEqual(report.nativeMedia, candidate.nativeMedia, 'Portable native media must match the verified unpacked candidate');
    report.nativeMediaFilesMatchSource = true;
    try {
      await page.waitForFunction(() => window.lan && document.querySelector('.source-card'));
    } catch (error) {
      report.guiState = await page.evaluate(() => ({ preload: typeof window.lan,
        sourceCount: document.querySelectorAll('.source-card').length,
        networkCount: document.querySelectorAll('#network option').length,
        notice: document.querySelector('#notice')?.textContent }));
      report.pageErrors = pageErrors;
      throw error;
    }
    await page.locator('#network').selectOption('127.0.0.1');
    await page.locator('#forwarding-enabled').uncheck();
    await page.locator('#microphone').uncheck();
    await page.locator('#system-audio').uncheck();
    assert.equal(await page.locator('#rtmp-enabled').isChecked(), true, 'Fresh portable settings must enable RTMP by default');
    assert.equal(await page.locator('#codec').inputValue(), 'HEVC', 'Fresh portable web settings must prefer HEVC');
    assert.equal(await page.locator('#rtmp-codec').inputValue(), 'HEVC');
    assert.equal(await page.locator('#rtmp-acceleration').inputValue(), 'auto');
    report.defaults = { codec: 'HEVC', rtmpEnabled: true, rtmpCodec: 'HEVC', rtmpAcceleration: 'auto' };
    const mediaPort = await freePort([debugPort]), rtmpPort = await freePort([debugPort, mediaPort]);
    await page.locator('#port').fill(String(mediaPort));
    await page.locator('#rtmp-port').fill(String(rtmpPort));
    await page.locator('#resolution').selectOption('720');
    await page.locator('#bitrate').fill('3');
    await page.evaluate(() => {
      window.lan.onEvent(({ type, payload }) => { if (type === 'rtmp-state') window.__portableRtmp = payload; });
    });
    await page.locator('.source-card').first().click();
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#preview').videoWidth > 0);
    const status = await (await fetch(`http://127.0.0.1:${mediaPort}/api/status`)).json();
    if (!status.roomId) throw new Error('Portable runtime did not start its real web service');
    await page.waitForFunction(() => window.__portableRtmp?.phase === 'ready'
      && !document.querySelector('#copy-rtmp').disabled, null, { timeout: 45000 });
    const rtmpUrl = await page.locator('#rtmp-link').inputValue();
    assert.equal(new URL(rtmpUrl).hostname, '127.0.0.1');
    assert.equal(Number(new URL(rtmpUrl).port), rtmpPort);
    await page.locator('#copy-rtmp').click();
    const copied = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 }).trim();
    assert.ok(copied === rtmpUrl, 'Portable RTMP copy action must place the actual playing address in the clipboard');
    const rtmp = await page.evaluate(() => ({ codec: window.__portableRtmp.codec,
      encoder: window.__portableRtmp.encoder, hardware: window.__portableRtmp.hardware }));
    assert.match(rtmp.codec, /HEVC|H\.?265/i);
    report.rtmp = { ...rtmp, ...await verifyPublisher(page, child.pid, embeddedMedia, rtmp),
      runtimeCodec: rtmp.codec, codec: 'HEVC', ready: true, accelerationRequested: 'auto', copyMatchesAddress: true,
      decodedVideoFrames: await decodeFrames(path.join(embeddedMedia, 'bin', 'ffmpeg.exe'), rtmpUrl),
      enhancedRtmpRead: true, receiverSpeakerOutput: false };
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#status-text').textContent === '尚未广播');
    await released(mediaPort); await released(rtmpPort);
    assert.equal(await page.locator('#rtmp-link').inputValue(), '');
    assert.equal(await page.locator('#copy-rtmp').isEnabled(), false);
    report.rtmp.ownedListenersReleased = true;
    report.checks = ['single-file runtime extracts and initializes GUI', 'production preload and source enumeration',
      'actual extracted native manifest, binaries, licenses and sources match the verified candidate',
      'real screen capture and HTTP room service', 'fresh web HEVC and RTMP HEVC/auto defaults',
      'default HEVC NVIDIA-preferred RTMP is ready and copied; actual owned publisher and acceleration are confirmed',
      'extracted bundled FFmpeg Enhanced RTMP receiver decodes three actual HEVC video frames',
      'stop releases capture and both TCP servers'];
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = safeDiagnostic(error.stack || error); console.error(report.error); process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    // Terminate only the exact still-owned launcher and its test descendants.
    if (child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* It may have exited after browser.close. */ }
    }
    await fs.writeFile(path.join(root, 'test-results', 'portable-launch.json'), JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(safeDiagnostic(error.stack || error)); process.exitCode = 1; });
