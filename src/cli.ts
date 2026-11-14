import fs from 'node:fs/promises';
import path from 'node:path';
import {
  explainAllSkips,
  knownTargetIds,
  selectAllTargets,
  targetsHelpLines,
} from './adapters/catalog.js';
import { createDemoAdapter } from './adapters/providers/demo.js';
import { parseTargetSpec, resolveAdapter } from './adapters/registry.js';
import { killAllChildren } from './adapters/utils/spawn.js';
import {
  DEFAULT_CARD_PATH,
  parseCliArgs,
  type ParsedCommand,
  type RunOptions,
  UsageError,
} from './cli-args.js';
import { renderSvgCard } from './core/card.js';
import { detectTargets } from './core/detect.js';
import { InterruptedError } from './core/errors.js';
import { clearHistory, readHistory } from './core/history.js';
import { compareResultsByRank } from './core/metrics.js';
import { DEFAULT_PHASE_TIMEOUT_MS, MAX_RUNS, runSpeedtestRepeated } from './core/runner.js';
import { c, sanitizeInline, truncateAnsi, wrapText } from './tui/ansi.js';
import {
  consumeSpeedtestEvents,
  describeRunError,
  type OutputMode,
  renderCompareTable,
  renderDetectTable,
  renderHistoryTable,
  type TargetFailure,
} from './tui/dashboard.js';
import { err, isOutputClosed, markOutputClosed, maxLineWidth, out, restoreTerminal } from './tui/io.js';
import { promptInteractiveTarget } from './tui/prompt.js';
import {
  RESULT_SCHEMA_VERSION,
  type BenchmarkMode,
  type SpeedtestAdapter,
  type SpeedtestResult,
  type TargetInfo,
} from './types.js';

const VERSION = '0.3.0';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_NOTHING_DETECTED = 2;
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;
const EXIT_SIGHUP = 129;
const HARD_EXIT_AFTER_MS = 2000;

function helpText(): string {
  return `speedtest-ai v${VERSION} — a speed test for AI agent CLIs and models

USAGE
  speedtest-ai all [flags]            Benchmark every installed agent CLI
  speedtest-ai                        Pick a target interactively
  speedtest-ai run -t <target>        Benchmark one target (or target:model)
  speedtest-ai compare -t <t1,t2,..>  Benchmark several, with a leaderboard
  speedtest-ai demo                   Simulated run, no model is called
  speedtest-ai detect [--json]        List what is installed and usable
  speedtest-ai history                Show saved results (--limit N, --clear)

  "all", "run" and "compare" send real prompts and spend real model tokens.

TARGETS (-t)
${targetsHelpLines(78).join('\n')}

WHAT IS MEASURED
  TTFT     process start (or request sent) to the first visible token
  tok/s    decode rate: tokens after the first one / time between the first
           and the last token. A target that does not stream is "buffered":
           no TTFT, ranked last, on end-to-end tok/s (marked E2E).
  tokens   "normalized": one local estimator on the visible text, the same
           for every target. Vendor counts are shown for information only.

MODES (default: quick for "all" and the picker, standard otherwise)
      --quick            Download only: TTFT, tok/s, jitter
      --standard         Ping, download, large-prompt upload, agent tool loop
      --full             Same phases with a longer answer and prompt

FLAGS
  -t, --target <spec>    Target or target:model, e.g. claude, ollama:llama3.2
  -m, --model <model>    Model for a single target (default: the CLI's own)
  -a, --all              Same as the "all" command
      --runs <n>         Repeat the download n times (1-${MAX_RUNS}), report the median
      --as-configured    Keep your MCP servers, hooks, plugins and project
                         context. Default is lean: your login and model only
      --include-apis     "all" also tests cloud APIs that have a key set
      --profile <name>   Demo profile (see Simulated above; default frontier)
      --cmd <template>   Shell command for -t cmd; the prompt replaces
                         {prompt} and is also in $SPEEDTEST_PROMPT
      --base-url <url>   OpenAI-compatible or provider base URL
      --api-key <key>    Provider API key (default: from the environment)
      --timeout <sec>    Per-phase time limit (default ${DEFAULT_PHASE_TIMEOUT_MS / 1000})
      --card [path]      Save an SVG card. The path must end in .svg or
                         contain a "/" (default ./${DEFAULT_CARD_PATH})
      --json             Print only the final JSON
      --jsonl            Stream progress events as JSON lines
      --plain            Line output instead of the live gauge
      --no-history       Do not save this run
      --limit <n>        history: entries to show (default 15)
      --clear            history: delete saved results
  -h, --help             Show this help
  -v, --version          Show the version

EXIT CODES
  0    at least one target completed
  1    every target failed
  2    bad arguments, or "all" found nothing to benchmark
  130  interrupted with Ctrl-C (press twice to exit at once)
  143  terminated
`;
}

