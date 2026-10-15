import { HostMedia } from './host-media.js';
import { CaptureSession } from './capture-session.mjs';
import { createAudioMixer } from './audio-mixer.mjs';
import { createRtmpRecorder } from './rtmp-recorder.mjs';
import { createShareController } from './share.js';
import { createMicrophoneController } from './microphone-controller.mjs';
import { createSettingsAutosave } from './settings-autosave.mjs';
import { createRouterAddressController } from './router-address.mjs';
import { videoCodecSupport } from '../shared/rtc.js';

const $ = id => document.getElementById(id);
let networks = [], sources = [], selected = null, sourceTab = 'screen';
let media = null, running = false, busy = false, muted = false, viewers = [];
let sourceRequest = 0, noticeTimer, statsTimer;
let capture = null, stoppingTask = null;
let audioMixer = null;
let activeRoomId = null, rtmpInfo = null, rtmpRecorder = null;
let initialized = false, uiClosing = false;
const peerStates = new Map();
const peerCodecs = new Map();
const microphones = createMicrophoneController({ mediaDevices: navigator.mediaDevices,
  getBusy: () => busy || running || uiClosing,
  onDevices: (devices, selection) => {
    $('mic-device').replaceChildren(new Option('系统默认麦克风', ''), ...devices.map(device => new Option(device.label, device.deviceId)));
    $('mic-device').value = selection;
  },
  onState: state => {
    $('microphone-status').textContent = state.message;
    $('microphone-status').classList.toggle('error', ['permission-denied', 'no-devices', 'device-unavailable', 'error'].includes(state.status));
  }
});
const autosave = createSettingsAutosave({ read: () => ({ ...getConfig(), micDeviceId: microphones.getState().preferredId }),
  save: config => window.lan.saveSettings(config),
  onState: ({ status, error }) => {
    $('settings-status').textContent = { pending: '正在等待保存…', saving: '正在保存设置…', saved: '设置已自动保存', error: '设置未保存，请检查输入或文件权限' }[status];
    $('settings-status').classList.toggle('error', status === 'error');
    $('settings-status').title = error?.message || '';
  }
});
const share = createShareController({ notify, onConfigChanged: () => { if (initialized) { void router.changed(); autosave.schedule(); } } });
const router = createRouterAddressController({
  read: () => { const config = share.getConfig(); return { enabled: config.forwardingEnabled && !uiClosing, automatic: config.autoRouterAddress, host: $('network').value }; },
  detect: host => window.lan.detectRouter(host), cancel: () => window.lan.cancelRouterDetection(),
  onAddress: address => { share.setRouterAddress(address); if (initialized) autosave.schedule(); },
  onState: state => {
    $('router-status').textContent = state.message;
    $('router-status').classList.toggle('error', ['error', 'unsupported'].includes(state.status));
  }
});

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = String(message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 11000 : 3000);
}

function getConfig() {
  return { host: $('network').value, port: Number($('port').value), roomName: $('room').value,
    resolution: $('resolution').value, fps: Number($('fps').value), bitrateMbps: Number($('bitrate').value),
    maxViewers: Number($('max-viewers').value), microphone: $('microphone').checked, micDeviceId: $('mic-device').value,
    systemAudio: $('system-audio').checked, systemVolume: Number($('system-volume').value), micVolume: Number($('mic-volume').value),
    codec: $('codec').value, udpMin: Number($('udp-min').value), udpMax: Number($('udp-max').value),
    networkName: networks.find(network => network.address === $('network').value)?.name || '', sourceType: sourceTab, ...share.getConfig() };
}

function updateBudget() {
  const budget = Number($('bitrate').value) * Number($('max-viewers').value);
  $('budget-value').textContent = `${budget} / 70 Mbps`;
  $('budget-bar').value = Math.min(budget, 70);
  document.querySelector('.budget').classList.toggle('over', budget > 70);
}

function updateControls() {
  for (const control of document.querySelectorAll('.config-control')) control.disabled = uiClosing || busy || running;
  $('mic-device').disabled = uiClosing || busy || running || !$('microphone').checked;
  $('system-volume').disabled = uiClosing || busy || !$('system-audio').checked;
  $('mic-volume').disabled = uiClosing || busy || !$('microphone').checked;
  $('system-volume-value').textContent = `${$('system-volume').value}%`;
  $('mic-volume-value').textContent = `${$('mic-volume').value}%`;
  $('start').disabled = uiClosing || !!stoppingTask || (!capture && busy) || (!capture && !selected);
  $('start').classList.toggle('stop', !!capture || running);
  $('start').querySelector('span:last-child').textContent = stoppingTask ? '正在停止…' : running ? '停止广播' : capture ? '取消准备' : '开始广播';
  $('status').classList.toggle('live', running);
  $('status-text').textContent = running ? '正在广播' : stoppingTask ? '正在停止' : busy ? '正在准备' : '尚未广播';
}

