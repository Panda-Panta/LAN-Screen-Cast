const os = require('node:os');
const { isUnicastIPv4 } = require('./shared/network.mjs');

const DEFAULTS = Object.freeze({
  host: '', port: 8765, udpMin: 50000, udpMax: 50100,
  rtmpEnabled: true, rtmpPort: 1935, advertisedRtmpPort: 1935,
  rtmpCodec: 'HEVC', rtmpAcceleration: 'auto',
  resolution: '1080', fps: 30, bitrateMbps: 6, maxViewers: 5,
  microphone: false, micDeviceId: '', systemAudio: false, systemVolume: 100, micVolume: 100,
  codec: 'HEVC', roomName: '局域网投屏',
  forwardingEnabled: false, advertisedHost: '', advertisedPort: 8765, autoRouterAddress: true, networkName: '', sourceType: 'screen'
});

function listNetworks(interfaces = os.networkInterfaces()) {
  const result = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      const virtual = /virtual|vmware|vbox|vpn|tailscale|hyper-v|wsl|vgate|docker/i.test(name) || item.address.startsWith('169.254.');
      result.push({ name, address: item.address, netmask: item.netmask || '', cidr: item.cidr || '', virtual, local: false });
    }
  }
  result.sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.name.localeCompare(b.name));
  result.push({ name: '仅本机测试', address: '127.0.0.1', netmask: '255.0.0.0', cidr: '127.0.0.1/8', virtual: false, local: true });
  return result;
}

