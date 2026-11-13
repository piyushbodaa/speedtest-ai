import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseTargetSpec, resolveAdapter } from './adapters/registry.js';
import { renderSvgCard } from './core/card.js';
import { detectTargets } from './core/detect.js';
import { clearHistory, loadHistory } from './core/history.js';
import { runSpeedtest } from './core/runner.js';
import {
  consumeSpeedtestEvents,
  renderCompareTable,
  renderDetectTable,
  renderHistoryTable,
} from './tui/dashboard.js';
import { c } from './tui/ansi.js';
import { promptInteractiveTarget } from './tui/prompt.js';
import type { BenchmarkMode, SpeedtestResult } from './types.js';

const VERSION = '0.2.0';

function printHelp(): void {
  const help = `
speedtest-ai v${VERSION} — Live TPS & latency speedtest for AI models and agent harnesses

USAGE:
  speedtest-ai all [flags]                      Benchmark ALL installed CLIs & compare
  speedtest-ai                                  Interactive target picker (TTY)
  speedtest-ai run -t <target[:model]> [flags]  Run speedtest on a harness or model
  speedtest-ai demo [flags]                     Zero-setup simulated speedometer
  speedtest-ai compare -t <t1,t2,...> [flags]   Compare multiple targets side-by-side
  speedtest-ai detect [--json]                  Detect installed AI CLIs, local & cloud targets
  speedtest-ai history [--limit N] [--clear]    View or clear saved speedtest history

TARGETS (-t, --target):
  Harnesses:   claude, codex, agy, grok, muse, cmd (with --cmd "...")
  Local:       ollama:<model>, lmstudio:<model>
  Cloud APIs:  openai:<model>, anthropic:<model>, gemini:<model>, openrouter:<model>
  Simulated:   demo:frontier | demo:flash | demo:reasoning | demo:local

FLAGS:
  -a, --all               Benchmark all detected installed CLIs (shortcut for "all")
  -t, --target <spec>     Target or target:model (e.g. claude:sonnet, ollama:llama3.2)
  -m, --model <model>     Override model name
      --profile <name>    Demo profile (frontier | flash | reasoning | local)
      --quick             Single-stage fast test (Download TPS + TTFT, ~5-8s)
      --standard          All 4 stages (Ping + Download + Upload + Agent Loop)
      --full              Extended 4-stage benchmark with larger payloads
      --cmd <template>    Shell command for -t cmd (supports {prompt} or $SPEEDTEST_PROMPT)
      --base-url <url>    Custom OpenAI-compatible or provider base URL
      --api-key <key>     Override provider API key
      --card [path]       Save a shareable SVG speedtest card (default: ./speedtest-ai-card.svg)
      --json              Output final SpeedtestResult JSON only
      --jsonl             Stream live SpeedtestEvent NDJSON lines (Desktop/GUI bridge)
      --plain             Disable live TUI gauge animation
      --no-history        Do not save this run to local history
      --timeout <sec>     Per-phase timeout in seconds (default: 90; 45 for "all")
      --limit <n>         Number of history entries to display (default: 15)
      --clear             Clear saved history
  -h, --help              Show help
  -v, --version           Show version
`;
  process.stdout.write(help.trimStart());
}

function normalizeOptionalCardFlag(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--card') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        out.push('--card=speedtest-ai-card.svg');
      } else {
        out.push(arg);
      }
    } else {
      out.push(arg);
    }
  }
  return out;
}

async function runSingleTarget(opts: {
  targetSpec: string;
  model?: string;
  mode: BenchmarkMode;
  cmd?: string;
  baseUrl?: string;
  apiKey?: string;
  cardPath?: string;
  outputMode: 'tui' | 'plain' | 'json' | 'jsonl' | 'silent';
  noHistory: boolean;
  timeoutMs: number;
}): Promise<SpeedtestResult> {
  const parsedSpec = parseTargetSpec(opts.targetSpec);
  const needsDiscovery =
    (parsedSpec.id === 'ollama' || parsedSpec.id === 'lmstudio') &&
    !opts.model &&
    !parsedSpec.model;
  const detected = needsDiscovery ? await detectTargets() : undefined;
  const { adapter, model } = await resolveAdapter({
    targetSpec: opts.targetSpec,
    model: opts.model,
    cmd: opts.cmd,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    detectedTargets: detected,
  });

  const controller = new AbortController();
  const onSigInt = () => controller.abort(new Error('Interrupted by user'));
  process.on('SIGINT', onSigInt);

  try {
    const events = runSpeedtest({
      adapter,
      model,
      mode: opts.mode,
      timeoutMs: opts.timeoutMs,
      noHistory: opts.noHistory,
      signal: controller.signal,
    });

    const result = await consumeSpeedtestEvents(events, {
      mode: opts.outputMode,
      noHistory: opts.noHistory,
    });

    if (opts.cardPath) {
      const absPath = path.resolve(opts.cardPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, renderSvgCard(result), 'utf8');
      if (opts.outputMode !== 'json' && opts.outputMode !== 'jsonl') {
        process.stdout.write(`Saved SVG card: ${absPath}\n`);
      }
    }

    return result;
  } finally {
    process.off('SIGINT', onSigInt);
  }
}

