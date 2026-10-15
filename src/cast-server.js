const { LanServer } = require('./lan-server');
const { RtmpSession } = require('./rtmp-session');

const disabledRtmp = () => ({ enabled: false, phase: 'stopped', message: 'RTMP 已关闭', localUrl: '', forwardedUrl: '', codec: 'H.264 / AAC' });

// The web server remains the broadcast owner. Optional RTMP preparation starts
// in the background, so a port conflict or a missing media service cannot stop
// an otherwise usable web broadcast.
class CastServer extends LanServer {
  constructor(config, { binDir, tempRoot, createRtmp = (value, options) => new RtmpSession(value, options), ...webOptions } = {}) {
    super(config, webOptions);
    this.rtmp = config.rtmpEnabled ? createRtmp(config, { audience: this.audience, binDir, tempRoot }) : null;
    this.rtmp?.on('state', payload => this.emit('rtmp-state', { ...payload, roomId: this.roomId }));
    this.preparingRtmp = null;
  }
  async start() {
    await super.start();
    if (this.rtmp) {
      this.preparingRtmp = this.rtmp.prepare();
      // beginRtmp reports this failure to its caller; the state event explains
      // it in the UI even when capture was cancelled before begin was called.
      void this.preparingRtmp.catch(() => {});
    }
    return this.getSessionInfo();
  }
  getSessionInfo() { return { ...super.getSessionInfo(), rtmp: this.rtmp?.getInfo() || disabledRtmp() }; }
  async beginRtmp(request) {
    if (!this.rtmp || this.stopping || !this.server?.listening) throw new Error('当前广播未启用 RTMP。');
    await this.preparingRtmp;
    if (this.stopping || !this.server?.listening) throw new Error('RTMP 准备已取消。');
    return this.rtmp.begin(request);
  }
  updateAdvertisedHost(address) {
    super.updateAdvertisedHost(address);
    this.rtmp?.updateAdvertisedHost(address);
    return this.getSessionInfo();
  }
  kick(id) { return id.startsWith('rtmp:') ? this.rtmp?.kick(id) : super.kick(id); }
  async stop() {
    await Promise.all([this.rtmp?.stop(), super.stop()]);
  }
}
module.exports = { CastServer };