function integer(value, min, max, label) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    throw new Error(`${label}需要是 ${min}–${max} 的整数。`);
  }
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}需要是 ${min}–${max} 的整数。`);
  return number;
}

function validateConfig(input, networks = listNetworks()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('广播设置无效。');
  if (!networks.some(item => item.address === input.host)) throw new Error('所选网卡已不可用，请刷新网络列表后重新选择。');
  const forwardingEnabled = input.forwardingEnabled === undefined ? DEFAULTS.forwardingEnabled : input.forwardingEnabled;
  if (typeof forwardingEnabled !== 'boolean') throw new Error('端口转发开关无效。');
  const autoRouterAddress = input.autoRouterAddress === undefined ? DEFAULTS.autoRouterAddress : input.autoRouterAddress;
  if (typeof autoRouterAddress !== 'boolean') throw new Error('自动读取路由器地址开关无效。');
  const systemAudio = input.systemAudio === undefined ? DEFAULTS.systemAudio : input.systemAudio;
  if (typeof systemAudio !== 'boolean') throw new Error('系统声音开关无效。');
  const rtmpEnabled = input.rtmpEnabled === undefined ? DEFAULTS.rtmpEnabled : input.rtmpEnabled;
  if (typeof rtmpEnabled !== 'boolean') throw new Error('RTMP 开关无效。');
  const advertisedHost = input.advertisedHost === undefined ? DEFAULTS.advertisedHost :
    typeof input.advertisedHost === 'string' ? input.advertisedHost.trim() : null;
  if (advertisedHost === null || (advertisedHost && !isUnicastIPv4(advertisedHost)) || (forwardingEnabled && !advertisedHost)) {
    throw new Error('一级网络地址需要填写二级路由器 WAN 口的普通单播 IPv4，不能填写 URL。');
  }
  if (forwardingEnabled && (!isUnicastIPv4(input.host) || networks.find(item => item.address === input.host)?.local)) {
    throw new Error('仅本机测试网卡不能启用端口转发，请选择实际的局域网网卡。');
  }
  const config = {
    host: input.host,
    port: integer(input.port, 1024, 65535, '网页端口'),
    rtmpEnabled,
    rtmpCodec: input.rtmpCodec === undefined ? DEFAULTS.rtmpCodec : input.rtmpCodec,
    rtmpAcceleration: input.rtmpAcceleration === undefined ? DEFAULTS.rtmpAcceleration : input.rtmpAcceleration,
    rtmpPort: integer(input.rtmpPort === undefined ? DEFAULTS.rtmpPort : input.rtmpPort, 1024, 65535, 'RTMP 端口'),
    advertisedRtmpPort: integer(input.advertisedRtmpPort === undefined ? DEFAULTS.advertisedRtmpPort : input.advertisedRtmpPort, 1, 65535, '一级网络 RTMP 端口'),
    udpMin: integer(input.udpMin, 1024, 65535, 'UDP 起始端口'),
    udpMax: integer(input.udpMax, 1024, 65535, 'UDP 结束端口'),
    maxViewers: integer(input.maxViewers, 1, 32, '观看人数'),
    bitrateMbps: integer(input.bitrateMbps, 1, 30, '码率'),
    fps: Number(input.fps), resolution: input.resolution, codec: input.codec === undefined ? DEFAULTS.codec : input.codec,
    microphone: input.microphone === true,
    micDeviceId: typeof input.micDeviceId === 'string' ? input.micDeviceId.slice(0, 256) : '',
    systemAudio,
    systemVolume: integer(input.systemVolume === undefined ? DEFAULTS.systemVolume : input.systemVolume, 0, 100, '系统声音音量'),
    micVolume: integer(input.micVolume === undefined ? DEFAULTS.micVolume : input.micVolume, 0, 100, '麦克风音量'),
    roomName: typeof input.roomName === 'string' ? input.roomName.trim().slice(0, 48) : '',
    forwardingEnabled, advertisedHost, autoRouterAddress,
    networkName: typeof input.networkName === 'string' ? input.networkName.slice(0, 128) : '',
    sourceType: input.sourceType === undefined ? DEFAULTS.sourceType : input.sourceType,
    advertisedPort: integer(input.advertisedPort === undefined ? DEFAULTS.advertisedPort : input.advertisedPort, 1, 65535, '一级网络网页端口')
  };
  if (config.udpMax - config.udpMin < 31 || config.udpMax - config.udpMin > 2000) throw new Error('UDP 范围需要包含 32–2001 个端口，且结束端口大于起始端口。');
  if (config.rtmpEnabled && config.rtmpPort === config.port) throw new Error('RTMP 与网页需要使用不同的 TCP 端口。');
  if (!['H264', 'HEVC'].includes(config.rtmpCodec)) throw new Error('RTMP 编码请选择 H.264 或 HEVC。');
  if (!['auto', 'hardware', 'software'].includes(config.rtmpAcceleration)) throw new Error('RTMP 加速方式无效。');
  if (config.rtmpEnabled && config.forwardingEnabled && config.advertisedRtmpPort === config.advertisedPort) throw new Error('一级网络的 RTMP 与网页需要映射到不同的 TCP 端口。');
  if (![30, 60].includes(config.fps)) throw new Error('帧率请选择 30 或 60。');
  if (!['720', '1080', 'native'].includes(config.resolution)) throw new Error('分辨率请选择 720p、1080p 或原始尺寸。');
  if (!['auto', 'H264', 'VP8', 'HEVC'].includes(config.codec)) throw new Error('编码格式无效。');
  if (!['screen', 'window'].includes(config.sourceType)) throw new Error('采集类型无效。');
  if (config.bitrateMbps * config.maxViewers > 70) throw new Error('按 100 Mbps 网络计算，总视频预算不能超过 70 Mbps。请降低每台码率或观看人数。');
  if (!config.roomName) config.roomName = DEFAULTS.roomName;
  return config;
}

function validatePreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('用户设置无效。');
  const preferences = { ...DEFAULTS, ...input };
  if (preferences.host && !isUnicastIPv4(preferences.host) && preferences.host !== '127.0.0.1') throw new Error('网卡地址无效。');
  if (typeof preferences.forwardingEnabled !== 'boolean') throw new Error('端口转发开关无效。');
  // A draft may refer to a disconnected NIC or await its first WAN query.
  // Starting a broadcast still uses the stricter live-interface validation.
  const saved = validateConfig({ ...preferences, forwardingEnabled: false }, [{ address: preferences.host }]);
  return { ...saved, forwardingEnabled: preferences.forwardingEnabled };
}

module.exports = { DEFAULTS, listNetworks, validateConfig, validatePreferences };
