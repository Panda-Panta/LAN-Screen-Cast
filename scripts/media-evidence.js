// Verify the bytes actually supplied to native media processes. The manifest is
// an inventory, never a substitute for reading the complete runtime directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const sourceDirectory = path.resolve(__dirname, '..', 'vendor', 'media');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':')
    || /[\0-\x1f?*"<>|]/.test(value) || path.posix.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..'
      || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe native media relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

function inventory(directory, prefix = '') {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Native media directory must be a real directory: ${directory}`);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = safeRelative(prefix ? `${prefix}/${entry.name}` : entry.name);
    const absolute = path.join(directory, entry.name);
    const current = fs.lstatSync(absolute);
    if (current.isSymbolicLink()) throw new Error(`Native media input must not be a link: ${relative}`);
    if (current.isDirectory()) files.push(...inventory(absolute, relative));
    else if (current.isFile()) files.push({ path: relative, absolute, size: current.size });
    else throw new Error(`Native media input must be a regular file: ${relative}`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function fileHash(file) {
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}

function verifyMediaDirectory(directory = sourceDirectory, { expectedDirectory } = {}) {
  const actual = inventory(path.resolve(directory));
  const manifestFile = actual.find(file => file.path === 'manifest.json');
  if (!manifestFile) throw new Error('Native media manifest.json is missing');
  const manifestBytes = fs.readFileSync(manifestFile.absolute);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.dependencies)
    || manifest.dependencies.length === 0 || manifest.dependencies.some(item => !item || typeof item !== 'object' || Array.isArray(item))
    || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Native media manifest has an unsupported or incomplete schema');
  }
  const seen = new Set();
  const declared = manifest.files.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid native media file record');
    const relative = safeRelative(item.path);
    const key = relative.toLowerCase();
    if (key === 'manifest.json' || seen.has(key)) throw new Error(`Duplicate or self-referencing native media path: ${relative}`);
    if (!Number.isSafeInteger(item.size) || item.size < 0 || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new Error(`Invalid native media size or SHA256: ${relative}`);
    }
    seen.add(key);
    return { path: relative, size: item.size, sha256: item.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const runtimeFiles = actual.filter(file => file.path !== 'manifest.json');
  assert.deepEqual(runtimeFiles.map(file => file.path), declared.map(file => file.path),
    'Native media actual file inventory differs from manifest (missing or unlisted file)');
  for (const required of ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'bin/mediamtx.exe']) {
    if (!seen.has(required)) throw new Error(`Required native media executable is missing: ${required}`);
  }
  const files = runtimeFiles.map((file, index) => {
    const evidence = { path: file.path, size: file.size, sha256: fileHash(file.absolute) };
    assert.deepEqual(evidence, declared[index], `Native media bytes differ from manifest: ${file.path}`);
    return evidence;
  });
  const evidence = { schemaVersion: 1, manifestSha256: hash(manifestBytes), files };
  if (expectedDirectory !== undefined) {
    assert.deepEqual(evidence, verifyMediaDirectory(expectedDirectory), 'Native media runtime differs from source dependency bytes');
  }
  return evidence;
}

module.exports = { verifyMediaDirectory, fileHash };
if (require.main === module) {
  if (process.argv.length > 4) throw new Error('Usage: node scripts/media-evidence.js [directory] [expected-directory]');
  console.log(JSON.stringify(verifyMediaDirectory(process.argv[2], { expectedDirectory: process.argv[3] })));
}
