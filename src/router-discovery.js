const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dgram = require('node:dgram');
const childProcess = require('node:child_process');
const { isUnicastIPv4 } = require('./shared/network.mjs');

const MAX_XML_BYTES = 128 * 1024;
const MAX_SSDP_BYTES = 8192;
const SSDP_GROUP = '239.255.255.250';
const SEARCH_TYPES = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
];
const SOAP_NAMESPACE = 'http://schemas.xmlsoap.org/soap/envelope/';
const TIMINGS = Object.freeze({ gatewayTimeoutMs: 5000, ssdpTimeoutMs: 1500, httpTimeoutMs: 900,
  upnpTimeoutMs: 3400, natPmpTimeoutMs: 1200, natPmpRetryMs: 250, overallTimeoutMs: 10000 });

// This script is constant. The selected address is environment data, never shell code.
// Native interface properties avoid NetTCPIP's CIM permissions and cold-start cost.
// GatewayAddresses belongs to the adapter whose IPv4 matches the selected address.
const GATEWAY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$selected = $env:LAN_CAST_DISCOVERY_HOST
$records = @(
  foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($adapter.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
    $properties = $adapter.GetIPProperties()
    $addresses = @($properties.UnicastAddresses | Where-Object {
      $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and $_.Address.ToString() -eq $selected
    })
    if ($addresses.Count -eq 0) { continue }
    $ipv4 = $properties.GetIPv4Properties()
    foreach ($address in $addresses) {
      foreach ($gateway in $properties.GatewayAddresses) {
        if ($gateway.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
        [PSCustomObject]@{
          host = $address.Address.ToString()
          gateway = $gateway.Address.ToString()
          interfaceIndex = [int]$ipv4.Index
          prefixLength = [int]$address.PrefixLength
        }
      }
    }
  }
)
ConvertTo-Json -InputObject $records -Compress
`;

class DiscoveryError extends Error {
  constructor(message, code = 'FAILED') { super(message); this.code = code; }
}
function canceled(signal) {
  return signal?.reason instanceof DiscoveryError ? signal.reason : new DiscoveryError('WAN 地址读取已取消。', 'CANCELED');
}
function checkAbort(signal) { if (signal?.aborted) throw canceled(signal); }
function scopeSignal(parent, timeoutMs, message) {
  const controller = new AbortController();
  const forward = () => controller.abort(canceled(parent));
  if (parent?.aborted) forward(); else parent?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort(new DiscoveryError(message, 'TIMEOUT')), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', forward); } };
}
function waitWithSignal(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(canceled(signal)); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
async function bounded(action, parent, timeoutMs, message) {
  const scope = scopeSignal(parent, timeoutMs, message);
  try { checkAbort(scope.signal); return await waitWithSignal(Promise.resolve().then(() => action(scope.signal)), scope.signal); }
  finally { scope.dispose(); }
}

function selectGatewayFromJson(json, host) {
  let records;
  try { records = JSON.parse(String(json).replace(/^\uFEFF/, '')); }
  catch { throw new DiscoveryError('Windows 返回的网关 JSON 无效。'); }
  if (records === null) records = [];
  if (!Array.isArray(records)) records = [records];
  const routes = records.filter(item => item && item.host === host && isUnicastIPv4(item.gateway) &&
    Number.isInteger(item.interfaceIndex) && item.interfaceIndex > 0 &&
    Number.isInteger(item.prefixLength) && item.prefixLength >= 1 && item.prefixLength <= 32);
  if (!routes.length) return null;
  const metricsKnown = routes.every(item => Number.isInteger(item.routeMetric) && item.routeMetric >= 0 &&
    Number.isInteger(item.interfaceMetric) && item.interfaceMetric >= 0);
  if (metricsKnown) routes.sort((left, right) => left.routeMetric + left.interfaceMetric - right.routeMetric - right.interfaceMetric);
  else if (new Set(routes.map(item => item.gateway)).size > 1) {
    throw new DiscoveryError('所选网卡存在多个 IPv4 默认网关，无法安全确定所属路由器，请在路由器管理页手动查看 WAN 地址。');
  }
  const selected = routes[0];
  return { gateway: selected.gateway, interfaceIndex: selected.interfaceIndex, prefixLength: selected.prefixLength };
}

function createWindowsGatewayResolver({ execFile = childProcess.execFile, platform = process.platform,
  environment = process.env } = {}) {
  return async ({ host, signal, timeoutMs = TIMINGS.gatewayTimeoutMs }) => {
    if (!isUnicastIPv4(host)) throw new DiscoveryError('所选网卡需要是普通单播 IPv4 地址。');
    if (platform !== 'win32') throw new DiscoveryError('目前仅支持在 Windows 上自动读取所选网卡的默认网关。');
    checkAbort(signal);
    const executable = path.win32.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(GATEWAY_SCRIPT, 'utf16le').toString('base64')];
    const json = await new Promise((resolve, reject) => {
      let child;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { finish(canceled(signal)); child?.kill(); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        child = execFile(executable, args, { shell: false, windowsHide: true, encoding: 'utf8',
          timeout: timeoutMs, maxBuffer: 64 * 1024, env: { ...environment, LAN_CAST_DISCOVERY_HOST: host } }, (error, stdout) => {
          if (error) finish(new DiscoveryError(error.killed ? '读取所选网卡的默认网关超时。' : '无法读取所选网卡的默认网关，请检查网卡连接。'));
          else finish(null, stdout);
        });
        if (signal?.aborted) abort();
      } catch { finish(new DiscoveryError('无法启动 Windows 网关读取，请检查 PowerShell 是否可用。')); }
    });
    const result = selectGatewayFromJson(json, host);
    if (!result) throw new DiscoveryError('所选网卡没有可用的 IPv4 默认网关，请检查网卡连接。');
    return result;
  };
}

function ipv4Number(value) { return value.split('.').reduce((number, byte) => (number * 256 + Number(byte)) >>> 0, 0); }
function isLocalEndpoint(address, host, gateway, prefixLength) {
  if (!isUnicastIPv4(address)) return false;
  if (address === gateway) return true;
  if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 32) return false;
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  const number = ipv4Number(address);
  const local = ipv4Number(host);
  if ((number & mask) !== (local & mask)) return false;
  if (prefixLength < 31 && ((number & ~mask) === 0 || (number & ~mask) === (~mask >>> 0))) return false;
  return true;
}
function safeRouterUrl(value, context) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\#]/.test(value)) return null;
  // Check the original authority before URL can normalize octal, integer or hex hosts.
  const authority = value.match(/^http:\/\/([^/?#]+)(?:[/?#]|$)/i)?.[1];
  if (!authority || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}(?::[1-9]\d{0,4})?$/.test(authority)) return null;
  try {
    const url = new URL(value);
    const port = url.port ? Number(url.port) : 80;
    if (url.protocol !== 'http:' || port < 1 || port > 65535 || url.username || url.password || url.hash ||
      !isLocalEndpoint(url.hostname, context.host, context.gateway, context.prefixLength)) return null;
    return url;
  } catch { return null; }
}
function resolveServiceUrl(value, base, context) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f\\#]/.test(value)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return safeRouterUrl(value, context);
  if (value.startsWith('//')) return safeRouterUrl(`http:${value}`, context);
  try { return safeRouterUrl(new URL(value, base).href, context); } catch { return null; }
}

function readRouterXml(url, { host, signal, timeoutMs, method = 'GET', serviceType }) {
  checkAbort(signal);
  const body = method === 'POST' ? Buffer.from(`<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="${SOAP_NAMESPACE}" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="${serviceType}"/></s:Body></s:Envelope>`) : null;
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const timer = setTimeout(() => finish(new DiscoveryError('路由器 UPnP 服务响应超时。', 'TIMEOUT')), timeoutMs);
    const abort = () => finish(canceled(signal));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { request?.destroy(); reject(error); } else resolve(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const headers = { Accept: 'text/xml, application/xml', 'Accept-Encoding': 'identity', Connection: 'close' };
      if (body) Object.assign(headers, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': body.length,
        SOAPAction: `"${serviceType}#GetExternalIPAddress"` });
      // Literal IPv4 plus localAddress and agent:false avoid DNS, proxies and reused foreign sockets.
      request = http.request({ hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search,
        method, headers, localAddress: host, agent: false, maxHeaderSize: 16 * 1024 }, response => {
        if (response.statusCode !== 200) { finish(new DiscoveryError(`路由器 UPnP 服务返回 HTTP ${response.statusCode}，未读取到 WAN 地址。`)); return; }
        if (Number(response.headers['content-length']) > MAX_XML_BYTES ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          finish(new DiscoveryError('路由器返回的 XML 过大或压缩格式不受支持。')); return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_XML_BYTES) finish(new DiscoveryError('路由器返回的 XML 超过大小限制。'));
          else chunks.push(chunk);
        });
        response.once('aborted', () => finish(new DiscoveryError('路由器提前关闭了 UPnP 响应。')));
        response.once('error', () => finish(new DiscoveryError('读取路由器 UPnP 响应失败。')));
        response.once('end', () => {
          try { finish(null, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { finish(new DiscoveryError('路由器返回的 XML 不是有效的 UTF-8。')); }
        });
      });
      request.once('error', () => finish(new DiscoveryError('无法连接路由器的本地 UPnP 服务。')));
      if (signal?.aborted) abort(); else request.end(body);
    } catch { finish(new DiscoveryError('无法发起路由器 UPnP 查询。')); }
  });
}

function xmlError() { return new DiscoveryError('路由器返回的 XML 无效或包含不允许的实体声明。'); }
function validXmlCodepoint(value) {
  return value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) || (value >= 0x10000 && value <= 0x10ffff);
}
function decodeXml(value) {
  const entities = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;
  if (value.replace(entities, '').includes('&')) throw xmlError();
  return value.replace(entities, entity => {
    const known = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (known[entity]) return known[entity];
    const point = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    if (!validXmlCodepoint(point)) throw xmlError();
    return String.fromCodePoint(point);
  });
}

// A bounded, non-validating XML reader for IGD descriptions and SOAP envelopes.
// It never evaluates DTDs/entities, fetches schemas, or executes processing instructions.
function parseXml(input) {
  if (Buffer.byteLength(input) > MAX_XML_BYTES || /<!DOCTYPE|<!ENTITY/i.test(input) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input)) throw xmlError();
  const xml = input.replace(/^\uFEFF/, '');
  const root = { children: [], text: '', namespaces: {} };
  const stack = [root];
  let index = 0;
  let nodes = 0;
  const name = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
  while (index < xml.length) {
    if (xml[index] !== '<') {
      const next = xml.indexOf('<', index);
      const end = next < 0 ? xml.length : next;
      stack.at(-1).text += decodeXml(xml.slice(index, end)); index = end; continue;
    }
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end < 0 || xml.slice(index + 4, end).includes('--')) throw xmlError();
      index = end + 3; continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end < 0 || stack.length === 1) throw xmlError();
      stack.at(-1).text += xml.slice(index + 9, end); index = end + 3; continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end < 0) throw xmlError(); index = end + 2; continue;
    }
    let quote = null;
    let end = index + 1;
    for (; end < xml.length; end++) {
      if (quote) { if (xml[end] === quote) quote = null; }
      else if (xml[end] === '"' || xml[end] === "'") quote = xml[end];
      else if (xml[end] === '>') break;
    }
    if (end === xml.length || end - index > 4096) throw xmlError();
    const tag = xml.slice(index + 1, end);
    index = end + 1;
    const closing = tag.match(new RegExp(`^/(${name})\\s*$`));
    if (closing) {
      if (stack.length === 1 || stack.at(-1).rawName !== closing[1]) throw xmlError();
      stack.pop(); continue;
    }
    const opening = tag.match(new RegExp(`^(${name})([\\s\\S]*?)(/?)$`));
    if (!opening) throw xmlError();
    let attributes = opening[2];
    const values = {};
    let attributeCount = 0;
    while (attributes.trim()) {
      const attribute = attributes.match(new RegExp(`^\\s+(${name})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`));
      if (!attribute || Object.hasOwn(values, attribute[1]) || ++attributeCount > 32) throw xmlError();
      values[attribute[1]] = decodeXml(attribute[2] ?? attribute[3]);
      attributes = attributes.slice(attribute[0].length);
    }
    if (++nodes > 4096 || stack.length >= 64) throw xmlError();
    const namespaces = { ...stack.at(-1).namespaces };
    for (const [key, value] of Object.entries(values)) {
      if (key === 'xmlns') namespaces[''] = value;
      else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    }
    const [prefix, localName] = opening[1].includes(':') ? opening[1].split(':') : ['', opening[1]];
    if (prefix && !namespaces[prefix]) throw xmlError();
    const node = { rawName: opening[1], name: localName, namespace: namespaces[prefix] || '', namespaces,
      children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!opening[3]) stack.push(node);
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw xmlError();
  return root.children[0];
}
function child(parent, name, required = true) {
  const matches = parent.children.filter(item => item.name === name);
  if (matches.length > 1 || (required && matches.length !== 1)) throw xmlError();
  return matches[0];
}
function childText(parent, name, required = true) {
  const node = child(parent, name, required);
  if (!node) return null;
  if (node.children.length) throw xmlError();
  return node.text.trim();
}
function* descendants(node) {
  yield node;
  for (const item of node.children) yield* descendants(item);
}
function readServices(xml, location, context) {
  const root = parseXml(xml);
  if (root.name !== 'root') throw xmlError();
  const declaredBase = childText(root, 'URLBase', false);
  const base = declaredBase ? safeRouterUrl(declaredBase, context) : location;
  if (!base) throw new DiscoveryError('路由器 UPnP 声明的服务地址不在所选网卡的本地网络。');
  const device = [...descendants(root)].find(node => node.name === 'device' &&
    /^urn:schemas-upnp-org:device:InternetGatewayDevice:[12]$/.test(childText(node, 'deviceType', false) || ''));
  if (!device) throw new DiscoveryError('默认网关没有提供 UPnP IGD 路由器描述。');
  const services = [];
  for (const node of descendants(device)) {
    if (node.name !== 'service') continue;
    const serviceType = childText(node, 'serviceType', false);
    if (!/^urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:[12]$/.test(serviceType || '')) continue;
    const control = resolveServiceUrl(childText(node, 'controlURL', false), base, context);
    if (control) services.push({ type: serviceType, control });
    if (services.length >= 8) break;
  }
  if (!services.length) throw new DiscoveryError('默认网关没有可安全读取的 UPnP WAN 地址服务。');
  return services;
}
function readWanAddress(xml, serviceType, context) {
  const envelope = parseXml(xml);
  if (envelope.name !== 'Envelope' || envelope.namespace !== SOAP_NAMESPACE) throw xmlError();
  const body = child(envelope, 'Body');
  if (body.namespace !== SOAP_NAMESPACE || child(body, 'Fault', false)) throw new DiscoveryError('路由器拒绝了 UPnP WAN 地址读取。');
  const response = child(body, 'GetExternalIPAddressResponse');
  if (response.namespace !== serviceType) throw xmlError();
  const address = childText(response, 'NewExternalIPAddress');
  if (!isUnicastIPv4(address) || address === context.gateway || address === context.host) {
    throw new DiscoveryError('路由器没有返回有效的 WAN IPv4；默认网关和电脑 LAN 地址不能作为 WAN 地址。');
  }
  return address;
}

function ssdpLocation(payload, remote, context) {
  if (remote.address !== context.gateway || payload.length > MAX_SSDP_BYTES) return null;
  const lines = payload.toString('utf8').split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(lines.shift() || '')) return null;
  const headers = Object.create(null);
  for (const line of lines) {
    if (!line) break;
    // HTTP token field names include UPnP 1.1's dotted names; EXT has no value.
    const match = line.match(/^([!#$%&'*+.^_\x60|~0-9A-Za-z-]+):[ \t]*([^\r\n\x00]*)$/);
    if (!match) return null;
    const key = match[1].toLowerCase();
    if (Object.hasOwn(headers, key)) return null;
    headers[key] = match[2].trim();
  }
  if (!SEARCH_TYPES.includes(headers.st)) return null;
  return safeRouterUrl(headers.location, context);
}
function findRouterLocations(context, { signal, timeoutMs, targets }) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const locations = new Map();
    let settled = false;
    const close = () => { try { socket.close(); } catch {} };
    const timer = setTimeout(() => finish(), timeoutMs);
    const abort = () => finish(canceled(signal));
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); close();
      if (error) reject(error); else resolve([...locations.values()]);
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(new DiscoveryError('无法通过所选网卡发送 UPnP 发现请求。')));
    socket.on('message', (payload, remote) => {
      const location = ssdpLocation(payload, remote, context);
      if (location && locations.size < 8) locations.set(location.href, location);
    });
    try {
      socket.bind(0, context.host, () => {
        if (settled) { close(); return; }
        try { socket.setMulticastInterface(context.host); socket.setMulticastTTL(2); socket.setMulticastLoopback(false); } catch {}
        for (const target of targets) {
          if (![context.gateway, SSDP_GROUP].includes(target.address) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) continue;
          for (const type of SEARCH_TYPES) {
            const message = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${target.address}:${target.port}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${type}\r\n\r\n`);
            socket.send(message, target.port, target.address, () => {});
          }
        }
      });
    } catch { finish(new DiscoveryError('所选网卡不可用，无法发现路由器。')); }
    if (signal?.aborted) abort();
  });
}
async function queryUpnp(context, options, signal) {
  const targets = options.ssdpTargets || [{ address: context.gateway, port: 1900 }, { address: SSDP_GROUP, port: 1900 }];
  const locations = await findRouterLocations(context, { signal, timeoutMs: options.ssdpTimeoutMs, targets });
  if (!locations.length) throw new DiscoveryError('默认网关未响应 UPnP 发现，可能未开启 UPnP。');
  let failure;
  for (const location of locations.slice(0, 4)) {
    checkAbort(signal);
    try {
      const xml = await readRouterXml(location, { host: context.host, signal, timeoutMs: options.httpTimeoutMs });
      const services = readServices(xml, location, context);
      for (const service of services) {
        checkAbort(signal);
        try {
          const response = await readRouterXml(service.control, { host: context.host, signal,
            timeoutMs: options.httpTimeoutMs, method: 'POST', serviceType: service.type });
          return readWanAddress(response, service.type, context);
        } catch (error) { checkAbort(signal); failure = error; }
      }
    } catch (error) { checkAbort(signal); failure = error; }
  }
  throw failure || new DiscoveryError('UPnP 未返回可用的 WAN IPv4 地址。');
}

