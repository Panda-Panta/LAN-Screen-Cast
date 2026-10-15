// Deterministic source evidence. User data, build output and documentation are
// excluded; validation additionally includes the tests and verification tools.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyMediaDirectory } = require('./media-evidence');
const root = path.resolve(__dirname, '..');

function filesIn(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Evidence directory must not be a link: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Evidence input must not be a link: ${file}`);
    if (entry.isDirectory()) return entry.name === '__pycache__' ? [] : filesIn(file);
    return entry.isFile() ? [file] : [];
  });
}

function fingerprint(files) {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const file of files.sort()) {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    const fd = fs.openSync(file, 'r');
    try {
      digest.update(`${relative}\0${fs.fstatSync(fd).size}\0`);
      let length;
      while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
      digest.update('\0');
    } finally { fs.closeSync(fd); }
  }
  return digest.digest('hex');
}

function sourceEvidence() {
  const nativeMedia = verifyMediaDirectory();
  const production = [...filesIn(path.join(root, 'src')), ...filesIn(path.join(root, 'assets')),
    ...filesIn(path.join(root, 'vendor', 'media')),
    ...['package.json', 'package-lock.json', 'LICENSE'].map(file => path.join(root, file))];
  return { version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    nativeMedia,
    sourceFingerprint: fingerprint([...production]),
    validationFingerprint: fingerprint([...production, ...filesIn(path.join(root, 'tests')),
      ...filesIn(path.join(root, 'scripts'))]) };
}

module.exports = { sourceEvidence };
if (require.main === module) console.log(JSON.stringify(sourceEvidence()));
