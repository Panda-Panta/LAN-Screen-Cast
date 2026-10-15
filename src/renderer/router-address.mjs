import { isUnicastIPv4 } from '../shared/network.mjs';

export function createRouterAddressController({ read, detect, cancel, onAddress, onState,
  intervalMs = 30000, timers = globalThis }) {
  let revision = 0, active = null, interval = null, disposed = false;
  const publish = (status, message) => { if (!disposed) onState?.({ status, message }); };

  function invalidate() {
    ++revision; active = null;
    try { void Promise.resolve(cancel?.()).catch(() => {}); } catch { /* A closing page can no longer send IPC. */ }
  }

  function refresh({ force = false } = {}) {
    const config = read();
    if (disposed || !config.enabled || (!config.automatic && !force)) return Promise.resolve();
    if (!config.host || config.host === '127.0.0.1') { publish('unsupported', '请选择实际局域网网卡，再读取路由器。'); return Promise.resolve(); }
    const key = `${config.host}:${config.automatic}`;
    if (active?.key === key) return active.promise;
    invalidate();
    const current = revision;
    publish('checking', '正在查询所选网卡的路由器 WAN 地址…');
    const promise = (async () => {
      try {
        const result = await detect(config.host);
        const latest = read();
        if (disposed || current !== revision || latest.host !== config.host || !latest.enabled || result?.cancelled) return;
        if (!result?.supported || !isUnicastIPv4(result.wanAddress)) {
          publish('unsupported', result?.message || '路由器未提供可用的地址查询接口，请关闭自动模式并手动填写。'); return;
        }
        onAddress?.(result.wanAddress, result);
        publish('ready', `${result.wanAddress} · ${result.method === 'nat-pmp' ? 'NAT-PMP' : 'UPnP'} · 已读取，自动模式每 30 秒检查。`);
        return result;
      } catch (error) {
        if (!disposed && current === revision) publish('error', `读取失败：${error.message}。可关闭自动模式并手动填写。`);
      } finally { if (current === revision) active = null; }
    })();
    active = { key, promise };
    return promise;
  }

  function changed() { invalidate(); return refresh(); }
  function start() {
    if (disposed || interval !== null) return;
    interval = timers.setInterval(() => refresh(), intervalMs);
    void refresh();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; invalidate();
    if (interval !== null) timers.clearInterval(interval);
    interval = null;
  }
  return { refresh, changed, start, dispose };
}