function queryNatPmp(context, { signal, timeoutMs, retryMs, port }) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let retryTimer;
    let retryDelay = retryMs;
    const close = () => { try { socket.close(); } catch {} };
    const timer = setTimeout(() => finish(new DiscoveryError('默认网关未返回 NAT-PMP WAN 地址，可能未开启 NAT-PMP。', 'TIMEOUT')), timeoutMs);
    const abort = () => finish(canceled(signal));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(retryTimer); signal?.removeEventListener('abort', abort); close();
      if (error) reject(error); else resolve(value);
    };
    const send = () => {
      if (settled) return;
      // RFC 6886 section 3.2: opcode 0 only; no mapping operations are sent.
      socket.send(Buffer.from([0, 0]), port, context.gateway, error => {
        if (error) finish(new DiscoveryError('默认网关无法接收 NAT-PMP 地址查询。'));
      });
      retryTimer = setTimeout(send, retryDelay); retryDelay *= 2;
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(new DiscoveryError('无法通过所选网卡读取 NAT-PMP WAN 地址。')));
    socket.on('message', (payload, remote) => {
      if (remote.address !== context.gateway || remote.port !== port || payload.length !== 12 || payload[0] !== 0 || payload[1] !== 128) return;
      const code = payload.readUInt16BE(2);
      if (code !== 0) {
        finish(new DiscoveryError(code === 2 ? '路由器不允许 NAT-PMP 地址读取。' : `路由器拒绝 NAT-PMP 地址读取（错误码 ${code}）。`)); return;
      }
      const address = [...payload.subarray(8, 12)].join('.');
      if (!isUnicastIPv4(address) || address === context.gateway || address === context.host) {
        finish(new DiscoveryError('NAT-PMP 未返回有效的 WAN IPv4；默认网关和电脑 LAN 地址不能作为 WAN 地址。')); return;
      }
      finish(null, address);
    });
    try { socket.bind(0, context.host, () => { if (settled) close(); else send(); }); }
    catch { finish(new DiscoveryError('所选网卡不可用，无法读取 NAT-PMP 地址。')); }
    if (signal?.aborted) abort();
  });
}

