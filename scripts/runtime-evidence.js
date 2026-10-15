const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceEvidence } = require('./source-fingerprint');
const { verifyMediaDirectory } = require('./media-evidence');

async function runtimeEvidence(application) {
  const runtime = await application.evaluate(({ app }) => ({ version: app.getVersion(),
    packaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath,
    executable: process.execPath }));
  const { sourceFingerprint, validationFingerprint } = sourceEvidence();
  const mediaDirectory = runtime.packaged ? path.join(runtime.resourcesPath, 'media')
    : path.join(runtime.appPath, 'vendor', 'media');
  const nativeMedia = verifyMediaDirectory(mediaDirectory, { expectedDirectory: path.resolve(__dirname, '..', 'vendor', 'media') });
  const evidence = { version: runtime.version, sourceFingerprint, validationFingerprint, nativeMedia };
  const executable = process.env.LAN_CAST_EXECUTABLE;
  if (!executable) {
    if (runtime.packaged) throw new Error('Packaged verification requires the exact candidate executable');
    return evidence;
  }
  if (!runtime.packaged || path.resolve(runtime.executable).toLowerCase() !== path.resolve(executable).toLowerCase()) {
    throw new Error('Runtime does not belong to the requested packaged candidate');
  }
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { ...evidence, packagedRuntime: { version: runtime.version, nativeMedia,
    executableSha256: hash(executable),
    asarSha256: hash(path.join(path.dirname(executable), 'resources', 'app.asar')) } };
}
module.exports = { runtimeEvidence };
