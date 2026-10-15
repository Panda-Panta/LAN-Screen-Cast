const { spawn: spawnProcess } = require('node:child_process');
const path = require('node:path');
const { DEFAULTS } = require('./config');

const PROBE_FRAMES = 3;
const PROBE_TIMEOUT_MS = 10000;
const KILL_WAIT_MS = 500;

function abortError() {
  const error = new Error('RTMP 编码器检查已取消。');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function checkAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function readConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('RTMP 编码设置无效。');
  const codec = config.rtmpCodec === undefined ? DEFAULTS.rtmpCodec : config.rtmpCodec;
  const acceleration = config.rtmpAcceleration === undefined ? DEFAULTS.rtmpAcceleration : config.rtmpAcceleration;
  if (!['H264', 'HEVC'].includes(codec)) throw new Error('RTMP 编码格式需要选择 H.264 或 HEVC。');
  if (!['auto', 'hardware', 'software'].includes(acceleration)) throw new Error('RTMP 加速方式无效。');
  if (![30, 60].includes(config.fps)) throw new Error('RTMP 帧率需要选择 30 或 60。');
  if (!Number.isInteger(config.bitrateMbps) || config.bitrateMbps < 1 || config.bitrateMbps > 30) {
    throw new Error('RTMP 码率需要是 1–30 Mbps 的整数。');
  }
  if (!['720', '1080', 'native'].includes(config.resolution)) throw new Error('RTMP 分辨率无效。');
  return { codec, acceleration, fps: config.fps, bitrateMbps: config.bitrateMbps, resolution: config.resolution };
}

function candidate(codec, suffix, hardware, name, options, pixelFormat = 'nv12') {
  return { codec, encoder: `${codec === 'H264' ? 'h264' : 'hevc'}_${suffix}`, hardware, name, options, pixelFormat };
}

function candidates(config) {
  const hardware = [
    candidate(config.codec, 'nvenc', true, 'NVIDIA NVENC', [
      '-preset', 'p1', '-tune', 'ull', '-rc', 'cbr', '-rc-lookahead', '0',
      '-zerolatency', '1', '-delay', '0', '-forced-idr', '1'
    ]),
    candidate(config.codec, 'qsv', true, 'Intel QSV', [
      '-preset', 'veryfast', '-async_depth', '1', '-low_delay_brc', '1', '-look_ahead_depth', '0'
    ]),
    candidate(config.codec, 'amf', true, 'AMD AMF', [
      '-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'cbr', '-async_depth', '1', '-latency', '1', '-preanalysis', '0'
    ]),
    candidate(config.codec, 'mf', true, 'Windows Media Foundation', [
      '-hw_encoding', '1', '-rate_control', 'cbr', '-scenario', 'display_remoting'
    ])
  ];
  // Media Foundation explicitly selects synchronous software MFTs when hw_encoding=0.
  // Optional LGPL/BSD libraries are attempted only if their real encode also succeeds.
  const software = [candidate(config.codec, 'mf', false, 'Windows Media Foundation', [
    '-hw_encoding', '0', '-rate_control', 'cbr', '-scenario', 'display_remoting'
  ])];
  if (config.codec === 'H264') {
    software.push({ codec: 'H264', encoder: 'libopenh264', hardware: false, name: 'OpenH264',
      options: ['-rc_mode', 'bitrate', '-allow_skip_frames', '1'], pixelFormat: 'yuv420p' });
  } else {
    software.push({ codec: 'HEVC', encoder: 'libkvazaar', hardware: false, name: 'Kvazaar',
      options: ['-kvazaar-params', `preset=ultrafast,gop=0,owf=0,period=${config.fps}`], pixelFormat: 'yuv420p' });
  }
  if (config.acceleration === 'hardware') return hardware;
  if (config.acceleration === 'software') return software;
  return [...hardware, ...software];
}

function videoArgs(item, config) {
  const bitrate = `${config.bitrateMbps}M`;
  return ['-c:v', item.encoder, '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate,
    '-r', String(config.fps), '-g', String(config.fps), '-bf', '0', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-pix_fmt', item.pixelFormat, ...item.options];
}

function probeArgs(args, config) {
  // Native capture dimensions are not known yet. Its actual publish process remains
  // authoritative; this bounded sample establishes codec/device availability only.
  const size = config.resolution === '720' ? '1280x720' : '1920x1080';
  return ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${config.fps}`,
    '-frames:v', String(PROBE_FRAMES), '-an', '-sn', '-dn', ...args, '-f', 'null', '-'];
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}无效。`);
  return value;
}

