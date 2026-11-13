# speedtest-ai

A live speedometer CLI and streaming benchmark engine for measuring the real-time speed of **AI agent harnesses** (`claude`, `codex`, `agy`, `grok`, `muse`, or any custom CLI agent) and **AI models** (`ollama`, `lmstudio`, `openai`, `anthropic`, `gemini`, `openrouter`), modeled on `speedtest.net` / `fast.com`.

## Quick Start

### One-line install (Omarchy Linux, Linux & macOS)

```sh
curl -fsSL https://krutrimmulyankan.in/speedtest/install.sh | sh
```

This installs the standalone zero-dependency bundle to `~/.local/bin/speedtest-ai` (and aliases `aispeed`), verified with SHA-256.

### Run immediately

```bash
# Instant zero-cost simulated speedometer
speedtest-ai demo
speedtest-ai demo --quick --profile flash

# Auto-detect installed AI harnesses, local servers & configured API keys
speedtest-ai detect

# Interactive picker (in a TTY)
speedtest-ai

# Benchmark your AI harnesses or models
speedtest-ai run -t claude
speedtest-ai run -t codex --quick
speedtest-ai run -t ollama:llama3.2
speedtest-ai run -t openai:gpt-4.1-mini
speedtest-ai compare -t claude,codex,demo:flash --quick
```

### Build from source

```bash
npm install
npm run build
npm link
```

## Omarchy Linux, Arch, Linux & macOS Compatibility

- **Works natively on Omarchy Linux**: Built and verified on Omarchy Linux. Installs directly into `~/.local/bin`, which is already on Omarchy's default `$PATH`.
- **Zero runtime dependencies**: Requires only Node.js `>= 20` (uses built-in `fetch`, `node:util`, `node:child_process`, `node:perf_hooks`, and `node:crypto`).
- **`mise` shim safe**: Automatically resolves real binaries and passes `MISE_AUTO_INSTALL=false` so uninstalled `mise` shims never hang or trigger background downloads.
- **Smooth terminal rendering**: Uses DEC Mode 2026 synchronized output for flicker-free speedometer gauges in Ghostty, Alacritty, Kitty, Foot, WezTerm, and macOS Terminal/iTerm2.

## How WiFi Speedtest Metrics Map to AI Agents

| WiFi Metric | AI Agent / Model Metric | How It Is Measured |
| --- | --- | --- |
| **Ping** | **TTFT (Time To First Token)** | Time from request/spawn start until the first response token arrives (plus harness boot overhead when emitted). |
| **Jitter** | **Inter-Token Latency Jitter** | Mean absolute deviation between consecutive per-token arrival intervals (RFC 3550 style). |
| **Download** | **Sustained Decode TPS (`tok/s`)** | Output tokens generated after the first token divided by `(t_last - t_first)`, alongside end-to-end throughput and peak rolling TPS. |
| **Upload** | **Context Prefill TPS (`tok/s`)** | Cache-busted synthetic telemetry log (`~2.6k–4.5k` input tokens with random nonces + embedded verification needle) prefilled before first output token. |
| **Agent Loop** | **Tool-Call Roundtrip (`ms`)** | Isolated sandbox probe verifying the agent harness can read a file (`probe.txt`) via its tool loop and return its exact token. |

## CLI Reference

```text
speedtest-ai                                  Interactive target picker (TTY)
speedtest-ai run -t <target[:model]> [flags]  Run speedtest on a harness or model
speedtest-ai demo [flags]                     Zero-setup simulated speedometer
speedtest-ai compare -t <t1,t2,...> [flags]   Compare multiple targets side-by-side
speedtest-ai detect [--json]                  Detect installed AI CLIs, local & cloud targets
speedtest-ai history [--limit N] [--clear]    View or clear saved speedtest history
```

Common flags:
- `--quick`: Single-stage Fast.com-style run (Download TPS + TTFT + Jitter in ~5-8s).
- `--full`: Extended 4-stage run with larger token payloads.
- `--cmd "<command>"`: Benchmark any custom CLI agent (`{prompt}` placeholder or `$SPEEDTEST_PROMPT` env).
- `--card [path]`: Export a shareable dark-mode SVG speedtest card (default `./speedtest-ai-card.svg`).
- `--json`: Print final `SpeedtestResult` JSON only.
- `--jsonl`: Stream live `SpeedtestEvent` NDJSON lines.
- `--plain`: Disable live TUI gauge animation.

## Desktop / GUI Integration (`--jsonl` & Library API)

The benchmark engine is strictly decoupled from terminal rendering. Any desktop app (Qt/QML, Tauri, Electron) can spawn:

```bash
speedtest-ai run -t claude --jsonl
```

and parse newline-delimited JSON events (`run:start`, `phase:start`, `gauge:tick`, `phase:complete`, `phase:skip`, `run:complete`, `run:error`) to drive a live graphical speedometer needle, or import `runSpeedtest`, `detectTargets`, `resolveAdapter`, and `renderSvgCard` directly from `speedtest-ai`.
