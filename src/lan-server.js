const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomBytes, randomInt, randomUUID, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { isUnicastIPv4 } = require('./shared/network.mjs');
const { AudienceRegistry } = require('./audience');

const MAX_MESSAGE = 96 * 1024;
const RETRY_MESSAGES = new Map([
  ['timeout', '媒体连接超时，正在重试。一级网络观看请检查 UDP 端口转发和校园网设备互访限制。'],
  ['negotiation', '媒体协商失败，正在重试。请检查 UDP 端口转发和校园网设备互访限制。'],
  ['failed', '媒体连接已中断，正在重试。请检查网络和 UDP 端口转发。']
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const PUBLIC_FILES = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/viewer.js', 'viewer.js'], ['/viewer.css', 'viewer.css'],
  ['/rtc.js', '../shared/rtc.js'], ['/receiver-session.mjs', 'receiver-session.mjs'], ['/invitation.mjs', 'invitation.mjs']]);

function equalSecret(input, expected) {
  if (typeof input !== 'string') return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validSignal(message, types) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || !types.includes(message.type)) return false;
  if (message.type === 'restart') return true;
  if (typeof message.generation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.generation)) return false;
  if (message.type === 'candidate') {
    return !!(message.candidate === null || (message.candidate && typeof message.candidate === 'object' && !Array.isArray(message.candidate) &&
      typeof message.candidate.candidate === 'string' && message.candidate.candidate.length < 4096 &&
      (message.candidate.sdpMid == null || (typeof message.candidate.sdpMid === 'string' && message.candidate.sdpMid.length <= 128)) &&
      (message.candidate.sdpMLineIndex == null || (Number.isInteger(message.candidate.sdpMLineIndex) && message.candidate.sdpMLineIndex >= 0 && message.candidate.sdpMLineIndex <= 63)) &&
      (message.candidate.usernameFragment == null || (typeof message.candidate.usernameFragment === 'string' && message.candidate.usernameFragment.length <= 256))));
  }
  return !!(message.sdp && typeof message.sdp === 'object' && !Array.isArray(message.sdp) && message.sdp.type === message.type &&
    typeof message.sdp.sdp === 'string' && message.sdp.sdp.length > 0 && message.sdp.sdp.length < 90000);
}

function cleanSignal(message) {
  if (message.type === 'restart') return { type: 'restart' };
  const result = { type: message.type, generation: message.generation };
  if (message.type !== 'candidate') result.sdp = { type: message.sdp.type, sdp: message.sdp.sdp };
  else if (message.candidate === null) result.candidate = null;
  else {
    result.candidate = { candidate: message.candidate.candidate };
    for (const field of ['sdpMid', 'sdpMLineIndex', 'usernameFragment']) {
      if (message.candidate[field] !== undefined) result.candidate[field] = message.candidate[field];
    }
  }
  return result;
}

class LanServer extends EventEmitter {
  constructor(config, { staticDir = path.join(__dirname, 'viewer'), audience = new AudienceRegistry(config.maxViewers) } = {}) {
    super();
    this.config = config;
    this.staticDir = staticDir;
    this.peers = new Map();
    this.audience = audience;
    audience.on('joined', viewer => { if (viewer.protocol === 'rtmp') this.emit('viewer-joined', viewer); });
    audience.on('left', viewer => { if (viewer.protocol === 'rtmp') this.emit('viewer-left', viewer); });
    audience.on('changed', viewers => this.emit('viewers', viewers));
    this.failures = new Map();
    this.server = null;
    this.wss = null;
    this.stopping = false;
    this.sockets = new Set();
    this.stopTask = null;
    this.allowedHosts = new Set();
    this.allowedOrigins = new Set();
  }

  get viewers() {
    return this.audience.viewers;
  }