/** One controller for the whole invocation: an interrupt stops the current target and the batch. */
const controller = new AbortController();
let stopCode: number | undefined;
let sigintCount = 0;
let hardExitReport: (() => void) | undefined;

function hardExit(code: number): never {
  killAllChildren({ force: true });
  restoreTerminal();
  try {
    hardExitReport?.();
  } catch {
    // Exiting matters more than the report.
  }
  process.exit(code);
}

/**
 * Asks everything to stop and lets the generators unwind (children get SIGTERM, temp dirs are
 * removed, the partial leaderboard is printed). The hard exit is only a fallback.
 */
function requestStop(code: number, reason: string): void {
  if (stopCode === undefined) stopCode = code;
  process.exitCode = stopCode;
  if (!controller.signal.aborted) controller.abort(new InterruptedError(reason));
  killAllChildren();
  setTimeout(() => hardExit(stopCode ?? code), HARD_EXIT_AFTER_MS).unref();
}

function onInterrupt(): void {
  sigintCount += 1;
  if (sigintCount >= 2) {
    hardExitReport = undefined;
    hardExit(EXIT_SIGINT);
  }
  requestStop(EXIT_SIGINT, 'Interrupted by user');
}

function installProcessHandlers(): void {
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', () => requestStop(EXIT_SIGTERM, 'Terminated'));
  process.on('SIGHUP', () => requestStop(EXIT_SIGHUP, 'Terminal closed'));
  process.on('exit', () => restoreTerminal());

  // A reader that went away (`| head -1`) is a quiet stop, not a crash.
  const onStreamError = (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED' || error?.code === 'ERR_STREAM_WRITE_AFTER_END') {
      markOutputClosed();
      requestStop(EXIT_OK, 'Output closed');
      return;
    }
    throw error;
  };
  process.stdout.on('error', onStreamError);
  process.stderr.on('error', () => {});
}

function demoTimeScale(): number | undefined {
  const raw = process.env.SPEEDTEST_AI_DEMO_TIME_SCALE;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

interface PreparedTarget {
  id: string;
  name: string;
  adapter: SpeedtestAdapter;
  model?: string;
}

function assertKnownTarget(spec: string, run: RunOptions): void {
  const { id } = parseTargetSpec(spec);
  if (id === '') throw new UsageError(`"${spec}" is not a target. Write it as target or target:model.`);
  if (run.baseUrl !== undefined || knownTargetIds().includes(id)) return;
  throw new UsageError(`Unknown target "${id}". Run "speedtest-ai detect" to list the targets.`);
}

async function prepareTarget(
  spec: string,
  run: RunOptions,
  detected: TargetInfo[] | undefined,
  model: string | undefined
): Promise<PreparedTarget> {
  const parsed = parseTargetSpec(spec);
  if (parsed.id === 'demo') {
    const profile = model ?? parsed.model ?? 'frontier';
    const adapter = createDemoAdapter(profile as Parameters<typeof createDemoAdapter>[0], {
      timeScale: demoTimeScale(),
    });
    return { id: adapter.id, name: adapter.name, adapter };
  }

  let detectedTargets = detected;
  const needsDiscovery = (parsed.id === 'ollama' || parsed.id === 'lmstudio') && !model && !parsed.model;
  if (!detectedTargets && needsDiscovery) detectedTargets = await detectTargets();

  const resolved = await resolveAdapter({
    targetSpec: spec,
    model,
    cmd: run.cmd,
    baseUrl: run.baseUrl,
    apiKey: run.apiKey,
    detectedTargets,
  });
  return { id: resolved.adapter.id, name: resolved.adapter.name, adapter: resolved.adapter, model: resolved.model };
}

function isHumanOutput(output: OutputMode): boolean {
  return output === 'tui' || output === 'plain';
}

function runPrepared(
  target: PreparedTarget,
  run: RunOptions,
  mode: BenchmarkMode,
  view: { output: OutputMode; compact: boolean }
): Promise<SpeedtestResult> {
  const events = runSpeedtestRepeated({
    adapter: target.adapter,
    model: target.model,
    mode,
    timeoutMs: run.timeoutMs,
    noHistory: run.noHistory,
    signal: controller.signal,
    asConfigured: run.asConfigured,
    runs: run.runs,
  });
  return consumeSpeedtestEvents(events, {
    mode: view.output,
    noHistory: run.noHistory,
    compact: view.compact,
    onInterruptKey: onInterrupt,
  });
}

async function saveCard(cardPath: string, result: SpeedtestResult, announce: boolean): Promise<void> {
  const absPath = path.resolve(cardPath);
  try {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, renderSvgCard(result), 'utf8');
    if (announce) out(`Saved SVG card: ${absPath}\n`);
  } catch (error) {
    err(`speedtest-ai: could not write the card to ${absPath}: ${describeRunError(error).message}\n`);
  }
}

