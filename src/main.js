const { app, BrowserWindow, desktopCapturer, ipcMain, session, clipboard, powerSaveBlocker, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const QRCode = require('qrcode');
const { DEFAULTS, listNetworks, validateConfig, validatePreferences } = require('./config');
const { SettingsStore } = require('./settings-store');
const { CastServer } = require('./cast-server');
const { BroadcastSession } = require('./broadcast-session');
const { isLocalDocument } = require('./trusted-page');
const { createDisplayMediaHandler } = require('./display-media');

app.setName('LAN Screen Cast');
const dataDir = process.env.LAN_CAST_DATA_DIR || path.join(app.getPath('appData'), 'LAN Screen Cast');
app.setPath('userData', dataDir);
app.setPath('sessionData', path.join(dataDir, 'session'));
const hostFile = path.join(__dirname, 'renderer', 'index.html');
const settingsFile = path.join(dataDir, 'settings.json');
const settings = new SettingsStore(settingsFile, { defaults: DEFAULTS });
let window;
let selectedSource = null;
let selectedSystemAudio = false;
let captureRevision = 0;
let awake = null;
let allowClose = false, closeRequest = null, shutdownTask = null;
let activeInfo = null;
let routerQuery = null, routerRevision = 0;
const broadcast = new BroadcastSession(config => {
  const next = new CastServer(config, {
    binDir: app.isPackaged ? path.join(process.resourcesPath, 'media', 'bin') : path.join(__dirname, '..', 'vendor', 'media', 'bin'),
    tempRoot: path.join(dataDir, 'session', 'rtmp')
  });
  for (const type of ['viewer-joined', 'viewer-left', 'signal', 'viewers']) {
    next.on(type, payload => { if (broadcast.current === next || broadcast.pending === next) emit(type, payload); });
  }
  next.on('rtmp-state', payload => {
    if (broadcast.current !== next && broadcast.pending !== next && broadcast.retired !== next) return;
    if (activeInfo?.roomId === payload.roomId) activeInfo = { ...activeInfo, rtmp: payload };
    emit('rtmp-state', payload);
  });
  next.on('server-error', payload => {
    if (broadcast.current === next || broadcast.pending === next) { emit('error', payload); void stop().catch(reportStopFailure); }
  });
  return next;
});

function trusted(contents) { return !!window && contents === window.webContents && isLocalDocument(contents.getURL(), hostFile); }
function emit(type, payload) {
  if (window && !window.isDestroyed()) window.webContents.send('lan:event', { type, payload });
}
function reportStopFailure(error) { emit('stop-error', error.message); }

async function stop() {
  cancelRouterDetection();
  ++captureRevision;
  selectedSource = null;
  selectedSystemAudio = false;
  activeInfo = null;
  if (awake !== null) { powerSaveBlocker.stop(awake); awake = null; }
  await broadcast.stop();
}

function cancelRouterDetection() {
  ++routerRevision;
  routerQuery?.abort(); routerQuery = null;
}

async function detectRouter(host) {
  if (!listNetworks().some(network => network.address === host && !network.local)) throw new Error('请选择实际局域网网卡后再读取路由器。');
  cancelRouterDetection();
  const controller = new AbortController(); routerQuery = controller;
  const revision = routerRevision;
  const owner = broadcast.current;
  const sessionRevision = broadcast.revision;
  const { discoverRouterWan } = require('./router-discovery');
  try {
    const result = await discoverRouterWan({ host, signal: controller.signal });
    if (controller.signal.aborted || revision !== routerRevision || sessionRevision !== broadcast.revision
        || broadcast.current !== owner) return { supported: false, cancelled: true, message: '地址查询已取消。' };
    if (result.supported && owner?.config.host === host && owner.config.forwardingEnabled && owner.config.autoRouterAddress
        && owner.config.advertisedHost !== result.wanAddress) {
      const origin = new URL(`http://${result.wanAddress}:${owner.config.advertisedPort}/`).origin;
      const forwardedQr = await QRCode.toDataURL(`${origin}/#token=${owner.token}`, { width: 200, margin: 1, color: { dark: '#17354cff', light: '#ffffffff' } });
      if (controller.signal.aborted || revision !== routerRevision || sessionRevision !== broadcast.revision
          || broadcast.current !== owner) return { ...result, cancelled: true };
      const info = owner.updateAdvertisedHost(result.wanAddress);
      activeInfo = { ...activeInfo, ...info, localQr: activeInfo.localQr, forwardedQr, qr: forwardedQr };
      emit('session-info', { info: activeInfo, advertisedHost: result.wanAddress });
    }
    return result;
  } finally { if (routerQuery === controller) routerQuery = null; }
}

function finishClose() {
  if (shutdownTask) return shutdownTask;
  cancelRouterDetection();
  if (closeRequest) clearTimeout(closeRequest.timer);
  shutdownTask = (async () => {
    await stop();
    await settings.flush().catch(error => console.error('设置保存失败：', error.message));
    allowClose = true;
    if (window && !window.isDestroyed()) window.close(); else app.quit();
  })().catch(error => {
    shutdownTask = null; closeRequest = null;
    emit('close-error', `关闭失败：${error.message} 请稍后再次关闭窗口以重试。`);
    throw error;
  });
  return shutdownTask;
}

function requestClose() {
  if (closeRequest || allowClose) return;
  const id = randomUUID();
  closeRequest = { id, timer: setTimeout(() => { void finishClose().catch(() => {}); }, 2500) };
  // Network and capture ownership are released independently of file I/O.
  void stop().catch(reportStopFailure);
  emit('prepare-close', { requestId: id });
}

function handle(name, action) {
  ipcMain.handle(`lan:${name}`, async (event, ...args) => {
    if (!trusted(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('不允许此页面控制广播。');
    return action(...args);
  });
}

function setupIpc() {
  handle('get-networks', () => listNetworks());
  handle('get-sources', async type => {
    if (!['screen', 'window'].includes(type)) throw new Error('采集类型无效。');
    const sources = await desktopCapturer.getSources({ types: [type], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: type === 'window' });
    return sources.filter(source => !source.name.startsWith('LAN Screen Cast')).map(source => ({
      id: source.id, name: source.name, displayId: source.display_id,
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : ''
    }));
  });
  handle('select-source', async (id, config) => {
    // A failed native exit remains owned. A user's next start retries cleanup
    // before opening another capture or accepting any new viewers.
    if (broadcast.retired) await stop();
    if (broadcast.current || broadcast.busy) throw new Error('广播期间不能更改采集源。');
    const captureConfig = validateConfig(config);
    if (typeof id !== 'string' || id.length > 200) throw new Error('请选择屏幕或窗口。');
    const revision = ++captureRevision;
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (revision !== captureRevision || !window || window.isDestroyed()) throw new Error('采集选择已取消。');
    if (!sources.some(item => item.id === id)) throw new Error('所选窗口已关闭，请刷新采集源。');
    selectedSource = id;
    selectedSystemAudio = captureConfig.systemAudio;
    window.webContents.setWebRTCUDPPortRange({ min: config.udpMin, max: config.udpMax });
    window.webContents.setWebRTCIPHandlingPolicy('default');
  });
  handle('start', async input => {
    if (broadcast.current || broadcast.busy) throw new Error('广播已经启动或正在回收。');
    if (!selectedSource) throw new Error('请先选择采集源。');
    const config = validateConfig(input);
    const result = await broadcast.start(config, async info => {
      const options = { width: 200, margin: 1, color: { dark: '#17354cff', light: '#ffffffff' } };
      const [localQr, forwardedQr] = await Promise.all([
        QRCode.toDataURL(info.localInviteUrl || info.inviteUrl, options),
        info.forwardedInviteUrl ? QRCode.toDataURL(info.forwardedInviteUrl, options) : null
      ]);
      return { ...info, localQr, forwardedQr, qr: forwardedQr || localQr };
    });
    if (!broadcast.current || broadcast.current.roomId !== result.roomId || !selectedSource) throw new Error('广播启动已取消。');
    activeInfo = result;
    awake = powerSaveBlocker.start('prevent-display-sleep');
    return result;
  });
  handle('stop', stop);
  handle('signal', (peerId, signal) => broadcast.current?.sendSignal(peerId, signal));
  handle('kick', peerId => { if (typeof peerId === 'string') return broadcast.current?.kick(peerId); });
  handle('begin-rtmp', request => {
    const owner = broadcast.current;
    if (!request || !owner || request.roomId !== owner.roomId) throw new Error('RTMP 广播会话已失效。');
    return owner.beginRtmp({ mimeType: request.mimeType });
  });
  handle('append-rtmp', request => {
    if (!broadcast.current?.rtmp) throw new Error('RTMP 广播会话已失效。');
    return broadcast.current.rtmp.append(request);
  });
  handle('finish-rtmp', request => {
    if (!broadcast.current?.rtmp) return;
    return broadcast.current.rtmp.finish(request);
  });
  handle('retry', (peerId, reason) => {
    if (typeof peerId !== 'string' || peerId.length > 64 || !['timeout', 'negotiation', 'failed'].includes(reason)) throw new Error('媒体重试请求无效。');
    broadcast.current?.retry(peerId, reason);
  });
  handle('copy', text => {
    if (typeof text !== 'string' || text.length > 2048) throw new Error('复制内容无效。');
    clipboard.writeText(text);
  });
  handle('get-settings', async () => {
    const saved = await settings.load();
    try { return validatePreferences(saved); } catch { return { ...DEFAULTS }; }
  });
  handle('save-settings', input => settings.save(validatePreferences(input)));
  handle('detect-router', detectRouter);
  handle('cancel-router-detection', cancelRouterDetection);
  handle('ready-to-close', async requestId => {
    if (!closeRequest || closeRequest.id !== requestId) throw new Error('关闭请求已失效。');
    await finishClose();
  });
}

app.whenReady().then(async () => {
  await fs.mkdir(path.join(dataDir, 'session'), { recursive: true });
  Menu.setApplicationMenu(null);
  setupIpc();
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (!trusted(contents)) return false;
    if (permission === 'display-capture') return !!selectedSource;
    return permission === 'media' && details.mediaType !== 'video';
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allow = trusted(contents) && (permission === 'display-capture' ? !!selectedSource :
      permission === 'media' && (details.mediaTypes || []).every(type => type === 'audio'));
    callback(allow);
  });
  ses.setDisplayMediaRequestHandler(createDisplayMediaHandler({
    getSelection: () => selectedSource && window && !window.isDestroyed() && trusted(window.webContents)
      ? {id: selectedSource, revision: captureRevision, audioAllowed: selectedSystemAudio, frame: window.webContents.mainFrame} : null,
    getSources: () => desktopCapturer.getSources({types: ['screen', 'window'], thumbnailSize: {width: 0, height: 0}})
  }));
  window = new BrowserWindow({
    width: 1250, height: 900, minWidth: 1024, minHeight: 720,
    title: 'LAN Screen Cast · 局域网投屏', backgroundColor: '#edf3f8',
    icon: path.join(__dirname, '../assets/icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!isLocalDocument(url, hostFile)) event.preventDefault(); });
  window.webContents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isInPlace) void stop().catch(reportStopFailure);
  });
  window.webContents.on('render-process-gone', () => { void stop().catch(reportStopFailure); });
  window.on('close', event => { if (!allowClose) { event.preventDefault(); requestClose(); } });
  window.on('closed', () => { window = null; void stop().catch(reportStopFailure); });
  await window.loadFile(hostFile);
}).catch(error => { console.error(error); app.quit(); });

app.on('before-quit', event => {
  if (window && !allowClose) { event.preventDefault(); requestClose(); }
});
app.on('window-all-closed', () => app.quit());
