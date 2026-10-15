// Each edit owns an immutable complete snapshot. Writes are serialized even
// when a second debounce or close flush arrives while IPC is still saving.
export function createSettingsAutosave({ read, save, delayMs = 250, onState, timers = globalThis }) {
  let timer = null;
  let pending = null;
  let revision = 0;
  let queue = Promise.resolve();
  let disposed = false;

  function clearPending() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    pending = null;
  }

  function notify(status, itemRevision, error) {
    if (disposed || itemRevision !== revision) return;
    try { onState?.(error === undefined ? { status } : { status, error }); }
    catch { /* Status rendering cannot interrupt persistence. */ }
  }

  function snapshot() {
    ++revision;
    return { config: JSON.parse(JSON.stringify(read())), revision };
  }

  function enqueue(item) {
    const task = queue.catch(() => {}).then(async () => {
      notify('saving', item.revision);
      await save(item.config);
      notify('saved', item.revision);
    });
    queue = task;
    // Debounce callbacks have no caller to await their failures. Keep the
    // rejection observable to flush callers without an unhandled rejection.
    void task.catch(error => notify('error', item.revision, error));
    return task;
  }

  function schedule() {
    if (disposed) return;
    clearPending();
    try { pending = snapshot(); }
    catch (error) { notify('error', revision, error); return; }
    notify('pending', pending.revision);
    timer = timers.setTimeout(() => {
      const item = pending;
      clearPending();
      if (item) enqueue(item);
    }, delayMs);
  }

  function flush() {
    if (disposed) return queue;
    clearPending();
    let item;
    try { item = snapshot(); }
    catch (error) {
      notify('error', revision, error);
      // Even an invalid final draft must wait for older accepted writes before
      // a caller can acknowledge that it is safe to close the window.
      return queue.catch(() => {}).then(() => { throw error; });
    }
    return enqueue(item);
  }

  // Saving already handed to the queue continues; cancellation drops only
  // the pending debounce and suppresses statuses belonging to older edits.
  function cancel() { clearPending(); ++revision; }
  function dispose() { cancel(); disposed = true; }

  return { schedule, flush, cancel, dispose };
}
