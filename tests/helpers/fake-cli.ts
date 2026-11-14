import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A scriptable stand-in for an agent CLI. The scenario is a JSON list of steps passed as argv[2]:
 *   {wait: ms}            sleep
 *   {out: value}          print a JSON line (strings are printed raw, with a newline)
 *   {bytes: [..]}         write raw bytes to stdout (no newline)
 *   {err: text}           write to stderr
 *   {exit: code}          exit
 *   {hang: true}          stay alive forever
 *   {ignoreSigterm: true} trap SIGTERM
 *   {grandchild: sec}     start `sleep <sec>` that inherits stdout, print {grandchild: pid}
 *   {pid: true}           print {pid}
 *   {echoStdin: true}     for each stdin line print {echo: <parsed line>}; {"cmd":"finish"} prints {t:"done"}
 */
const FAKE_CLI_SOURCE = `
const { spawn } = require('node:child_process');
const steps = JSON.parse(process.argv[2] || '[]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (const step of steps) {
    if (step.wait !== undefined) await sleep(step.wait);
    else if (step.out !== undefined) process.stdout.write((typeof step.out === 'string' ? step.out : JSON.stringify(step.out)) + '\\n');
    else if (step.bytes) process.stdout.write(Buffer.from(step.bytes));
    else if (step.err !== undefined) process.stderr.write(step.err);
    else if (step.exit !== undefined) { await sleep(20); process.exit(step.exit); }
    else if (step.hang) await new Promise(() => { setInterval(() => {}, 1000); });
    else if (step.ignoreSigterm) process.on('SIGTERM', () => {});
    else if (step.grandchild) {
      const gc = spawn('sleep', [String(step.grandchild)], { stdio: ['ignore', 'inherit', 'inherit'] });
      process.stdout.write(JSON.stringify({ grandchild: gc.pid }) + '\\n');
    }
    else if (step.pid) process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
    else if (step.echoStdin) {
      await new Promise((resolve) => {
        let buf = '';
        process.stdin.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\\n')) !== -1) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            const msg = JSON.parse(line);
            if (msg.cmd === 'finish') { process.stdout.write(JSON.stringify({ t: 'done' }) + '\\n'); }
            else process.stdout.write(JSON.stringify({ echo: msg }) + '\\n');
          }
        });
        process.stdin.on('end', resolve);
      });
    }
  }
})();
`;

export type FakeStep =
  | { wait: number }
  | { out: unknown }
  | { bytes: number[] }
  | { err: string }
  | { exit: number }
  | { hang: true }
  | { ignoreSigterm: true }
  | { grandchild: number }
  | { pid: true }
  | { echoStdin: true };

export interface FakeCli {
  dir: string;
  script: string;
  /** argv for `process.execPath`. */
  args: (steps: FakeStep[]) => string[];
  remove: () => void;
}

export function createFakeCli(): FakeCli {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-fake-'));
  const script = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(script, FAKE_CLI_SOURCE, 'utf8');
  return {
    dir,
    script,
    args: (steps) => [script, JSON.stringify(steps)],
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(check: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return check();
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
