// Read-only production device diagnosis with an isolated application profile.
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function main() {
  const enabled = process.argv.includes('--hevc');
  const args = enabled ? ['--enable-features=PlatformHEVCEncoderSupport,WebRtcAllowH265Send,WebRtcAllowH265Receive', root] : [root];
  const app = await _electron.launch({ args, env: { ...process.env,
    LAN_CAST_DATA_DIR: path.join(root, '.cache', enabled ? 'hevc-diagnostic' : 'devices-diagnostic') }, timeout: 30000 });
  const report = { at: new Date().toISOString(), hevcFeaturesEnabled: enabled };
  try {
    const host = await app.firstWindow();
    await host.waitForFunction(() => document.querySelector('.source-card'));
    report.runtime = await app.evaluate(() => process.versions);
    report.capabilities = await host.evaluate(() => ({
      sender: RTCRtpSender.getCapabilities('video')?.codecs.map(codec => codec.mimeType),
      receiver: RTCRtpReceiver.getCapabilities('video')?.codecs.map(codec => codec.mimeType)
    }));
    report.microphone = await host.evaluate(async () => {
      const snapshot = async () => {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
        return { count: devices.length, named: devices.filter(device => device.label).length,
          selectable: devices.filter(device => device.deviceId && !['default', 'communications'].includes(device.deviceId)).length };
      };
      const result = { before: await snapshot(), bootOptions: document.querySelector('#mic-device').options.length };
      let probe;
      try {
        probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        result.live = await snapshot(); result.tracks = probe.getAudioTracks().length;
      } catch (error) { result.error = { name: error.name, message: error.message }; }
      finally { probe?.getTracks().forEach(track => track.stop()); }
      result.after = await snapshot();
      return result;
    });
    report.gpu = await app.evaluate(async ({ app }) => {
      const info = await app.getGPUInfo('basic');
      return info.gpuDevice?.map(({ deviceString, vendorId, deviceId }) => ({ deviceString, vendorId, deviceId }));
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await fs.writeFile(path.join(root, 'test-results', enabled ? 'hevc-capabilities.json' : 'device-diagnosis.json'), JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
