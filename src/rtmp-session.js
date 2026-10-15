const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME_MODES = new Map([
  ['video/x-matroska;codecs=avc1,opus', 'copy'],
  ['video/webm;codecs=vp8,opus', 'transcode'],
]);

function equalSecret(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const input = Buffer.from(value), secret = Buffer.from(expected);
  return input.length === secret.length && timingSafeEqual(input, secret);
}

function normalizeAddress(value) {
  return typeof value === 'string' ? value.replace(/^::ffff:/i, '') : '';
}

function cancelled() { return new Error('RTMP 启动或传输已取消。'); }
async function settlesWithin(promise, ms) {
  let timer;
  try { return await Promise.race([promise.then(() => true, () => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

async function allocateLoopbackPort(signal) {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, port) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      server.removeListener('error', onError);
      try { server.close(() => error ? reject(error) : resolve(port)); }
      catch { error ? reject(error) : resolve(port); }
    };
    const abort = () => done(cancelled());
    const onError = error => done(error);
    server.once('error', onError);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    server.listen({ host: '127.0.0.1', port: 0, signal }, () => done(null, server.address().port));
  });
}

function requestJson(url, { method = 'GET', authorization, timeoutMs = 1500, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, signal, agent: false,
      headers: authorization ? { Authorization: authorization } : {} }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_HTTP_BYTES) request.destroy(new Error('RTMP 控制响应过大。'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('RTMP 控制响应已中断。')));
      response.once('close', () => { if (!response.complete) reject(new Error('RTMP 控制响应未完成。')); });
      response.once('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`RTMP 控制接口返回 ${response.statusCode}。`);
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { reject(new Error('RTMP 控制响应无效。')); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('RTMP 控制接口超时。')));
    request.once('error', reject);
    request.end();
  });
}

// Owns only the native processes and credentials created for this broadcast.
// The renderer feeds one continuous recorder container and keeps its stream.
class RtmpSession extends EventEmitter {
  constructor(config, { audience, binDir = path.join(__dirname, '..', 'vendor', 'media', 'bin'),
    tempRoot = os.tmpdir(), dependencies = {}, timings = {} } = {}) {
    super();
    this.config = { ...config };
    this.audience = audience;
    if (config.rtmpEnabled !== false && (!audience || typeof audience.admit !== 'function' || typeof audience.remove !== 'function')) {
      throw new Error('RTMP 需要共享观看人数管理器。');
    }
    this.binDir = path.resolve(binDir);
    this.tempRoot = path.resolve(tempRoot);
    this.dependencies = { fs, spawn, requestJson, allocateLoopbackPort, now: Date.now, ...dependencies };
    this.timings = { pollMs: 500, prepareTimeoutMs: 10000, mediaTimeoutMs: 15000,
      monitorTimeoutMs: 4000, authTimeoutMs: 10000, writeTimeoutMs: 3000,
      requestTimeoutMs: 1500, terminateMs: 600, killMs: 900, ...timings };
    this.enabled = config.rtmpEnabled !== false;
    this.phase = this.enabled ? 'preparing' : 'stopped';
    this.message = this.enabled ? '正在准备 RTMP 服务。' : 'RTMP 已关闭。';
    this.closed = false;
    this.abort = new AbortController();
    this.ownedProcesses = new Set();
    this.reservations = new Map();
    this.authSockets = new Set();
    this.logs = new Map();
    this.sequence = 0;
    this.uploadMbps = 0;
  }

  getInfo() {
    const usable = this.enabled && !!this.streamPath && !['stopped', 'error'].includes(this.phase);
    return { enabled: this.enabled, phase: this.phase, message: this.message,
      localUrl: usable ? `rtmp://${this.config.host}:${this.config.rtmpPort}/${this.streamPath}` : '',
      forwardedUrl: usable && this.config.forwardingEnabled === true && this.config.advertisedHost ?
        `rtmp://${this.config.advertisedHost}:${this.config.advertisedRtmpPort}/${this.streamPath}` : '',
      codec: `${(this.encoderInfo?.codec || this.config.rtmpCodec) === 'HEVC' ? 'HEVC' : 'H.264'}${this.config.systemAudio || this.config.microphone ? ' / AAC' : ''}`,
      encoder: this.encoderInfo?.encoder || '', hardware: this.encoderInfo?.hardware ?? null,
      uploadMbps: this.uploadMbps };
  }

