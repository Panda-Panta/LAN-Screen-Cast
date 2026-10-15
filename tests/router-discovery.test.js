const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const dgram = require('node:dgram');
const http = require('node:http');
const { once } = require('node:events');
const { createRouterWanDiscovery, createWindowsGatewayResolver, selectGatewayFromJson,
  discoverRouterWan } = require('../src/router-discovery');

// Real UDP and HTTP fixtures bind an existing IPv4 interface. No router is queried.
const host = Object.values(os.networkInterfaces()).flat().find(item => !item.internal &&
  (item.family === 'IPv4' || item.family === 4) && !item.address.startsWith('169.254.'))?.address;
assert.ok(host, 'The protocol fixtures need an existing non-loopback IPv4 interface.');

const serviceType = 'urn:schemas-upnp-org:service:WANIPConnection:1';
function description(base, services = [{ type: serviceType, control: '/control' }], deviceVersion = 1) {
  return `<?xml version="1.0"?>\n<root xmlns="urn:schemas-upnp-org:device-1-0"><URLBase>${base}/</URLBase>
    <device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:${deviceVersion}</deviceType><deviceList>
    <device><deviceType>urn:schemas-upnp-org:device:WANDevice:${deviceVersion}</deviceType><deviceList><device>
    <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:${deviceVersion}</deviceType><serviceList>
    ${services.map(item => `<service><serviceType>${item.type}</serviceType><controlURL>${item.control}</controlURL></service>`).join('')}
    </serviceList></device></deviceList></device></deviceList></device></root>`;
}
function soap(address, type = serviceType) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
    <s:Body><u:GetExternalIPAddressResponse xmlns:u="${type}"><NewExternalIPAddress>${address}</NewExternalIPAddress>
    </u:GetExternalIPAddressResponse></s:Body></s:Envelope>`;
}
function natResponse(address, result = 0) {
  const payload = Buffer.alloc(12);
  payload[1] = 128;
  payload.writeUInt16BE(result, 2);
  payload.writeUInt32BE(1234, 4);
  Buffer.from(address.split('.').map(Number)).copy(payload, 8);
  return payload;
}
async function udpFixture(t, onMessage, bindAddress = host) {
  const socket = dgram.createSocket('udp4');
  const messages = [];
  socket.on('message', (payload, remote) => {
    messages.push({ payload, remote });
    if (onMessage) onMessage(payload, remote, socket);
  });
  const listening = once(socket, 'listening');
  socket.bind(0, bindAddress);
  await listening;
  t.after(() => new Promise(resolve => socket.close(resolve)));
  return { socket, port: socket.address().port, messages };
}
async function httpFixture(t, onRequest) {
  const requests = [];
  let base;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = { method: request.method, url: request.url, headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'), source: request.socket.remoteAddress };
    requests.push(entry);
    onRequest(entry, response, base);
  });
  const listening = once(server, 'listening');
  server.listen(0, host);
  await listening;
  base = `http://${host}:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { base, requests, server };
}
async function ssdpFixture(t, location, customize) {
  return udpFixture(t, (payload, remote, socket) => {
    const st = payload.toString().match(/\r\nST:\s*([^\r\n]+)/i)?.[1] || 'upnp:rootdevice';
    const reply = customize ? customize(location, st) :
      `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nSERVER: fixture/1 UPnP/1.0 router/1\r\nST: ${st}\r\nLOCATION: ${location}\r\nUSN: uuid:test-router\r\n\r\n`;
    if (reply) socket.send(Buffer.from(reply), remote.port, remote.address);
  });
}
function discovery(ssdp, nat, overrides = {}) {
  return createRouterWanDiscovery({
    resolveGateway: async () => ({ gateway: host, prefixLength: 32, interfaceIndex: 1 }),
    ssdpTargets: [{ address: host, port: ssdp.port }], natPmpPort: nat.port,
    gatewayTimeoutMs: 250, ssdpTimeoutMs: 160, httpTimeoutMs: 300,
    upnpTimeoutMs: 1000, natPmpTimeoutMs: 160, natPmpRetryMs: 50, overallTimeoutMs: 1600,
    ...overrides
  });
}
async function routerFixture(t, handler) {
  const web = await httpFixture(t, handler || ((request, response, base) => {
    response.setHeader('Content-Type', 'text/xml');
    response.end(request.url === '/device.xml' ? description(base) : soap('10.23.4.5'));
  }));
  const ssdp = await ssdpFixture(t, `${web.base}/device.xml`);
  const nat = await udpFixture(t);
  return { web, ssdp, nat, discover: discovery(ssdp, nat) };
}

