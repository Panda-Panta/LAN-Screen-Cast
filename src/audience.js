const { EventEmitter } = require('node:events');

// Admission is synchronous across the web and RTMP authentication paths. An
// accepted-but-not-yet-playing reader still occupies a slot until its owner
// confirms disconnect or releases a failed handshake.
class AudienceRegistry extends EventEmitter {
  constructor(maxViewers) {
    super();
    if (!Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 32) throw new Error('观看人数上限无效。');
    this.maxViewers = maxViewers;
    this.entries = new Map();
  }
  get size() { return this.entries.size; }
  get viewers() { return Array.from(this.entries.values(), value => ({ ...value })); }
  has(id) { return this.entries.has(id); }
  get(id) { const viewer = this.entries.get(id); return viewer ? { ...viewer } : undefined; }
  admit(id, { name = '观看设备', address = '', protocol } = {}) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 128 || !['webrtc', 'rtmp'].includes(protocol)) return false;
    const current = this.entries.get(id);
    if (current) return current.protocol === protocol;
    if (this.size >= this.maxViewers) return false;
    const viewer = Object.freeze({ id, name: String(name).replace(/[\x00-\x1f]/g, '').trim().slice(0, 40) || '观看设备',
      address: String(address).slice(0, 128), protocol, joinedAt: Date.now() });
    this.entries.set(id, viewer);
    this.emit('joined', { ...viewer });
    this.emit('changed', this.viewers);
    return true;
  }
  remove(id) {
    const viewer = this.entries.get(id);
    if (!viewer) return false;
    this.entries.delete(id);
    this.emit('left', { ...viewer });
    this.emit('changed', this.viewers);
    return true;
  }
}
module.exports = { AudienceRegistry };
