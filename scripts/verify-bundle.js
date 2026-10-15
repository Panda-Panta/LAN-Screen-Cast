const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const { sourceEvidence } = require('./source-fingerprint');
const { verifyMediaDirectory } = require('./media-evidence');
const root = path.resolve(__dirname, '..');
const archive = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
let verified = 0;
function verify(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `Production file must not be a link: ${file}`);
    if (entry.isDirectory()) { verify(file); continue; }
    const relative = path.relative(root, file);
    assert.deepEqual(asar.extractFile(archive, relative), fs.readFileSync(file), `Packaged file differs: ${relative}`);
    verified++;
  }
}
verify(path.join(root, 'src'));
for (const relative of ['assets/icon.ico', 'assets/icon.png', 'LICENSE']) {
  assert.deepEqual(asar.extractFile(archive, relative.split('/').join(path.sep)), fs.readFileSync(path.join(root, relative)));
  verified++;
}
const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packaged = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(packaged.main, 'src/main.js');
assert.equal(packaged.version, source.version);
for (const file of asar.listPackage(archive)) assert.doesNotMatch(file.replaceAll('\\', '/'), /^\/(?:test-results|tests|\.cache|scripts)\//);
const nativeMedia = verifyMediaDirectory(path.join(path.dirname(archive), 'media'), {
  expectedDirectory: path.join(root, 'vendor', 'media') });
const report = { productionFilesMatchSource: true, verifiedFiles: verified, version: packaged.version,
  nativeMediaFilesMatchSource: true, nativeMediaVerifiedFiles: nativeMedia.files.length + 1, nativeMedia,
  sourceFingerprint: sourceEvidence().sourceFingerprint,
  asarSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
fs.writeFileSync(path.join(root, 'test-results', 'bundle-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
