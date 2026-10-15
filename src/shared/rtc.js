export const RTC_CONFIG = { iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };

export function normalizeVideoCodec(value) {
  const name = String(value || '').replace(/^video\//i, '').toUpperCase();
  if (name === 'H265' || name === 'H.265' || name === 'HEVC') return 'HEVC';
  if (name === 'H.264') return 'H264';
  return name === 'AUTO' ? 'auto' : name;
}

export function videoCodecLabel(value) {
  const name = normalizeVideoCodec(value);
  return name === 'HEVC' ? 'HEVC / H.265' : name === 'H264' ? 'H.264' : name;
}

function repairCodec(codec) {
  return ['RTX', 'RED', 'ULPFEC', 'FLEXFEC', 'FLEXFEC-03'].includes(normalizeVideoCodec(codec.mimeType));
}

export function videoCodecSupport(direction = 'send') {
  // Decoding HEVC does not imply that this machine can encode it. In
  // Chromium HEVC is supplied by the platform; there is no software encoder.
  const api = direction === 'receive' ? globalThis.RTCRtpReceiver : globalThis.RTCRtpSender;
  let codecs = [], capabilitiesAvailable = false;
  try {
    const capabilities = api?.getCapabilities?.('video');
    capabilitiesAvailable = Array.isArray(capabilities?.codecs);
    if (capabilitiesAvailable) codecs = capabilities.codecs.filter(codec => /^video\//i.test(codec?.mimeType || ''));
  } catch { /* Capability queries can fail while a GPU process is unavailable. */ }
  const available = [...new Set(codecs.filter(codec => !repairCodec(codec)).map(codec => normalizeVideoCodec(codec.mimeType)))];
  return { direction, available, hevc: available.includes('HEVC'), capabilitiesAvailable, codecs };
}

export function preferCodec(transceiver, selection) {
  const requested = ['HEVC', 'H264', 'VP8'].includes(normalizeVideoCodec(selection)) ? normalizeVideoCodec(selection) : 'auto';
  const support = videoCodecSupport('send');
  const result = { requested, preferred: '', available: support.available, applied: false, fallback: false, fallbackReason: '', message: '' };
  if (!support.capabilitiesAvailable) {
    return { ...result, fallbackReason: 'capabilities-unavailable', message: '无法读取发送端编码能力；由浏览器协商编码，HEVC 是否可用尚未确认。' };
  }
  if (typeof transceiver?.setCodecPreferences !== 'function') {
    return { ...result, fallbackReason: 'preferences-unavailable', message: '此浏览器无法设置编码优先级；以实际协商和发送统计为准。' };
  }
  const order = [...new Set([requested, 'H264', 'VP8'])];
  const rank = codec => {
    const index = order.indexOf(normalizeVideoCodec(codec.mimeType));
    return index < 0 ? order.length : index;
  };
  const media = support.codecs.filter(codec => !repairCodec(codec)).sort((a, b) => rank(a) - rank(b));
  if (!media.length) return { ...result, fallbackReason: 'sender-unsupported', message: '发送端没有提供可用的视频编码能力。' };
  // Keep every original capability object, including RTX's apt and RED/FEC.
  // Removing only an unwanted primary codec can leave its repair dependencies
  // invalid. Reordering also retains shared alternatives for older receivers.
  const codecs = [...media, ...support.codecs.filter(repairCodec)];
  try { transceiver.setCodecPreferences(codecs); }
  catch { return { ...result, fallbackReason: 'preferences-rejected', message: '浏览器未接受编码优先级；继续协商，并以实际发送统计为准。' }; }
  result.applied = true;
  result.preferred = normalizeVideoCodec(media[0].mimeType);
  result.fallback = requested !== 'auto' && result.preferred !== requested;
  if (result.fallback) {
    result.fallbackReason = 'sender-unsupported';
    result.message = `此电脑未提供 ${videoCodecLabel(requested)} 发送能力，优先回落至 ${videoCodecLabel(result.preferred)}；最终编码以协商和实际发送为准。`;
  } else if (requested === 'HEVC') {
    result.message = '已优先选择 HEVC / H.265；接收端未协商 HEVC 时回落至 H.264 / VP8。';
  } else result.message = `优先选择 ${videoCodecLabel(result.preferred)}；等待协商和实际发送统计。`;
  return result;
}

export function negotiatedVideoCodec(description, mid = null) {
  const sections = String(description?.sdp || '').split(/\r?\nm=/).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const [kind, port, _protocol, ...payloads] = lines[0].trim().split(/\s+/);
    if (kind !== 'video' || Number(port.split('/')[0]) === 0 || lines.includes('a=inactive')) continue;
    if (mid != null && !lines.includes(`a=mid:${mid}`)) continue;
    const codecs = new Map();
    for (const line of lines) {
      const match = /^a=rtpmap:(\d+)\s+([^/]+)/i.exec(line);
      if (match) codecs.set(match[1], { mimeType: `video/${match[2]}` });
    }
    for (const payload of payloads) {
      const codec = codecs.get(payload);
      if (codec && !repairCodec(codec)) return normalizeVideoCodec(codec.mimeType);
    }
  }
  return '';
}

export function lowLatency(receiver) {
  try {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
    else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
  } catch { /* Browser chooses its own minimum buffer when this hint is unsupported. */ }
}

export async function videoStats(pc, previous = null, direction = 'inbound-rtp') {
  const reports = await pc.getStats();
  let video, rtt = null, codec = '';
  reports.forEach(report => {
    if (report.type === direction && (report.kind === 'video' || report.mediaType === 'video') && !report.isRemote) {
      const format = reports.get(report.codecId);
      if (!format || !repairCodec(format)) {
        const bytes = report.bytesReceived ?? report.bytesSent ?? 0;
        const currentBytes = video?.bytesReceived ?? video?.bytesSent ?? -1;
        if (bytes > currentBytes) video = report;
      }
    }
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      const pair = reports.get(report.selectedCandidatePairId);
      if (pair?.currentRoundTripTime != null) rtt = Math.round(pair.currentRoundTripTime * 1000);
    }
  });
  const implementation = {
    encoderImplementation: video?.encoderImplementation ?? null, decoderImplementation: video?.decoderImplementation ?? null,
    powerEfficientEncoder: video?.powerEfficientEncoder ?? null, powerEfficientDecoder: video?.powerEfficientDecoder ?? null,
    framesEncoded: video?.framesEncoded ?? null, framesDecoded: video?.framesDecoded ?? null,
  };
  if (!video) return { previous, rtt, fps: null, mbps: null, buffer: null, codec, codecLabel: '', ...implementation };
  const format = reports.get(video.codecId);
  codec = format?.mimeType?.split('/')[1] || '';
  const bytes = video.bytesReceived ?? video.bytesSent ?? 0;
  const frames = video.framesDecoded ?? video.framesEncoded ?? 0;
  const seconds = previous ? (video.timestamp - previous.timestamp) / 1000 : 0;
  const mbps = seconds > 0 ? Math.max(0, (bytes - previous.bytes) * 8 / seconds / 1000000) : null;
  const fps = video.framesPerSecond ?? (seconds > 0 ? Math.max(0, Math.round((frames - previous.frames) / seconds)) : null);
  const count = previous ? (video.jitterBufferEmittedCount || 0) - previous.emitted : 0;
  const delay = previous ? (video.jitterBufferDelay || 0) - previous.delay : 0;
  const buffer = count > 0 ? Math.round(delay / count * 1000) : null;
  return { previous: { timestamp: video.timestamp, bytes, frames, emitted: video.jitterBufferEmittedCount || 0, delay: video.jitterBufferDelay || 0 },
    rtt, fps, mbps, buffer, codec, codecLabel: videoCodecLabel(codec), sdpFmtpLine: format?.sdpFmtpLine || '', ...implementation };
}
