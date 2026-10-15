const DEFAULT_IDS = new Set(['default', 'communications']);
const CANCELLED = Symbol('cancelled microphone refresh');

function normalizeId(id) {
  return typeof id === 'string' && !DEFAULT_IDS.has(id) ? id : '';
}

function microphoneList(inputs) {
  const seen = new Set();
  return inputs.filter(input => {
    if (!input.deviceId || DEFAULT_IDS.has(input.deviceId) || seen.has(input.deviceId)) return false;
    seen.add(input.deviceId);
    return true;
  }).map((input, index) => Object.freeze({
    deviceId: input.deviceId,
    groupId: input.groupId || '',
    label: input.label || `麦克风 ${index + 1}（未显示名称）`,
  }));
}

function failureState(error) {
  const errorName = error?.name || 'Error';
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(errorName)) {
    return { status: 'permission-denied', errorName, message: '麦克风访问被拒绝。请在 Windows 的麦克风隐私设置中允许桌面应用访问，再点击“刷新麦克风”。' };
  }
  if (['NotFoundError', 'DevicesNotFoundError'].includes(errorName)) {
    return { status: 'no-devices', errorName, message: '未检测到麦克风。请连接并启用设备，再点击“刷新麦克风”。' };
  }
  if (['NotReadableError', 'TrackStartError', 'AbortError', 'OverconstrainedError', 'ConstraintNotSatisfiedError'].includes(errorName)) {
    return { status: 'device-unavailable', errorName, message: '无法打开麦克风。请检查设备是否被其他程序占用或已被禁用，然后刷新重试。' };
  }
  return { status: 'error', errorName, message: `读取麦克风设备失败：${error?.message || String(error)}。请点击“刷新麦克风”重试。` };
}

