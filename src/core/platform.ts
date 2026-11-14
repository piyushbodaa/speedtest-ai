import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * Stops a child and everything it started. POSIX: a signal to the process group the child leads.
 * Windows has no process groups or signals, so taskkill walks the process tree instead.
 */
export function killTree(pid: number, signal: 'SIGTERM' | 'SIGKILL', groupOnly = false): boolean {
  if (IS_WINDOWS) {
    const args = ['/pid', String(pid), '/T'];
    // Without /F taskkill only asks windowed programs to close; console CLIs need it.
    args.push('/F');
    const res = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    return res.status === 0;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    if (groupOnly) return false;
    try {
      // The group may be gone while the leader is still a zombie, or the child never became a
      // group leader; fall back to the single pid. ESRCH here means there is nothing left.
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function treeAlive(pid: number): boolean {
  try {
    process.kill(IS_WINDOWS ? pid : -pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** File names to try for a command in one PATH directory. Windows needs an extension. */
export function executableNames(cmd: string, pathExt = process.env.PATHEXT): string[] {
  if (!IS_WINDOWS) return [cmd];
  if (path.extname(cmd)) return [cmd];
  const exts = (pathExt || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  // Real executables first, then npm's .cmd shims.
  const order = ['.exe', '.com', '.cmd', '.bat'].filter((e) => exts.includes(e));
  return order.map((ext) => cmd + ext);
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for cmd.exe the way cross-spawn does, so it reaches a .cmd shim intact. */
function escapeCmdArgument(arg: string): string {
  let out = String(arg);
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`;
  // Twice: the shim itself passes the arguments through cmd.exe once more.
  return out.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

export interface SpawnTarget {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * What to hand to child_process.spawn for a resolved binary. Node refuses to start .cmd/.bat
 * files directly. An npm shim is unwrapped to `node <script>`, which keeps arguments (prompts
 * with newlines and quotes) byte-exact; any other batch file goes through cmd.exe.
 */
export function spawnTarget(cmd: string, args: string[]): SpawnTarget {
  if (!IS_WINDOWS || !/\.(cmd|bat)$/i.test(cmd)) return { file: cmd, args };
  try {
    const text = fsSync.readFileSync(cmd, 'utf8');
    const match = /"%~?dp0%?\\([^"\r\n]+?\.(?:c|m)?js)"/i.exec(text);
    if (match) {
      const script = path.join(path.dirname(cmd), match[1]);
      if (fsSync.existsSync(script)) return { file: process.execPath, args: [script, ...args] };
    }
  } catch {
    // Unreadable shim: fall through to cmd.exe.
  }
  const line = [`"${cmd}"`, ...args.map(escapeCmdArgument)].join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
