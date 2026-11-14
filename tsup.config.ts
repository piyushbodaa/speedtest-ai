import { chmod } from 'node:fs/promises';
import { defineConfig } from 'tsup';

// The licence notice travels with the standalone bundle, which is distributed without the repo.
const shebang = {
  js: '#!/usr/bin/env node\n// KM AI Speed Test (speedtest-ai). MIT License. Copyright (c) 2026 Krutrim Mulyankan.\n// https://krutrimmulyankan.in/speedtest/LICENSE.txt',
};

export default defineConfig([
  {
    // The installed command. CommonJS, because the installer drops it as an extensionless file and
    // Node only runs extensionless ES modules from 20.19 / 22.7 on; CommonJS runs on every Node 20+.
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    target: 'node20',
    platform: 'node',
    sourcemap: true,
    banner: shebang,
    async onSuccess() {
      await chmod('dist/cli.cjs', 0o755);
    },
  },
  {
    // Same program as a standalone ES module, published as speedtest-ai.mjs for older installers.
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    banner: shebang,
    async onSuccess() {
      await chmod('dist/cli.mjs', 0o755);
    },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
  },
]);
