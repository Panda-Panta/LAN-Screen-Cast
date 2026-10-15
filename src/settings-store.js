const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class SettingsStore {
  constructor(filename, { defaults = {}, fs: fileSystem = fs } = {}) {
    this.filename = filename;
    this.defaults = defaults;
    this.fs = fileSystem;
    this.queue = Promise.resolve();
  }

  async load() {
    await this.queue.catch(() => {});
    try {
      const settings = JSON.parse(await this.fs.readFile(this.filename, 'utf8'));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ...this.defaults };
      return { ...this.defaults, ...settings };
    }
    catch { return { ...this.defaults }; }
  }

  save(config) {
    // Serialize when accepted, before waiting for any preceding file operation.
    // Later mutations of a caller's object cannot change its queued snapshot.
    let contents;
    try { contents = JSON.stringify(config, null, 2); }
    catch (error) { return Promise.reject(error); }
    const task = this.queue.catch(() => {}).then(async () => {
      await this.fs.mkdir(path.dirname(this.filename), { recursive: true });
      const temp = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await this.fs.writeFile(temp, contents, 'utf8');
        await this.fs.rename(temp, this.filename);
      } catch (error) {
        await this.fs.unlink(temp).catch(() => {});
        throw error;
      }
    });
    this.queue = task;
    void task.catch(() => {});
    return task;
  }

  flush() { return this.queue; }
}

module.exports = { SettingsStore };
