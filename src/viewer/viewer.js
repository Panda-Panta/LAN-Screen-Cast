import { RTC_CONFIG, lowLatency, videoStats } from './rtc.js';
import { ReceiverSession } from './receiver-session.mjs';
import { invitationToken, parseInvitation } from './invitation.mjs';

const $ = id => document.getElementById(id);
const video = $('remote');
let token = invitationToken(location.hash), previous = null, currentMedia = null;
let videoFrameId = null, audioNeedsGesture = false, statusRevision = 0, statsBusy = false;
const platform = /Android/.test(navigator.userAgent) ? 'Android' : /iPhone|iPad/.test(navigator.userAgent) ? 'iOS' : /Windows/.test(navigator.userAgent) ? 'Windows' : '浏览器';
const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : '浏览器';
$('device-name').value = `${platform} · ${browser}`;
$('code-field').hidden = !!token;

function status(text, live = false) {
  $('connection-text').textContent = text;
  $('connection').classList.toggle('live', live); $('live-dot').classList.toggle('live', live);
}
function showError(text) { $('error').textContent = text; $('error').hidden = !text; }
function showJoin(text) {
  $('overlay').hidden = false; $('join-panel').hidden = false; $('connecting-panel').hidden = true;
  $('watch').disabled = false; $('watch').textContent = '开始观看';
  $('join-description').textContent = text || '连接广播电脑，实时观看屏幕或窗口。';
  $('disconnect').disabled = true; $('mute').disabled = true;
}
function diagnostics(phase, detail) {
  const complete = phase === 'watching' ? 4 : ['admitted', 'negotiating'].includes(phase) ? 2 : 1;
  const active = ['admitted', 'negotiating'].includes(phase) ? 3 : phase === 'connecting' || phase === 'retrying' ? 2 : 0;
  for (const [index, id] of ['page', 'auth', 'media', 'frame'].entries()) {
    $(`stage-${id}`).dataset.state = index + 1 <= complete ? 'complete' : index + 1 === active ? 'current' : 'waiting';
  }
  $('diagnostic-note').textContent = detail || '网页已打开。点击开始观看后，依次进行观看认证、媒体协商和视频接收。';
}
function clearMedia() {
  if (videoFrameId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameId);
  videoFrameId = null; currentMedia = null; previous = null; audioNeedsGesture = false;
  video.pause();
  for (const track of video.srcObject?.getTracks() || []) track.stop();
  video.srcObject = null;
  $('player').classList.remove('playing'); $('enable-audio').hidden = true; $('mute').disabled = true;
  for (const id of ['fps', 'bitrate', 'rtt', 'buffer', 'codec']) $(id).textContent = '—';
}
function roomName(name) { $('room-name').textContent = name; document.title = `${name} · 观看`; }
function changed(state) {
  status(state.text, state.phase === 'watching'); diagnostics(state.phase, state.detail);
  $('stream-description').textContent = state.phase === 'watching' ? '画面正在实时传输' : state.text;
  if (state.phase === 'terminal') {
    showJoin(state.text);
    if (state.code === 'AUTH') { token = ''; $('code-field').hidden = false; }
  } else if (state.phase === 'watching') {
    $('overlay').hidden = true; $('player').classList.add('playing');
    $('disconnect').disabled = false; $('mute').disabled = false;
  } else {
    $('overlay').hidden = false; $('join-panel').hidden = true; $('connecting-panel').hidden = false;
    $('connecting-message').textContent = state.text;
    $('connect-tip').textContent = state.detail;
    $('disconnect').disabled = false;
  }
}
const session = new ReceiverSession({
  createSocket: () => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`),
  createPeer: () => new RTCPeerConnection(RTC_CONFIG),
  onState: changed, onError: showError, onRoom: roomName, onClear: clearMedia,
  onTrack: (event, context) => {
    lowLatency(event.receiver);
    const stream = event.streams[0] || video.srcObject || new MediaStream();
    if (!event.streams[0] && !stream.getTracks().some(track => track.id === event.track.id)) stream.addTrack(event.track);
    currentMedia = context;
    if (video.srcObject !== stream) video.srcObject = stream;
    void play(context);
    if (video.requestVideoFrameCallback && videoFrameId === null) {
      videoFrameId = video.requestVideoFrameCallback((_time, metadata) => {
        if (!context.isCurrent()) return;
        videoFrameId = null;
        if (metadata.width > 0 && metadata.height > 0) session.noteVideoFrame(context.peer);
      });
    }
  },
});

async function play(context = currentMedia, enableSound = false) {
  if (!context?.isCurrent()) return;
  if (enableSound) { video.muted = false; audioNeedsGesture = false; }
  try {
    await video.play();
    if (!context.isCurrent()) return;
    $('enable-audio').textContent = '点击开启声音';
    $('enable-audio').hidden = !(audioNeedsGesture && video.srcObject?.getAudioTracks().length);
  } catch {
    if (!context.isCurrent()) return;
    // Audio autoplay may require another gesture. Keep the video useful while
    // showing an explicit sound button; never declare blocked playback a loss
    // of the UDP media connection.
    video.muted = true; audioNeedsGesture = true;
    try {
      await video.play();
      if (!context.isCurrent()) return;
      $('enable-audio').textContent = '点击开启声音';
      $('enable-audio').hidden = !video.srcObject?.getAudioTracks().length;
    } catch {
      if (!context.isCurrent()) return;
      $('enable-audio').textContent = '点击播放画面与声音'; $('enable-audio').hidden = false;
    }
  }
  if (context.isCurrent()) $('mute').textContent = video.muted ? '取消静音' : '静音';
}

$('watch').addEventListener('click', () => {
  if (!('RTCPeerConnection' in window)) { showError('此浏览器不支持实时画面，请使用新版 Chrome 或 Edge。'); return; }
  const pin = $('access-code').value.trim();
  if (!token && !/^\d{6}$/.test(pin)) { showError('请输入广播电脑显示的 6 位观看码。'); $('access-code').focus(); return; }
  video.muted = false; $('mute').textContent = '静音';
  session.start({ token, pin, name: $('device-name').value.trim() || `${platform} · ${browser}` });
});
$('access-code').addEventListener('keydown', event => { if (event.key === 'Enter') $('watch').click(); });
$('cancel').addEventListener('click', () => session.stop('已取消连接'));
$('disconnect').addEventListener('click', () => session.stop('已断开连接'));
$('enable-audio').addEventListener('click', () => { void play(currentMedia, true); });
$('mute').addEventListener('click', () => {
  video.muted = !video.muted; audioNeedsGesture = false; $('enable-audio').hidden = true;
  $('mute').textContent = video.muted ? '取消静音' : '静音';
  if (!video.muted) void play(currentMedia, true);
});
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('player').requestFullscreen(); }
  catch { showError('此浏览器暂时无法进入全屏，请使用浏览器的全屏功能。'); }
});
document.addEventListener('fullscreenchange', () => { $('fullscreen').textContent = document.fullscreenElement ? '退出全屏' : '全屏'; });
$('invite-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const url = parseInvitation($('invite-address').value);
    session.stop('', false); showError('');
    if (url === location.href) refreshInvitation();
    else location.assign(url);
  } catch (error) { showError(error.message); $('invite-address').focus(); }
});

function refreshInvitation() {
  session.stop('', false); token = invitationToken(location.hash);
  $('code-field').hidden = !!token; $('access-code').value = '';
  showError(''); showJoin(); status('准备观看');
  $('stream-description').textContent = '尚未开始观看'; diagnostics('idle');
  if (location.hash && !token) showError('邀请已失效或格式不正确，可粘贴新邀请，或使用 6 位观看码。');
  void loadStatus();
}
window.addEventListener('online', () => { if (session.desired && !session.socket) session.open(); });
window.addEventListener('hashchange', refreshInvitation);
window.addEventListener('pagehide', () => { statusRevision++; session.stop('', false); });

setInterval(async () => {
  const current = session.peer;
  if (statsBusy || !current || current.connectionState !== 'connected') return;
  statsBusy = true;
  try {
    const stats = await videoStats(current, previous);
    if (current !== session.peer || !session.desired) return;
    previous = stats.previous;
    if (stats.previous?.frames > 0) session.noteVideoFrame(current);
    $('fps').textContent = stats.fps === null ? '—' : `${Math.round(stats.fps)} fps`;
    $('bitrate').textContent = stats.mbps === null ? '—' : `${stats.mbps.toFixed(1)} Mbps`;
    $('rtt').textContent = stats.rtt === null ? '—' : `${stats.rtt} ms`;
    $('buffer').textContent = stats.buffer === null ? '—' : `${stats.buffer} ms`;
    $('codec').textContent = `${stats.codec || '视频'} · ${video.videoWidth} × ${video.videoHeight}`;
  } catch { /* A peer may close while getStats is pending. */ }
  finally { statsBusy = false; }
}, 1500);

async function loadStatus() {
  const revision = ++statusRevision;
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('网页服务不可达');
    const info = await response.json();
    if (revision !== statusRevision || session.desired) return;
    roomName(info.roomName || '局域网投屏');
  } catch {
    if (revision !== statusRevision || session.desired) return;
    status('广播电脑暂时不可达');
    showError('请检查广播是否开启、观看地址和 TCP 网页端口转发。');
  }
}
refreshInvitation();