function printError(message: string): void {
  for (const text of wrapText(`speedtest-ai: ${message}`, maxLineWidth())) err(`${text}\n`);
}

async function runSingle(spec: string, run: RunOptions, mode: BenchmarkMode): Promise<number> {
  assertKnownTarget(spec, run);
  const output: OutputMode = run.output;
  const { id } = parseTargetSpec(spec);

  const fail = (error: unknown, emitEvent: boolean): number => {
    const described = describeRunError(error);
    if (output === 'jsonl' && emitEvent) {
      out(JSON.stringify({ type: 'run:error', target: id, error: described.message, kind: described.kind, failureKind: described.failureKind }) + '\n');
    }
    if (output === 'json') {
      out(JSON.stringify({ error: { target: id, message: described.message, kind: described.kind, failureKind: described.failureKind } }, null, 2) + '\n');
    }
    if (described.kind === 'interrupted') {
      if (stopCode !== EXIT_OK) printError(stopCode === EXIT_SIGINT ? 'interrupted.' : `${described.message.toLowerCase()}.`);
      return stopCode ?? EXIT_SIGINT;
    }
    printError(described.message);
    return EXIT_FAILED;
  };

  let target: PreparedTarget;
  try {
    target = await prepareTarget(spec, run, undefined, run.model);
  } catch (error) {
    return fail(error, true);
  }
  if (controller.signal.aborted) return fail(new InterruptedError(), true);

  let result: SpeedtestResult;
  try {
    result = await runPrepared(target, run, mode, { output, compact: false });
  } catch (error) {
    return fail(error, false);
  }
  if (run.cardPath) await saveCard(run.cardPath, result, isHumanOutput(output));
  return EXIT_OK;
}

interface BatchEntry {
  /** What the user (or detection) called it. */
  label: string;
  id: string;
  name: string;
  prepare: () => Promise<PreparedTarget>;
}

function cardPathFor(base: string, entry: BatchEntry, used: Set<string>): string {
  const ext = path.extname(base) || '.svg';
  const stem = base.slice(0, base.length - path.extname(base).length);
  const slug = entry.label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || entry.id;
  let candidate = `${stem}-${slug}${ext}`;
  for (let n = 2; used.has(candidate); n++) candidate = `${stem}-${slug}-${n}${ext}`;
  used.add(candidate);
  return candidate;
}

