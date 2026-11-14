import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnIsolated } from '../src/adapters/utils/spawn.js';
import { resolveBinary } from '../src/core/detect.js';
import { executableNames, IS_WINDOWS, spawnTarget } from '../src/core/platform.js';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-platform-')));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('platform helpers', () => {
  it('passes plain executables through untouched', () => {
    expect(spawnTarget(process.execPath, ['-v'])).toEqual({ file: process.execPath, args: ['-v'] });
  });

  it.skipIf(IS_WINDOWS)('looks for the bare command name on POSIX', () => {
    expect(executableNames('claude')).toEqual(['claude']);
  });

  it.skipIf(!IS_WINDOWS)('tries real executables before .cmd shims on Windows', () => {
    expect(executableNames('claude', '.COM;.EXE;.BAT;.CMD;.PS1')).toEqual(['claude.exe', 'claude.com', 'claude.cmd', 'claude.bat']);
    expect(executableNames('claude.exe')).toEqual(['claude.exe']);
  });
});

// The prompt must reach the agent byte for byte: newlines, quotes and cmd.exe metacharacters.
const AWKWARD = 'line one\nline "two" & <three> | 100% ^caret (paren) ; done';

describe.skipIf(!IS_WINDOWS)('Windows command shims', () => {
  const script = path.join(dir, 'echo-args.cjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');

  async function run(file: string, args: string[]): Promise<string[]> {
    const handle = spawnIsolated(file, args, { cwd: dir });
    let out = '';
    handle.stdout.on('data', (chunk) => (out += chunk));
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(0);
    return JSON.parse(out);
  }

  it('unwraps an npm shim to node and keeps every argument intact', async () => {
    const bin = path.join(dir, 'agent.cmd');
    fs.writeFileSync(bin, '@ECHO off\r\nnode "%dp0%\\echo-args.cjs" %*\r\n');
    expect(spawnTarget(bin, ['x']).file).toBe(process.execPath);
    expect(await run(bin, ['-p', AWKWARD])).toEqual(['-p', AWKWARD]);
  });

  it('runs any other batch file through cmd.exe with its arguments quoted', async () => {
    const bin = path.join(dir, 'plain.cmd');
    fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    expect(await run(bin, ['--flag', 'two words', 'a&b'])).toEqual(['--flag', 'two words', 'a&b']);
  });

  it('finds a .cmd on PATH by its bare name', async () => {
    const bin = path.join(dir, 'findme.cmd');
    fs.writeFileSync(bin, '@echo off\r\n');
    expect(await resolveBinary('findme', { pathEnv: dir })).toMatchObject({ status: 'found', path: bin });
  });
});
