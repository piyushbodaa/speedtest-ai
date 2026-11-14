#!/usr/bin/env node
// Builds the publishable folder `release/`:
//
//   speedtest-ai.cjs   the CommonJS bundle that install.sh downloads
//   speedtest-ai.mjs   the same program as an ES module (the filename older installers fetch)
//   install.sh         scripts/install.sh with the bundle's SHA-256 pinned
//   checksums.txt      SHA-256 of the three files above
//
// Deploy by copying the whole folder to the website in one step, so install.sh and the bundle it
// pins never go out of sync.
//
// Usage: node scripts/release.mjs [--skip-checks] [--no-build]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (flag !== '--skip-checks' && flag !== '--no-build') {
    console.error(`Unknown option ${flag}. Usage: node scripts/release.mjs [--skip-checks] [--no-build]`);
    process.exit(2);
  }
}

const SHA_PLACEHOLDER = '__SPEEDTEST_AI_SHA256__';

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail(`"${command} ${args.join(' ')}" failed`);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Runs a bundle with `--version`, as old Node would: without ES-module syntax detection. */
function versionOf(file, { forceCommonJs }) {
  const attempt = (extraArgs) =>
    spawnSync(process.execPath, [...extraArgs, file, '--version'], { encoding: 'utf8', timeout: 20_000 });
  let result = forceCommonJs ? attempt(['--no-experimental-detect-module']) : attempt([]);
  // Node versions that never had module detection reject the flag; they behave that way anyway.
  if (forceCommonJs && result.status !== 0 && /bad option/i.test(result.stderr ?? '')) result = attempt([]);
  if (result.status !== 0) {
    fail(`${path.relative(root, file)} --version failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!flags.has('--skip-checks')) {
  run(npm, ['run', 'typecheck']);
  run(npm, ['test']);
}
if (!flags.has('--no-build')) run(npm, ['run', 'build']);

const cjsBundle = path.join(root, 'dist', 'cli.cjs');
const esmBundle = path.join(root, 'dist', 'cli.mjs');
for (const file of [cjsBundle, esmBundle]) {
  if (!fs.existsSync(file)) fail(`${path.relative(root, file)} is missing; run the build first`);
}

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });

// Tested under the names and conditions they are used with: the CommonJS bundle as the
// extensionless file the installer writes, the ES module as a .mjs file. The copy lives outside
// the repository, whose package.json ("type": "module") would make Node read it as an ES module.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-release-'));
const installedCopy = path.join(scratch, 'speedtest-ai');
fs.copyFileSync(cjsBundle, installedCopy);
const expected = `speedtest-ai v${pkg.version}`;
let cjsVersion;
try {
  cjsVersion = versionOf(installedCopy, { forceCommonJs: true });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (cjsVersion !== expected) {
  fail(`the CommonJS bundle reports "${cjsVersion}" but package.json says ${pkg.version}`);
}

const outputs = {
  cjs: path.join(releaseDir, 'speedtest-ai.cjs'),
  esm: path.join(releaseDir, 'speedtest-ai.mjs'),
  installer: path.join(releaseDir, 'install.sh'),
};
fs.copyFileSync(cjsBundle, outputs.cjs);
fs.copyFileSync(esmBundle, outputs.esm);
fs.chmodSync(outputs.cjs, 0o755);
fs.chmodSync(outputs.esm, 0o755);

const esmVersion = versionOf(outputs.esm, { forceCommonJs: false });
if (esmVersion !== expected) fail(`the ES module bundle reports "${esmVersion}", expected "${expected}"`);

const installerSource = fs.readFileSync(path.join(root, 'scripts', 'install.sh'), 'utf8');
const pinLine = `PINNED_SHA256="${SHA_PLACEHOLDER}"`;
if (installerSource.split(pinLine).length !== 2) {
  fail(`scripts/install.sh must contain the line ${pinLine} exactly once`);
}
fs.writeFileSync(outputs.installer, installerSource.replace(pinLine, `PINNED_SHA256="${sha256(outputs.cjs)}"`), {
  mode: 0o755,
});

const checksumLines = Object.values(outputs).map((file) => `${sha256(file)}  ${path.basename(file)}`);
fs.writeFileSync(path.join(releaseDir, 'checksums.txt'), checksumLines.join('\n') + '\n');

console.log(`\nspeedtest-ai ${pkg.version} release written to ${path.relative(root, releaseDir)}/`);
for (const line of checksumLines) console.log(`  ${line}`);
console.log('\nCopy the folder to the website in one step (install.sh pins the bundle checksum).');
