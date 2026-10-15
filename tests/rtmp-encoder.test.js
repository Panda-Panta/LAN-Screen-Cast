const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { selectRtmpEncoder } = require('../src/rtmp-encoder');

const config = { rtmpCodec: 'H264', rtmpAcceleration: 'auto', resolution: '720', fps: 30, bitrateMbps: 6 };
const ffmpegPath = path.join(__dirname, 'fixture-ffmpeg.exe');
const value = (args, option) => args[args.indexOf(option) + 1];

function fixture(behavior) {
  const calls = [];
  const children = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kills = [];
    child.pid = 1000 + children.length;
    child.kill = signal => {
      child.kills.push(signal);
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    calls.push({ file, args, options });
    children.push(child);
    queueMicrotask(() => behavior(child, args, calls.length));
    return child;
  };
  return { calls, children, spawn };
}

function complete(child, code = 0, frames = 3) {
  child.stdout.emit('data', Buffer.from(`frame=${frames}\nprogress=end\n`));
  child.emit('close', code, null);
}

function options(fake, extra = {}) {
  return { ffmpegPath, spawn: fake.spawn, probeTimeoutMs: 100, killWaitMs: 10, ...extra };
}

test('hardware selection requires encoded frames and returns output-only NVIDIA low latency parameters', async () => {
  const fake = fixture(child => complete(child));
  const selected = await selectRtmpEncoder(config, options(fake));
  assert.equal(selected.codec, 'H264');
  assert.equal(selected.encoder, 'h264_nvenc');
  assert.equal(selected.hardware, true);
  assert.match(selected.label, /NVIDIA NVENC 硬件/);
  assert.equal(value(selected.args, '-preset'), 'p1');
  assert.equal(value(selected.args, '-tune'), 'ull');
  assert.equal(value(selected.args, '-rc'), 'cbr');
  assert.equal(value(selected.args, '-zerolatency'), '1');
  assert.equal(value(selected.args, '-bf'), '0');
  assert.equal(value(selected.args, '-r'), '30');
  assert.equal(value(selected.args, '-g'), '30');
  assert.equal(value(selected.args, '-b:v'), '6M');
  assert.equal(value(selected.args, '-pix_fmt'), 'nv12');
  assert.equal(value(selected.args, '-vf'), 'pad=ceil(iw/2)*2:ceil(ih/2)*2');
  for (const forbidden of ['-i', '-f', '-c:a', '-map', '-progress']) assert.ok(!selected.args.includes(forbidden));
  const call = fake.calls[0];
  assert.equal(call.file, ffmpegPath);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(call.args.includes('-nostdin'));
  assert.ok(call.args.includes('-y'));
  assert.equal(value(call.args, '-progress'), 'pipe:1');
  assert.equal(value(call.args, '-frames:v'), '3');
  assert.equal(value(call.args, '-i'), 'color=c=black:s=1280x720:r=30');
  assert.equal(call.args.at(-1), '-');
});

test('HEVC remains HEVC while NVIDIA failure falls through to Intel hardware', async () => {
  const fake = fixture((child, args) => complete(child, value(args, '-c:v') === 'hevc_qsv' ? 0 : 1));
  const selected = await selectRtmpEncoder({ ...config, rtmpCodec: 'HEVC', fps: 60, resolution: '1080', bitrateMbps: 8 }, options(fake));
  assert.equal(selected.codec, 'HEVC');
  assert.equal(selected.encoder, 'hevc_qsv');
  assert.equal(selected.hardware, true);
  assert.equal(value(selected.args, '-async_depth'), '1');
  assert.equal(value(selected.args, '-preset'), 'veryfast');
  assert.equal(value(selected.args, '-low_delay_brc'), '1');
  assert.equal(value(selected.args, '-look_ahead_depth'), '0');
  assert.equal(value(selected.args, '-g'), '60');
  assert.equal(value(selected.args, '-r'), '60');
  assert.equal(value(selected.args, '-b:v'), '8M');
  assert.equal(value(fake.calls[0].args, '-i'), 'color=c=black:s=1920x1080:r=60');
  assert.deepEqual(fake.calls.map(call => value(call.args, '-c:v')), ['hevc_nvenc', 'hevc_qsv']);
});

test('AMD hardware uses the matching codec and documented low latency mode', async () => {
  const fake = fixture((child, args) => complete(child, value(args, '-c:v') === 'h264_amf' ? 0 : 1));
  const selected = await selectRtmpEncoder(config, options(fake));
  assert.equal(selected.encoder, 'h264_amf');
  assert.equal(selected.hardware, true);
  assert.equal(value(selected.args, '-usage'), 'ultralowlatency');
  assert.equal(value(selected.args, '-quality'), 'speed');
  assert.equal(value(selected.args, '-rc'), 'cbr');
  assert.equal(value(selected.args, '-async_depth'), '1');
});

