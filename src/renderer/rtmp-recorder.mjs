const MIME_TYPES = [
  'video/webm;codecs=vp8,opus',
  'video/x-matroska;codecs=avc1,opus',
];
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_MS = 3000;
const now = () => globalThis.performance?.now?.() ?? Date.now();

// The recorder borrows the final mixed stream. It owns only its recording and
// queue: disposing RTMP must not stop the tracks used by the webpage broadcast.
export function createRtmpRecorder({ stream, config, roomId, api, onError = () => {} }) {
  let recorder = null, generation = null, sequence = 0, startTask = null;
  let disposed = false, recording = false, pumping = false;
  let queue = [], activeItem = null, pendingBytes = 0, ageTimer = null;
  let finishedGeneration = null;
  let resolveCancelled;
  const cancelled = new Promise(resolve => { resolveCancelled = resolve; });

  function finish(currentGeneration, message) {
    if (!currentGeneration || finishedGeneration === currentGeneration) return;
    finishedGeneration = currentGeneration;
    try {
      void Promise.resolve(api.finishRtmp({ generation: currentGeneration, ...(message ? { message } : {}) })).catch(() => {});
    } catch { /* A backend that already stopped cannot delay local disposal. */ }
  }

  function clearDeadline() {
    if (ageTimer !== null) clearTimeout(ageTimer);
    ageTimer = null;
  }

  function end(message) {
    if (disposed) return;
    disposed = true;
    recording = false;
    resolveCancelled();
    clearDeadline();
    for (const item of queue) item.blob = null;
    queue = [];
    if (activeItem) activeItem.blob = null;
    activeItem = null;
    pendingBytes = 0;
    const closingRecorder = recorder;
    recorder = null;
    stream = null;
    if (closingRecorder) {
      // stop() can produce one final Blob and a stop event. Neither may append
      // to the already ended container, so detach before stopping.
      closingRecorder.ondataavailable = null;
      closingRecorder.onerror = null;
      closingRecorder.onstop = null;
      try { if (closingRecorder.state !== 'inactive') closingRecorder.stop(); }
      catch { /* Continue releasing the backend when the recorder has failed. */ }
    }
    const closingGeneration = generation;
    generation = null;
    finish(closingGeneration, message);
  }

  function fail(error) {
    if (disposed) return;
    const detail = typeof error === 'string' ? error : error?.message || '录制发生错误';
    const message = `RTMP ${detail}；网页广播继续`;
    end(message);
    try { onError(message); } catch { /* UI reporting cannot retain media resources. */ }
  }

  function armDeadline() {
    clearDeadline();
    if (disposed) return;
    const oldest = activeItem || queue[0];
    if (!oldest) return;
    const remaining = MAX_PENDING_MS - (now() - oldest.queuedAt);
    if (remaining <= 0) {
      fail('分片处理超过 3 秒，已停止该 RTMP 源');
      return;
    }
    ageTimer = setTimeout(armDeadline, remaining);
  }

  async function pump() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      while (!disposed && queue.length) {
        const item = queue.shift();
        activeItem = item;
        const currentGeneration = generation;
        const currentSequence = sequence;
        // Only one conversion or IPC is in flight. Racing cancellation also
        // releases our references while an uninterruptible Blob/IPC is pending.
        let bytes = await Promise.race([item.blob.arrayBuffer(), cancelled]);
        item.blob = null;
        if (disposed || generation !== currentGeneration) return;
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== item.size) {
          fail('录制分片内容无效，已停止该 RTMP 源');
          return;
        }
        const writing = api.appendRtmp({ generation: currentGeneration, sequence: currentSequence, bytes: new Uint8Array(bytes) });
        bytes = null;
        const ack = await Promise.race([Promise.resolve(writing), cancelled]);
        if (disposed || generation !== currentGeneration) return;
        if (ack?.generation !== currentGeneration || ack?.sequence !== currentSequence) {
          fail('分片确认不匹配，已停止该 RTMP 源');
          return;
        }
        pendingBytes -= item.size;
        activeItem = null;
        sequence++;
        armDeadline();
      }
    } catch (error) {
      fail(error);
    } finally {
      pumping = false;
    }
  }

  function enqueue(event) {
    if (disposed || !recording) return;
    const blob = event?.data;
    const size = blob?.size;
    if (!Number.isSafeInteger(size) || size < 0 || typeof blob?.arrayBuffer !== 'function') {
      fail('录制分片无效，已停止该 RTMP 源');
      return;
    }
    if (size === 0) return;
    if (size > MAX_CHUNK_BYTES) {
      fail('单个录制分片超过 4 MiB，已停止该 RTMP 源');
      return;
    }
    // Charge the Blob before any conversion starts. Dropping an interior Blob
    // would corrupt the continuous Matroska/WebM input, so overload ends it.
    if (pendingBytes + size > MAX_PENDING_BYTES) {
      fail('待发送录制分片超过 8 MiB，已停止该 RTMP 源');
      return;
    }
    pendingBytes += size;
    queue.push({ blob, size, queuedAt: now() });
    armDeadline();
    if (!disposed) void pump();
  }

  async function runStart() {
    if (disposed || config?.rtmpEnabled === false) return;
    const Recorder = globalThis.MediaRecorder;
    if (typeof Recorder !== 'function' || typeof Recorder.isTypeSupported !== 'function') {
      throw new Error('当前环境不支持媒体录制');
    }
    if (!api || ['beginRtmp', 'appendRtmp', 'finishRtmp'].some(name => typeof api[name] !== 'function')) {
      throw new Error('录制服务接口不可用');
    }
    if (typeof roomId !== 'string' || !roomId || !Number.isFinite(config?.bitrateMbps) || config.bitrateMbps <= 0) {
      throw new Error('录制配置无效');
    }

    let mimeType = null, constructorError = null;
    for (const candidate of MIME_TYPES) {
      try {
        if (!Recorder.isTypeSupported(candidate)) continue;
        recorder = new Recorder(stream, { mimeType: candidate,
          videoBitsPerSecond: Math.round(config.bitrateMbps * 1_000_000),
          audioBitsPerSecond: 128_000, videoKeyFrameIntervalDuration: 1000 });
        mimeType = candidate;
        break;
      } catch (error) { constructorError = error; }
    }
    if (!recorder) throw constructorError || new Error('当前环境不支持 H.264 或 VP8 媒体录制');
    recorder.ondataavailable = enqueue;
    recorder.onerror = event => fail(event?.error || new Error('录制器发生错误'));
    recorder.onstop = () => { if (!disposed) fail('录制意外停止，已停止该 RTMP 源'); };

    const opening = Promise.resolve(api.beginRtmp({ roomId, mimeType })).then(result => {
      if (disposed) {
        // A stopped capture can still receive a successful begin. Finish that
        // exact generation, without adopting it into a newer recorder.
        if (typeof result?.generation === 'string' && result.generation) finish(result.generation);
        return undefined;
      }
      if (typeof result?.generation !== 'string' || !result.generation) throw new Error('录制服务未返回有效会话');
      return result;
    });
    const result = await Promise.race([opening, cancelled]);
    if (disposed || !result) return;
    generation = result.generation;
    recording = true;
    // Do not retry after begin: start can fail despite a MIME capability claim,
    // and reusing a partially opened container would hide a hardware failure.
    recorder.start(100);
    if (!disposed) return { generation, mimeType };
  }

  return {
    start() {
      if (!startTask) startTask = runStart().catch(error => { fail(error); return undefined; });
      return startTask;
    },
    dispose() { end(); },
  };
}