async function runAllInstalledTargets(opts: {
  mode: BenchmarkMode;
  modelOverride?: string;
  cmd?: string;
  baseUrl?: string;
  apiKey?: string;
  outputMode: 'tui' | 'plain' | 'json' | 'jsonl';
  noHistory: boolean;
  timeoutMs: number;
}): Promise<void> {
  const targets = await detectTargets();
  if (opts.outputMode !== 'json' && opts.outputMode !== 'jsonl') {
    process.stdout.write(renderDetectTable(targets) + '\n');
  }

  let ready = targets.filter((t) => t.available && t.category !== 'demo');
  if (ready.length === 0) {
    const demo = targets.find((t) => t.id === 'demo');
    ready = demo ? [demo] : [];
  }

  const results: SpeedtestResult[] = [];
  const failures: Array<{ targetId: string; targetName: string; error: string }> = [];

  for (let i = 0; i < ready.length; i++) {
    const t = ready[i];
    if (opts.outputMode !== 'json' && opts.outputMode !== 'jsonl') {
      process.stdout.write(
        `\n${c.bold(c.brightCyan(`▶ [${i + 1}/${ready.length}]`))} ${c.bold(`Benchmarking ${t.name}`)} ${c.dim(`(${t.id}${t.defaultModel && t.defaultModel !== 'default' ? `:${t.defaultModel}` : ''}) [${opts.mode}]`)}\n`
      );
    }

    try {
      const res = await runSingleTarget({
        targetSpec: t.id,
        model: opts.modelOverride || t.defaultModel,
        mode: opts.mode,
        cmd: opts.cmd,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        outputMode: opts.outputMode === 'json' ? 'silent' : opts.outputMode,
        noHistory: opts.noHistory,
        timeoutMs: opts.timeoutMs,
      });
      results.push(res);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (rawMsg.toLowerCase().includes('interrupted by user')) {
        throw err;
      }
      const cleanMsg = rawMsg.split(/\r?\n/)[0].trim();
      failures.push({ targetId: t.id, targetName: t.name, error: cleanMsg });
      if (opts.outputMode !== 'json' && opts.outputMode !== 'jsonl') {
        process.stdout.write(`  ${c.yellow('⚠')} Skipped ${t.name}: ${c.gray(cleanMsg)}\n`);
      }
    }
  }

  const sorted = [...results].sort(
    (a, b) => b.summary.downloadDecodeTps - a.summary.downloadDecodeTps
  );

  if (opts.outputMode === 'json') {
    process.stdout.write(JSON.stringify({ results: sorted, skipped: failures }, null, 2) + '\n');
  } else if (opts.outputMode !== 'jsonl') {
    if (sorted.length > 0) {
      process.stdout.write('\n' + renderCompareTable(sorted, failures) + '\n');
    } else {
      process.stdout.write(c.bold(c.yellow('\nNo installed CLIs completed a benchmark:\n')));
      for (const f of failures) {
        process.stdout.write(`  ⚠  ${f.targetId} (${f.targetName}): ${f.error}\n`);
      }
      process.exitCode = 1;
    }
  }
}

