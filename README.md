# KM AI Speed Test (`speedtest-ai`)

By [Krutrim Mulyankan](https://krutrimmulyankan.in/speedtest). A speed test for AI agent CLIs, in the spirit of a WiFi speed test. `speedtest-ai all` finds the
agent CLIs installed on your machine (`claude`, `codex`, `agy`, `grok`, `muse`, ...), sends each one
the same prompt, and reports a time to first token and a tokens-per-second figure that can be
compared between them.

Version 0.6.0. Linux, macOS and Windows. Node.js 20 or newer, no runtime dependencies.

> `all`, `run` and `compare` call the real CLIs with your accounts. They send real prompts and
> **spend real model tokens**. `demo` and `detect` do not call any model.

## Install

```sh
curl -fsSL https://krutrimmulyankan.in/speedtest/install.sh | sh
```

The installer downloads one self-contained file, checks its SHA-256, and puts it at
`~/.local/bin/speedtest-ai` with an `aispeed` alias next to it. It warns if that directory or
`node` is not on your `PATH`.

When run in an interactive terminal it then offers a first speed test: it lists the CLIs it found,
says that real model tokens will be used, and waits five seconds so you can press Ctrl-C to skip.
Without a terminal it only prints the command. To never start a test:

```sh
curl -fsSL https://krutrimmulyankan.in/speedtest/install.sh | SPEEDTEST_NO_AUTO_RUN=1 sh
```

`INSTALL_DIR=/some/dir` installs somewhere else.

### Windows

In PowerShell:

```powershell
irm https://krutrimmulyankan.in/speedtest/install.ps1 | iex
```

It installs to `%LOCALAPPDATA%\Programs\speedtest-ai`, adds that folder to your user `PATH`, and
does not start a test. Agent CLIs installed with npm (`.cmd` shims) and native `.exe` installs are
both found. The test suite runs on Windows in CI; real agent CLIs on Windows have not been measured
by the maintainers yet, so treat results there as new.

### Update

```sh
speedtest-ai update
```

This re-runs the hosted installer over the existing install (checksum verified, no benchmark is
started). On v0.3.0 or older, which has no `update` command, run the install command again.

### Uninstall

```sh
rm -f ~/.local/bin/speedtest-ai ~/.local/bin/aispeed ~/.local/bin/kmspeed
rm -rf ~/.local/share/speedtest-ai     # saved results
```

### From source

```sh
npm install
npm run build
node dist/cli.cjs demo
```

## Quick start

```sh
speedtest-ai all                 # benchmark every installed agent CLI (spends tokens)
speedtest-ai                     # pick a target from a menu
speedtest-ai detect              # what is installed and usable; calls no model
speedtest-ai demo                # simulated run to see the display; calls no model

speedtest-ai run -t claude                  # one target, all four phases
speedtest-ai run -t codex --quick           # one target, download only
speedtest-ai run -t claude -m sonnet        # a specific model instead of the CLI's own
speedtest-ai compare -t claude,codex,grok   # several targets and a leaderboard
speedtest-ai all --runs 3                   # median of three samples per CLI
speedtest-ai history                        # saved results
```

## What is measured

Every target is timed the same way, so the figures can be compared.

- **The clock starts when the CLI process is spawned** (for HTTP targets: when the request is
  sent). The CLI's own start-up is therefore part of TTFT, which is what you wait for in practice.
- **CLI ready**: spawn to the first event the CLI prints. Information only.
- **TTFT** (the "ping"): spawn to the first *visible* token. Thinking that is streamed before the
  answer does not count as the first token.
- **tok/s** (the "download"): the decode rate, tokens after the first one divided by the time
  between the first and the last visible token. This is the figure that is ranked and graded.
- **End-to-end tok/s**: all visible tokens divided by the time from spawn to the last token.
- **Peak**: the best full one-second window.
- **Jitter**: mean absolute deviation of the gaps between chunks. **Max stall**: the longest gap.
- The clock stops at the CLI's final event, not when its process exits.

### Normalized tokens

Vendors count tokens differently; the same text can differ by tens of percent from one tokenizer
to the next. Every rate here is therefore computed in **normalized tokens**: one local estimator
applied to the visible answer text, identical for every target. The counts a vendor reports
(output, input, cached, reasoning) are shown for information and are never mixed into a rate.

### Buffered targets

A decode rate only means something when the answer really arrives as a stream: at least 8 chunks,
spread over at least one second, with no single chunk holding more than half of the text. A target
that delivers its answer in one piece is **buffered**: it has no TTFT ("n/a (buffered)") and no
decode rate. It is graded on end-to-end tok/s, marked `(E2E)`, and always ranked after the
streaming targets.

Other caveat tags you may see next to a result:

| Tag | Meaning |
| --- | --- |
| `buffered` | no real stream, see above |
| `short` | the stream lasted under 2 s or produced under 150 tokens, so the rate is less reliable |
| `experimental` | the adapter was written from the CLI's documentation and not verified against it |
| `lean` / `as-configured` | how the CLI was started, see below |
| `N runs ±x%` | median of N samples and half the min–max spread |

Without `--runs`, each result is a **single sample**. Model speed varies from minute to minute, so
use `--runs 3` (up to 5) before drawing conclusions: the first run executes every phase, the
following runs repeat the download, and the result is the median with the min–max range.

Grades are applied to the ranked figure: HYPER ≥ 140, TURBO ≥ 80, CRUISING ≥ 40, STEADY ≥ 20,
CRAWLING below that.

### Phases

| Mode | Phases |
| --- | --- |
| `--quick` (default for `all` and the menu) | download |
| `--standard` (default for `run`, `compare`, `demo`) | ping, download, upload, tool loop |
| `--full` | the same with a longer answer and a larger prompt |

- **Ping**: a tiny prompt; gives the headline TTFT.
- **Download**: asks for 30 numbered sentences of about 20 words (60 in `--full`), long enough
  for a stream of several seconds.
- **Upload**: a large prompt with a marker the model must repeat. Reports TTFT for the large
  prompt and how much longer that is than the ping. A prefill rate is shown only when the answer
  was verified and the difference is large enough to stand out from run-to-run noise (at least 500 ms and a quarter of the ping).
- **Tool loop** (agent CLIs only): the agent must read a file and return the token in it. It counts
  only if the token is right and a tool call was observed.

A failed ping or download fails the target. A failed upload or tool loop is shown as failed and the
rest of the result stands. A phase that runs out of time (`--timeout`, default 180 s per phase) or
is interrupted is an error; it is never turned into a result and never saved.

## Lean and `--as-configured`

By default each agent CLI is started **lean**: it keeps your login and your configured model, and
runs in an empty temporary directory without your MCP servers, hooks, plugins, skills or project
context. That measures the model stream and keeps the token cost low.

`--as-configured` starts the CLI with your full setup instead. Use it to see what your own
configuration costs in start-up time and tokens; expect slower and more variable numbers.

How each verified CLI is slimmed down in lean mode:

| CLI | Lean mode |
| --- | --- |
| `claude` | `--safe-mode`: login and model kept; MCP servers, hooks and plugins off |
| `codex` | plugins, apps, hooks, memories and your MCP servers disabled |
| `agy` | empty temporary directory; permissions are skipped only for the tool-loop phase |
| `grok` | tool list reduced to what the phase needs |
| `muse` | empty preset, reminders disabled |

Experimental CLIs have no lean mode: they run in an empty temporary directory but with their own
configuration, and their results are tagged `as-configured`.

The model is the one each CLI is configured to use unless you pass `-m` (or `target:model`). The
model name in the result is the one the CLI reports.

## Supported targets

`speedtest-ai detect` shows what is found on your machine and `speedtest-ai --help` prints the
full, current list.

- **Verified** (tested against the real CLI): `claude`, `codex`, `agy`, `grok`, `muse`.
  `codex` is driven through `codex app-server`, which streams; if that cannot start, the run falls
  back to `codex exec`, which is buffered, and says so.
- **Experimental** (built from each tool's documented headless mode, not tested): `gemini`, `qwen`,
  `opencode`, `kilo`, `cursor-agent`, `amp`, `copilot`, `crush`, `pi`, `omp`, `kiro-cli`, `goose`,
  `droid`. At detection time the installed binary's own help is checked for the flags the adapter
  needs. If they are missing the CLI is listed as installed but unsupported and is not run.
  Results carry an `experimental` tag.
- **Detect only** (no confirmed headless invocation yet): `aider`, `kimi`, `devin`, `commandcode`,
  `freebuff`, `mcode`, `dsh`, `auggie`, `cline`.
- **Local runtimes**: `ollama:<model>`, `lmstudio:<model>`, when they are running.
- **Cloud APIs**: `openai:<model>`, `anthropic:<model>`, `gemini-api:<model>`,
  `openrouter:<model>`, with the usual API key variable set, or any OpenAI-compatible endpoint with
  `--base-url`.
- **Your own command**: `-t cmd --cmd "my-agent {prompt}"`. The prompt replaces `{prompt}` and is
  also exported as `$SPEEDTEST_PROMPT`; standard output is the answer and exit code 0 is success.
- **Simulator**: `demo:flash`, `demo:frontier`, `demo:reasoning`, `demo:local`, `demo:buffered`.

What `all` runs: every verified or experimental agent CLI that is installed, usable and not known
to be logged out, plus Ollama and LM Studio if they are running. Cloud API targets are included
only with `--include-apis`. If nothing is found, `all` says so and exits with code 2; it never
substitutes the simulator.

Detection never runs a `mise` shim and never triggers an install: it looks for the real binary
behind the shim.

## Command reference

```text
speedtest-ai all [flags]            Benchmark every installed agent CLI
speedtest-ai                        Pick a target interactively
speedtest-ai run -t <target>        Benchmark one target (or target:model)
speedtest-ai compare -t <t1,t2,..>  Benchmark several, with a leaderboard
speedtest-ai demo                   Simulated run, no model is called
speedtest-ai detect [--json]        List what is installed and usable
speedtest-ai history                Show saved results (--limit N, --clear)
```

| Flag | Meaning |
| --- | --- |
| `-t, --target <spec>` | target or `target:model` |
| `-m, --model <model>` | model for a single target; default is the CLI's own |
| `-a, --all` | same as the `all` command |
| `--quick`, `--standard`, `--full` | mode (give at most one) |
| `--runs <n>` | repeat the download n times, 1 to 5, and report the median |
| `--as-configured` | keep your MCP servers, hooks, plugins and project context |
| `--include-apis` | `all` also tests cloud APIs that have a key set |
| `--profile <name>` | demo profile |
| `--cmd <template>` | shell command for `-t cmd` |
| `--base-url <url>`, `--api-key <key>` | provider endpoint and key |
| `--timeout <sec>` | per-phase time limit, default 180 |
| `--card [path]` | save an SVG card; the path must end in `.svg` or contain a `/` (default `./speedtest-ai-card.svg`; `all` and `compare` write one file per target) |
| `--json` | print only the final JSON |
| `--jsonl` | stream progress events as JSON lines |
| `--plain` | line output instead of the live gauge |
| `--no-history` | do not save this run |
| `--limit <n>`, `--clear` | `history`: entries to show, or delete them |

Unknown flags, missing values, more than one mode flag and out-of-range numbers are errors.

### Stopping a run

Ctrl-C stops the current target and the whole `all` / `compare` run, kills the CLI that was
running, prints the leaderboard of the targets that had finished, and exits with code 130. A
second Ctrl-C exits at once. `SIGTERM` does the same with code 143. Closing the pipe the output
goes to (`| head -1`) stops the run quietly.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | at least one target completed |
| 1 | every target failed |
| 2 | bad arguments, or `all` found nothing to benchmark |
| 130 | interrupted with Ctrl-C |
| 143 | terminated |

The codes are the same with `--json` and `--jsonl`.

### Terminal

The live view is a speedometer: one dial with the current tokens per second in large digits, and
ping, peak and token count underneath. It needs at least 40 columns and 20 rows; on a smaller terminal, with `--plain`, or when the output is not a terminal, progress is
printed line by line. All output fits 80 columns. Each agent CLI is drawn in its own accent colour (Claude Code orange, Codex green, Antigravity
blue and so on). `NO_COLOR` turns colour off.

## JSON output

`--json` prints exactly one JSON document on standard output and nothing else:

- `run` / `demo`: a `SpeedtestResult` (`schemaVersion: 2`), or `{"error": {...}}` if the target
  failed.
- `all` / `compare`: `{schemaVersion, mode, interrupted, results, failed, notRun}`, with `results`
  in leaderboard order and `failed` holding `{targetId, targetName, error, kind, failureKind}`.

The fields to read from a result are in `summary`: `rankTps` and `rankMetric` (`"decode"` or
`"e2e"`), `grade`, `ttftMs` (null when buffered), `downloadDecodeTps` (null when buffered),
`downloadE2eTps`, `downloadPeakTps`, `isBuffered`, `shortOutput`, `downloadOutputTokens`
(normalized) and the vendor-reported `reported*` counts. `tier`, `isolation`, `runs`, `aggregate`
(for `--runs`), `skipped` (failed upload / tool-loop phases) and `notes` sit next to `summary`.

`--jsonl` prints one event per line while the run is in progress: `run:start`, `repeat:start`,
`repeat:complete`, `phase:start`, `gauge:tick`, `phase:complete`, `phase:skip`, `run:complete`,
and `run:error` for every target that fails, times out or is interrupted. `all` and `compare`
finish with one `batch:complete` line that has the ranking, the failed targets and the targets
that were not run.

## History

Completed runs are appended to `~/.local/share/speedtest-ai/history.json` (the last 200; set
`SPEEDTEST_AI_HOME` to move it). A result card shows how the run compares with earlier runs of the
same target, model, mode and isolation. Runs saved by older versions stay in the file but are not
compared. If the file cannot be parsed it is renamed to `history.json.corrupt` and a new one is
started. `--no-history` skips saving.

## Library

The engine does no terminal rendering and can be imported:

```ts
import { detectTargets, resolveAdapter, runSpeedtestRepeated, selectAllTargets } from 'speedtest-ai';

const detected = await detectTargets();
for (const target of selectAllTargets(detected)) {
  const { adapter, model } = await resolveAdapter({ targetSpec: target.id, detectedTargets: detected });
  for await (const event of runSpeedtestRepeated({ adapter, model, mode: 'quick', runs: 1 })) {
    if (event.type === 'run:complete') console.log(target.id, event.result.summary.rankTps);
  }
}
```

A failed run yields `run:error` and then throws `TargetFailedError`, `PhaseTimeoutError` or
`InterruptedError`. Pass an `AbortSignal` as `signal` to stop a run, and call `killAllChildren()`
from your own signal handlers.

## Development

```sh
npm run typecheck
npm test
npm run build            # dist/cli.cjs (the command) and dist/index.js (the library)
npm run release:bundle   # release/ with the bundle, checksums and install.sh
```

The tests call no model: they use the simulator, shell commands, fake CLIs and recorded, sanitized
event streams. `SPEEDTEST_AI_DEMO_TIME_SCALE` (for example `0.2`) shortens the simulator's delays.