test('SSDP accepts an empty EXT header without trailing whitespace before read-only HTTP', async t => {
  const ctx = await routerFixture(t);
  const result = await ctx.discover({ host });
  assert.equal(result.method, 'upnp');
  assert.equal(result.wanAddress, '10.23.4.5');
  assert.deepEqual(ctx.web.requests.map(item => [item.method, item.url]), [['GET', '/device.xml'], ['POST', '/control']]);
  assert.equal(ctx.web.requests[1].headers.soapaction, `"${serviceType}#GetExternalIPAddress"`);
  assert.equal(ctx.nat.messages.length, 0);
});

test('SSDP accepts UPnP 1.1 extension header names and reads WANIPConnection:2', async t => {
  const type = 'urn:schemas-upnp-org:service:WANIPConnection:2';
  const web = await httpFixture(t, (request, response, base) => response.end(request.url === '/device.xml'
    ? description(base, [{ type, control: '/control' }], 2) : soap('10.23.4.6', type)));
  // The SP after EXT isolates dotted field names from the separate empty-EXT regression.
  const ssdp = await ssdpFixture(t, `${web.base}/device.xml`, (location, st) =>
    `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT: \r\nSERVER: fixture/1 UPnP/1.1 router/1\r\n` +
    `BOOTID.UPNP.ORG: 1\r\nCONFIGID.UPNP.ORG: 2\r\nSEARCHPORT.UPNP.ORG: 1900\r\n` +
    `ST: ${st}\r\nLOCATION: ${location}\r\nUSN: uuid:test-router\r\n\r\n`);
  const nat = await udpFixture(t);
  const result = await discovery(ssdp, nat)({ host });
  assert.equal(result.method, 'upnp');
  assert.equal(result.wanAddress, '10.23.4.6');
  assert.deepEqual(web.requests.map(item => [item.method, item.url]), [['GET', '/device.xml'], ['POST', '/control']]);
  assert.equal(web.requests[1].headers.soapaction, `"${type}#GetExternalIPAddress"`);
  assert.equal(nat.messages.length, 0);
});

test('SSDP rejects duplicate headers irrespective of case before HTTP', async t => {
  const web = await httpFixture(t, (_request, response) => response.end('unexpected'));
  const nat = await udpFixture(t);
  for (const field of ['st', 'Location', 'ext', '__PrOtO__']) {
    const ssdp = await ssdpFixture(t, `${web.base}/device.xml`, (location, st) => {
      const value = field === 'st' ? st : field === 'Location' ? location : '';
      const first = field === '__PrOtO__' ? '__proto__: first\r\n' : '';
      return `HTTP/1.1 200 OK\r\nEXT: \r\nST: ${st}\r\nLOCATION: ${location}\r\n${first}${field}: ${value}\r\n\r\n`;
    });
    const result = await discovery(ssdp, nat, { ssdpTimeoutMs: 45, natPmpTimeoutMs: 45 })({ host });
    assert.ok(ssdp.messages.length > 0, field);
    assert.equal(result.supported, false, field);
    assert.equal(result.wanAddress, undefined, field);
  }
  assert.equal(web.requests.length, 0);
});

