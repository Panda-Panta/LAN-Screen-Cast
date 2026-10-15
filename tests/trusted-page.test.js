const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isLocalDocument } = require('../src/trusted-page');

test('trusted local document accepts Chromium and Node encodings of a Windows short-path tilde', () => {
  const file = path.resolve('temp', 'PANDA-~1', '画面 空格', 'index.html');
  const encoded = pathToFileURL(file).href;
  assert.equal(isLocalDocument(encoded, file), true);
  assert.equal(isLocalDocument(encoded.replace(/%7e/gi, '~'), file), true);
});

test('trusted local document rejects other files and URL additions', () => {
  const file = path.resolve('temp', 'index.html');
  const url = pathToFileURL(file).href;
  for (const candidate of [pathToFileURL(path.resolve('temp', 'other.html')).href,
    `${url}?next=1`, `${url}#token=abc`, 'https://example.com/index.html',
    'file://attacker.example/index.html', 'data:text/html,test', 'javascript:alert(1)',
    url.replace('index.html', 'sub%2Findex.html'), url.replace('index.html', '%ZZ.html'), null, 'not a URL']) {
    assert.equal(isLocalDocument(candidate, file), false, String(candidate));
  }
});
