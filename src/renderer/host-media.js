import { RTC_CONFIG, preferCodec, videoStats, normalizeVideoCodec, videoCodecLabel, negotiatedVideoCodec, withVideoBitrateBudget } from '../shared/rtc.js';
import { advertiseCandidate, advertiseDescription } from '../shared/network.mjs';

export class HostMedia {
  constructor(stream, config, sendSignal, onPeerState) {
    this.stream = stream;
    this.config = config;
    this.sendSignal = sendSignal;
    this.onPeerState = onPeerState;
    this.peers = new Map();
    this.stopped = false;
  }

  async add(id) {
    if (this.stopped) return;
    this.remove(id);
    let pc;
    try { pc = new RTCPeerConnection(RTC_CONFIG); }
    catch (error) { this.onPeerState(id, 'error', error.message); throw error; }
    const peer = { pc, generation: crypto.randomUUID(), candidates: [], queue: Promise.resolve(), queuedSignals: 0, previous: null, timer: null, codec: null, videoTransceiver: null };
    this.peers.set(id, peer);
    // Start the deadline before the first awaited WebRTC operation, otherwise
    // an offer or sender operation that never finishes retains an admitted slot.
    peer.timer = setTimeout(() => { if (pc.connectionState !== 'connected') this.fail(id, peer, 'timeout'); }, 18000);
    pc.onicecandidate = ({ candidate }) => {
      if (!this.isCurrent(id, peer) || !candidate) return;
      try {
        for (const advertised of advertiseCandidate(candidate.toJSON(), this.config)) {
          void Promise.resolve(this.sendSignal(id, { type: 'candidate', generation: peer.generation, candidate: advertised }))
            .catch(error => this.fail(id, peer, 'error', error.message));
        }
      } catch (error) { this.fail(id, peer, 'error', error.message); }
    };
    pc.onconnectionstatechange = () => {
      if (!this.isCurrent(id, peer)) return;
      if (pc.connectionState === 'failed') { this.fail(id, peer, 'failed'); return; }
      if (pc.connectionState === 'connected') { clearTimeout(peer.timer); peer.timer = null; }
      else if (pc.connectionState === 'disconnected') {
        clearTimeout(peer.timer);
        peer.timer = setTimeout(() => this.fail(id, peer, 'timeout'), 8000);
      }
      this.onPeerState(id, pc.connectionState, undefined, peer.codec);
    };
    try {
      for (const track of this.stream.getTracks()) {
        if (!this.isCurrent(id, peer)) return;
        const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [this.stream] });
        if (track.kind === 'video') {
          peer.videoTransceiver = transceiver;
          peer.codec = { ...preferCodec(transceiver, this.config.codec), id, negotiated: '', actual: '', codec: '', phase: 'preference',
            encoderImplementation: null, powerEfficientEncoder: null, framesEncoded: null };
          this.onPeerState(id, pc.connectionState, undefined, peer.codec);
        }
        const params = transceiver.sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = track.kind === 'video' ? this.config.bitrateMbps * 1000000 : 96000;
        if (track.kind === 'video') {
          params.encodings[0].maxFramerate = this.config.fps;
          params.degradationPreference = 'maintain-resolution';
        }
        await transceiver.sender.setParameters(params);
      }
      if (!this.isCurrent(id, peer)) return;
      const offer = await pc.createOffer();
      if (!this.isCurrent(id, peer)) return;
      await pc.setLocalDescription(offer);
      if (!this.isCurrent(id, peer)) return;
      await this.sendSignal(id, { type: 'offer', generation: peer.generation, sdp: advertiseDescription(pc.localDescription.toJSON(), this.config) });
    } catch (error) {
      // Closing or replacing a peer can make an in-flight WebRTC call reject;
      // that old result must never fail the replacement connection.
      if (this.isCurrent(id, peer)) { this.fail(id, peer, 'error', error.message); throw error; }
    }
  }

  async signal(message) {
    const peer = this.peers.get(message.peerId);
    if (!peer) return;
    if (message.type === 'restart') { await this.add(message.peerId); return; }
    if (message.generation !== peer.generation) return;
    if (peer.queuedSignals >= 128) { this.fail(message.peerId, peer, 'error', '连接消息过多，已取消此设备的协商。'); return; }
    peer.queuedSignals++;
    peer.queue = peer.queue.then(async () => {
      if (!this.isCurrent(message.peerId, peer)) return;
      if (message.type === 'answer') {
        if (peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription(withVideoBitrateBudget(message.sdp, this.config.bitrateMbps));
        if (!this.isCurrent(message.peerId, peer)) return;
        const negotiated = negotiatedVideoCodec(peer.pc.remoteDescription, peer.videoTransceiver?.mid);
        if (negotiated) this.updateCodec(message.peerId, peer, { negotiated, phase: 'negotiated' });
        for (const candidate of peer.candidates.splice(0)) {
          if (!this.isCurrent(message.peerId, peer)) return;
          await peer.pc.addIceCandidate(candidate);
        }
      } else if (message.type === 'candidate' && message.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate);
        else {
          if (peer.candidates.length >= 128) throw new Error('连接候选过多，已取消此设备的协商。');
          peer.candidates.push(message.candidate);
        }
      }
    }).catch(error => this.fail(message.peerId, peer, 'error', error.message)).finally(() => { peer.queuedSignals--; });
    await peer.queue;
  }

  mute(muted) { this.stream.getAudioTracks().forEach(track => { track.enabled = !muted; }); }

  async stats() {
    let total = 0;
    let connected = 0;
    const codecs = [];
    for (const [id, peer] of this.peers) {
      if (peer.pc.connectionState !== 'connected') { if (peer.codec) codecs.push({ ...peer.codec }); continue; }
      let stats;
      try { stats = await videoStats(peer.pc, peer.previous, 'outbound-rtp'); }
      catch (error) { if (this.isCurrent(id, peer)) throw error; continue; }
      if (!this.isCurrent(id, peer)) continue;
      connected++;
      peer.previous = stats.previous;
      total += stats.mbps || 0;
      if (peer.codec) peer.codec = { ...peer.codec, framesEncoded: stats.framesEncoded };
      // A codec in an SDP/capability list is not proof that frames were encoded.
      // Only attribute actual sending after RTP stats contain encoded frames.
      if (stats.codec && stats.framesEncoded > 0) {
        this.updateCodec(id, peer, { actual: normalizeVideoCodec(stats.codec), codec: stats.codec, phase: 'actual',
          encoderImplementation: stats.encoderImplementation, powerEfficientEncoder: stats.powerEfficientEncoder });
      }
      if (peer.codec) codecs.push({ ...peer.codec });
    }
    return { total, connected, codecs };
  }

  updateCodec(id, peer, update) {
    if (!this.isCurrent(id, peer) || !peer.codec) return;
    const previous = peer.codec;
    const codec = { ...previous, ...update };
    const selected = codec.actual || codec.negotiated || codec.preferred;
    codec.fallback = codec.requested !== 'auto' && !!selected && selected !== codec.requested;
    codec.fallbackReason = codec.fallback ? (previous.fallbackReason === 'sender-unsupported' ? 'sender-unsupported' :
      codec.negotiated && codec.negotiated !== codec.requested ? 'not-negotiated' : 'different-actual-codec') : '';
    if (codec.actual) {
      codec.message = codec.fallback ? `请求 ${videoCodecLabel(codec.requested)}，实际发送 ${videoCodecLabel(codec.actual)}。` : `实际发送 ${videoCodecLabel(codec.actual)}。`;
    } else if (codec.negotiated) {
      codec.message = codec.fallback ? `请求 ${videoCodecLabel(codec.requested)}，协商编码为 ${videoCodecLabel(codec.negotiated)}；等待实际发送统计。` : `协商编码为 ${videoCodecLabel(codec.negotiated)}；等待实际发送统计。`;
    }
    peer.codec = codec;
    if (previous.message !== codec.message || previous.phase !== codec.phase) this.onPeerState(id, peer.pc.connectionState, undefined, codec);
  }

  isCurrent(id, peer) { return !this.stopped && this.peers.get(id) === peer; }

  fail(id, peer, state, message) {
    if (!this.isCurrent(id, peer)) return;
    this.remove(id);
    this.onPeerState(id, state, message, peer.codec);
  }

  remove(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.candidates.length = 0;
    clearTimeout(peer.timer);
    peer.pc.onconnectionstatechange = null;
    peer.pc.onicecandidate = null;
    try { peer.pc.close(); } catch { /* An already-closed peer must not block the others. */ }
  }

  stop() {
    this.stopped = true;
    for (const id of this.peers.keys()) this.remove(id);
    this.stream.getTracks().forEach(track => track.stop());
  }
}