test('SSDP rejects invalid header name tokens before HTTP', async t => {
  const web = await httpFixture(t, (_request, response) => response.end('unexpected'));
  const nat = await udpFixture(t);
  for (const field of ['BAD HEADER', 'BAD/HEADER', 'BAD(HEADER)', 'BAD@HEADER', 'BÄD-HEADER']) {
    const ssdp = await ssdpFixture(t, `${web.base}/device.xml`, (location, st) =>
      `HTTP/1.1 200 OK\r\nEXT: \r\nST: ${st}\r\nLOCATION: ${location}\r\n${field}: value\r\n\r\n`);
    const result = await discovery(ssdp, nat, { ssdpTimeoutMs: 45, natPmpTimeoutMs: 45 })({ host });
    assert.ok(ssdp.messages.length > 0, field);
    assert.equal(result.supported, false, field);
    assert.equal(result.wanAddress, undefined, field);
  }
  assert.equal(web.requests.length, 0);
});

test('UPnP uses the chosen source interface and only GetExternalIPAddress, accepting private campus WAN', async t => {
  const ctx = await routerFixture(t);
  const result = await ctx.discover({ host });
  assert.equal(result.supported, true);
  assert.equal(result.wanAddress, '10.23.4.5');
  assert.equal(result.gateway, host);
  assert.equal(result.method, 'upnp');
  assert.ok(result.message.length > 0);
  assert.ok(ctx.ssdp.messages.length > 0);
  assert.ok(ctx.ssdp.messages.every(item => item.remote.address === host));
  assert.match(ctx.ssdp.messages[0].payload.toString(), /^M-SEARCH \* HTTP\/1\.1\r\n/);
  assert.deepEqual(ctx.web.requests.map(item => [item.method, item.url]), [['GET', '/device.xml'], ['POST', '/control']]);
  assert.equal(ctx.web.requests[1].headers.soapaction, `"${serviceType}#GetExternalIPAddress"`);
  assert.match(ctx.web.requests[1].body, /<u:GetExternalIPAddress/);
  assert.ok(ctx.web.requests.every(item => item.source === host));
  assert.equal(ctx.nat.messages.length, 0);
});

test('UPnP can read a WANPPP service after another read-only WAN service fails', async t => {
  const ppp = 'urn:schemas-upnp-org:service:WANPPPConnection:1';
  const ctx = await routerFixture(t, (request, response, base) => {
    if (request.url === '/device.xml') {
      response.end(description(base, [{ type: serviceType, control: '/unavailable' }, { type: ppp, control: 'ppp?x=1&amp;y=2' }]));
    } else if (request.url === '/unavailable') {
      response.writeHead(500); response.end('<s:Fault xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"/>');
    } else response.end(soap('100.64.12.8', ppp));
  });
  const result = await ctx.discover({ host });
  assert.equal(result.wanAddress, '100.64.12.8');
  assert.equal(result.method, 'upnp');
  assert.equal(ctx.web.requests.at(-1).url, '/ppp?x=1&y=2');
  assert.equal(ctx.web.requests.at(-1).headers.soapaction, `"${ppp}#GetExternalIPAddress"`);
});

test('NAT-PMP fallback sends exactly the external address request and retries a lost reply', async t => {
  const ssdp = await udpFixture(t);
  let attempts = 0;
  const nat = await udpFixture(t, (_payload, remote, socket) => {
    if (++attempts === 2) socket.send(natResponse('10.55.7.3'), remote.port, remote.address);
  });
  const result = await discovery(ssdp, nat)({ host });
  assert.equal(result.supported, true);
  assert.equal(result.wanAddress, '10.55.7.3');
  assert.equal(result.method, 'nat-pmp');
  assert.equal(attempts, 2);
  assert.ok(nat.messages.every(item => item.payload.equals(Buffer.from([0, 0]))));
  assert.ok(nat.messages.every(item => item.remote.address === host));
});

