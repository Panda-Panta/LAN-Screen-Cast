// Each cancelled startup owns cleanup of its eventual listener.
class BroadcastSession {
  constructor(createServer) {
    this.createServer = createServer;
    this.current = null;
    this.pending = null;
    this.readyPending = null;
    this.retired = null;
    this.revision = 0;
    this.stopTask = null;
  }
  get busy() { return !!this.pending || !!this.stopTask || !!this.retired; }
  async start(config, decorate = async info => info) {
    if (this.current || this.busy) throw new Error('广播服务正在运行或回收，请稍后再试。');
    const revision = ++this.revision;
    const next = this.createServer(config);
    this.pending = next;
    try {
      const info = await next.start();
      if (revision !== this.revision) throw new Error('广播启动已取消。');
      this.readyPending = next;
      const result = await decorate(info);
      if (revision !== this.revision) throw new Error('广播启动已取消。');
      this.current = next;
      return result;
    } catch (error) {
      try { await next.stop(); }
      catch (cleanupError) { this.retired = next; throw cleanupError; }
      throw error;
    } finally {
      if (this.pending === next) this.pending = null;
      if (this.readyPending === next) this.readyPending = null;
    }
  }
  async stop() {
    ++this.revision;
    if (this.stopTask) return this.stopTask;
    const active = this.current || this.readyPending || this.retired;
    this.current = null;
    this.readyPending = null;
    if (active) {
      this.retired = active;
      this.stopTask = Promise.resolve().then(() => active.stop()).then(() => {
        if (this.retired === active) this.retired = null;
      }).finally(() => { this.stopTask = null; });
    }
    if (this.stopTask) await this.stopTask;
  }
}
module.exports = { BroadcastSession };
