import { defineConfig } from 'vitest/config';

// These suites drive fake CLIs written as /bin/sh scripts, or the POSIX installer. The logic they
// cover is the same on every platform, so on Windows they are left to the Linux and macOS jobs;
// tests/platform.test.ts and the CI steps cover what is Windows-specific.
const posixOnly = [
  'tests/agy.test.ts',
  'tests/claude.test.ts',
  'tests/grok.test.ts',
  'tests/muse.test.ts',
  'tests/text-stream.test.ts',
  'tests/detect.test.ts',
];

export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'dist/**', 'release/**', ...(process.platform === 'win32' ? posixOnly : [])],
  },
});