async function refreshNetworks(preferred, preferredName) {
  networks = await window.lan.getNetworks();
  const chosen = preferred || $('network').value;
  $('network').replaceChildren(...networks.map(network => {
    const option = document.createElement('option');
    option.value = network.address;
    option.textContent = `${network.name} · ${network.address}${network.virtual ? '（虚拟）' : ''}`;
    return option;
  }));
  $('network').value = networks.some(n => n.address === chosen) ? chosen : networks.find(n => n.name === preferredName)?.address || networks[0].address;
  networkDetail();
}

function networkDetail() {
  const network = networks.find(item => item.address === $('network').value);
  $('network-detail').textContent = network?.local ? '仅本机可看；其他设备请选局域网网卡。' : `IPv4 ${network?.address} / ${network?.netmask}`;
}

async function refreshSources() {
  const request = ++sourceRequest;
  $('source-list').textContent = '正在读取画面…';
  try {
    const list = await window.lan.getSources(sourceTab);
    if (request !== sourceRequest) return;
    sources = list;
    selected = sources.find(item => item.id === selected?.id) || null;
    $('source-list').replaceChildren();
    if (!list.length) {
      const text = document.createElement('p'); text.className = 'source-error';
      text.textContent = '未找到可采集画面。请打开目标窗口，再点击“刷新画面”。';
      $('source-list').append(text);
    }
    for (const source of list) {
      const button = document.createElement('button');
      button.className = 'source-card config-control'; button.title = source.name;
      const img = document.createElement('img'); img.alt = `${source.name}预览`;
      if (source.thumbnail) img.src = source.thumbnail;
      const name = document.createElement('span'); name.textContent = source.name;
      button.append(img, name); button.classList.toggle('selected', selected?.id === source.id);
      button.setAttribute('aria-pressed', String(selected?.id === source.id));
      button.addEventListener('click', () => {
        if (running || busy) return;
        selected = source;
        $('source-name').textContent = source.name;
        for (const card of $('source-list').children) { card.classList.remove('selected'); card.setAttribute('aria-pressed', 'false'); }
        button.classList.add('selected'); button.setAttribute('aria-pressed', 'true');
        updateControls();
      });
      $('source-list').append(button);
    }
    if (!selected && !running) $('source-name').textContent = '选择要分享的画面';
    updateControls();
  } catch (error) { $('source-list').textContent = '读取画面失败，请重试。'; notify(error.message, true); }
}

function renderViewers() {
  $('viewer-count').textContent = String(viewers.length);
  $('viewers').replaceChildren();
  $('participants-note').textContent = running ? `${viewers.length} / ${getConfig().maxViewers} 台` : '开始广播后显示连接设备';
  if (!viewers.length) {
    const empty = document.createElement('p'); empty.className = 'empty-list'; empty.textContent = running ? '链接已准备好，等待设备加入。' : '还没有设备加入。'; $('viewers').append(empty);
  }
  const states = { new: '正在连接', connecting: '正在连接', connected: '正在观看', disconnected: '网络波动', failed: '连接失败', timeout: '连接超时', error: '协商失败', closed: '已断开' };
  for (const viewer of viewers) {
    const row = document.createElement('div'); row.className = 'viewer-row';
    const avatar = document.createElement('div'); avatar.className = 'viewer-avatar'; avatar.textContent = '▣';
    const detail = document.createElement('div'); detail.className = 'viewer-detail';
    const name = document.createElement('strong'); name.textContent = viewer.name;
    const address = document.createElement('span'); address.textContent = viewer.address;
    detail.append(name, address);
    const codec = peerCodecs.get(viewer.id);
    if (codec || viewer.protocol === 'rtmp') {
      const format = document.createElement('span'); format.className = 'viewer-codec';
      format.textContent = viewer.protocol === 'rtmp' ? `RTMP · ${rtmpInfo?.codec || '正在协商编码'}` : codec.actual ? `实际编码 ${codec.actual}${codec.fallback ? ' · 已回落' : ''}` : codec.message || '正在协商编码';
      format.title = codec?.message || ''; detail.append(format);
    }
    const state = document.createElement('span'); state.className = 'peer-state'; state.textContent = viewer.protocol === 'rtmp' ? '播放器接收' : states[peerStates.get(viewer.id)] || '正在连接';
    const kick = document.createElement('button'); kick.className = 'text-button'; kick.textContent = '断开'; kick.title = `断开 ${viewer.name}`;
    kick.addEventListener('click', () => window.lan.kick(viewer.id).catch(error => notify(error.message, true)));
    row.append(avatar, detail, state, kick); $('viewers').append(row);
  }
}

