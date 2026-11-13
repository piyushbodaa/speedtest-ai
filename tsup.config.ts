import { chmod } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
    async onSuccess() {
      await chmod('dist/cli.js', 0o755);
    },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: false,
  },
]);
