import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterInvokeRequest, AdapterStreamChunk } from '../../src/types.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

export function readFixture(name: string): unknown[] {
  return fs
    .readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * What the stand-in binary does, chosen by its first argument ("app-server", "exec", anything else):
 *   replay  print the fixture lines, then exit with `exit` or stay alive when it is undefined
 *   rpc     answer JSON-RPC requests from stdin with the fixture's responses; after `turn/start`
 *           print the fixture's notifications and stay alive (like the real app-server)
 *   silent  print nothing and stay alive
 *   exit    write `stderr` and exit with `exit`
 */
export interface ReplayRoute {
  mode: 'replay' | 'rpc' | 'silent' | 'exit';
  file?: string;
  exit?: number;
  stderr?: string;
  /** rpc: answer this request id with a JSON-RPC error instead of the fixture's result. */
  errorOnId?: number;
}

export interface ReplayScenario {
  appServer?: ReplayRoute;
  exec?: ReplayRoute;
  print?: ReplayRoute;
}

const SCRIPT_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
fs.appendFileSync(path.join(dir, 'pids.log'), process.pid + '\\n');
const first = process.argv[2];
const route = (first === 'app-server' ? scenario.appServer : first === 'exec' ? scenario.exec : scenario.print) || { mode: 'exit', exit: 2, stderr: 'no route' };
const out = (line) => process.stdout.write(line + '\\n');
const hang = () => setInterval(() => {}, 1000);
const lines = route.file ? fs.readFileSync(route.file, 'utf8').split('\\n').filter(Boolean) : [];
const finish = () => {
  if (route.stderr) process.stderr.write(route.stderr);
  if (route.exit === undefined) hang();
  else setTimeout(() => process.exit(route.exit), 20);
};
if (route.mode === 'silent') hang();
else if (route.mode === 'exit') finish();
else if (route.mode === 'replay') { for (const line of lines) out(line); finish(); }
else if (route.mode === 'rpc') {
  const parsed = lines.map((line) => JSON.parse(line));
  let buf = '';
  process.stdin.on('data', (data) => {
    buf += data;
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      fs.appendFileSync(path.join(dir, 'received.log'), line + '\\n');
      const msg = JSON.parse(line);
      if (msg.id === undefined || !msg.method) continue;
      if (route.errorOnId === msg.id) { out(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'rejected by fake server' } })); continue; }
      const response = parsed.find((m) => m.id === msg.id && m.method === undefined);
      if (response) out(JSON.stringify(response));
      if (msg.method === 'turn/start') for (const m of parsed) if (m.method !== undefined) out(JSON.stringify(m));
    }
  });
  hang();
}
`;

export interface ReplayCli {
  /** Executable path to hand to an adapter factory. */
  bin: string;
  setScenario(scenario: ReplayScenario): void;
  /** One argv array per invocation, in order. */
  invocations(): string[][];
  /** Every line the adapter wrote to the app-server's stdin. */
  received(): any[];
  pids(): number[];
  reset(): void;
  remove(): void;
}

export function createReplayCli(): ReplayCli {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedtest-ai-replay-'));
  const bin = path.join(dir, 'fake-agent.cjs');
  fs.writeFileSync(bin, `#!${process.execPath}\n${SCRIPT_SOURCE}`, { mode: 0o755 });
  const readLines = (name: string): string[] => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return {
    bin,
    setScenario: (scenario) => fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario)),
    invocations: () => readLines('argv.log').map((line) => JSON.parse(line)),
    received: () => readLines('received.log').map((line) => JSON.parse(line)),
    pids: () => readLines('pids.log').map(Number),
    reset: () => {
      for (const name of ['argv.log', 'received.log', 'pids.log']) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    },
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export function request(overrides: Partial<AdapterInvokeRequest> = {}): AdapterInvokeRequest {
  return { phase: 'download', prompt: 'Say hi.', signal: new AbortController().signal, ...overrides };
}

export async function drain(gen: AsyncGenerator<AdapterStreamChunk, void, unknown>) {
  const chunks: AdapterStreamChunk[] = [];
  let error: unknown;
  const startedAt = Date.now();
  try {
    for await (const chunk of gen) chunks.push(chunk);
  } catch (err) {
    error = err;
  }
  return { chunks, error, elapsedMs: Date.now() - startedAt };
}

export const kindsOf = (chunks: AdapterStreamChunk[]) => chunks.map((c) => c.kind);

export const textOf = (chunks: AdapterStreamChunk[]) =>
  chunks
    .filter((c) => c.kind === 'text')
    .map((c) => c.text)
    .join('');
