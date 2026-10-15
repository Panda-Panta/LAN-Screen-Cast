// Address helpers are shared by trusted Node configuration and the browser sender.
// Manual UDP forwarding is a declared mapping, not a STUN discovery result.
export function isUnicastIPv4(address) {
  if (typeof address !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts.some(part => part > 255) || parts[0] === 0 || parts[0] === 127 || parts[0] >= 224) return false;
  return !(parts[0] === 169 && parts[1] === 254);
}

function forwardingReady(config) {
  return config?.forwardingEnabled === true && isUnicastIPv4(config.host) && isUnicastIPv4(config.advertisedHost) &&
    Number.isInteger(config.udpMin) && Number.isInteger(config.udpMax) && config.udpMin > 0 &&
    config.udpMax <= 65535 && config.udpMin <= config.udpMax;
}

function mappedCandidate(line, config) {
  if (!forwardingReady(config) || typeof line !== 'string' || line.length > 4096 || /[\r\n\x00]/.test(line)) return null;
  const fields = line.trim().split(/\s+/);
  const foundation = fields[0]?.match(/^candidate:([A-Za-z0-9+/]{1,32})$/)?.[1];
  if (!foundation || fields.length < 8 || fields.length % 2 !== 0 || fields[2].toLowerCase() !== 'udp' ||
    fields[4] !== config.host || fields[6] !== 'typ' || fields[7] !== 'host') return null;
  if (![fields[1], fields[3], fields[5]].every(value => /^\d+$/.test(value))) return null;
  const component = Number(fields[1]);
  const priority = Number(fields[3]);
  const port = Number(fields[5]);
  if (component < 1 || component > 256 || priority < 1 || priority > 2147483647 ||
    port < config.udpMin || port > config.udpMax) return null;
  // RFC 8445 type preference 100 is below the normal host preference of 126.
  const reflexivePriority = Math.max(1, Math.min(priority - 1, 100 * 2 ** 24 + priority % 2 ** 24));
  const extensions = [];
  for (let index = 8; index < fields.length; index += 2) {
    if (!['raddr', 'rport', 'tcptype'].includes(fields[index])) extensions.push(fields[index], fields[index + 1]);
  }
  return [`candidate:fwd${foundation.slice(0, 29)}`, fields[1], fields[2], reflexivePriority,
    config.advertisedHost, fields[5], 'typ', 'srflx', 'raddr', config.host, 'rport', fields[5], ...extensions].join(' ');
}

export function advertiseCandidate(candidateInit, config) {
  const mapped = mappedCandidate(candidateInit?.candidate, config);
  if (!mapped) return [candidateInit];
  const additional = { ...candidateInit, candidate: mapped };
  for (const field of ['sdpMid', 'sdpMLineIndex', 'usernameFragment']) {
    if (field in candidateInit) additional[field] = candidateInit[field];
  }
  return [candidateInit, additional];
}

export function advertiseDescription(descriptionInit, config) {
  if (!forwardingReady(config) || typeof descriptionInit?.sdp !== 'string') return descriptionInit;
  const newline = descriptionInit.sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = descriptionInit.sdp.split(/\r?\n/);
  const sections = [[]];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([]);
    sections.at(-1).push(line);
  }
  let changed = false;
  const result = [];
  for (const section of sections) {
    const existing = new Set(section);
    for (const line of section) {
      result.push(line);
      if (!line.startsWith('a=candidate:')) continue;
      const mapped = mappedCandidate(line.slice(2), config);
      if (!mapped || existing.has(`a=${mapped}`)) continue;
      existing.add(`a=${mapped}`);
      result.push(`a=${mapped}`);
      changed = true;
    }
  }
  return changed ? { ...descriptionInit, type: descriptionInit.type, sdp: result.join(newline) } : descriptionInit;
}
