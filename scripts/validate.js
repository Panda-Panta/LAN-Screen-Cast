const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { sourceEvidence } = require('./source-fingerprint');
const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
fs.mkdirSync(results, { recursive: true });
const before = sourceEvidence();
const report = { ...before, startedAt: new Date().toISOString(), passed: false };
const hash = content => crypto.createHash('sha256').update(content).digest('hex');
try {
  const tests = fs.readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.test.js'))
    .sort().map(file => path.join('tests', file));
  for (const [file, args] of [['node-tests.txt', ['--test', '--test-reporter=spec', ...tests]],
    ['syntax-check.txt', ['scripts/check.js']]]) {
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true,
      maxBuffer: 5 * 1024 * 1024, env: { ...process.env, NODE_DISABLE_COLORS: '1' } });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    fs.writeFileSync(path.join(results, file), output, 'utf8');
    process.stdout.write(output);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${file} failed`);
    report[file === 'node-tests.txt' ? 'nodeLogSha256' : 'syntaxLogSha256'] = hash(Buffer.from(output, 'utf8'));
  }
  assert.deepEqual(sourceEvidence(), before, 'validation inputs changed during the run');
  report.passed = true;
} catch (error) {
  report.error = error.stack; console.error(error); process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(results, 'validation-evidence.json'), JSON.stringify(report, null, 2));
}