async function startBroadcast() {
  if (!selected || capture || busy || stoppingTask) return;
  const config = getConfig();
  microphones.cancel();
  const current = new CaptureSession(() => window.lan.stop());
  capture = current;
  busy = true; updateControls();
  try {
    await current.wait(() => window.lan.selectSource(selected.id, config));
    const displayStream = await current.wait(() => navigator.mediaDevices.getDisplayMedia({
      audio: config.systemAudio ? {echoCancellation: false, noiseSuppression: false, autoGainControl: false} : false,
      video: {frameRate: {ideal: config.fps}}, systemAudio: 'include'
    }), value => current.ownStream(value));
    const track = displayStream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('采集源已结束，请重新选择画面');
    const sourceEnded = () => {
      if (capture !== current) return;
      notify('采集源已结束，广播已停止。');
      void stopBroadcast();
    };
    track.addEventListener('ended', sourceEnded);
    current.disposeWith(() => track.removeEventListener('ended', sourceEnded));
    if (config.systemAudio) {
      if (!displayStream.getAudioTracks().some(audio => audio.readyState === 'live')) throw new Error('未取得系统声音音轨，请检查 Windows 输出设备，或关闭系统声音后重试');
      for (const audio of displayStream.getAudioTracks()) {
        const systemEnded = () => {
          if (capture !== current) return;
          $('system-audio-status').textContent = '系统声音采集中断，请停止后重新开始。';
          if (running) notify('系统声音采集中断，画面广播仍在继续。', true);
          else { notify('系统声音采集中断，广播准备已停止，请检查输出设备后重试。', true); void stopBroadcast(); }
        };
        audio.addEventListener('ended', systemEnded);
        current.disposeWith(() => audio.removeEventListener('ended', systemEnded));
      }
    }
    const limits = { frameRate: { ideal: config.fps, max: config.fps } };
    if (config.resolution !== 'native') { limits.width = { max: config.resolution === '720' ? 1280 : 1920 }; limits.height = { max: config.resolution === '720' ? 720 : 1080 }; }
    await current.wait(() => track.applyConstraints(limits));
    track.contentHint = config.fps === 60 ? 'motion' : 'detail';
    let micStream = null;
    if (config.microphone) {
      micStream = await current.wait(() => navigator.mediaDevices.getUserMedia({ audio: { deviceId: config.micDeviceId ? { exact: config.micDeviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }), value => current.ownStream(value));
      if (!micStream.getAudioTracks().some(audio => audio.readyState === 'live')) throw new Error('未取得麦克风音轨，请检查麦克风设备');
      for (const audio of micStream.getAudioTracks()) {
        const microphoneEnded = () => {
          if (capture !== current) return;
          if (running) notify('麦克风已断开，画面广播仍在继续。', true);
          else { notify('麦克风已断开，广播准备已停止，请检查设备后重试。', true); void stopBroadcast(); }
        };
        audio.addEventListener('ended', microphoneEnded);
        current.disposeWith(() => audio.removeEventListener('ended', microphoneEnded));
      }
    }
    const mixed = await current.wait(() => createAudioMixer({capture: current, displayStream, microphoneStream: micStream,
      systemAudio: config.systemAudio, systemVolume: config.systemVolume, micVolume: config.micVolume}));
    const stream = mixed.stream;
    audioMixer = mixed;
    current.disposeWith(() => {if (audioMixer === mixed) audioMixer = null;});
    current.assertActive();
    if (track.readyState !== 'live') throw new Error('采集源已结束，请重新选择画面');
    const activeMedia = new HostMedia(stream, config, (id, signal) => window.lan.sendSignal(id, signal), (id, state, _message, codec) => {
      if (capture !== current || current.cancelled) return;
      peerStates.set(id, state); if (codec) peerCodecs.set(id, codec); renderViewers();
      const retryReason = { timeout: 'timeout', error: 'negotiation', failed: 'failed' }[state];
      if (retryReason) {
        activeMedia.remove(id);
        void window.lan.retry(id, retryReason).catch(error => { if (capture === current) notify(error.message, true); });
      }
    });
    media = activeMedia;
    current.disposeWith(() => activeMedia.stop());
    const sessionInfo = await current.wait(() => window.lan.start(config));
    if (track.readyState !== 'live') throw new Error('采集源已结束，请重新选择画面');
    running = true; muted = false;
    $('system-audio-status').textContent = config.systemAudio ? '正在采集整台电脑播放的声音。' : '采集整台电脑播放的声音，包含其他应用。';
    busy = false;
    $('preview').srcObject = stream; $('preview').classList.add('active'); $('preview-empty').hidden = true;
    $('live-label').hidden = false;
    const size = track.getSettings(); $('preview-size').textContent = `${size.width} × ${size.height} · ${config.fps} fps 上限`;
    share.show(sessionInfo, config);
    activeRoomId = sessionInfo.roomId;
    rtmpInfo = sessionInfo.rtmp;
    if (config.rtmpEnabled) {
      const recorder = createRtmpRecorder({ stream, config, roomId: sessionInfo.roomId, api: window.lan,
        onError: message => { if (capture === current && !current.cancelled) notify(message, true); } });
      rtmpRecorder = recorder;
      current.disposeWith(() => { recorder.dispose(); if (rtmpRecorder === recorder) rtmpRecorder = null; });
      void recorder.start();
    }
    $('mute').hidden = !config.microphone; $('mute').textContent = '麦克风静音';
    // Persistence does not own live media or delay the stop button. A late
    // failure from a previous broadcast must not change the new session UI.
    void autosave.flush().catch(error => { if (capture === current && !current.cancelled) notify(`广播已开始，但设置保存失败：${error.message}`, true); });
    statsTimer = setInterval(async () => {
      const active = media;
      if (!running || !active) return;
      try {
        const stats = await active.stats();
        if (active === media) {
          $('upload').textContent = `${(stats.total + (Number(rtmpInfo?.uploadMbps) || 0)).toFixed(1)} Mbps`;
          for (const codec of stats.codecs || []) peerCodecs.set(codec.id, codec);
          renderViewers();
        }
      } catch { /* A peer may close during a stats sample. */ }
    }, 1500);
    renderViewers(); updateControls();
  } catch (error) {
    if (capture === current) await stopBroadcast();
    if (!current.cancelled || error.name !== 'CaptureCancelled') notify(`无法开始广播：${error.message}。请检查启用的声音设备和 Windows 权限。`, true);
  } finally {
    if (capture === current) { busy = false; updateControls(); }
  }
}

async function stopBroadcast() {
  if (stoppingTask) return stoppingTask;
  const current = capture;
  capture = null;
  busy = true; running = false; updateControls();
  clearInterval(statsTimer);
  const stopped = current ? current.cancel() : window.lan.stop();
  media = null;
  audioMixer = null;
  activeRoomId = null; rtmpInfo = null; rtmpRecorder = null;
  $('preview').srcObject = null; $('preview').classList.remove('active'); $('preview-empty').hidden = false; $('live-label').hidden = true;
  $('preview-size').textContent = '—'; $('upload').textContent = '—'; $('mute').hidden = true;
  $('system-audio-status').textContent = '采集整台电脑播放的声音，包含其他应用。';
  share.clear();
  viewers = []; peerStates.clear(); peerCodecs.clear(); renderViewers();
  stoppingTask = Promise.resolve(stopped).catch(error => notify(error.message, true)).finally(() => {
    stoppingTask = null;
    if (!capture) { busy = false; updateControls(); if (!uiClosing) void microphones.refresh(); }
  });
  updateControls();
  return stoppingTask;
}

window.lan.onEvent(({ type, payload }) => {
  if (type === 'viewer-joined' && media && payload.protocol !== 'rtmp') {
    const active = media;
    void active.add(payload.id).catch(error => { if (media === active) notify(`设备连接失败：${error.message}`, true); });
  }
  if (type === 'viewer-left') { media?.remove(payload.id); peerStates.delete(payload.id); peerCodecs.delete(payload.id); }
  if (type === 'signal' && media) void media.signal(payload).catch(error => notify(`连接协商失败：${error.message}`, true));
  if (type === 'viewers') { viewers = payload; renderViewers(); }
  if (type === 'rtmp-state' && payload.roomId === activeRoomId) {
    if (['error', 'stopped'].includes(payload.phase)) { rtmpRecorder?.dispose(); rtmpRecorder = null; }
    rtmpInfo = payload; share.updateRtmp(payload); renderViewers();
  }
  if (type === 'error') { notify(`广播服务异常：${payload}`, true); void stopBroadcast(); }
  if (type === 'stop-error' || type === 'close-error') notify(payload, true);
  if (type === 'session-info' && running) {
    share.setRouterAddress(payload.advertisedHost);
    if (media) media.config = { ...media.config, advertisedHost: payload.advertisedHost };
    share.updateSession(payload.info, getConfig()); autosave.schedule();
    notify('路由器 WAN 地址已变化，观看链接和二维码已更新，请重新分享。');
  }
  if (type === 'prepare-close') {
    uiClosing = true; microphones.dispose(); router.dispose(); updateControls();
    void (async () => {
      await stopBroadcast();
      try { await autosave.flush(); } catch { /* The last valid configuration stays on disk. */ }
      autosave.dispose();
      await window.lan.readyToClose(payload.requestId).catch(() => {});
    })();
  }
});

$('start').addEventListener('click', () => capture || running ? void stopBroadcast() : void startBroadcast());
$('network').addEventListener('change', networkDetail);
$('refresh-networks').addEventListener('click', () => refreshNetworks().then(() => { void router.changed(); autosave.schedule(); }).catch(error => notify(error.message, true)));
$('refresh-sources').addEventListener('click', refreshSources);
for (const tab of document.querySelectorAll('[data-source-tab]')) tab.addEventListener('click', () => {
  if (running || busy) return;
  sourceTab = tab.dataset.sourceTab; selected = null;
  for (const button of document.querySelectorAll('[data-source-tab]')) { button.classList.toggle('active', button === tab); button.setAttribute('aria-selected', String(button === tab)); }
  updateControls(); void refreshSources(); if (initialized) autosave.schedule();
});
for (const id of ['bitrate', 'max-viewers']) $(id).addEventListener('input', updateBudget);
$('microphone').addEventListener('change', async () => {
  updateControls();
  if ($('microphone').checked) {
    const state = await microphones.refresh({ requestPermission: true });
    if (['permission-denied', 'no-devices', 'device-unavailable', 'error'].includes(state.status) && !busy && !running) {
      $('microphone').checked = false; notify(state.message, true); updateControls();
    }
  } else microphones.cancel();
  if (initialized) autosave.schedule();
});
$('refresh-microphones').addEventListener('click', () => { void microphones.refresh({ requestPermission: true }); });
$('mic-device').addEventListener('change', () => { microphones.setPreferred($('mic-device').value); if (initialized) autosave.schedule(); });
$('detect-router').addEventListener('click', () => { void router.refresh({ force: true }); });
$('mute').addEventListener('click', () => { muted = !muted; audioMixer?.setMicrophoneMuted(muted); $('mute').textContent = muted ? '取消麦克风静音' : '麦克风静音'; });
$('system-audio').addEventListener('change', updateControls);
for (const [id, apply] of [['system-volume', value => audioMixer?.setSystemVolume(value)], ['mic-volume', value => audioMixer?.setMicrophoneVolume(value)]]) {
  $(id).addEventListener('input', () => {
    apply(Number($(id).value)); updateControls();
    if (initialized && !uiClosing) autosave.schedule();
  });
}
for (const control of document.querySelectorAll('input.config-control, select.config-control')) {
  for (const event of ['input', 'change']) control.addEventListener(event, () => { if (initialized && !uiClosing) autosave.schedule(); });
}
window.addEventListener('pagehide', () => { microphones.dispose(); router.dispose(); autosave.dispose(); });

async function init() {
  const settings = await window.lan.getSettings();
  const mapping = { port: 'port', roomName: 'room', resolution: 'resolution', fps: 'fps', bitrateMbps: 'bitrate', maxViewers: 'max-viewers', codec: 'codec', udpMin: 'udp-min', udpMax: 'udp-max', systemVolume: 'system-volume', micVolume: 'mic-volume' };
  for (const [key, id] of Object.entries(mapping)) if (settings[key] != null) $(id).value = settings[key];
  $('microphone').checked = settings.microphone === true;
  $('system-audio').checked = settings.systemAudio === true;
  await refreshNetworks(settings.host, settings.networkName);
  microphones.setPreferred(settings.micDeviceId); await microphones.refresh();
  share.loadSettings(settings);
  sourceTab = settings.sourceType === 'window' ? 'window' : 'screen';
  for (const button of document.querySelectorAll('[data-source-tab]')) { const active = button.dataset.sourceTab === sourceTab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }
  const capabilities = videoCodecSupport('send');
  $('codec-support').textContent = capabilities.hevc ? '本机支持 HEVC 发送；接收端不支持时自动回落，每台设备会显示实际编码。' : '本机未提供 HEVC 发送能力，选择 HEVC 时将回落到 H.264 / VP8。';
  updateBudget(); await refreshSources(); initialized = true; updateControls(); router.start();
}
void init().catch(error => notify(`初始化失败：${error.message}`, true));
