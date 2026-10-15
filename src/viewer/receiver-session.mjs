const GENERATION = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_HELP = '网页已打开且观看认证通过。请核对二级路由器 UDP 媒体端口转发、电脑防火墙，以及校园网用户隔离规则。';

// Owns only signaling and peer lifetimes. The page owns playback and reports
// its first decoded video frame separately from the ICE connection state.
export class ReceiverSession {
  constructor({ createSocket, createPeer, onState = () => {}, onError = () => {}, onRoom = () => {},
    onTrack = () => {}, onClear = () => {},
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = timer => globalThis.clearTimeout(timer) }) {
    Object.assign(this, { createSocket, createPeer, onState, onError, onRoom, onTrack, onClear, setTimer, clearTimer });
    this.socket = null; this.peer = null; this.generation = null; this.desired = false;
    this.revision = 0; this.retries = 0; this.recovering = false; this.candidates = new Map();
    this.phase = 'idle'; this.credentials = null;
  }

  start(credentials) {
    this.stop('', false);
    this.credentials = { token: credentials.token || '', pin: credentials.pin || '', name: credentials.name || '浏览器' };
    this.desired = true; this.retries = 0; this.recovering = false;
    this.open();
  }

  stop(text = '已断开连接', notify = true, code = '') {
    this.revision++; this.desired = false; this.credentials = null; this.retryReason = '';
    this.clearTimer(this.retryTimer); this.retryTimer = null;
    this.detachSocket(); this.resetPeer();
    if (notify) this.state('terminal', text, '', code);
    else this.phase = 'idle';
  }

  state(phase, text, detail = '', code = '') {
    this.phase = phase;
    this.onState({ phase, text, detail, code, recovering: this.recovering, attempt: this.retries });
  }

  detachSocket() {
    this.clearTimer(this.joinTimer); this.joinTimer = null;
    const old = this.socket; this.socket = null;
    if (!old) return;
    old.onopen = null; old.onmessage = null; old.onerror = null; old.onclose = null;
    old.close();
  }

  resetPeer() {
    this.clearTimer(this.failTimer); this.failTimer = null;
    const old = this.peer; this.peer = null; this.generation = null; this.candidates.clear();
    if (old) {
      old.ontrack = null; old.onicecandidate = null; old.onconnectionstatechange = null;
      old.close();
    }
    this.onClear();
  }

  send(message, socket = this.socket) {
    if (this.desired && socket === this.socket && socket?.readyState === 1) socket.send(JSON.stringify(message));
  }

  open() {
    if (!this.desired) return;
    this.clearTimer(this.retryTimer); this.retryTimer = null;
    if (this.socket) return;
    this.onError('');
    this.state('connecting', this.recovering ? '连接中断，正在重新连接…' : '正在连接广播电脑…',
      '网页已经打开，正在建立观看认证连接。');
    this.resetPeer();
    const revision = this.revision;
    let socket;
    try { socket = this.createSocket(); } catch (error) { this.retry(error.message || '无法连接广播电脑'); return; }
    this.socket = socket;
    const active = () => this.desired && this.revision === revision && this.socket === socket;
    let queue = Promise.resolve();
    this.joinTimer = this.setTimer(() => {
      if (!active()) return;
      this.retryReason = '观看认证连接超时，请检查广播是否开启、TCP 网页端口转发和访问地址。';
      socket.close();
    }, 15000);
    socket.onopen = () => {
      if (!active()) return;
      this.state('connecting', '正在验证观看邀请…', '网页和信令连接已建立，等待观看认证。');
      this.send({ type: 'join', ...this.credentials }, socket);
    };
    const failed = error => {
      if (!active()) return;
      this.onError(`画面连接失败：${error.message}`);
      this.retryReason = '媒体协商失败。' + MEDIA_HELP;
      socket.close();
    };
    socket.onmessage = event => {
      if (!active()) return;
      let message;
      try { message = JSON.parse(event.data); } catch (error) { failed(error); return; }
      // Stop/auth messages must precede a following socket close, even while
      // an earlier SDP operation is awaiting the browser. Revision checks
      // prevent that outstanding operation from publishing another answer.
      if (['ended', 'kicked', 'error'].includes(message?.type)) {
        void this.message(message, socket, active).catch(failed);
        return;
      }
      queue = queue.then(async () => {
        if (active()) await this.message(message, socket, active);
      }).catch(failed);
    };
    socket.onerror = () => {
      if (active()) this.state('connecting', '无法连接广播电脑', '请检查 TCP 网页端口转发、访问地址和广播是否开启。');
    };
    socket.onclose = () => {
      if (!active()) return;
      const reason = this.retryReason || (this.phase === 'admitted' || this.phase === 'negotiating' ? MEDIA_HELP :
        '连接已中断。请检查网络、TCP 网页端口转发和广播是否开启。');
      this.retryReason = '';
      this.detachSocket(); this.resetPeer(); this.retry(reason);
    };
  }