test('Media Foundation hardware is explicitly forced after vendor hardware paths fail', async () => {
  const fake = fixture((child, args) => complete(child, value(args, '-hw_encoding') === '1' ? 0 : 1));
  const selected = await selectRtmpEncoder(config, options(fake));
  assert.equal(selected.encoder, 'h264_mf');
  assert.equal(selected.hardware, true);
  assert.equal(value(selected.args, '-hw_encoding'), '1');
  assert.equal(value(selected.args, '-rate_control'), 'cbr');
  assert.equal(value(selected.args, '-scenario'), 'display_remoting');
  assert.equal(fake.calls.length, 4);
});

test('auto preserves H264 and explicitly labels the actual software fallback', async () => {
  const fake = fixture((child, args) => complete(child, value(args, '-hw_encoding') === '0' ? 0 : 1));
  const selected = await selectRtmpEncoder(config, options(fake));
  assert.equal(selected.codec, 'H264');
  assert.equal(selected.encoder, 'h264_mf');
  assert.equal(selected.hardware, false);
  assert.equal(value(selected.args, '-hw_encoding'), '0');
  assert.match(selected.label, /软件编码.*硬件不可用.*回退/);
  assert.equal(fake.calls.length, 5);
});

test('software mode never probes hardware and can use optional OpenH264', async () => {
  const fake = fixture((child, args) => complete(child, value(args, '-c:v') === 'libopenh264' ? 0 : 1));
  const selected = await selectRtmpEncoder({ ...config, rtmpAcceleration: 'software' }, options(fake));
  assert.equal(selected.encoder, 'libopenh264');
  assert.equal(selected.hardware, false);
  assert.match(selected.label, /OpenH264 软件编码/);
  assert.doesNotMatch(selected.label, /硬件编码|回退/);
  assert.deepEqual(fake.calls.map(call => value(call.args, '-c:v')), ['h264_mf', 'libopenh264']);
  assert.equal(value(fake.calls[0].args, '-hw_encoding'), '0');
  assert.equal(value(selected.args, '-pix_fmt'), 'yuv420p');
  assert.equal(value(selected.args, '-rc_mode'), 'bitrate');
});

test('optional Kvazaar software keeps HEVC and disables frame reordering', async () => {
  const fake = fixture((child, args) => complete(child, value(args, '-c:v') === 'libkvazaar' ? 0 : 1));
  const selected = await selectRtmpEncoder({ ...config, rtmpCodec: 'HEVC', rtmpAcceleration: 'software' }, options(fake));
  assert.equal(selected.codec, 'HEVC');
  assert.equal(selected.encoder, 'libkvazaar');
  assert.equal(selected.hardware, false);
  assert.equal(value(selected.args, '-kvazaar-params'), 'preset=ultrafast,gop=0,owf=0,period=30');
  assert.equal(value(selected.args, '-pix_fmt'), 'yuv420p');
  assert.deepEqual(fake.calls.map(call => value(call.args, '-c:v')), ['hevc_mf', 'libkvazaar']);
});

test('hardware-only failure never falls through to software or silently changes codec', async () => {
  const fake = fixture(child => complete(child, 1));
  await assert.rejects(selectRtmpEncoder({ ...config, rtmpCodec: 'HEVC', rtmpAcceleration: 'hardware' }, options(fake)), /没有可用的 HEVC 硬件编码器/);
  assert.deepEqual(fake.calls.map(call => value(call.args, '-c:v')), ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf']);
  assert.equal(value(fake.calls.at(-1).args, '-hw_encoding'), '1');
});

test('unavailable HEVC software fails explicitly without substituting H264', async () => {
  const fake = fixture(child => complete(child, 1));
  await assert.rejects(selectRtmpEncoder({ ...config, rtmpCodec: 'HEVC', rtmpAcceleration: 'software' }, options(fake)), /没有可用的 HEVC 软件编码器/);
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls.every(call => !value(call.args, '-c:v').includes('h264')));
});

test('zero exit without real output frames cannot be reported as hardware availability', async () => {
  const fake = fixture((child, args) => complete(child, 0, value(args, '-c:v') === 'h264_qsv' ? 3 : 0));
  const selected = await selectRtmpEncoder(config, options(fake));
  assert.equal(selected.encoder, 'h264_qsv');
  assert.equal(fake.calls.length, 2);
});

test('encoded frames followed by nonzero exit cannot qualify an encoder', async () => {
  const fake = fixture((child, args) => complete(child, value(args, '-c:v') === 'h264_qsv' ? 0 : 1, 3));
  const selected = await selectRtmpEncoder(config, options(fake));
  assert.equal(selected.encoder, 'h264_qsv');
});

test('progress fragmented across stdout chunks still counts actual frames', async () => {
  const fake = fixture(child => {
    child.stdout.emit('data', Buffer.from('frame='));
    child.stdout.emit('data', Buffer.from('3\r\nprogress=end\n'));
    child.emit('close', 0);
  });
  assert.equal((await selectRtmpEncoder(config, options(fake))).encoder, 'h264_nvenc');
});

