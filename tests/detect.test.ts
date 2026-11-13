import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSafeEnv, detectTargets, resolveRealBinary } from '../src/core/detect.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('detect and mise shim protection', () => {
  it('buildSafeEnv enforces MISE_AUTO_INSTALL=false and strips CLAUDECODE', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const safe = buildSafeEnv();
    expect(safe.MISE_AUTO_INSTALL).toBe('false');
    expect(safe.MISE_NOT_FOUND_AUTO_INSTALL).toBe('0');
    expect(safe.CLAUDECODE).toBeUndefined();
    expect(safe.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
  });

  it('prefers non-mise-shim binaries and ignores missing uninstalled shims', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'speedtest-detect-'));
    tempDirs.push(root);

    const shimDir = path.join(root, '.local', 'share', 'mise', 'shims');
    const realDir = path.join(root, 'real-bin');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(shimDir, { recursive: true });
      await fs.mkdir(realDir, { recursive: true });
    });

    const shimBin = path.join(shimDir, 'mytool');
    const realBin = path.join(realDir, 'mytool');
    await writeFile(shimBin, '#!/bin/sh\nexit 1\n', 'utf8');
    await writeFile(realBin, '#!/bin/sh\necho 1.0\n', 'utf8');
    await chmod(shimBin, 0o755);
    await chmod(realBin, 0o755);

    const resolved = await resolveRealBinary('mytool', `${shimDir}${path.delimiter}${realDir}`);
    expect(resolved).toBe(realBin);

    const missing = await resolveRealBinary('definitely-missing-binary-xyz', realDir);
    expect(missing).toBeNull();
  });

  it('detectTargets always returns demo as available and completes quickly', async () => {
    const start = Date.now();
    const targets = await detectTargets();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    const demo = targets.find((t) => t.id === 'demo');
    expect(demo?.available).toBe(true);
    expect(targets.some((t) => t.id === 'claude')).toBe(true);
    expect(targets.some((t) => t.id === 'codex')).toBe(true);
  });
});
