export function createShareController({ notify, onConfigChanged }) {
  const $ = id => document.getElementById(id);
  let session = null;
  let activeConfig = null;

  function getConfig() {
    return { forwardingEnabled: $('forwarding-enabled').checked,
      advertisedHost: $('advertised-host').value.trim(), advertisedPort: Number($('advertised-port').value),
      autoRouterAddress: $('auto-router-address').checked,
      rtmpEnabled: $('rtmp-enabled').checked, rtmpPort: Number($('rtmp-port').value),
      advertisedRtmpPort: Number($('advertised-rtmp-port').value),
      rtmpCodec: $('rtmp-codec').value, rtmpAcceleration: $('rtmp-acceleration').value };
  }

  function mappingText() {
    const forwarding = getConfig();
    const host = $('network').value || '所选电脑 IPv4';
    const udp = `${$('udp-min').value}–${$('udp-max').value}`;
    return `二级路由器 WAN 地址：${forwarding.advertisedHost || '请填写 WAN IPv4'}\n` +
      `目标电脑 LAN 地址：${host}\n` +
      `TCP ${forwarding.advertisedPort || '对外端口'} → ${host}:${$('port').value}\n` +
      `UDP ${udp} → ${host} 的相同端口 ${udp}\n` +
      '请使用相同的 UDP 外部 / 内部端口，不要改变媒体端口号。\n' +
      (forwarding.rtmpEnabled
        ? `RTMP TCP ${forwarding.advertisedRtmpPort || '对外 RTMP 端口'} → ${host}:${forwarding.rtmpPort || '本机 RTMP 端口'}\nRTMP 仅需 TCP 转发；网页媒体还需上述 UDP 范围。\n`
        : '') +
      '请在 DHCP 中固定电脑地址，并允许程序通过 Windows 防火墙。';
  }

  function updateMapping() {
    $('forwarding-fields').hidden = !$('forwarding-enabled').checked;
    $('advertised-host').readOnly = $('auto-router-address').checked;
    $('rtmp-port-fields').hidden = !$('rtmp-enabled').checked;
    $('advertised-rtmp-fields').hidden = !$('rtmp-enabled').checked;
    $('mapping-list').textContent = mappingText();
    if (!session) updateRtmpPresentation();
  }

  function selectedInvitation() {
    const forwarded = $('share-target').value === 'forwarded';
    return { target: forwarded ? 'forwarded' : 'local',
      invite: forwarded ? session?.forwardedInviteUrl : (session?.localInviteUrl || session?.inviteUrl),
      url: forwarded ? session?.forwardedUrl : (session?.localUrl || session?.url),
      qr: forwarded ? session?.forwardedQr : (session?.localQr || session?.qr),
      rtmpUrl: forwarded ? session?.rtmp?.forwardedUrl : session?.rtmp?.localUrl };
  }

  function updateRtmpPresentation() {
    const state = session?.rtmp;
    const enabled = state ? state.enabled === true : $('rtmp-enabled').checked;
    const item = selectedInvitation();
    const ready = enabled && state?.phase === 'ready' && !!item.rtmpUrl;
    $('rtmp-link').value = enabled ? item.rtmpUrl || '' : '';
    $('rtmp-link').placeholder = enabled ? '开始广播后生成 RTMP 地址' : 'RTMP 已关闭';
    $('copy-rtmp').disabled = !ready;
    $('rtmp-status').dataset.phase = state?.phase || 'stopped';
    $('rtmp-status').classList.toggle('error', enabled && state?.phase === 'error');
    const phases = { preparing: '正在准备 RTMP 服务…', waiting: 'RTMP 服务就绪，等待画面…',
      starting: '正在生成 RTMP 媒体…',
      error: 'RTMP 暂不可用，网页观看仍可继续。', stopped: 'RTMP 已停止。' };
    $('rtmp-status').textContent = !enabled ? 'RTMP 已关闭；网页观看仍可用。'
      : !state ? '开始广播后可用播放器观看。'
      : state.phase === 'ready' ? `${readyRtmpText(state)}${!item.rtmpUrl ? '；当前网络尚无 RTMP 地址，请检查一级网络设置' : ''}`
      : state.message || phases[state.phase] || '正在准备 RTMP…';
  }

  function readyRtmpText(state) {
    const copiedVideo = state.encoder === 'copy';
    const acceleration = copiedVideo ? '视频直接复制' : state.hardware === true ? '硬件编码'
      : state.hardware === false ? '软件编码' : '加速状态待确认';
    let text = `RTMP 已可用 · ${state.codec || '实际编码待确认'} · ${state.encoder || '编码器待确认'} · ${acceleration}`;
    if (!copiedVideo && state.hardware === false && (activeConfig?.rtmpAcceleration ?? 'auto') === 'auto') {
      text += '；没有可用硬件编码器，已回落到软件编码';
    }
    if (/HEVC|H[.\s]?265/i.test(state.codec || '')) text += '；Enhanced RTMP，播放器需要支持 HEVC';
    if (state.message) text += `。${state.message}`;
    return text;
  }

  function updateInvitation() {
    if (!session) return;
    const item = selectedInvitation();
    $('invite-link').value = item.invite || '';
    $('plain-url').textContent = item.url || '—';
    $('pin').textContent = session.pin;
    $('qr').hidden = !item.qr;
    if (item.qr) $('qr').src = item.qr; else $('qr').removeAttribute('src');
    $('qr-placeholder').hidden = !!item.qr;
    for (const id of ['copy-link', 'copy-code']) $(id).disabled = !item.invite;
    $('share-description').textContent = item.target === 'forwarded'
      ? '供一级网络用户打开。请按左侧清单完成端口转发，再分享对应地址。'
      : activeConfig?.host === '127.0.0.1' ? '当前仅供本机测试。其他设备观看时，请改选局域网网卡。'
      : '本路由器内的设备打开链接或扫码，再点击“开始观看”。一级网络用户请选择上面的对应入口。';
    updateRtmpPresentation();
  }

  function show(info, config) {
    session = { ...info, rtmp: info.rtmp || { enabled: config?.rtmpEnabled !== false,
      phase: 'preparing', localUrl: '', forwardedUrl: '' } }; activeConfig = config;
    const option = $('share-target').querySelector('[value="forwarded"]');
    option.disabled = !info.forwardedInviteUrl;
    $('share-target').disabled = false;
    $('share-target').value = info.forwardedInviteUrl ? 'forwarded' : 'local';
    updateInvitation();
  }

  function clear() {
    session = null; activeConfig = null;
    $('invite-link').value = ''; $('plain-url').textContent = '—'; $('pin').textContent = '------';
    $('qr').hidden = true; $('qr').removeAttribute('src'); $('qr-placeholder').hidden = false;
    $('share-target').disabled = true;
    $('share-target').querySelector('[value="forwarded"]').disabled = true;
    for (const id of ['copy-link', 'copy-code']) $(id).disabled = true;
    $('share-description').textContent = '开始广播后，分享链接或扫描二维码即可观看。';
    updateRtmpPresentation();
  }

  function loadSettings(settings) {
    $('forwarding-enabled').checked = settings.forwardingEnabled === true;
    $('auto-router-address').checked = settings.autoRouterAddress !== false;
    $('advertised-host').value = typeof settings.advertisedHost === 'string' ? settings.advertisedHost : '';
    if (settings.advertisedPort != null) $('advertised-port').value = settings.advertisedPort;
    $('rtmp-enabled').checked = settings.rtmpEnabled !== false;
    $('rtmp-port').value = settings.rtmpPort ?? 1935;
    $('advertised-rtmp-port').value = settings.advertisedRtmpPort ?? 1935;
    $('rtmp-codec').value = settings.rtmpCodec ?? 'HEVC';
    $('rtmp-acceleration').value = settings.rtmpAcceleration ?? 'auto';
    updateMapping();
  }

  const failed = error => notify(error.message, true);
  const modeChanged = () => { updateMapping(); onConfigChanged?.(getConfig()); };
  $('forwarding-enabled').addEventListener('change', modeChanged);
  $('auto-router-address').addEventListener('change', modeChanged);
  $('rtmp-enabled').addEventListener('change', modeChanged);
  $('rtmp-codec').addEventListener('change', modeChanged);
  $('rtmp-acceleration').addEventListener('change', modeChanged);
  for (const id of ['advertised-host', 'advertised-port', 'port', 'udp-min', 'udp-max']) $(id).addEventListener('input', updateMapping);
  for (const id of ['rtmp-port', 'advertised-rtmp-port']) {
    $(id).addEventListener('input', modeChanged);
    $(id).addEventListener('change', modeChanged);
  }
  $('network').addEventListener('change', modeChanged);
  $('copy-mapping').addEventListener('click', () => window.lan.copy(mappingText()).then(() => notify('路由器配置清单已复制。')).catch(failed));
  $('share-target').addEventListener('change', updateInvitation);
  $('copy-link').addEventListener('click', () => {
    const item = selectedInvitation();
    if (item.invite) void window.lan.copy(item.invite).then(() => notify('观看链接已复制。')).catch(failed);
  });
  $('copy-code').addEventListener('click', () => {
    const item = selectedInvitation();
    if (item.url) void window.lan.copy(`${item.url}\n观看码：${session.pin}`).then(() => notify('地址和观看码已复制。')).catch(failed);
  });
  $('copy-rtmp').addEventListener('click', () => {
    const item = selectedInvitation();
    if (session?.rtmp?.enabled && session.rtmp.phase === 'ready' && item.rtmpUrl) {
      const message = /HEVC|H[.\s]?265/i.test(session.rtmp.codec || '')
        ? 'RTMP 地址已复制，请使用支持 Enhanced RTMP / HEVC 的播放器。'
        : 'RTMP 地址已复制，可在 PotPlayer / VLC 中打开。';
      void window.lan.copy(item.rtmpUrl).then(() => notify(message)).catch(failed);
    }
  });
  updateMapping(); clear();
  function updateSession(info, config) {
    if (!session || session.roomId !== info.roomId) return;
    // Router refreshes update addresses; RTMP state events own media readiness.
    const rtmp = session.rtmp;
    session = { ...info, rtmp: rtmp ? { ...rtmp,
      localUrl: info.rtmp?.localUrl ?? rtmp.localUrl,
      forwardedUrl: info.rtmp?.forwardedUrl ?? rtmp.forwardedUrl } : info.rtmp };
    activeConfig = config || activeConfig;
    $('share-target').querySelector('[value="forwarded"]').disabled = !session.forwardedInviteUrl;
    if (!session.forwardedInviteUrl && $('share-target').value === 'forwarded') $('share-target').value = 'local';
    updateInvitation();
  }
  function updateRtmp(payload) {
    if (!session || !payload || payload.roomId !== session.roomId) return;
    const { roomId, ...state } = payload;
    session = { ...session, rtmp: { ...session.rtmp, ...state } };
    updateRtmpPresentation();
  }
  function setRouterAddress(address) { $('advertised-host').value = address; updateMapping(); }
  return { getConfig, loadSettings, show, clear, updateSession, updateRtmp, setRouterAddress };
}