/** The shared loop behind `all` and `compare`: keeps going past failures, one final leaderboard. */
async function runBatch(entries: BatchEntry[], run: RunOptions, mode: BenchmarkMode): Promise<number> {
  const output = run.output;
  const human = isHumanOutput(output);
  const results: SpeedtestResult[] = [];
  const failures: TargetFailure[] = [];
  const usedCardPaths = new Set<string>();
  let started = 0;
  let reported = false;

  const report = () => {
    if (reported) return;
    reported = true;
    const interrupted = stopCode !== undefined;
    const notRun = entries.slice(started).map((e) => e.label);
    const ranked = [...results].sort(compareResultsByRank);
    if (output === 'json') {
      out(
        JSON.stringify(
          { schemaVersion: RESULT_SCHEMA_VERSION, mode, interrupted, results: ranked, failed: failures, notRun },
          null,
          2
        ) + '\n'
      );
    } else if (output === 'jsonl') {
      out(
        JSON.stringify({
          type: 'batch:complete',
          interrupted,
          ranking: ranked.map((r) => ({
            target: r.targetId,
            model: r.model,
            rankTps: r.summary.rankTps,
            rankMetric: r.summary.rankMetric,
            ttftMs: r.summary.ttftMs,
          })),
          failed: failures,
          notRun,
        }) + '\n'
      );
    } else {
      const table = renderCompareTable(results, { failures, notRun: interrupted ? notRun : [], interrupted });
      if (table) out(`\n${table}\n`);
      if (interrupted && stopCode !== EXIT_OK) printError(stopCode === EXIT_SIGINT ? 'interrupted.' : 'terminated.');
    }
  };
  hardExitReport = report;

  for (let i = 0; i < entries.length; i++) {
    if (controller.signal.aborted) break;
    const entry = entries[i];
    started = i + 1;
    if (human) {
      const head = `${c.bold(c.brightCyan(`▶ [${i + 1}/${entries.length}]`))} ${c.bold(sanitizeInline(entry.name))} ${c.dim(`(${entry.label}) [${mode}${run.runs > 1 ? `, ${run.runs} runs` : ''}]`)}`;
      out(`\n${truncateAnsi(head, maxLineWidth())}\n`);
    }

    let streamedError = false;
    try {
      const target = await entry.prepare();
      if (controller.signal.aborted) throw new InterruptedError();
      streamedError = true;
      const result = await runPrepared(target, run, mode, { output: output === 'json' ? 'silent' : output, compact: true });
      results.push(result);
      if (run.cardPath) await saveCard(cardPathFor(run.cardPath, entry, usedCardPaths), result, human);
    } catch (error) {
      const described = describeRunError(error);
      if (described.kind === 'interrupted' || controller.signal.aborted) {
        // The interrupted target was started but has no result; it is neither ranked nor "failed".
        started = i;
        break;
      }
      failures.push({ targetId: entry.id, targetName: entry.name, error: described.message, kind: described.kind, failureKind: described.failureKind });
      if (output === 'jsonl' && !streamedError) {
        out(JSON.stringify({ type: 'run:error', target: entry.id, error: described.message, kind: described.kind, failureKind: described.failureKind }) + '\n');
      }
      if (human) {
        const width = maxLineWidth();
        const all = wrapText(`${described.kind === 'timeout' ? 'timed out' : 'failed'}: ${described.message}`, Math.max(10, width - 4));
        const wrapped = all.slice(0, 3);
        if (all.length > wrapped.length) wrapped[2] = truncateAnsi(`${wrapped[2]} …`, Math.max(10, width - 4));
        wrapped.forEach((text, n) => out(n === 0 ? `  ${c.yellow('✗')} ${text}\n` : `    ${c.gray(text)}\n`));
      }
    }
  }

  report();
  hardExitReport = undefined;
  if (stopCode !== undefined) return stopCode;
  return results.length > 0 ? EXIT_OK : EXIT_FAILED;
}

async function runAll(includeApis: boolean, run: RunOptions, mode: BenchmarkMode, known?: TargetInfo[]): Promise<number> {
  const human = isHumanOutput(run.output);
  const width = maxLineWidth();
  if (human && !known) out(c.dim('Looking for installed AI agent CLIs…\n'));
  const detected = known ?? (await detectTargets());
  if (controller.signal.aborted) return stopCode ?? EXIT_SIGINT;

  const targets = selectAllTargets(detected, { includeApis });
  const skips = explainAllSkips(detected, { includeApis });

  if (targets.length === 0) {
    const message = 'No AI agent CLI that can be benchmarked was detected.';
    if (run.output === 'json') {
      out(
        JSON.stringify(
          { schemaVersion: RESULT_SCHEMA_VERSION, mode, interrupted: false, results: [], failed: [], notRun: [], error: message, skipped: skips },
          null,
          2
        ) + '\n'
      );
    } else if (run.output === 'jsonl') {
      out(JSON.stringify({ type: 'batch:complete', interrupted: false, ranking: [], failed: [], notRun: [], error: message, skipped: skips }) + '\n');
    }
    printError(message);
    for (const skip of skips) printError(`  ${skip.id}: ${sanitizeInline(skip.reason)}`);
    printError('Run "speedtest-ai detect" for details, or "speedtest-ai demo" for a simulated run.');
    return EXIT_NOTHING_DETECTED;
  }

  if (human) {
    const list = targets.map((t) => t.id).join(', ');
    for (const text of wrapText(`Benchmarking ${targets.length} ${targets.length === 1 ? 'target' : 'targets'}: ${list}`, width)) {
      out(`${c.bold(text)}\n`);
    }
    for (const skip of skips) {
      out(`${c.gray(truncateAnsi(`  skipping ${skip.id}: ${sanitizeInline(skip.reason)}`, width))}\n`);
    }
    for (const text of wrapText(
      `This sends real prompts to each one and spends model tokens (${mode} mode${run.asConfigured ? ', as configured' : ', lean'}). Ctrl-C stops.`,
      width
    )) {
      out(`${c.dim(text)}\n`);
    }
  }

  const entries: BatchEntry[] = targets.map((t) => ({
    label: t.id,
    id: t.id,
    name: t.name,
    prepare: () => prepareTarget(t.id, run, detected, undefined),
  }));
  return runBatch(entries, run, mode);
}