  async start() {
    if (this.server) throw new Error('广播服务已经启动。');
    if (this.config.forwardingEnabled === true && (!isUnicastIPv4(this.config.advertisedHost) ||
      !Number.isInteger(this.config.advertisedPort) || this.config.advertisedPort < 1 || this.config.advertisedPort > 65535)) {
      throw new Error('一级网络地址或端口无效，需要普通单播 IPv4 和有效 TCP 端口。');
    }
    this.stopping = false;
    this.stopTask = null;
    this.token = randomBytes(24).toString('base64url');
    this.pin = String(randomInt(0, 1000000)).padStart(6, '0');
    this.roomId = randomUUID();
    this.failures.clear();
    const server = http.createServer((req, res) => this.handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('页面读取失败');
    }));
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.maxConnections = 160;
    this.server = server;
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    server.on('upgrade', (req, socket, head) => {
      if (this.stopping || req.url !== '/signal' || !this.validHost(req) || !this.allowedOrigins.has(req.headers.origin) || this.wss.clients.size >= 96) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.config.port, this.config.host, () => { server.removeListener('error', reject); resolve(); });
      });
    } catch (error) {
      this.wss.close();
      this.wss = null;
      this.server = null;
      if (error.code === 'EADDRINUSE') throw new Error('网页端口已被占用，请选择其他端口。');
      if (error.code === 'EADDRNOTAVAIL') throw new Error('网卡地址已不可用，请刷新网络列表。');
      throw new Error(`无法启动局域网服务：${error.message}`);
    }
    const port = server.address().port;
    this.origin = new URL(`http://${this.config.host}:${port}/`).origin;
    const forwardedOrigin = this.config.forwardingEnabled === true ? new URL(`http://${this.config.advertisedHost}:${this.config.advertisedPort}/`).origin : '';
    this.allowedOrigins = new Set([this.origin, ...(forwardedOrigin ? [forwardedOrigin] : [])]);
    this.allowedHosts = new Set(Array.from(this.allowedOrigins, origin => new URL(origin).host));
    server.on('error', error => this.emit('server-error', error.message));
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss?.clients || []) {
        if (!ws.alive) { ws.terminate(); continue; }
        ws.alive = false;
        ws.ping();
      }
      const now = Date.now();
      for (const [address, failure] of this.failures) if (now - failure.since > 60000) this.failures.delete(address);
    }, 10000);
    this.heartbeat.unref();
    return this.getSessionInfo();
  }

  getSessionInfo() {
    const port = this.server.address().port;
    const forwardedOrigin = this.config.forwardingEnabled === true
      ? new URL(`http://${this.config.advertisedHost}:${this.config.advertisedPort}/`).origin : '';
    const localUrl = `${this.origin}/`;
    const forwardedUrl = forwardedOrigin ? `${forwardedOrigin}/` : '';
    const localInviteUrl = `${localUrl}#token=${this.token}`;
    const forwardedInviteUrl = forwardedUrl ? `${forwardedUrl}#token=${this.token}` : '';
    return { port, host: this.config.host, token: this.token, pin: this.pin, roomId: this.roomId,
      localUrl, localInviteUrl, forwardedUrl, forwardedInviteUrl,
      url: forwardedUrl || localUrl, inviteUrl: forwardedInviteUrl || localInviteUrl };
  }

  updateAdvertisedHost(address) {
    if (!this.server?.listening || this.stopping || !this.config.forwardingEnabled) throw new Error('当前广播无法更新一级网络地址。');
    if (!isUnicastIPv4(address)) throw new Error('路由器 WAN 地址无效。');
    this.config = { ...this.config, advertisedHost: address };
    const forwardedOrigin = new URL(`http://${address}:${this.config.advertisedPort}/`).origin;
    this.allowedOrigins = new Set([this.origin, forwardedOrigin]);
    this.allowedHosts = new Set(Array.from(this.allowedOrigins, origin => new URL(origin).host));
    return this.getSessionInfo();
  }

  validHost(req) { return this.allowedHosts.has(req.headers.host); }

  async handleHttp(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), display-capture=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!this.validHost(req)) { res.writeHead(403); res.end('Host 不匹配'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const route = new URL(req.url, this.origin).pathname;
    if (route === '/api/status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ roomName: this.config.roomName, roomId: this.roomId, viewers: this.audience.size, maxViewers: this.config.maxViewers }));
      return;
    }
    const file = PUBLIC_FILES.get(route);
    if (!file) { res.writeHead(404); res.end('页面不存在'); return; }
    let body;
    try { body = await fs.readFile(path.join(this.staticDir, file)); }
    catch { res.writeHead(404); res.end('页面不存在'); return; }
    res.setHeader('Content-Type', MIME[path.extname(file)]);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  send(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify(data));
  }

  deny(ws, code, message) {
    this.send(ws, { type: 'error', code, message });
    ws.close(1008, code);
  }

  handleConnection(ws, req) {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    let peer = null;
    const address = req.socket.remoteAddress;
    const joinTimeout = setTimeout(() => this.deny(ws, 'TIMEOUT', '连接超时，请重新观看。'), 10000);
    joinTimeout.unref();
    let messages = 0;
    let windowStart = Date.now();
    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - windowStart > 1000) { messages = 0; windowStart = Date.now(); }
      if (++messages > 120) { this.deny(ws, 'RATE', '消息过于频繁。'); return; }
      if (isBinary) { this.deny(ws, 'INVALID', '连接消息无效。'); return; }
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { this.deny(ws, 'INVALID', '连接消息无效。'); return; }
      if (!peer) {
        if (message?.type !== 'join') { this.deny(ws, 'AUTH', '请先输入观看码。'); return; }
        const previous = this.failures.get(address);
        if (previous && Date.now() - previous.since < 60000 && previous.count >= 8) {
          this.deny(ws, 'RATE', '观看码尝试过多，请稍后再试。'); return;
        }
        if (!equalSecret(message.token, this.token) && !equalSecret(message.pin, this.pin)) {
          const failure = previous && Date.now() - previous.since < 60000 ? previous : { count: 0, since: Date.now() };
          failure.count++;
          this.failures.set(address, failure);
          this.deny(ws, 'AUTH', '观看码不正确或链接已过期。'); return;
        }
        if (this.stopping) { this.deny(ws, 'ENDED', '广播已结束。'); return; }
        const id = randomUUID();
        const name = typeof message.name === 'string' ? message.name : '观看设备';
        if (!this.audience.admit(id, { name, address, protocol: 'webrtc' })) { this.deny(ws, 'FULL', '观看人数已满，请稍后再试。'); return; }
        clearTimeout(joinTimeout);
        peer = { ...this.audience.get(id), ws };
        this.peers.set(peer.id, peer);
        this.send(ws, { type: 'joined', peerId: peer.id, roomId: this.roomId, roomName: this.config.roomName });
        this.emit('viewer-joined', { id: peer.id, protocol: 'webrtc' });
      } else {
        if (!validSignal(message, ['answer', 'candidate', 'restart'])) { this.deny(ws, 'INVALID', '信令消息无效。'); return; }
        this.emit('signal', { ...cleanSignal(message), peerId: peer.id });
      }
    });
    ws.on('close', () => {
      clearTimeout(joinTimeout);
      if (peer) clearTimeout(peer.closeTimeout);
      if (peer && this.peers.delete(peer.id)) {
        this.emit('viewer-left', { id: peer.id });
        this.audience.remove(peer.id);
      }
    });
  }

  sendSignal(peerId, signal) {
    const peer = this.peers.get(peerId);
    if (peer && validSignal(signal, ['offer', 'candidate'])) this.send(peer.ws, cleanSignal(signal));
  }

  kick(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.send(peer.ws, { type: 'kicked', message: '广播端已断开此设备。' });
    peer.ws.close(1008, 'KICKED');
  }

  retry(peerId, reason) {
    const message = RETRY_MESSAGES.get(reason);
    const peer = this.peers.get(peerId);
    if (!message || !peer) return false;
    this.send(peer.ws, { type: 'error', code: 'RETRY', message });
    this.peers.delete(peer.id);
    this.emit('viewer-left', { id: peer.id });
    this.audience.remove(peer.id);
    peer.ws.close(1013, 'RETRY');
    peer.closeTimeout = setTimeout(() => peer.ws.terminate(), 1000);
    peer.closeTimeout.unref();
    return true;
  }

  async stop() {
    if (this.stopping) return this.stopTask;
    if (!this.server) return;
    this.stopping = true;
    this.stopTask = this.closeServer();
    return this.stopTask;
  }

  async closeServer() {
    clearInterval(this.heartbeat);
    const server = this.server;
    const wss = this.wss;
    for (const ws of wss.clients) { this.send(ws, { type: 'ended' }); ws.close(1001, 'ENDED'); }
    const forceClose = setTimeout(() => {
      for (const ws of wss.clients) ws.terminate();
      for (const socket of this.sockets) socket.destroy();
    }, 250);
    forceClose.unref();
    server.closeIdleConnections();
    await Promise.all([
      new Promise(resolve => wss.close(resolve)),
      new Promise(resolve => server.close(resolve))
    ]);
    clearTimeout(forceClose);
    for (const id of this.peers.keys()) this.audience.remove(id);
    this.peers.clear();
    this.sockets.clear();
    this.server = null;
    this.wss = null;
    this.emit('viewers', this.viewers);
  }
}

module.exports = { LanServer, validSignal };
