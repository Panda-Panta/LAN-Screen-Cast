const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyMediaDirectory } = require('../scripts/media-evidence');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-native-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'bin/ffmpeg.exe': Buffer.from('fake encoder, not an executable'),
    'bin/ffprobe.exe': Buffer.from('fake probe, not an executable'),
    'bin/mediamtx.exe': Buffer.from('fake server, not an executable'),
    'licenses/FFmpeg.txt': Buffer.from('fixture license inventory'),
    'sources/corresponding-source.zip': Buffer.from('fixture corresponding source inventory')
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const manifest = { schemaVersion: 1, dependencies: [{ name: 'fixture', version: '1' }],
    files: Object.entries(files).map(([relative, bytes]) => ({ path: relative, size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') })) };
  const save = () => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  save();
  return { root, files, manifest, save };
}

test('native evidence checks every declared binary, license and source byte; identical copies compare', t => {
  const source = fixture(t), copy = fixture(t);
  const evidence = verifyMediaDirectory(copy.root, { expectedDirectory: source.root });
  assert.equal(evidence.schemaVersion, 1); assert.match(evidence.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.files.length, 5);
  for (const entry of evidence.files) assert.deepEqual(entry, source.manifest.files.find(file => file.path === entry.path));
});

test('native evidence rejects a changed binary even when its size and manifest are unchanged', t => {
  const data = fixture(t), file = path.join(data.root, 'bin', 'ffmpeg.exe');
  const modified = Buffer.from(data.files['bin/ffmpeg.exe']); modified[0] ^= 1; fs.writeFileSync(file, modified);
  assert.throws(() => verifyMediaDirectory(data.root), /bytes differ from manifest/);
});

test('native evidence rejects missing files, unlisted side files and missing manifest', t => {
  const missing = fixture(t); fs.unlinkSync(path.join(missing.root, 'licenses', 'FFmpeg.txt'));
  assert.throws(() => verifyMediaDirectory(missing.root), /inventory differs/);
  const extra = fixture(t); fs.writeFileSync(path.join(extra.root, 'bin', 'injected.dll'), 'unlisted');
  assert.throws(() => verifyMediaDirectory(extra.root), /inventory differs/);
  const noManifest = fixture(t); fs.unlinkSync(path.join(noManifest.root, 'manifest.json'));
  assert.throws(() => verifyMediaDirectory(noManifest.root), /manifest.json is missing/);
});

test('a forged self-consistent manifest cannot replace the source runtime', t => {
  const source = fixture(t), forged = fixture(t), bytes = Buffer.from('alternate native encoder');
  fs.writeFileSync(path.join(forged.root, 'bin', 'ffmpeg.exe'), bytes);
  Object.assign(forged.manifest.files.find(file => file.path === 'bin/ffmpeg.exe'), { size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') }); forged.save();
  assert.doesNotThrow(() => verifyMediaDirectory(forged.root));
  assert.throws(() => verifyMediaDirectory(forged.root, { expectedDirectory: source.root }), /differs from source/);
});

test('stale manifest metadata is distinguished even when all native files are unchanged', t => {
  const source = fixture(t), stale = fixture(t);
  stale.manifest.dependencies[0].version = '0'; stale.save();
  assert.throws(() => verifyMediaDirectory(stale.root, { expectedDirectory: source.root }), /differs from source/);
});

test('native evidence rejects traversal, absolute paths and Windows path aliases before reading them', t => {
  for (const bad of ['../outside.exe', '/outside.exe', 'C:/outside.exe', 'bin\\ffmpeg.exe', 'bin/../ffmpeg.exe',
    'bin//ffmpeg.exe', 'bin/ffmpeg.exe ', 'bin/CON.exe', 'bin/evil:stream', 'bin/injected?.dll', 'manifest.json']) {
    const data = fixture(t); data.manifest.files[0].path = bad; data.save();
    assert.throws(() => verifyMediaDirectory(data.root), /Unsafe|self-referencing/, bad);
  }
});

test('native evidence rejects duplicate case-insensitive paths and invalid digest or size', t => {
  const duplicates = fixture(t);
  duplicates.manifest.files.push({ ...duplicates.manifest.files[0], path: 'BIN/FFMPEG.EXE' }); duplicates.save();
  assert.throws(() => verifyMediaDirectory(duplicates.root), /Duplicate/);
  for (const [key, value] of [['sha256', 'not-a-hash'], ['sha256', 'A'.repeat(64)], ['size', -1], ['size', '15'], ['size', 1.5]]) {
    const invalid = fixture(t); invalid.manifest.files[0][key] = value; invalid.save();
    assert.throws(() => verifyMediaDirectory(invalid.root), /Invalid native media size or SHA256/);
  }
});

test('native evidence requires all three process binaries even with a self-consistent inventory', t => {
  const data = fixture(t); fs.unlinkSync(path.join(data.root, 'bin', 'ffprobe.exe'));
  data.manifest.files = data.manifest.files.filter(file => file.path !== 'bin/ffprobe.exe'); data.save();
  assert.throws(() => verifyMediaDirectory(data.root), /Required native media executable is missing/);
});

test('native evidence rejects directory links to external files', t => {
  const data = fixture(t), external = fixture(t);
  const bin = path.join(data.root, 'bin'); fs.rmSync(bin, { recursive: true });
  fs.symlinkSync(path.join(external.root, 'bin'), bin, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyMediaDirectory(data.root), /must not be a link/);
});