test('pre-cancelled selection does not spawn a process', async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = fixture(child => complete(child));
  await assert.rejects(selectRtmpEncoder(config, options(fake, { signal: controller.signal })), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(fake.calls.length, 0);
});

test('cancellation kills only its owned probe and prevents all fallback attempts', async () => {
  const controller = new AbortController();
  const fake = fixture(() => controller.abort());
  await assert.rejects(selectRtmpEncoder(config, options(fake, { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.children[0].kills, ['SIGKILL']);
});

test('cancellation just after successful child close still prevents a stale result', async () => {
  const controller = new AbortController();
  const fake = fixture(child => {
    complete(child);
    controller.abort();
  });
  await assert.rejects(selectRtmpEncoder(config, options(fake, { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.children[0].kills, []);
});

test('hung probe is bounded, killed, then allows a later same-codec candidate', async () => {
  const fake = fixture((child, args) => {
    if (value(args, '-c:v') === 'h264_qsv') complete(child);
  });
  const selected = await selectRtmpEncoder(config, options(fake, { probeTimeoutMs: 15 }));
  assert.equal(selected.encoder, 'h264_qsv');
  assert.deepEqual(fake.children[0].kills, ['SIGKILL']);
  assert.deepEqual(fake.children[1].kills, []);
});

test('cancellation completes within its bound when child kill throws without close', async () => {
  const controller = new AbortController();
  const fake = fixture(child => {
    child.kill = () => { throw new Error('test termination error'); };
    controller.abort();
  });
  await assert.rejects(selectRtmpEncoder(config, options(fake, { signal: controller.signal, killWaitMs: 5 })), { name: 'AbortError' });
  assert.equal(fake.calls.length, 1);
});

test('a probe that cannot exit remains owned and prevents the next candidate', async () => {
  const owned = [];
  const fake = fixture(child => { child.kill = () => false; });
  await assert.rejects(selectRtmpEncoder(config, options(fake, { probeTimeoutMs: 10, killWaitMs: 5,
    onProcess: child => owned.push(child) })), { code: 'RTMP_PROBE_CLEANUP_FAILED', cleanupFailed: true });
  assert.equal(fake.calls.length, 1, 'a live failed probe must not be abandoned to start another');
  assert.equal(owned[0], fake.children[0]);
});

test('missing FFmpeg fails immediately instead of spawning every fallback', async () => {
  const fake = fixture(child => child.emit('error', Object.assign(new Error('missing file'), { code: 'ENOENT' })));
  await assert.rejects(selectRtmpEncoder(config, options(fake)), /无法启动 RTMP 编码检查/);
  assert.equal(fake.calls.length, 1);
});

test('invalid codec, mode, dimensions or numeric values never enter executable arguments', async () => {
  const fake = fixture(child => complete(child));
  for (const patch of [{ rtmpCodec: 'H264 -i secret' }, { rtmpAcceleration: 'fast' }, { fps: '30' },
    { bitrateMbps: '6' }, { bitrateMbps: 31 }, { bitrateMbps: NaN }, { resolution: '1920x1080;cmd' }]) {
    await assert.rejects(selectRtmpEncoder({ ...config, ...patch }, options(fake)), /RTMP/);
  }
  await assert.rejects(selectRtmpEncoder(config, options(fake, { ffmpegPath: 'ffmpeg.exe' })), /文件路径/);
  assert.equal(fake.calls.length, 0);
});

test('missing codec and acceleration default to HEVC and prefer NVIDIA when all hardware could succeed', async () => {
  const fake = fixture(child => complete(child));
  const selected = await selectRtmpEncoder({ resolution: 'native', fps: 30, bitrateMbps: 6, args: ['-i', 'untrusted'] }, options(fake));
  assert.equal(selected.codec, 'HEVC');
  assert.equal(selected.hardware, true);
  assert.equal(selected.encoder, 'hevc_nvenc');
  assert.equal(fake.calls.length, 1);
  assert.match(selected.label, /HEVC.*NVIDIA NVENC 硬件/);
  assert.equal(value(fake.calls[0].args, '-i'), 'color=c=black:s=1920x1080:r=30');
  assert.ok(!selected.args.includes('untrusted'));
});

test('default HEVC hardware priority tries other hardware before a same-codec software fallback', async () => {
  const fake = fixture((child, args) => complete(child, value(args, '-c:v') === 'libkvazaar' ? 0 : 1));
  const selected = await selectRtmpEncoder({ resolution: '720', fps: 30, bitrateMbps: 6 }, options(fake));
  assert.equal(selected.codec, 'HEVC');
  assert.equal(selected.encoder, 'libkvazaar');
  assert.equal(selected.hardware, false);
  assert.match(selected.label, /HEVC.*软件编码.*硬件不可用.*回退/);
  assert.deepEqual(fake.calls.map(call => value(call.args, '-c:v')),
    ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf', 'hevc_mf', 'libkvazaar']);
  assert.equal(value(fake.calls[3].args, '-hw_encoding'), '1');
  assert.equal(value(fake.calls[4].args, '-hw_encoding'), '0');
});