function probe(ffmpegPath, args, { signal, spawn, timeoutMs, killWaitMs, onProcess }) {
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let terminated = null;
    let timer;
    let killTimer;
    let frames = 0;
    let progress = '';
    let stderr = '';
    let exited = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const terminate = error => {
      if (settled || terminated) return;
      terminated = error;
      clearTimeout(timer);
      // This short probe has no output files and no child helpers. Terminate its
      // owned ChildProcess directly; never search by executable name or global PID.
      try { child.kill('SIGKILL'); } catch { /* bounded completion below */ }
      if (!settled) killTimer = setTimeout(() => {
        if (exited || child.exitCode != null) {
          finish(error.name === 'AbortError' ? error : null, { ok: false, reason: error.message });
          return;
        }
        const failure = new Error('RTMP 编码检查进程未能退出，已停止选择编码器。', { cause: error });
        failure.code = 'RTMP_PROBE_CLEANUP_FAILED';
        if (error.name === 'AbortError') { failure.name = 'AbortError'; failure.code = 'ABORT_ERR'; }
        failure.cleanupFailed = true;
        finish(failure);
      }, killWaitMs);
    };
    const onAbort = () => terminate(abortError());

    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(new Error('无法启动 RTMP 编码检查，请检查随软件提供的 FFmpeg 文件。', { cause: error }));
      return;
    }
    onProcess?.(child);
    child.once('exit', () => { exited = true; });
    child.stdout.on('data', chunk => {
      if (settled) return;
      progress = (progress + String(chunk)).slice(-8192);
      for (const match of progress.matchAll(/(?:^|\n)frame=\s*(\d+)\r?(?=\n|$)/g)) frames = Math.max(frames, Number(match[1]));
    });
    child.stderr.on('data', chunk => {
      if (!settled) stderr = (stderr + String(chunk)).slice(-4096);
    });
    child.once('error', error => {
      // A failed kill can emit error while the process is still alive. Its
      // owner's cleanup must retain it; it cannot qualify another candidate.
      if (terminated && child.pid && !exited && child.exitCode == null) return;
      if (terminated) {
        finish(terminated.name === 'AbortError' ? terminated : null, { ok: false, reason: terminated.message });
      } else {
        finish(new Error('无法启动 RTMP 编码检查，请检查随软件提供的 FFmpeg 文件。', { cause: error }));
      }
    });
    child.once('close', code => {
      exited = true;
      if (terminated) {
        finish(terminated.name === 'AbortError' ? terminated : null, { ok: false, reason: terminated.message });
      } else {
        finish(null, { ok: code === 0 && frames >= PROBE_FRAMES,
          reason: code === 0 ? `实际编码 ${frames} 帧` : stderr.trim() || `FFmpeg 退出代码 ${code}` });
      }
    });
    timer = setTimeout(() => terminate(new Error('RTMP 编码器检查超时。')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Abort can arrive between the preflight check and listener registration.
    if (signal?.aborted) onAbort();
  });
}

async function selectRtmpEncoder(input, options = {}) {
  const { signal } = options;
  checkAborted(signal);
  const config = readConfig(input);
  if (typeof options.ffmpegPath !== 'string' || !path.isAbsolute(options.ffmpegPath)) {
    throw new Error('RTMP 编码器文件路径无效。');
  }
  const spawn = options.spawn === undefined ? spawnProcess : options.spawn;
  if (typeof spawn !== 'function') throw new Error('RTMP 编码检查启动器无效。');
  if (options.onProcess !== undefined && typeof options.onProcess !== 'function') throw new Error('RTMP 编码检查进程归属无效。');
  const timeoutMs = boundedInteger(options.probeTimeoutMs, PROBE_TIMEOUT_MS, 1, 30000, '编码检查超时');
  const killWaitMs = boundedInteger(options.killWaitMs, KILL_WAIT_MS, 1, 1000, '编码检查清理时限');
  const codecName = config.codec === 'H264' ? 'H.264' : 'HEVC';
  for (const item of candidates(config)) {
    checkAborted(signal);
    const args = videoArgs(item, config);
    const result = await probe(options.ffmpegPath, probeArgs(args, config), { signal, spawn, timeoutMs, killWaitMs, onProcess: options.onProcess });
    checkAborted(signal);
    if (!result.ok) continue;
    const label = item.hardware ? `${codecName} · ${item.name} 硬件编码` :
      `${codecName} · ${item.name} 软件编码${config.acceleration === 'auto' ? '（硬件不可用，已回退）' : ''}`;
    return { codec: config.codec, encoder: item.encoder, hardware: item.hardware, label, args };
  }
  if (config.acceleration === 'hardware') {
    throw new Error(`没有可用的 ${codecName} 硬件编码器。请检查显卡驱动，或改为“硬件优先”允许软件回退。`);
  }
  throw new Error(`没有可用的 ${codecName} ${config.acceleration === 'software' ? '软件' : '硬件或软件'}编码器。请更换 RTMP 编码格式或检查系统与随包媒体组件。`);
}

module.exports = { selectRtmpEncoder };