  _state(phase, message) {
    this.phase = phase;
    this.message = message;
    this.emit('state', this.getInfo());
  }

  _assertOpen() { if (this.closed || this.abort.signal.aborted) throw cancelled(); }

  prepare() {
    if (!this.enabled) return Promise.resolve(this.getInfo());
    if (this.prepareTask) return this.prepareTask;
    if (this.closed) return Promise.reject(cancelled());
    this.prepareTask = this._prepare();
    return this.prepareTask;
  }

  async _prepare() {
    try {
      this._state('preparing', '正在准备 RTMP 服务。');
      const { fs: files } = this.dependencies;
      await files.access(path.join(this.binDir, 'mediamtx.exe'));
      await files.access(path.join(this.binDir, 'ffmpeg.exe'));
      this._assertOpen();
      await files.mkdir(this.tempRoot, { recursive: true });
      this.directory = await files.mkdtemp(path.join(this.tempRoot, 'lan-cast-rtmp-'));
      this._assertOpen();
      this.streamPath = `live/${randomBytes(24).toString('base64url')}`;
      this.publisherPassword = randomBytes(32).toString('base64url');
      this.controlPassword = randomBytes(32).toString('base64url');
      this.authPath = `/authorize/${randomBytes(32).toString('base64url')}`;
      await this._startAuthServer();
      this._assertOpen();
      this.apiPort = await this.dependencies.allocateLoopbackPort(this.abort.signal);
      this._assertOpen();
      const configuration = {
        logLevel: 'warn', logDestinations: ['stdout'], readTimeout: '5s', writeTimeout: '3s', writeQueueSize: 256,
        authMethod: 'http', authHTTPAddress: `http://127.0.0.1:${this.authServer.address().port}${this.authPath}`,
        authHTTPExclude: [], authInternalUsers: [],
        api: true, apiAddress: `127.0.0.1:${this.apiPort}`, apiAllowOrigins: [],
        metrics: false, pprof: false, playback: false,
        rtsp: false, rtmp: true, rtmpAddress: `${this.config.host}:${this.config.rtmpPort}`,
        rtmpEncryption: 'no', rtmpTrustedProxies: [],
        hls: false, webrtc: false, srt: false, moq: false,
        pathDefaults: { source: 'publisher', overridePublisher: false, maxReaders: this.config.maxViewers,
          record: false, alwaysAvailable: false },
        paths: { [this.streamPath]: {} },
      };
      this.configPath = path.join(this.directory, 'mediamtx.yml');
      await files.writeFile(this.configPath, JSON.stringify(configuration, null, 2), { encoding: 'utf8', mode: 0o600 });
      this._assertOpen();
      this.mediaServer = this._spawn('mediamtx', [this.configPath]);
      const deadline = this.dependencies.now() + this.timings.prepareTimeoutMs;
      while (true) {
        this._assertOpen();
        try {
          const info = await this._api('/v3/info');
          if (info.version !== 'v1.21.2' && info.version !== '1.21.2') throw new Error('RTMP 服务版本不匹配。');
          await this._pollSnapshot();
          break;
        } catch (error) {
          this._assertOpen();
          if (this.dependencies.now() >= deadline) throw error;
          await this._pause(100);
        }
      }
      this._assertOpen();
      this.monitorSuccessAt = this.dependencies.now();
      this._state('waiting', 'RTMP 服务已准备，等待录制画面。');
      this.pollTimer = setInterval(() => { this._poll().catch(error => this._fail(error.message)); }, this.timings.pollMs);
      this.pollTimer.unref();
      return this.getInfo();
    } catch (error) {
      if (!this.closed) await this._fail(`RTMP 服务准备失败：${this._clean(error.message)}`);
      else await this._cleanup();
      throw error;
    }
  }

