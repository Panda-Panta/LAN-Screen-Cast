export class CaptureCancelled extends Error {
  constructor(message = '广播准备已取消') { super(message); this.name = 'CaptureCancelled'; }
}

// Owns capture resources even when a browser permission request cannot itself
// be cancelled. The UI stops immediately; late device tracks are still adopted
// and released by this same session rather than leaking into a newer broadcast.
export class CaptureSession {
  constructor(stopRemote) {
    this.stopRemote = stopRemote;
    this.cancelled = false;
    this.reason = '';
    this.tracks = new Set();
    this.cleanups = new Set();
    this.stopTask = null;
    this.cancelSignal = new Promise(resolve => { this.resolveCancel = resolve; });
  }

  assertActive() {
    if (this.cancelled) throw new CaptureCancelled(this.reason);
  }

  ownStream(stream) {
    for (const track of stream.getTracks()) {
      if (this.cancelled) this.stopTrack(track);
      else this.tracks.add(track);
    }
    return stream;
  }

  disposeWith(cleanup) {
    if (this.cancelled) cleanup();
    else this.cleanups.add(cleanup);
  }

  async wait(operation, adopt = value => value) {
    this.assertActive();
    const task = Promise.resolve().then(() => {
      this.assertActive();
      return operation();
    }).then(value => {
      // Adopt before checking cancellation so a late microphone stream is
      // always stopped. Promise.race also handles this task's late rejection.
      const adopted = adopt(value);
      this.assertActive();
      return adopted;
    });
    return Promise.race([task, this.cancelSignal.then(() => { throw new CaptureCancelled(this.reason); })]);
  }

  stopTrack(track) {
    if (track.readyState === 'ended') return;
    try { track.stop(); } catch { /* Continue releasing the other resources. */ }
  }

  cancel(reason = '广播已停止') {
    if (this.cancelled) return this.stopTask;
    this.cancelled = true;
    this.reason = reason;
    this.resolveCancel();
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* A peer that already closed cannot block cleanup. */ }
    }
    this.cleanups.clear();
    for (const track of this.tracks) this.stopTrack(track);
    this.tracks.clear();
    try { this.stopTask = Promise.resolve(this.stopRemote()); }
    catch (error) { this.stopTask = Promise.reject(error); }
    // A source-ended event can initiate cancellation before its UI awaits it.
    void this.stopTask.catch(() => {});
    return this.stopTask;
  }
}