async function runCompare(specs: string[], run: RunOptions, mode: BenchmarkMode): Promise<number> {
  for (const spec of specs) assertKnownTarget(spec, run);
  const needsDetection = specs.some((spec) => !['demo', 'cmd'].includes(parseTargetSpec(spec).id));
  const detected = needsDetection ? await detectTargets() : undefined;
  if (controller.signal.aborted) return stopCode ?? EXIT_SIGINT;

  const entries: BatchEntry[] = specs.map((spec) => {
    const { id } = parseTargetSpec(spec);
    const info = detected?.find((t) => t.id === id);
    return {
      label: spec,
      id,
      name: info?.name ?? (id === 'demo' ? 'Demo Simulator' : id === 'cmd' ? 'Custom Command' : id),
      prepare: () => prepareTarget(spec, run, detected, undefined),
    };
  });
  return runBatch(entries, run, mode);
}

async function runDefault(run: RunOptions): Promise<number> {
  const interactive = process.stdout.isTTY && process.stdin.isTTY && run.output === 'tui';
  if (!interactive) {
    if (run.output === 'json' || run.output === 'jsonl') {
      throw new UsageError('Nothing to run: add a command such as "all", "run -t <target>" or "detect".');
    }
    out(helpText());
    out('\n');
    out(renderDetectTable(await detectTargets()) + '\n');
    return EXIT_OK;
  }

  out(c.dim('Looking for installed AI agent CLIs…\n'));
  const detected = await detectTargets();
  out('\x1b[1A\r\x1b[2K');
  if (controller.signal.aborted) return stopCode ?? EXIT_SIGINT;

  const outcome = await promptInteractiveTarget(detected, {
    initialMode: run.mode,
    allTargets: selectAllTargets(detected, {}),
    signal: controller.signal,
  });
  if (outcome.kind === 'interrupted') {
    if (stopCode === undefined) stopCode = EXIT_SIGINT;
    return stopCode;
  }
  if (outcome.kind === 'cancelled') return EXIT_OK;

  const { targetId, mode } = outcome.selection;
  if (targetId === 'all') return runAll(false, run, mode, detected);
  return runSingle(targetId, run, mode);
}

async function dispatch(command: ParsedCommand): Promise<number> {
  switch (command.kind) {
    case 'help':
      out(helpText());
      return EXIT_OK;
    case 'version':
      out(`speedtest-ai v${VERSION}\n`);
      return EXIT_OK;
    case 'detect': {
      const targets = await detectTargets();
      if (command.json) {
        out(JSON.stringify(targets, null, 2) + '\n');
      } else {
        out(renderDetectTable(targets) + '\n');
        const hint = 'Benchmark them all: speedtest-ai all   ·   one: speedtest-ai run -t <id>';
        out('\n' + wrapText(hint, maxLineWidth()).map((l) => c.dim(l)).join('\n') + '\n');
      }
      return EXIT_OK;
    }
    case 'history': {
      if (command.clear) {
        await clearHistory();
        out(command.json ? JSON.stringify({ cleared: true }) + '\n' : 'Speedtest history cleared.\n');
        return EXIT_OK;
      }
      const history = await readHistory();
      if (command.json) {
        out(JSON.stringify(history.entries.slice(-command.limit), null, 2) + '\n');
      } else {
        out(renderHistoryTable(history.entries, command.limit, { legacyCount: history.legacyCount }) + '\n');
      }
      return EXIT_OK;
    }
    case 'run':
      return runSingle(command.targetSpec, command.run, command.run.mode ?? 'standard');
    case 'compare':
      return runCompare(command.specs, command.run, command.run.mode ?? 'standard');
    case 'all':
      return runAll(command.includeApis, command.run, command.run.mode ?? 'quick');
    case 'default':
      return runDefault(command.run);
  }
}

export async function main(rawArgv = process.argv.slice(2)): Promise<number> {
  installProcessHandlers();
  try {
    return await dispatch(parseCliArgs(rawArgv));
  } catch (error) {
    if (error instanceof UsageError) {
      printError(error.message);
      err('Run "speedtest-ai --help" for usage.\n');
      return EXIT_USAGE;
    }
    if (stopCode !== undefined) return stopCode;
    printError(describeRunError(error).message);
    return EXIT_FAILED;
  }
}

main().then((code) => {
  restoreTerminal();
  const finalCode = stopCode ?? code;
  process.exitCode = finalCode;
  // Anything still holding the event loop open (an idle keep-alive socket, a stuck child) must
  // not keep the command from returning.
  setTimeout(() => process.exit(finalCode), isOutputClosed() ? 0 : 1500).unref();
});