  async _startAuthServer() {
    const server = http.createServer((request, response) => this._handleAuth(request, response));
    this.authServer = server;
    server.requestTimeout = 2000;
    server.headersTimeout = 2000;
    server.maxConnections = 32;
    server.on('connection', socket => {
      this.authSockets.add(socket);
      socket.once('close', () => this.authSockets.delete(socket));
    });
    server.on('error', error => { if (!this.closed && server.listening) this._fail(`RTMP 认证服务失败：${this._clean(error.message)}`); });
    await new Promise((resolve, reject) => {
      const cancel = () => { server.close(); reject(cancelled()); };
      this.abort.signal.addEventListener('abort', cancel, { once: true });
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, signal: this.abort.signal }, () => {
        this.abort.signal.removeEventListener('abort', cancel);
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  _handleAuth(request, response) {
    const deny = () => { if (!response.writableEnded) { response.writeHead(403); response.end(); } };
    if (this.closed || request.method !== 'POST' || !equalSecret(request.url, this.authPath) ||
      normalizeAddress(request.socket.remoteAddress) !== '127.0.0.1') return deny();
    const chunks = [];
    let length = 0, rejected = false;
    request.on('data', chunk => {
      length += chunk.length;
      if (length > 8192) { rejected = true; deny(); request.destroy(); }
      else chunks.push(chunk);
    });
    request.once('error', deny);
    request.once('end', () => {
      if (rejected || this.closed) return deny();
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return deny(); }
      if (!this._authorize(input)) return deny();
      response.writeHead(204);
      response.end();
    });
  }

  _authorize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || this.closed) return false;
    const address = normalizeAddress(input.ip);
    if (input.action === 'api') return address === '127.0.0.1' && input.user === 'control' &&
      equalSecret(input.password, this.controlPassword);
    if (input.protocol !== 'rtmp' || !equalSecret(input.path, this.streamPath) || !UUID.test(input.id || '')) return false;
    if (input.action === 'publish') {
      if (!this.generation || address !== this.config.host || input.user !== 'publisher' ||
        !equalSecret(input.password, this.publisherPassword) || (this.publisherId && this.publisherId !== input.id)) return false;
      this.publisherId = input.id;
      return true;
    }
    if (input.action !== 'read' || this.phase !== 'ready') return false;
    const id = `rtmp:${input.id}`;
    if (this.reservations.has(id)) return this.audience.has(id);
    if (!this.audience.admit(id, { name: 'RTMP 播放器', address, protocol: 'rtmp' })) return false;
    this.reservations.set(id, { authorizedAt: this.dependencies.now(), confirmed: false });
    return true;
  }

  _ownProcess(child) {
    this.ownedProcesses.add(child);
    child.done = new Promise(resolve => {
      const exited = () => {
        child.rtmpExited = true; this.ownedProcesses.delete(child); resolve(); this._releaseReservationsIfServerExited();
      };
      child.once('exit', exited);
      child.once('close', exited);
      child.once('error', () => { if (!child.pid) exited(); });
    });
    return child;
  }