test('NAT-PMP discards wrong-source-port, wrong-opcode and truncated replies', async t => {
  const ssdp = await udpFixture(t);
  const other = await udpFixture(t);
  const foreign = await udpFixture(t, null, '127.0.0.1');
  const nat = await udpFixture(t, (_payload, remote, socket) => {
    foreign.socket.send(natResponse('10.1.1.0'), remote.port, remote.address);
    other.socket.send(natResponse('10.1.1.1'), remote.port, remote.address);
    const wrongOpcode = natResponse('10.1.1.2'); wrongOpcode[1] = 129;
    socket.send(wrongOpcode, remote.port, remote.address);
    socket.send(Buffer.from([0, 128]), remote.port, remote.address);
    socket.send(natResponse('10.1.1.3'), remote.port, remote.address);
  });
  const result = await discovery(ssdp, nat)({ host });
  assert.equal(result.wanAddress, '10.1.1.3');
});

test('each refresh rereads the gateway and WAN rather than retaining the previous DHCP address', async t => {
  let address = '10.23.4.5';
  let gatewayReads = 0;
  const ctx = await routerFixture(t, (request, response, base) =>
    response.end(request.url === '/device.xml' ? description(base) : soap(address)));
  const discover = discovery(ctx.ssdp, ctx.nat, { resolveGateway: async () => {
    gatewayReads++;
    return { gateway: host, prefixLength: 32, interfaceIndex: 1 };
  } });
  assert.equal((await discover({ host })).wanAddress, '10.23.4.5');
  address = '10.23.4.9';
  assert.equal((await discover({ host })).wanAddress, '10.23.4.9');
  assert.equal(gatewayReads, 2);
  assert.equal(ctx.web.requests.filter(item => item.method === 'POST').length, 2);
});

test('NAT-PMP denial gives a readable failure and never a guessed WAN address', async t => {
  const ssdp = await udpFixture(t);
  const nat = await udpFixture(t, (_payload, remote, socket) => socket.send(natResponse('10.23.4.5', 2), remote.port, remote.address));
  const result = await discovery(ssdp, nat)({ host });
  assert.equal(result.supported, false);
  assert.equal(result.wanAddress, undefined);
  assert.match(result.message, /拒绝|禁止|不允许/);
});

test('unsupported routers time out within a fixed bound without using the gateway as WAN', async t => {
  const ssdp = await udpFixture(t);
  const nat = await udpFixture(t);
  const started = performance.now();
  const result = await discovery(ssdp, nat)({ host });
  assert.equal(result.supported, false);
  assert.equal(result.gateway, host);
  assert.equal(result.wanAddress, undefined);
  assert.match(result.message, /UPnP|NAT-PMP/);
  assert.ok(performance.now() - started < 1400);
});

test('SSDP locations reject loopback, names, credentials, non-HTTP and noncanonical IPv4 before HTTP', async t => {
  const foreign = http.createServer((_request, response) => { foreignHits++; response.end('unexpected'); });
  let foreignHits = 0;
  const listening = once(foreign, 'listening'); foreign.listen(0, '127.0.0.1'); await listening;
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const locations = [`http://127.0.0.1:${foreign.address().port}/device.xml`, 'http://example.invalid/device.xml',
    `http://name:pass@${host}/device.xml`, `https://${host}/device.xml`, 'file:///device.xml',
    'http://0x7f000001/device.xml', 'http://2130706433/device.xml', 'http://224.1.2.3/device.xml',
    'http://8.8.8.8/device.xml', `http://${host}/device.xml#fragment`];
  const nat = await udpFixture(t);
  for (const location of locations) {
    const ssdp = await ssdpFixture(t, location);
    const result = await discovery(ssdp, nat, { ssdpTimeoutMs: 45, natPmpTimeoutMs: 45 })({ host });
    assert.equal(result.supported, false, location);
    assert.equal(result.wanAddress, undefined, location);
  }
  assert.equal(foreignHits, 0);
});

