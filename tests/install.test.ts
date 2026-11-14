import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const INSTALLER = path.resolve(__dirname, '..', 'scripts', 'install.sh');
const hasCurl = spawnSync('curl', ['--version']).status === 0;

/** Stands in for the real bundle: records an `all` run instead of spending tokens. */
const FAKE_BUNDLE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('speedtest-ai v0.0.0-test');
else if (args[0] === 'all') require('fs').appendFileSync(process.env.FAKE_LOG, 'ALL RAN\\n');
`;

let root: string;
let site: string;
let home: string;
let log: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-install-'));
  site = path.join(root, 'site');
  home = path.join(root, 'home');
  log = path.join(root, 'all.log');
  fs.mkdirSync(site);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(site, 'speedtest-ai.cjs'), FAKE_BUNDLE);
  const sha = createHash('sha256').update(FAKE_BUNDLE).digest('hex');
  fs.writeFileSync(path.join(site, 'checksums.txt'), `${sha}  speedtest-ai.cjs\n`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const CLEAN_PATH = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');

function install(env: Record<string, string> = {}, args: string[] = [], script = fs.readFileSync(INSTALLER, 'utf8')) {
  // HOME points at a temp directory, so the real ~/.local/bin is never touched.
  return spawnSync('sh', ['-s', '--', ...args], {
    input: script,
    encoding: 'utf8',
    cwd: root,
    env: {
      // System tools and node only: a speedtest already installed on this machine must not be
      // mistaken for another program that owns the name.
      PATH: CLEAN_PATH,
      HOME: home,
      FAKE_LOG: log,
      SPEEDTEST_AI_BASE_URL: `file://${site}`,
      ...env,
    },
    timeout: 30_000,
  });
}

const installed = () => path.join(home, '.local', 'bin', 'speedtest-ai');

describe.skipIf(!hasCurl || process.platform === 'win32')('install.sh', () => {
  it('is valid POSIX shell syntax', () => {
    expect(spawnSync('sh', ['-n', INSTALLER]).status).toBe(0);
  });

  it('installs the verified bundle and its alias, and starts no speed test without a terminal', () => {
    const result = install();

    expect(result.status).toBe(0);
    expect(fs.readFileSync(installed(), 'utf8')).toBe(FAKE_BUNDLE);
    expect(fs.statSync(installed()).mode & 0o111).not.toBe(0);
    expect(fs.readlinkSync(path.join(home, '.local', 'bin', 'aispeed'))).toBe('speedtest-ai');
    expect(result.stdout).toContain('Installed KM AI Speed Test (speedtest-ai v0.0.0-test)');
    expect(result.stdout).toContain('No interactive terminal, so no speed test was started');
    expect(result.stdout).toContain('is not on your PATH');
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readdirSync(path.join(home, '.local', 'bin')).sort()).toEqual(['aispeed', 'kmspeed', 'speedtest', 'speedtest-ai']);
    expect(result.stdout).toContain('Run it as: speedtest ');
  });

  it('leaves the speedtest name alone when another program already owns it', () => {
    // Ookla's internet speed test is also called "speedtest".
    const other = path.join(root, 'other-bin');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'speedtest'), '#!/bin/sh\necho ookla\n', { mode: 0o755 });
    const result = install({ PATH: `${other}:${CLEAN_PATH}` });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'speedtest'))).toBe(false);
    expect(result.stdout).toContain('Another program named speedtest is already installed');
    expect(result.stdout).toContain('Run this one as: speedtest-ai');
    expect(fs.readFileSync(path.join(other, 'speedtest'), 'utf8')).toContain('ookla');
  });

  it('honours SPEEDTEST_NO_AUTO_RUN=1 and --no-run', () => {
    for (const result of [install({ SPEEDTEST_NO_AUTO_RUN: '1' }), install({}, ['--no-run'])]) {
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('speed test was started');
      expect(fs.existsSync(log)).toBe(false);
    }
  });

  it('installs nothing when the checksum does not match', () => {
    fs.appendFileSync(path.join(site, 'speedtest-ai.cjs'), '// tampered\n');

    const result = install();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SHA-256 checksum mismatch, nothing was installed');
    expect(fs.existsSync(installed())).toBe(false);
  });

  it('uses the pinned checksum of a released installer instead of checksums.txt', () => {
    const script = fs.readFileSync(INSTALLER, 'utf8');
    expect(script.split('PINNED_SHA256="__SPEEDTEST_AI_SHA256__"')).toHaveLength(2);
    fs.rmSync(path.join(site, 'checksums.txt'));

    const wrong = install({}, [], script.replace('__SPEEDTEST_AI_SHA256__', 'a'.repeat(64)));
    expect(wrong.status).toBe(1);
    expect(fs.existsSync(installed())).toBe(false);

    const sha = createHash('sha256').update(FAKE_BUNDLE).digest('hex');
    const right = install({}, [], script.replace('__SPEEDTEST_AI_SHA256__', sha));
    expect(right.status).toBe(0);
    expect(fs.existsSync(installed())).toBe(true);
  });

  it('refuses a bundle that does not run, and a missing download', () => {
    const broken = 'this is not javascript (\n';
    fs.writeFileSync(path.join(site, 'speedtest-ai.cjs'), broken);
    fs.writeFileSync(
      path.join(site, 'checksums.txt'),
      `${createHash('sha256').update(broken).digest('hex')}  speedtest-ai.cjs\n`
    );
    const result = install();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not run on this Node.js');
    expect(fs.existsSync(installed())).toBe(false);

    fs.rmSync(path.join(site, 'speedtest-ai.cjs'));
    expect(install().status).toBe(1);
    expect(fs.existsSync(installed())).toBe(false);
  });

  it('does nothing when the script itself was cut off mid-download', () => {
    const script = fs.readFileSync(INSTALLER, 'utf8');
    const result = install({}, [], script.slice(0, Math.floor(script.length * 0.6)));
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(installed())).toBe(false);
  });

  it('rejects an old Node.js', () => {
    const bin = path.join(root, 'oldnode');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'node'),
      '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v18.19.0; else echo 18; fi\n',
      { mode: 0o755 }
    );
    const result = install({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node.js 20 or newer is required (found v18.19.0)');
  });
});