  _spawn(name, args) {
    this._assertOpen();
    const child = this._ownProcess(this.dependencies.spawn(path.join(this.binDir, `${name}.exe`), args,
      { cwd: this.directory, shell: false, windowsHide: true, stdio: [name === 'ffmpeg' ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    this.logs.set(name, '');
    const log = chunk => this.logs.set(name, (this.logs.get(name) + this._clean(chunk.toString())).slice(-1800));
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    child.stdin?.on('error', () => {});
    child.once('error', error => { if (!this.closed) this._fail(`RTMP ${name} 无法启动：${this._clean(error.message)}`); });
    child.once('exit', code => {
      if (!this.closed) this._fail(`RTMP ${name} 已退出（${code ?? '终止'}）。${this.logs.get(name).trim()}`);
    });
    return child;
  }

  async begin(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.mimeType !== 'string') throw new Error('RTMP 录制格式无效。');
    const mimeType = input.mimeType.toLowerCase().replace(/\s/g, '');
    if (!MIME_MODES.has(mimeType)) throw new Error('RTMP 录制格式不受支持。');
    if (this.beginning || this.generation) throw new Error('RTMP 录制已经开始。');
    this.beginning = true;
    try {
      await this.prepare();
      this._assertOpen();
      if (!this.enabled || this.phase !== 'waiting') throw new Error('RTMP 服务当前不可用。');
      this._state('starting', '正在检测 RTMP 视频编码器。');
      const selectEncoder = this.dependencies.selectEncoder || require('./rtmp-encoder').selectRtmpEncoder;
      this.encoderInfo = await selectEncoder(this.config, { ffmpegPath: path.join(this.binDir, 'ffmpeg.exe'), signal: this.abort.signal,
        onProcess: child => this._ownProcess(child) });
      this._assertOpen();
      this.generation = randomUUID();
      this.sequence = 0;
      this.mediaStartedAt = this.dependencies.now();
      this.publisherId = null;
      this.publishUrl = `rtmp://${this.config.host}:${this.config.rtmpPort}/${this.streamPath}?user=publisher&pass=${this.publisherPassword}`;
      const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-fflags', '+genpts',
        '-probesize', '262144', '-analyzeduration', '1000000', '-f', 'matroska', '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0?'];
      args.push(...this.encoderInfo.args);
      args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-af', 'aresample=async=1:first_pts=0', '-flvflags', 'no_duration_filesize',
        '-flush_packets', '1', '-f', 'flv', this.publishUrl);
      this._state('starting', `正在生成 RTMP：${this.encoderInfo.label}${this.config.systemAudio || this.config.microphone ? ' / AAC' : ''}。`);
      this.encoder = this._spawn('ffmpeg', args);
      return { generation: this.generation };
    } catch (error) {
      if (!this.closed) await this._fail(`RTMP 录制启动失败：${this._clean(error.message)}`);
      throw error;
    } finally { this.beginning = false; }
  }

  async append(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.generation !== 'string' ||
      !this.generation || input.generation !== this.generation || this.closed) throw new Error('RTMP 录制会话已失效。');
    let reason;
    if (!Number.isSafeInteger(input.sequence) || input.sequence !== this.sequence) reason = 'RTMP 录制分片顺序无效。';
    else if (!(input.bytes instanceof Uint8Array) || !input.bytes.byteLength || input.bytes.byteLength > MAX_CHUNK_BYTES) reason = 'RTMP 录制分片大小或类型无效。';
    else if (this.pendingWrite) reason = 'RTMP 录制写入重叠，已停止该流。';
    else if (!this.encoder?.stdin || this.encoder.stdin.destroyed) reason = 'RTMP 录制管道已关闭。';
    if (reason) { await this._fail(reason); throw new Error(reason); }
    const generation = this.generation, sequence = input.sequence;
    const bytes = Buffer.from(input.bytes);
    const stream = this.encoder.stdin;
    try {
      await new Promise((resolve, reject) => {
        let complete = false, callbackDone = false, returnKnown = false, needsDrain = false, drained = false;
        const finish = error => {
          if (complete) return;
          complete = true;
          clearTimeout(timer);
          stream.removeListener('drain', onDrain);
          stream.removeListener('error', onError);
          stream.removeListener('close', onClose);
          this.pendingWrite = null;
          error ? reject(error) : resolve();
        };
        const check = () => { if (returnKnown && callbackDone && (!needsDrain || drained)) finish(); };
        const onDrain = () => { drained = true; check(); };
        const onError = () => finish(new Error('RTMP 录制管道写入失败。'));
        const onClose = () => finish(new Error('RTMP 录制管道已关闭。'));
        const timer = setTimeout(() => finish(new Error('RTMP 写入超过 3 秒，已停止该流。')), this.timings.writeTimeoutMs);
        this.pendingWrite = { reject: () => finish(cancelled()) };
        stream.on('drain', onDrain);
        stream.once('error', onError);
        stream.once('close', onClose);
        try {
          needsDrain = !stream.write(bytes, error => { if (error) onError(); else { callbackDone = true; check(); } });
          returnKnown = true;
          check();
        } catch { onError(); }
      });
      this._assertOpen();
      if (generation !== this.generation) throw cancelled();
      ++this.sequence;
      return { generation, sequence };
    } catch (error) {
      if (!this.closed) await this._fail(error.message);
      throw error;
    }
  }