// Enumeration is passive by default. Only an explicit user action should pass
// requestPermission: true; persisted microphone settings do not authorize a
// startup probe. The caller must cancel before starting its real capture and
// dispose on unload, because getUserMedia itself cannot be aborted.
export function createMicrophoneController({
  mediaDevices, onDevices = () => {}, onState = () => {}, getBusy = () => false,
  preferredId: savedId = '',
} = {}) {
  let preferredId = normalizeId(savedId), devices = [], selection = '';
  let disposed = false, active = null, permissionGranted = false;
  const stoppedTracks = new WeakSet();
  let state = snapshot({ status: 'idle', message: '' });

  function snapshot(value) {
    return Object.freeze({
      status: value.status, message: value.message || '', errorName: value.errorName || '',
      deviceCount: devices.length, preferredId, selection,
      selectionMissing: value.selectionMissing || false,
    });
  }

  function current(job) { return !disposed && active === job && !job.cancelled; }

  function stopStream(stream) {
    let tracks;
    try { tracks = stream?.getTracks() || []; } catch { return; }
    for (const track of tracks) {
      if (!track || stoppedTracks.has(track)) continue;
      stoppedTracks.add(track);
      try { track.stop(); } catch { /* Still release the other tracks. */ }
    }
  }

  function releaseProbe(job) {
    const probe = job.probe;
    job.probe = null;
    stopStream(probe);
  }

  function cancelPending(status, notify) {
    const job = active;
    if (!job) return;
    active = null;
    job.cancelled = true;
    job.cancelResult = snapshot({ status, message: status === 'disposed' ? '' : '麦克风设备刷新已取消。' });
    job.resolveCancel(CANCELLED);
    releaseProbe(job);
    if (notify && !disposed && !active) { state = job.cancelResult; onState(state); }
  }

  function publish(value, job) {
    if (job && !current(job)) return job.cancelResult || state;
    state = snapshot(value);
    onState(state);
    return state;
  }

  function busyState(job) {
    return publish({ status: 'busy', message: '广播正在准备或进行中，请结束广播后刷新麦克风。' }, job);
  }

  // An abandoned native request retains a cleanup handler. Racing cancellation
  // lets the UI finish immediately while a permission dialog is still pending.
  async function boundary(job, operation, ownsProbe = false) {
    const pending = Promise.resolve().then(() => {
      if (!current(job) || getBusy()) return CANCELLED;
      return operation();
    }).then(value => {
      if (ownsProbe && value !== CANCELLED) {
        if (current(job) && !getBusy()) job.probe = value;
        else stopStream(value);
      }
      return value;
    });
    return Promise.race([pending, job.cancelPromise]);
  }

  function selectedState(status, message) {
    selection = devices.some(device => device.deviceId === preferredId) ? preferredId : '';
    const selectionMissing = status === 'ready' && !!preferredId && selection !== preferredId;
    return { status, selectionMissing, message: selectionMissing ? '之前选择的麦克风目前不可用，暂使用系统默认麦克风；设备重新连接后会恢复选择。' : message };
  }

  async function refresh({ requestPermission = false } = {}) {
    if (disposed) return state;
    cancelPending('cancelled', false);
    if (getBusy()) return busyState();
    if (!mediaDevices?.enumerateDevices || (requestPermission && !mediaDevices.getUserMedia)) {
      return publish({ status: 'unsupported', message: '当前环境不支持麦克风设备读取，请重新启动应用后重试。' });
    }
    const job = { cancelled: false, probe: null, cancelResult: null, devicesChanged: false };
    job.cancelPromise = new Promise(resolve => { job.resolveCancel = resolve; });
    active = job;
    publish({ status: 'loading', message: requestPermission ? '正在请求麦克风访问并读取设备…' : '正在读取麦克风设备…' }, job);
    try {
      if (getBusy()) return busyState(job);
      if (requestPermission) {
        const probe = await boundary(job, () => mediaDevices.getUserMedia({ audio: true, video: false }), true);
        if (!current(job)) return job.cancelResult || state;
        if (getBusy()) return busyState(job);
        if (probe === CANCELLED) return busyState(job);
        permissionGranted = true;
      }
      let enumerated;
      do {
        job.devicesChanged = false;
        enumerated = await boundary(job, () => mediaDevices.enumerateDevices());
        if (!current(job)) return job.cancelResult || state;
        if (getBusy() || enumerated === CANCELLED) return busyState(job);
      } while (job.devicesChanged);
      const inputs = enumerated.filter(input => input.kind === 'audioinput');
      const nextDevices = microphoneList(inputs);
      // Copy the permission-visible result before closing the probe, and close
      // before UI callbacks can start the broadcast's separate capture.
      releaseProbe(job);
      if (!current(job)) return job.cancelResult || state;
      if (getBusy()) return busyState(job);
      devices = nextDevices;
      let status, message;
      if (!inputs.length && permissionGranted) {
        status = 'no-devices';
        message = '未检测到麦克风。请连接并启用设备，再点击“刷新麦克风”。';
      } else if (!inputs.some(input => input.label)) {
        status = 'permission-required';
        message = '尚未获得麦克风设备信息。请点击“刷新麦克风”请求访问，并确认已连接和启用麦克风。';
      } else {
        permissionGranted = true;
        status = 'ready';
        message = devices.length ? `已读取 ${devices.length} 个麦克风，可选择设备或使用系统默认麦克风。` : '可使用系统默认麦克风。';
      }
      state = snapshot(selectedState(status, message));
      const result = state;
      onDevices([...devices], selection, result);
      if (current(job)) onState(result);
      return result;
    } catch (error) {
      if (!current(job)) return job.cancelResult || state;
      if (getBusy()) return busyState(job);
      const failure = failureState(error);
      if (failure.status === 'permission-denied') permissionGranted = false;
      return publish(failure, job);
    } finally {
      releaseProbe(job);
      if (active === job) active = null;
    }
  }

  function setPreferred(id) {
    if (disposed) return state;
    preferredId = normalizeId(id);
    state = snapshot({ ...state, ...selectedState(state.status, state.status === 'ready' ? (devices.length ? `已读取 ${devices.length} 个麦克风，可选择设备或使用系统默认麦克风。` : '可使用系统默认麦克风。') : state.message) });
    const result = state;
    onDevices([...devices], selection, result);
    if (!disposed && state === result) onState(result);
    return result;
  }

  function cancel() { cancelPending('cancelled', true); return state; }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelPending('disposed', false);
    mediaDevices?.removeEventListener?.('devicechange', deviceChanged);
    state = snapshot({ status: 'disposed', message: '' });
  }

  function deviceChanged() {
    // Permission changes can themselves emit devicechange. Fold events into
    // the current read so they cannot cancel the user's still-live probe.
    if (active && !getBusy()) { active.devicesChanged = true; return; }
    void refresh();
  }
  mediaDevices?.addEventListener?.('devicechange', deviceChanged);
  return { refresh, setPreferred, cancel, dispose, getState: () => state };
}