test('unsafe URLBase and absolute control URLs are rejected before a SOAP request', async t => {
  const nat = await udpFixture(t);
  for (const mode of ['base', 'control']) {
    const web = await httpFixture(t, (_request, response, base) => response.end(mode === 'base'
      ? description('http://8.8.8.8') : description(base, [{ type: serviceType, control: 'http://8.8.8.8/control' }])));
    const ssdp = await ssdpFixture(t, `${web.base}/device.xml`);
    const result = await discovery(ssdp, nat, { ssdpTimeoutMs: 45, natPmpTimeoutMs: 45 })({ host });
    assert.equal(result.supported, false, mode);
    assert.equal(web.requests.length, 1, mode);
    assert.equal(web.requests[0].method, 'GET');
  }
});

test('router HTTP redirects are not followed', async t => {
  const ctx = await routerFixture(t, (_request, response, base) => {
    response.writeHead(302, { Location: `${base}/redirected` }); response.end();
  });
  const result = await ctx.discover({ host });
  assert.equal(result.supported, false);
  assert.deepEqual(ctx.web.requests.map(item => item.url), ['/device.xml']);
});

test('DTD/entity declarations and malformed XML are rejected without SOAP or external entity loading', async t => {
  const nat = await udpFixture(t);
  for (const body of ['<!DOCTYPE root [<!ENTITY leak SYSTEM "file:///C:/Windows/win.ini">]><root>&leak;</root>',
    '<root><device></root>', '<root><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>&unknown;</root>']) {
    const web = await httpFixture(t, (_request, response) => response.end(body));
    const ssdp = await ssdpFixture(t, `${web.base}/device.xml`);
    const result = await discovery(ssdp, nat, { ssdpTimeoutMs: 45, natPmpTimeoutMs: 45 })({ host });
    assert.equal(result.supported, false);
    assert.equal(web.requests.length, 1);
  }
});

test('oversized XML and hanging HTTP cannot exceed the discovery deadline', async t => {
  const nat = await udpFixture(t);
  for (const mode of ['size', 'hang']) {
    const web = await httpFixture(t, (_request, response) => {
      if (mode === 'size') response.end(`<root>${'x'.repeat(180000)}</root>`);
    });
    const ssdp = await ssdpFixture(t, `${web.base}/device.xml`);
    const started = performance.now();
    const result = await discovery(ssdp, nat, { ssdpTimeoutMs: 45, natPmpTimeoutMs: 45, httpTimeoutMs: 90,
      overallTimeoutMs: 350 })({ host });
    assert.equal(result.supported, false);
    assert.ok(performance.now() - started < 1000, mode);
  }
});

test('gateway, host and invalid WAN values are rejected in actual SOAP responses', async t => {
  const nat = await udpFixture(t);
  for (const address of [host, '0.0.0.0', '127.0.0.1', '169.254.1.2', '224.1.2.3', '240.1.2.3', '01.2.3.4', 'http://10.1.2.3']) {
    const web = await httpFixture(t, (request, response, base) =>
      response.end(request.url === '/device.xml' ? description(base) : soap(address)));
    const ssdp = await ssdpFixture(t, `${web.base}/device.xml`);
    const result = await discovery(ssdp, nat, { ssdpTimeoutMs: 45, natPmpTimeoutMs: 45 })({ host });
    assert.equal(result.supported, false, address);
    assert.equal(result.wanAddress, undefined, address);
  }
});

test('cancellation closes an in-flight HTTP query and a pre-aborted query does no work', async t => {
  let controller = new AbortController();
  const ctx = await routerFixture(t, () => controller.abort());
  const result = await ctx.discover({ host, signal: controller.signal });
  assert.equal(result.supported, false);
  assert.match(result.message, /取消/);
  assert.equal(ctx.nat.messages.length, 0);
  controller = new AbortController(); controller.abort();
  const before = ctx.ssdp.messages.length;
  const canceled = await ctx.discover({ host, signal: controller.signal });
  assert.match(canceled.message, /取消/);
  assert.equal(ctx.ssdp.messages.length, before);
});

test('an unresponsive gateway resolver also has a bounded deadline', async t => {
  const ssdp = await udpFixture(t);
  const nat = await udpFixture(t);
  const started = performance.now();
  const result = await discovery(ssdp, nat, { resolveGateway: () => new Promise(() => {}),
    gatewayTimeoutMs: 60, overallTimeoutMs: 180 })({ host });
  assert.equal(result.supported, false);
  assert.match(result.message, /网关|超时/);
  assert.ok(performance.now() - started < 800);
  assert.equal(ssdp.messages.length, 0);
  assert.equal(nat.messages.length, 0);
});