function createRouterWanDiscovery(settings = {}) {
  const options = { ...TIMINGS, ...settings };
  for (const name of Object.keys(TIMINGS)) {
    if (!Number.isInteger(options[name]) || options[name] < 1 || options[name] > 30000) throw new Error(`Invalid router discovery timeout: ${name}`);
  }
  const resolveGateway = settings.resolveGateway || createWindowsGatewayResolver();
  const natPmpPort = settings.natPmpPort ?? 5351;
  if (!Number.isInteger(natPmpPort) || natPmpPort < 1 || natPmpPort > 65535) throw new Error('Invalid NAT-PMP port');
  return async (input = {}) => {
    const host = input?.host;
    const signal = input?.signal;
    const failed = (message, gateway) => ({ supported: false, ...(gateway ? { gateway } : {}), message });
    if (!isUnicastIPv4(host)) return failed('请选择实际局域网网卡的普通单播 IPv4；仅本机测试地址不能读取路由器 WAN。');
    const known = Object.values(os.networkInterfaces()).flat().some(item => item?.address === host && !item.internal &&
      (item.family === 'IPv4' || item.family === 4));
    if (!known) return failed('所选网卡 IPv4 已不可用，请刷新网络列表后重新选择。');
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return failed('WAN 地址读取的取消信号无效。');
    const scope = scopeSignal(signal, options.overallTimeoutMs, '读取路由器 WAN 地址超时，请重试或手动填写。');
    let gateway;
    try {
      checkAbort(scope.signal);
      const route = await bounded(stageSignal => resolveGateway({ host, signal: stageSignal, timeoutMs: options.gatewayTimeoutMs }),
        scope.signal, options.gatewayTimeoutMs, '读取所选网卡的默认网关超时。');
      if (!route || !isUnicastIPv4(route.gateway)) throw new DiscoveryError('所选网卡没有可用的 IPv4 默认网关。');
      gateway = route.gateway;
      const context = { host, gateway, prefixLength: route.prefixLength };
      let upnpFailure;
      try {
        const address = await bounded(stageSignal => queryUpnp(context, options, stageSignal), scope.signal,
          options.upnpTimeoutMs, '路由器 UPnP WAN 地址查询超时。');
        return { supported: true, wanAddress: address, gateway, method: 'upnp', message: '已通过 UPnP 读取路由器 WAN IPv4。' };
      } catch (error) { checkAbort(scope.signal); upnpFailure = error; }
      try {
        const address = await queryNatPmp(context, { signal: scope.signal, timeoutMs: options.natPmpTimeoutMs,
          retryMs: options.natPmpRetryMs, port: natPmpPort });
        return { supported: true, wanAddress: address, gateway, method: 'nat-pmp', message: '已通过 NAT-PMP 读取路由器 WAN IPv4。' };
      } catch (error) {
        checkAbort(scope.signal);
        return failed(`未能自动读取路由器 WAN IPv4，请在路由器管理页查看并手动填写。${upnpFailure instanceof DiscoveryError ? upnpFailure.message : 'UPnP 查询失败。'}${error instanceof DiscoveryError ? error.message : 'NAT-PMP 查询失败。'}`, gateway);
      }
    } catch (error) {
      return failed(scope.signal.aborted ? canceled(scope.signal).message :
        error instanceof DiscoveryError ? error.message : '无法读取所选网卡的路由器 WAN IPv4，请重试或手动填写。', gateway);
    } finally { scope.dispose(); }
  };
}

const discoverRouterWan = createRouterWanDiscovery();
module.exports = { discoverRouterWan, createRouterWanDiscovery, createWindowsGatewayResolver, selectGatewayFromJson };