  retry(reason) {
    if (!this.desired) return;
    this.recovering = true;
    const delay = Math.min(10000, 1000 * 2 ** Math.min(this.retries++, 4));
    this.state('retrying', `连接中断，${Math.ceil(delay / 1000)} 秒后重试`, reason);
    this.clearTimer(this.retryTimer);
    this.retryTimer = this.setTimer(() => this.open(), delay);
  }

  async message(message, socket, active) {
    if (!message || typeof message !== 'object') throw new Error('信令格式无效');
    if (message.type === 'joined') {
      this.clearTimer(this.joinTimer); this.joinTimer = null;
      this.onRoom(message.roomName || '局域网投屏');
      this.state('admitted', '观看认证已通过，等待画面协商…', '网页与观看认证已通过。正在建立 UDP 媒体连接。');
      this.failTimer = this.setTimer(() => { if (active()) { this.retryReason = MEDIA_HELP; socket.close(); } }, 25000);
    } else if (message.type === 'candidate' && message.candidate) {
      if (!GENERATION.test(message.generation || '')) throw new Error('媒体候选标识无效');
      if (message.generation === this.generation && this.peer?.remoteDescription) {
        const peer = this.peer;
        await peer.addIceCandidate(message.candidate);
      } else {
        const queued = this.candidates.get(message.generation) || [];
        if (queued.length >= 128 || (!this.candidates.has(message.generation) && this.candidates.size >= 8)) {
          throw new Error('媒体候选队列超出限制');
        }
        queued.push(message.candidate); this.candidates.set(message.generation, queued);
      }
    } else if (message.type === 'offer') {
      if (!GENERATION.test(message.generation || '') || message.sdp?.type !== 'offer' || typeof message.sdp.sdp !== 'string') {
        throw new Error('媒体协商格式无效');
      }
      const queued = this.candidates.get(message.generation) || [];
      this.resetPeer();
      if (!active()) return;
      const peer = this.createPeer();
      this.peer = peer; this.generation = message.generation;
      const current = () => active() && this.peer === peer && this.generation === message.generation;
      this.state('negotiating', '正在协商画面连接…', '认证已通过；如果一直没有画面，请检查 UDP 媒体端口转发。');
      peer.onicecandidate = ({ candidate }) => {
        if (current() && candidate) this.send({ type: 'candidate', generation: message.generation, candidate: candidate.toJSON() }, socket);
      };
      peer.ontrack = event => { if (current()) this.onTrack(event, { peer, generation: message.generation, isCurrent: current }); };
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        if (peer.connectionState === 'connected') {
          this.clearTimer(this.failTimer);
          if (this.phase !== 'watching') this.state('negotiating', '媒体通道已连接，等待第一帧…', 'UDP 媒体连接已建立，尚未确认收到视频帧。');
          if (this.phase !== 'watching') this.failTimer = this.setTimer(() => {
            if (current() && this.phase !== 'watching') { this.retryReason = '媒体已连接但未收到视频。' + MEDIA_HELP; socket.close(); }
          }, 25000);
        } else if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          this.clearTimer(this.failTimer);
          this.state('negotiating', '媒体连接中断，正在恢复…', MEDIA_HELP);
          this.failTimer = this.setTimer(() => { if (current()) { this.retryReason = MEDIA_HELP; socket.close(); } },
            peer.connectionState === 'failed' ? 500 : 4000);
        }
      };
      this.failTimer = this.setTimer(() => { if (current()) { this.retryReason = MEDIA_HELP; socket.close(); } }, 25000);
      await peer.setRemoteDescription(message.sdp);
      if (!current()) return;
      for (const candidate of queued) {
        await peer.addIceCandidate(candidate);
        if (!current()) return;
      }
      const answer = await peer.createAnswer();
      if (!current()) return;
      await peer.setLocalDescription(answer);
      if (current()) this.send({ type: 'answer', generation: message.generation, sdp: peer.localDescription.toJSON() }, socket);
    } else if (message.type === 'ended') this.stop('广播已结束');
    else if (message.type === 'kicked') this.stop(message.message || '广播端已断开此设备', true, 'KICKED');
    else if (message.type === 'error') {
      if (message.code === 'RETRY') {
        // Host negotiation failures are recoverable and already release their
        // slot. Retire this generation before closing; the close callback must
        // not schedule a second retry or wait for unfinished browser SDP work.
        this.detachSocket(); this.resetPeer();
        this.retry(message.message || MEDIA_HELP);
      } else if (message.code === 'FULL' && this.recovering) {
        this.retryReason = '原连接可能尚未释放观看名额，正在等待并重试。';
        socket.close();
      } else {
        this.stop(message.message || '连接失败', true, message.code || 'ERROR');
        this.onError(message.message || '连接失败');
      }
    }
  }

  noteVideoFrame(peer) {
    if (!this.desired || peer !== this.peer || peer.connectionState !== 'connected' || this.phase === 'watching') return;
    this.clearTimer(this.failTimer); this.failTimer = null;
    this.retries = 0; this.recovering = false;
    this.state('watching', '正在观看', '已收到视频帧。网络往返与接收缓冲仅反映链路环节，不代表端到端画面延迟。');
  }
}
