function volume(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new RangeError('广播音量必须是 0–100 的整数');
  return value;
}

function liveAudio(stream) {
  return stream ? stream.getAudioTracks().filter(track => track.readyState !== 'ended') : [];
}

// Own the original capture and the entire graph synchronously. A suspended
// AudioContext can leave resume pending after the user stops the broadcast;
// CaptureSession.wait races that request without delaying resource release.
export async function createAudioMixer({ capture, displayStream, microphoneStream = null,
  systemAudio = false, systemVolume = 100, micVolume = 100,
  AudioContextCtor = globalThis.AudioContext, MediaStreamCtor = globalThis.MediaStream }) {
  const tracks = new Set(), nodes = [];
  let context = null, systemGain = null, microphoneGain = null, output = null;
  let disposed = false, microphoneMuted = false, hasSystemInput = false;

  function ownStream(stream) {
    for (const track of stream.getTracks()) tracks.add(track);
    return capture.ownStream(stream);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const node of nodes) {
      try { node.disconnect(); } catch { /* Continue disconnecting the rest of the graph. */ }
    }
    nodes.length = 0;
    for (const track of tracks) capture.stopTrack(track);
    tracks.clear();
    systemGain = null; microphoneGain = null; output = null;
    const closingContext = context;
    context = null;
    if (closingContext) {
      try { void Promise.resolve(closingContext.close()).catch(() => {}); }
      catch { /* A device failure or already closed context cannot block track release. */ }
    }
  }

  function applyMicrophone() {
    if (disposed) return;
    if (microphoneGain) microphoneGain.gain.value = microphoneMuted ? 0 : micVolume / 100;
    // Keep the existing microphone-only mute semantics while preserving the
    // system signal when both sources share the outgoing audio track.
    if (output && microphoneGain && !hasSystemInput) output.enabled = !microphoneMuted;
  }

  const mixer = {
    stream: null,
    setSystemVolume(value) {
      systemVolume = volume(value);
      if (!disposed && systemGain) systemGain.gain.value = systemVolume / 100;
    },
    setMicrophoneVolume(value) { micVolume = volume(value); applyMicrophone(); },
    setMicrophoneMuted(value) {
      if (typeof value !== 'boolean') throw new TypeError('麦克风静音状态必须是布尔值');
      microphoneMuted = value; applyMicrophone();
    },
    dispose,
  };

  try {
    ownStream(displayStream);
    if (microphoneStream) ownStream(microphoneStream);
    capture.disposeWith(dispose);
    capture.assertActive();
    systemVolume = volume(systemVolume); micVolume = volume(micVolume);
    if (typeof systemAudio !== 'boolean') throw new TypeError('系统声音开关必须是布尔值');

    const systemTracks = systemAudio ? liveAudio(displayStream) : [];
    const microphoneTracks = liveAudio(microphoneStream);
    if (systemAudio && !systemTracks.length) throw new Error('系统声音采集未返回可用音轨，请检查系统播放设备后重试');
    hasSystemInput = systemTracks.length > 0;
    mixer.stream = new MediaStreamCtor(displayStream.getVideoTracks());
    if (!hasSystemInput && !microphoneTracks.length) return mixer;
    if (typeof AudioContextCtor !== 'function') throw new Error('当前环境不支持广播音频混合');

    context = new AudioContextCtor();
    const destination = context.createMediaStreamDestination();
    nodes.push(destination);
    ownStream(destination.stream);
    [output] = liveAudio(destination.stream);
    if (!output) throw new Error('音频混合器未返回可用音轨');
    mixer.stream = new MediaStreamCtor([...displayStream.getVideoTracks(), output]);

    function connectInput(inputTracks, level) {
      // Each source receives only its own audio; the outgoing stream retains
      // the original video separately.
      const source = context.createMediaStreamSource(new MediaStreamCtor(inputTracks));
      nodes.push(source);
      const gain = context.createGain();
      nodes.push(gain);
      gain.gain.value = level / 100;
      source.connect(gain); gain.connect(destination);
      return gain;
    }

    if (hasSystemInput) systemGain = connectInput(systemTracks, systemVolume);
    if (microphoneTracks.length) microphoneGain = connectInput(microphoneTracks, micVolume);
    applyMicrophone();
    await capture.wait(() => context.resume());
    capture.assertActive();
    return mixer;
  } catch (error) {
    dispose();
    throw error;
  }
}
