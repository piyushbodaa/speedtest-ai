import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  explainAllSkips,
  knownTargetIds,
  selectAllTargets,
  targetsHelpLines,
} from './adapters/catalog.js';
import { createDemoAdapter } from './adapters/providers/demo.js';
import { parseTargetSpec, resolveAdapter } from './adapters/registry.js';
import { spawnSync } from 'node:child_process';
import { killAllChildren } from './adapters/utils/spawn.js';
import { HARNESS_CATALOG } from './adapters/catalog.js';
import { copyImageToClipboard, latestShareCard, renderLeaderboardSvg, saveShareCard } from './core/share.js';
import { consumeParallel } from './tui/parallel.js';
import { brandPaint, commandName, kmAccent, PRODUCT_BYLINE, PRODUCT_NAME } from './tui/brand.js';
import {
  DEFAULT_CARD_PATH,
  parseCliArgs,
  type ParsedCommand,
  type RunOptions,
  UsageError,
} from './cli-args.js';
import { renderSvgCard } from './core/card.js';
import { detectTargets } from './core/detect.js';
import { InterruptedError, SkippedError } from './core/errors.js';
import { clearHistory, loadHistory, readHistory } from './core/history.js';
import { buildMenuModel, renderSwiftBarMenu } from './core/menu.js';
import { installMenubar, uninstallMenubar } from './core/menubar.js';
import { compareResultsByRank } from './core/metrics.js';
import { DEFAULT_PHASE_TIMEOUT_MS, MAX_RUNS, runSpeedtestRepeated } from './core/runner.js';
import { c, sanitizeInline, truncateAnsi, wrapText } from './tui/ansi.js';
import {
  consumeSpeedtestEvents,
  describeRunError,
  type OutputMode,
  renderCompactResult,
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

const VERSION = '0.10.0';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_NOTHING_DETECTED = 2;
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;
const EXIT_SIGHUP = 129;
const HARD_EXIT_AFTER_MS = 2000;

function helpText(): string {
  return `${PRODUCT_NAME} · speedtest v${VERSION}
A speed test for AI agent CLIs and models
${PRODUCT_BYLINE}

USAGE
  speedtest                         Test every installed agent CLI
  speedtest <agent> [<agent>...]    Test one agent, or compare several
  speedtest pick                    Choose a target and mode interactively
  speedtest run -t <target>         Full four-phase test of one target[:model]
  speedtest compare -t <t1,t2,..>   Benchmark several, with a leaderboard
  speedtest demo                    Simulated run, no model is called
  speedtest detect [--json]         List what is installed and usable
  speedtest history                 Show saved results (--limit N, --clear)
  speedtest share                   Copy the last result card to the clipboard
  speedtest update                  Install the latest version over this one
  speedtest menubar install         Menu-bar item (macOS) or tray (Windows)
  speedtest menu [--swiftbar]       Agents and last results, as data

  Every test sends real prompts and spend real model tokens.

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
  -p, --parallel         Test all the agents at the same time (much quicker;
                         each may read slightly lower than when tested alone)
      --as-configured    Keep your MCP servers, hooks, plugins and project
                         context. Default is lean: your login and model only
      --allow-permission-bypass
                         Let the tool-loop phase start agy and grok with their
                         permission prompts off (skipped otherwise)
      --include-apis     "all" also tests cloud APIs that have a key set
      --profile <name>   Demo profile (see Simulated above; default frontier)
      --cmd <template>   Shell command for -t cmd; the prompt replaces
                         {prompt} and is also in $SPEEDTEST_PROMPT
      --base-url <url>   OpenAI-compatible or provider base URL
      --api-key <key>    Provider API key (default: from the environment)
      --timeout <sec>    Per-phase time limit (default ${DEFAULT_PHASE_TIMEOUT_MS / 1000})
      --card [path]      Save an SVG card. The path must end in .svg or
                         contain a "/" (default ./${DEFAULT_CARD_PATH})
      --no-card          Do not save the shareable result image after a run
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
  throw new UsageError(`Unknown target "${id}". Run "${commandName()} detect" to list the targets.`);
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

/** Set when the user pressed s on the target that is running; cleared when the next one starts. */
let skipRequested = false;

async function runPrepared(
  target: PreparedTarget,
  run: RunOptions,
  mode: BenchmarkMode,
  view: { output: OutputMode; compact: boolean; skippable?: boolean }
): Promise<SpeedtestResult> {
  // One target gets its own controller, so skipping it does not stop the batch.
  skipRequested = false;
  const local = new AbortController();
  const forward = () => local.abort(controller.signal.reason);
  if (controller.signal.aborted) forward();
  else controller.signal.addEventListener('abort', forward, { once: true });
  const events = runSpeedtestRepeated({
    adapter: target.adapter,
    model: target.model,
    mode,
    timeoutMs: run.timeoutMs,
    noHistory: run.noHistory,
    signal: local.signal,
    asConfigured: run.asConfigured,
    allowPermissionBypass: run.allowPermissionBypass,
    runs: run.runs,
  });
  try {
    return await consumeSpeedtestEvents(events, {
      mode: view.output,
      noHistory: run.noHistory,
      compact: view.compact,
      onInterruptKey: onInterrupt,
      onSkipKey: view.skippable
        ? () => {
            if (skipRequested || local.signal.aborted) return;
            skipRequested = true;
            local.abort(new SkippedError());
          }
        : undefined,
    });
  } finally {
    controller.signal.removeEventListener('abort', forward);
  }
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

function homeRelative(file: string): string {
  const home = os.homedir();
  return home && file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/** Saves the shareable image of a finished run and says where it is. Never fails the run. */
function offerShareCard(results: SpeedtestResult[], run: RunOptions): void {
  if (run.noCard || results.length === 0 || !isHumanOutput(run.output)) return;
  try {
    const saved = saveShareCard(renderLeaderboardSvg(results, { version: `speedtest v${VERSION}` }));
    // The path gets a line to itself: it cannot be shortened, and nothing else should wrap with it.
    out(`\n${c.dim(`Result card saved. Copy it to your clipboard with: ${commandName()} share`)}\n`);
    out(`${homeRelative(saved.pngPath ?? saved.svgPath)}\n`);
  } catch {
    // A card is a convenience; a read-only home directory must not turn a good run into an error.
  }
}

function runShare(): number {
  const card = latestShareCard();
  if (!card) {
    printError(`there is no result card yet. Run "${commandName()}" first.`);
    return 1;
  }
  if (!card.pngPath) {
    out(`The card is an SVG here: ${card.svgPath}\n`);
    out('To get a PNG that can be copied and posted, install rsvg-convert (librsvg) or ImageMagick and run a test again.\n');
    return EXIT_OK;
  }
  const copied = copyImageToClipboard(card.pngPath);
  out(copied.ok ? `Copied the result card to the clipboard. Paste it anywhere.\n${card.pngPath}\n` : `Could not copy it (${copied.detail}). The image is here:\n${card.pngPath}\n`);
  return EXIT_OK;
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
  offerShareCard([result], run);
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

  if (run.parallel && entries.length > 1) {
    started = entries.length;
    // Resolve every target first, so a typo or a missing CLI is reported before anything starts.
    const prepared: Array<{ entry: BatchEntry; target?: PreparedTarget; error?: unknown }> = [];
    for (const entry of entries) {
      try {
        prepared.push({ entry, target: await entry.prepare() });
      } catch (error) {
        prepared.push({ entry, error });
      }
    }
    const runnable = prepared.filter((p) => p.target !== undefined);
    const outcomes = controller.signal.aborted
      ? []
      : await consumeParallel(
          runnable.map((p) => ({
            id: p.entry.id,
            // Two models of one agent share its name; then the label tells them apart.
            name: runnable.filter((q) => q.entry.name === p.entry.name).length > 1 ? p.entry.label : p.entry.name,
            events: runSpeedtestRepeated({
              adapter: p.target!.adapter,
              model: p.target!.model,
              mode,
              timeoutMs: run.timeoutMs,
              noHistory: run.noHistory,
              signal: controller.signal,
              asConfigured: run.asConfigured,
              allowPermissionBypass: run.allowPermissionBypass,
              runs: run.runs,
            }),
          })),
          {
            mode: output === 'json' ? 'silent' : output,
            onInterruptKey: onInterrupt,
            describeError: (error) => {
              const d = describeRunError(error);
              return `${d.kind === 'timeout' ? 'timed out' : d.kind === 'interrupted' ? 'stopped' : 'failed'}: ${d.message}`;
            },
          }
        );

    let next = 0;
    for (let i = 0; i < prepared.length; i++) {
      const { entry, target, error: prepareError } = prepared[i];
      const outcome = target ? outcomes[next++] : undefined;
      const error = prepareError ?? outcome?.error;
      if (human) {
        const accent = brandPaint(entry.id) ?? kmAccent;
        out(`\n${truncateAnsi(`${c.bold(accent(`▶ [${i + 1}/${entries.length}]`))} ${c.bold(accent(sanitizeInline(entry.name)))} ${c.dim(`(${entry.label}) [${mode}, parallel]`)}`, maxLineWidth())}\n`);
      }
      if (outcome?.result) {
        results.push(outcome.result);
        if (human) out(`${renderCompactResult(outcome.result)}\n`);
        if (run.cardPath) await saveCard(cardPathFor(run.cardPath, entry, usedCardPaths), outcome.result, human);
        continue;
      }
      const described = describeRunError(error ?? new InterruptedError());
      // A target stopped by Ctrl-C has no result; it is neither ranked nor "failed".
      if (described.kind === 'interrupted' || (controller.signal.aborted && !prepareError)) {
        if (human) out(`  ${c.yellow('–')} stopped\n`);
        continue;
      }
      failures.push({ targetId: entry.id, targetName: entry.name, error: described.message, kind: described.kind, failureKind: described.failureKind });
      if (output === 'jsonl' && prepareError) {
        out(JSON.stringify({ type: 'run:error', target: entry.id, error: described.message, kind: described.kind, failureKind: described.failureKind }) + '\n');
      }
      if (human) out(`  ${c.yellow('✗')} ${truncateAnsi(`${described.kind === 'timeout' ? 'timed out' : 'failed'}: ${described.message}`, Math.max(10, maxLineWidth() - 4))}\n`);
    }

    report();
    if (!controller.signal.aborted) offerShareCard(results, run);
    if (human && results.length > 1) {
      for (const text of wrapText(
        'Run in parallel: the agents shared this machine and network, so each may read a little lower than when tested alone.',
        maxLineWidth()
      )) out(`${c.dim(text)}\n`);
    }
    hardExitReport = undefined;
    if (stopCode !== undefined) return stopCode;
    return results.length > 0 ? EXIT_OK : EXIT_FAILED;
  }

  for (let i = 0; i < entries.length; i++) {
    if (controller.signal.aborted) break;
    const entry = entries[i];
    started = i + 1;
    if (human) {
      const accent = brandPaint(entry.id) ?? kmAccent;
      const head = `${c.bold(accent(`▶ [${i + 1}/${entries.length}]`))} ${c.bold(accent(sanitizeInline(entry.name)))} ${c.dim(`(${entry.label}) [${mode}${run.runs > 1 ? `, ${run.runs} runs` : ''}]`)}`;
      out(`\n${truncateAnsi(head, maxLineWidth())}\n`);
    }

    let streamedError = false;
    try {
      const target = await entry.prepare();
      if (controller.signal.aborted) throw new InterruptedError();
      streamedError = true;
      const result = await runPrepared(target, run, mode, {
        output: output === 'json' ? 'silent' : output,
        compact: true,
        skippable: entries.length > 1,
      });
      results.push(result);
      if (run.cardPath) await saveCard(cardPathFor(run.cardPath, entry, usedCardPaths), result, human);
    } catch (error) {
      const described = describeRunError(error);
      if (skipRequested && !controller.signal.aborted) {
        // The user moved on from this one; the rest of the batch still runs.
        skipRequested = false;
        failures.push({ targetId: entry.id, targetName: entry.name, error: 'skipped by you', kind: 'failed' });
        if (output === 'jsonl') out(JSON.stringify({ type: 'run:error', target: entry.id, error: 'skipped by you', kind: 'failed' }) + '\n');
        if (human) out(`  ${c.yellow('–')} skipped\n`);
        continue;
      }
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
  if (!controller.signal.aborted) offerShareCard(results, run);
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
    printError(`Run "${commandName()} detect" for details, or "${commandName()} demo" for a simulated run.`);
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

/** Re-runs the hosted installer over this install; it verifies the checksum before replacing anything. */
function runUpdate(): number {
  const base = (process.env.SPEEDTEST_AI_BASE_URL || 'https://krutrimmulyankan.in/speedtest').replace(/\/+$/, '');
  out(`Updating speedtest-ai (currently v${VERSION}) from ${base} …\n`);
  const env = { ...process.env, SPEEDTEST_NO_AUTO_RUN: '1' };
  const res =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '& ([scriptblock]::Create((irm ($env:SPEEDTEST_UPDATE_BASE + "/install.ps1"))))'],
          { stdio: 'inherit', env: { ...env, SPEEDTEST_UPDATE_BASE: base } }
        )
      : spawnSync('sh', ['-c', 's=$(curl -fsSL "$1/install.sh") || exit 1; printf "%s\\n" "$s" | sh', 'sh', base], {
          stdio: 'inherit',
          env,
        });
  if (res.status === 0) return EXIT_OK;
  printError('update failed. You can also re-run the install command from the website.');
  return 1;
}

async function dispatch(command: ParsedCommand): Promise<number> {
  switch (command.kind) {
    case 'help':
      out(helpText());
      return EXIT_OK;
    case 'version':
      out(`speedtest-ai v${VERSION}\n`);
      return EXIT_OK;
    case 'update':
      return runUpdate();
    case 'share':
      return runShare();
    case 'menubar': {
      const self = path.resolve(process.argv[1] ?? 'speedtest-ai');
      const outcome = command.action === 'install' ? installMenubar(self) : uninstallMenubar(self);
      out(outcome.lines.join('\n') + '\n');
      return outcome.ok ? EXIT_OK : 1;
    }
    case 'menu': {
      const model = buildMenuModel(await detectTargets(), await loadHistory(), {
        version: `v${VERSION}`,
        command: path.resolve(process.argv[1] ?? 'speedtest-ai'),
      });
      out(command.format === 'swiftbar' ? renderSwiftBarMenu(model) : JSON.stringify(model, null, 2) + '\n');
      return EXIT_OK;
    }
    case 'detect': {
      const targets = await detectTargets();
      if (command.json) {
        // How each agent CLI is started and what the lean mode switches off, so it can be audited.
        const audited = targets.map((target) => {
          const entry = HARNESS_CATALOG.find((h) => h.id === target.id);
          return entry ? { ...target, invocation: entry.invocation, isolation: entry.isolation } : target;
        });
        out(JSON.stringify(audited, null, 2) + '\n');
      } else {
        out(renderDetectTable(targets) + '\n');
        const hint = `Test them all: ${commandName()}   ·   one: ${commandName()} <id>`;
        out('\n' + wrapText(hint, maxLineWidth()).map((l) => c.dim(l)).join('\n') + '\n');
      }
      return EXIT_OK;
    }
    case 'history': {
      if (command.clear) {
        await clearHistory();
        out(command.json ? JSON.stringify({ cleared: true }) + '\n' : 'Speed test history cleared.\n');
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
