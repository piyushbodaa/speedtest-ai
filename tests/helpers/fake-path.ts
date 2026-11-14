import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A throwaway machine layout for discovery tests: a fake `mise` (shell builtins only, so it runs
 * with any PATH), mise shim / command-wrapper directories whose entries are symlinks to it, and
 * directories for real fake CLIs.
 *
 * The fake mise appends "<argv0> <args>" to `log` on every invocation. A shim that gets executed
 * shows up there with the shim's own name as argv0.
 */
export interface FakeMachine {
  root: string;
  miseBin: string;
  shimDir: string;
  wrapperDir: string;
  realDir: string;
  installsDir: string;
  log: string;
  /** Creates `<shimDir>/<cmd>` as a symlink to the fake mise. */
  addShim: (cmd: string) => string;
  /** Creates `<wrapperDir>/<cmd>` as a symlink to the fake mise. */
  addWrapper: (cmd: string) => string;
  /** Writes an executable shell script. Returns its path. */
  addScript: (dir: string, cmd: string, body: string) => string;
  /** Makes `mise which <cmd>` print `target`. Without it the fake answers "not currently active". */
  activate: (cmd: string, target: string) => void;
  /** Makes `mise which` sleep forever. */
  hangMise: () => void;
  readLog: () => string;
  remove: () => void;
}

export function createFakeMachine(): FakeMachine {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-machine-')));
  const miseHome = path.join(root, 'usr-bin');
  const shimDir = path.join(root, 'share', 'mise', 'shims');
  const wrapperDir = path.join(root, 'share', 'mise', 'command-wrappers', 'bin');
  const realDir = path.join(root, 'real-bin');
  const installsDir = path.join(root, 'share', 'mise', 'installs');
  const whichDir = path.join(root, 'mise-which');
  const log = path.join(root, 'mise.log');
  for (const dir of [miseHome, shimDir, wrapperDir, realDir, installsDir, whichDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const miseBin = path.join(miseHome, 'mise');
  fs.writeFileSync(
    miseBin,
    `#!/bin/sh
echo "$0 $*" >> '${log}'
if [ -f '${whichDir}/.hang' ]; then
  while :; do sleep 1; done
fi
if [ "$1" = "which" ]; then
  if [ -f '${whichDir}/'"$2" ]; then
    read -r target < '${whichDir}/'"$2"
    echo "$target"
    exit 0
  fi
  echo "mise ERROR $2 is a mise bin however it is not currently active. Use \`mise use\` to activate it in this directory." >&2
  exit 1
fi
echo "FAKE MISE EXECUTED AS SHIM" >&2
exit 97
`,
    { mode: 0o755 }
  );

  const addScript = (dir: string, cmd: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, cmd);
    fs.writeFileSync(file, body.startsWith('#!') ? body : `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const link = (dir: string, cmd: string) => {
    const file = path.join(dir, cmd);
    fs.symlinkSync(miseBin, file);
    return file;
  };

  return {
    root,
    miseBin,
    shimDir,
    wrapperDir,
    realDir,
    installsDir,
    log,
    addShim: (cmd) => link(shimDir, cmd),
    addWrapper: (cmd) => link(wrapperDir, cmd),
    addScript,
    activate: (cmd, target) => fs.writeFileSync(path.join(whichDir, cmd), `${target}\n`),
    hangMise: () => fs.writeFileSync(path.join(whichDir, '.hang'), ''),
    readLog: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** A fake CLI that answers `--version` and prints `help` for any invocation containing `--help`. */
export function fakeCliScript(options: { version?: string; help?: string; extra?: string }): string {
  const help = (options.help ?? '').replace(/'/g, `'\\''`);
  return `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--help" ]; then
    printf '%s\\n' '${help}'
    exit 0
  fi
done
if [ "$1" = "--version" ]; then
  echo '${options.version ?? '1.0.0-fake'}'
  exit 0
fi
${options.extra ?? 'exit 0'}
`;
}