  async finish(input) {
    if (!input || typeof input.generation !== 'string' || input.generation !== this.generation) {
      if (input?.generation && input.generation === this.finishedGeneration) return this.getInfo();
      throw new Error('RTMP 录制会话已失效。');
    }
    if (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 1000)) throw new Error('RTMP 结束原因无效。');
    this.finishedGeneration = this.generation;
    if (input.message) await this._fail(`RTMP 已停止：${this._clean(input.message)}`);
    else await this.stop();
    return this.getInfo();
  }

  async _api(route, method = 'GET') {
    this._assertOpen();
    return this.dependencies.requestJson(`http://127.0.0.1:${this.apiPort}${route}`, {
      method, authorization: `Basic ${Buffer.from(`control:${this.controlPassword}`).toString('base64')}`,
      timeoutMs: this.timings.requestTimeoutMs, signal: this.abort.signal,
    });
  }

  async _connections() {
    const items = [];
    for (let page = 0; page < 4; ++page) {
      const result = await this._api(`/v3/rtmp/conns/list?itemsPerPage=256&page=${page}`);
      if (!result || !Array.isArray(result.items) || !Number.isInteger(result.pageCount) || result.pageCount < 0 || result.pageCount > 4) {
        throw new Error('RTMP 连接列表无效或过大。');
      }
      items.push(...result.items);
      if (page + 1 >= result.pageCount) return items;
    }
    throw new Error('RTMP 连接列表过大。');
  }

  async _pollSnapshot() {
    const [connections, paths] = await Promise.all([this._connections(), this._api('/v3/paths/list?itemsPerPage=16')]);
    if (!paths || !Array.isArray(paths.items)) throw new Error('RTMP 媒体路径列表无效。');
    this._assertOpen();
    const byId = new Map(connections.map(item => [`rtmp:${item.id}`, item]));
    for (const [id, reservation] of this.reservations) {
      let connection = byId.get(id);
      if (!connection && (reservation.confirmed || this.dependencies.now() - reservation.authorizedAt >= this.timings.authTimeoutMs)) {
        try { connection = await this._api(`/v3/rtmp/conns/get/${encodeURIComponent(id.slice(5))}`); }
        catch (error) {
          if (error.statusCode === 404) { this.reservations.delete(id); this.audience.remove(id); continue; }
          throw error;
        }
      }
      if (connection?.state === 'read' && connection.path === this.streamPath) reservation.confirmed = true;
      else if (connection && this.dependencies.now() - reservation.authorizedAt >= this.timings.authTimeoutMs) await this.kick(id);
    }
    for (const connection of connections) {
      if (connection.state === 'read' && connection.path === this.streamPath && !this.reservations.has(`rtmp:${connection.id}`)) {
        await this._api(`/v3/rtmp/conns/kick/${encodeURIComponent(connection.id)}`, 'POST');
      }
    }
    const currentPath = paths.items.find(item => item.name === this.streamPath);
    const tracks = currentPath?.tracks2?.map(track => track.codec) || currentPath?.tracks || [];
    const online = currentPath && (currentPath.online === true || currentPath.ready === true || currentPath.available === true);
    if (this.generation && online) {
      const expectedCodec = this.encoderInfo?.codec === 'HEVC' ? 'H265' : 'H264';
      if (!tracks.includes(expectedCodec)) throw new Error('RTMP 媒体没有所选格式的视频。');
      if ((this.config.microphone === true || this.config.systemAudio === true) && !tracks.includes('MPEG-4 Audio')) {
        throw new Error('RTMP 媒体没有可用的 AAC 音频。');
      }
      if (this.phase === 'starting') this._state('ready', `RTMP 可用：${this.encoderInfo.label}${this.config.systemAudio || this.config.microphone ? ' / AAC' : ''}。`);
    } else if (this.generation && this.phase === 'ready') throw new Error('RTMP 媒体发布已中断。');
    this._updateUpload(connections);
  }

  _updateUpload(connections) {
    const now = this.dependencies.now();
    const counters = new Map(connections.filter(item => item.state === 'read' && item.path === this.streamPath)
      .map(item => [item.id, Number(item.outboundBytes ?? item.bytesSent ?? 0)]));
    let bytes = 0;
    if (this.previousCounters && now > this.previousCounterAt) {
      for (const [id, value] of counters) if (this.previousCounters.has(id) && Number.isFinite(value)) bytes += Math.max(0, value - this.previousCounters.get(id));
      this.uploadMbps = bytes * 8 / ((now - this.previousCounterAt) * 1000);
    } else this.uploadMbps = 0;
    this.previousCounters = counters;
    this.previousCounterAt = now;
    if (this.phase === 'ready') this.emit('state', this.getInfo());
  }

  async _poll() {
    if (this.closed || this.pollTask) return;
    this.pollTask = (async () => {
      try {
        await this._pollSnapshot();
        this.monitorSuccessAt = this.dependencies.now();
        if (this.phase === 'starting' && this.dependencies.now() - this.mediaStartedAt >= this.timings.mediaTimeoutMs) {
          await this._fail(`RTMP 未能在限定时间内生成画面。${this.logs.get('ffmpeg')?.trim() || ''}`);
        }
      } catch (error) {
        if (!this.closed && this.dependencies.now() - this.monitorSuccessAt >= this.timings.monitorTimeoutMs) {
          await this._fail(`RTMP 连接监测失败，已停止该流：${this._clean(error.message)}`);
        }
      }
    })();
    try { await this.pollTask; } finally { this.pollTask = null; }
  }

  async kick(id) {
    if (typeof id !== 'string' || !id.startsWith('rtmp:') || !UUID.test(id.slice(5)) || !this.reservations.has(id)) return false;
    try { await this._api(`/v3/rtmp/conns/kick/${encodeURIComponent(id.slice(5))}`, 'POST'); }
    catch (error) { if (error.statusCode !== 404) throw error; }
    this.reservations.delete(id);
    this.audience.remove(id);
    return true;
  }

  updateAdvertisedHost(address) {
    if (net.isIP(address) !== 4) throw new Error('一级网络 RTMP 地址无效。');
    this.config.advertisedHost = address;
    this.emit('state', this.getInfo());
    return this.getInfo();
  }

  _clean(value) {
    let result = String(value || '');
    for (const secret of [this.publishUrl, this.publisherPassword, this.controlPassword, this.authPath, this.streamPath]) {
      if (secret) result = result.split(secret).join('[会话信息]');
    }
    return result.replace(/rtmp:\/\/[^\s'"<>]+/gi, '[RTMP 地址]').slice(-1800);
  }

  async _pause(ms) {
    if (this.abort.signal.aborted) throw cancelled();
    await new Promise((resolve, reject) => {
      const done = () => { this.abort.signal.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(done, ms);
      const cancel = () => { clearTimeout(timer); reject(cancelled()); };
      this.abort.signal.addEventListener('abort', cancel, { once: true });
    });
  }

  async _fail(message) {
    if (this.closed) return this.cleanupTask;
    this.closed = true;
    this.finishedGeneration = this.generation || this.finishedGeneration;
    this.generation = null;
    this.uploadMbps = 0;
    this._state('error', this._clean(message));
    this.abort.abort();
    this.pendingWrite?.reject();
    return this._cleanup();
  }

  async stop() {
    if (!this.stopTask) {
      this.closed = true;
      this.finishedGeneration = this.generation || this.finishedGeneration;
      this.generation = null;
      this.uploadMbps = 0;
      this.abort.abort();
      this.pendingWrite?.reject();
      this._state('stopped', this.enabled ? 'RTMP 已停止。' : 'RTMP 已关闭。');
      this.stopTask = (async () => {
        await this._cleanup();
        if (this.prepareTask) await settlesWithin(this.prepareTask, this.timings.terminateMs + this.timings.killMs);
        await this._cleanup();
        if (this.ownedProcesses.size) throw new Error('RTMP 子进程未能退出，请再次停止或稍后重试。');
      })().finally(() => { this.stopTask = null; });
    }
    return this.stopTask;
  }

  async _terminate(child) {
    child.stdin?.destroy();
    if (child.rtmpExited || (child.exitCode !== null && child.exitCode !== undefined)) return true;
    try { child.kill('SIGTERM'); } catch {}
    const exited = await settlesWithin(child.done, this.timings.terminateMs);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch {}
      return settlesWithin(child.done, this.timings.killMs);
    }
    return true;
  }

  _releaseReservationsIfServerExited() {
    if (!this.closed || (this.mediaServer && !this.mediaServer.rtmpExited && this.mediaServer.exitCode == null)) return;
    for (const id of this.reservations.keys()) this.audience.remove(id);
    this.reservations.clear();
  }

  _cleanup() {
    if (this.cleanupTask) return this.cleanupTask;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    const processes = Array.from(this.ownedProcesses);
    this.ownedProcesses.clear();
    const authServer = this.authServer;
    this.authServer = null;
    const directory = this.directory;
    this.directory = null;
    this.cleanupTask = (async () => {
      const results = await Promise.allSettled(processes.map(child => this._terminate(child)));
      const unfinished = processes.filter((child, index) => !child.rtmpExited &&
        (results[index].status !== 'fulfilled' || results[index].value !== true));
      for (const child of unfinished) this.ownedProcesses.add(child);
      this._releaseReservationsIfServerExited();
      if (unfinished.length) this._state('error', `${this.message} RTMP 子进程未能完成退出；仍连接的观看者保留人数占位。`);
      for (const socket of this.authSockets) socket.destroy();
      this.authSockets.clear();
      if (authServer) await new Promise(resolve => { try { authServer.close(resolve); } catch { resolve(); } });
      if (directory && !unfinished.length) await this.dependencies.fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      else if (directory) this.directory = directory;
    })().finally(() => { this.cleanupTask = null; });
    return this.cleanupTask;
  }
}

module.exports = { RtmpSession, MAX_CHUNK_BYTES };