test('gateway JSON selects only the chosen interface and the lowest combined route metric', () => {
  const json = JSON.stringify([
    { host: '192.168.1.8', gateway: '192.168.1.1', interfaceIndex: 4, prefixLength: 24, routeMetric: 1, interfaceMetric: 1 },
    { host, gateway: '192.168.31.1', interfaceIndex: 6, prefixLength: 24, routeMetric: 1, interfaceMetric: 25 },
    { host, gateway: '192.168.31.2', interfaceIndex: 6, prefixLength: 24, routeMetric: 12, interfaceMetric: 5 },
    { host, gateway: '0.0.0.0', interfaceIndex: 6, prefixLength: 24, routeMetric: 0, interfaceMetric: 0 }
  ]);
  const result = selectGatewayFromJson(json, host);
  assert.equal(result.gateway, '192.168.31.2');
  assert.equal(result.interfaceIndex, 6);
  assert.equal(result.prefixLength, 24);
  assert.equal(selectGatewayFromJson('[]', host), null);
  assert.throws(() => selectGatewayFromJson('not json', host), /网关|JSON/);
});

test('native Windows gateway JSON needs no CIM route metrics and rejects ambiguous gateways', () => {
  const route = { host, gateway: '192.168.31.1', interfaceIndex: 6, prefixLength: 24 };
  assert.equal(selectGatewayFromJson(JSON.stringify([route]), host)?.gateway, route.gateway);
  assert.throws(() => selectGatewayFromJson(JSON.stringify([route, { ...route, gateway: '192.168.31.2' }]), host), /多个.*网关/);
});

test('Windows gateway command is fixed, hidden, bounded, read-only and passes the selected IP as data', async () => {
  const calls = [];
  const resolver = createWindowsGatewayResolver({ platform: 'win32', execFile: (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, JSON.stringify([{ host, gateway: '192.168.31.1', interfaceIndex: 6, prefixLength: 24,
      routeMetric: 0, interfaceMetric: 20 }]), '');
    return { kill() {} };
  } });
  const result = await resolver({ host, timeoutMs: 250 });
  assert.equal(result.gateway, '192.168.31.1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 250);
  assert.equal(calls[0].options.env.LAN_CAST_DISCOVERY_HOST, host);
  const command = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(command, /NetworkInterface\]::GetAllNetworkInterfaces\(\)/);
  assert.match(command, /GetIPProperties\(\)/);
  assert.match(command, /GatewayAddresses/);
  assert.doesNotMatch(command, /Get-NetIPAddress|Get-NetRoute|Get-CimInstance|Get-WmiObject/);
  assert.match(command, /ConvertTo-Json/);
  assert.match(command, /\$env:LAN_CAST_DISCOVERY_HOST/);
  assert.equal(command.includes(host), false);
  assert.doesNotMatch(command, /(?:Set|New|Remove)-Net|Invoke-Expression/);
  await assert.rejects(() => resolver({ host: '10.0.0.1;exit', timeoutMs: 250 }), /IPv4|网卡/);
  assert.equal(calls.length, 1);
});

test('invalid addresses and unsupported operating systems fail without guessing', async () => {
  for (const address of ['', '127.0.0.1', '0.0.0.0', 'example.invalid', 'http://10.1.2.3', '::1']) {
    const result = await discoverRouterWan({ host: address });
    assert.equal(result.supported, false, address);
    assert.equal(result.wanAddress, undefined, address);
    assert.match(result.message, /网卡|IPv4|本机/);
  }
  const resolver = createWindowsGatewayResolver({ platform: 'linux', execFile: () => assert.fail('Must not spawn PowerShell') });
  await assert.rejects(() => resolver({ host }), /Windows/);
});
