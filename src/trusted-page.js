const { fileURLToPath } = require('node:url');

// Chromium and Node may serialize the same filename differently (e.g. ~/%7E).
// Decode only a local file URL, then compare the complete expected filename.
function isLocalDocument(candidate, expectedFile) {
  if (typeof candidate !== 'string') return false;
  try {
    const url = new URL(candidate);
    return url.protocol === 'file:' && url.hostname === '' && url.username === ''
      && url.password === '' && url.search === '' && url.hash === ''
      && fileURLToPath(url) === expectedFile;
  } catch { return false; }
}

module.exports = { isLocalDocument };
