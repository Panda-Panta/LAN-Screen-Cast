const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let checked = 0;
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { visit(file); continue; }
    if (!/\.m?js$/.test(file)) continue;
    const moduleFile = file.endsWith('.mjs') || /[\\/](renderer|viewer|shared)[\\/]/.test(file);
    const result = moduleFile ? spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(file), encoding: 'utf8' }) :
      spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    checked++;
  }
}
for (const dir of ['src', 'scripts', 'tests']) visit(path.join(root, dir));
console.log(`Syntax checked ${checked} JavaScript files.`);