export async function main(rawArgv = process.argv.slice(2)): Promise<void> {
  const normalizedArgv = normalizeOptionalCardFlag(rawArgv);

  const parsed = parseArgs({
    args: normalizedArgv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', short: 'a', default: false },
      target: { type: 'string', short: 't' },
      model: { type: 'string', short: 'm' },
      profile: { type: 'string' },
      quick: { type: 'boolean', default: false },
      standard: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      cmd: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      card: { type: 'string' },
      json: { type: 'boolean', default: false },
      jsonl: { type: 'boolean', default: false },
      plain: { type: 'boolean', default: false },
      'no-history': { type: 'boolean', default: false },
      timeout: { type: 'string' },
      limit: { type: 'string' },
      clear: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  const { values, positionals } = parsed;

  if (values.help) {
    printHelp();
    return;
  }
  if (values.version) {
    process.stdout.write(`speedtest-ai v${VERSION}\n`);
    return;
  }

  const subcommand = positionals[0];
  const outputMode: 'tui' | 'plain' | 'json' | 'jsonl' = values.jsonl
    ? 'jsonl'
    : values.json
      ? 'json'
      : values.plain
        ? 'plain'
        : 'tui';

  const mode: BenchmarkMode = values.quick ? 'quick' : values.full ? 'full' : 'standard';
  const timeoutSec = values.timeout ? Number(values.timeout) : undefined;
  const timeoutMs =
    timeoutSec && Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 90_000;

  if (subcommand === 'all' || values.all) {
    const allMode: BenchmarkMode = values.full ? 'full' : values.standard ? 'standard' : 'quick';
    const allTimeoutMs =
      timeoutSec && Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 45_000;
    await runAllInstalledTargets({
      mode: allMode,
      modelOverride: values.model,
      cmd: values.cmd,
      baseUrl: values['base-url'],
      apiKey: values['api-key'],
      outputMode,
      noHistory: Boolean(values['no-history']),
      timeoutMs: allTimeoutMs,
    });
    return;
  }

  if (subcommand === 'detect') {
    const targets = await detectTargets();
    if (values.json) {
      process.stdout.write(JSON.stringify(targets, null, 2) + '\n');
    } else {
      process.stdout.write(renderDetectTable(targets) + '\n');
    }
    return;
  }

  if (subcommand === 'history') {
    if (values.clear) {
      await clearHistory();
      if (values.json) {
        process.stdout.write(JSON.stringify({ cleared: true }) + '\n');
      } else {
        process.stdout.write('Speedtest history cleared.\n');
      }
      return;
    }
    const history = await loadHistory();
    const limit = values.limit ? Math.max(1, Number(values.limit) || 15) : 15;
    if (values.json) {
      process.stdout.write(JSON.stringify(history.slice(-limit), null, 2) + '\n');
    } else {
      process.stdout.write(renderHistoryTable(history, limit) + '\n');
    }
    return;
  }

  if (subcommand === 'demo') {
    const profile = values.profile || values.model || 'frontier';
    await runSingleTarget({
      targetSpec: `demo:${profile}`,
      model: profile,
      mode,
      cardPath: values.card,
      outputMode,
      noHistory: Boolean(values['no-history']),
      timeoutMs,
    });
    return;
  }

  if (subcommand === 'compare') {
    if (!values.target) {
      throw new Error('compare requires -t <t1,t2,...> (e.g. -t demo:flash,demo:local)');
    }
    const specs = values.target
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (specs.length === 0) {
      throw new Error('No valid targets provided to compare.');
    }

    const results: SpeedtestResult[] = [];
    for (const spec of specs) {
      const res = await runSingleTarget({
        targetSpec: spec,
        mode,
        cmd: values.cmd,
        baseUrl: values['base-url'],
        apiKey: values['api-key'],
        outputMode: values.json ? 'silent' : outputMode === 'jsonl' ? 'jsonl' : outputMode,
        noHistory: Boolean(values['no-history']),
        timeoutMs,
      });
      results.push(res);
    }

    if (values.json) {
      const sorted = [...results].sort(
        (a, b) => b.summary.downloadDecodeTps - a.summary.downloadDecodeTps
      );
      process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
    } else if (!values.jsonl) {
      process.stdout.write('\n' + renderCompareTable(results) + '\n');
    }
    return;
  }

  if (subcommand === 'run' || values.target || values.cmd || values['base-url']) {
    const targetSpec = values.target || (values.cmd ? 'cmd' : values['base-url'] ? 'custom' : '');
    if (!targetSpec) {
      throw new Error('Specify a target with -t <target[:model]> (or run "speedtest-ai detect").');
    }
    if (targetSpec.toLowerCase() === 'all') {
      const allMode: BenchmarkMode = values.full ? 'full' : values.standard ? 'standard' : 'quick';
      const allTimeoutMs =
        timeoutSec && Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 45_000;
      await runAllInstalledTargets({
        mode: allMode,
        modelOverride: values.model,
        cmd: values.cmd,
        baseUrl: values['base-url'],
        apiKey: values['api-key'],
        outputMode,
        noHistory: Boolean(values['no-history']),
        timeoutMs: allTimeoutMs,
      });
      return;
    }
    await runSingleTarget({
      targetSpec,
      model: values.model,
      mode,
      cmd: values.cmd,
      baseUrl: values['base-url'],
      apiKey: values['api-key'],
      cardPath: values.card,
      outputMode,
      noHistory: Boolean(values['no-history']),
      timeoutMs,
    });
    return;
  }

  if (subcommand) {
    throw new Error(`Unknown command "${subcommand}". Run "speedtest-ai --help" for usage.`);
  }

  // No subcommand and no target flags: interactive picker if TTY, else print help + detected targets
  if (process.stdout.isTTY && process.stdin.isTTY && !values.json && !values.jsonl && !values.plain) {
    const targets = await detectTargets();
    const selection = await promptInteractiveTarget(targets);
    if (!selection) {
      return;
    }
    if (selection.targetId === 'all') {
      await runAllInstalledTargets({
        mode: selection.mode,
        outputMode: 'tui',
        noHistory: Boolean(values['no-history']),
        timeoutMs: timeoutSec && Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 45_000,
      });
      return;
    }
    await runSingleTarget({
      targetSpec: selection.targetId,
      model: selection.model,
      mode: selection.mode,
      cardPath: values.card,
      outputMode: 'tui',
      noHistory: Boolean(values['no-history']),
      timeoutMs,
    });
    return;
  }

  printHelp();
  process.stdout.write('\n');
  const targets = await detectTargets();
  process.stdout.write(renderDetectTable(targets) + '\n');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`speedtest-ai error: ${message}\n`);
  process.exitCode = 1;
});
