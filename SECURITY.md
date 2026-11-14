# Security

This page says exactly what KM AI Speed Test (`speedtest-ai`) does on your machine, what leaves it,
and how to check that for yourself before running anything.

## What it does

It starts the AI agent CLIs you already have (`claude`, `codex`, `agy`, `grok`, `muse`, ...) with a
fixed prompt, times their output, and prints the numbers. That is all.

- **Where it runs them:** in a new, empty temporary folder, never in your project.
- **What it asks:** a fixed text prompt about computer networking. The prompts are in
  `src/core/payloads.ts`. Nothing from your files, shell history or environment is put in a prompt.
- **What tools the agents get:** in the quick test (the default for `all`), none or read-only. The
  standard test adds a "tool loop" phase where the agent reads one file the tool wrote into the
  temporary folder.
- **Permission prompts:** Antigravity and Grok can only run that tool-loop phase unattended with a
  flag that turns their permission prompts off. The tool **does not pass that flag** unless you add
  `--allow-permission-bypass`; without it the phase is skipped for those two CLIs. Claude Code is
  limited to its Read tool and Codex runs in its read-only sandbox, so they need no bypass.

## What leaves your machine

| Traffic | When | To whom |
|---|---|---|
| The fixed test prompt and the model's answer | every real test | the vendor of each agent CLI, sent by that CLI itself, exactly as when you use it normally |
| A request to `127.0.0.1` (Ollama on 11434, LM Studio on 1234) | `detect`, `all`, `menu` | your own machine |
| An API request | only when you pick an API target (`-t openai:...`) or pass `--include-apis` | that API provider |
| A download of the installer and bundle | `update`, and the install command | `krutrimmulyankan.in` |

There is no telemetry, analytics, crash reporting or account. The tool never contacts Krutrim
Mulyankan while testing. A test in the suite (`tests/security.test.ts`) fails the build if any
other source file starts making network requests.

**API keys.** A key from your environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...) is sent only
to the provider it belongs to. If you point a target at another server with `--base-url`, no
environment key is sent there; you have to pass `--api-key` on purpose. A key given with `--api-key`
is visible to other processes on the machine while the test runs, so prefer the environment.

## What stays on your machine

- Results: `~/.local/share/speedtest-ai/history.json`, readable by you only. It holds the timings,
  token counts and model names, not the text the model wrote.
- Result cards: `~/.local/share/speedtest-ai/cards/`, an image of the leaderboard written after each
  run. It contains agent names, model names and figures only. Nothing is uploaded; `speedtest share`
  copies the image to your clipboard and you decide where it goes. `--no-card` turns it off.
- The menu-bar plugin (macOS), tray script (Windows) and Omarchy plugin only read that file through
  `speedtest menu` and start tests. They make no network requests of their own.

Remove everything with the uninstall steps in the README.

## What it is built from

- No runtime dependencies. The published program is one file bundled from this repository.
- The bundle is not minified. You can read it.
- Build tools (TypeScript, tsup, vitest) are development-only and pinned by `package-lock.json`.
- GitHub Actions used in CI and releases are pinned to commit hashes.

## Check it before you run it

You do not have to pipe a script into your shell. Any of these work.

**Read first, then run.**

```sh
curl -fsSLO https://krutrimmulyankan.in/speedtest/install.sh
less install.sh
sh install.sh --no-run      # installs, does not start a test
```

**Check the download against the build on GitHub.** Every release is built by GitHub Actions from a
tagged commit, and GitHub records a signed statement of that. With the [GitHub CLI](https://cli.github.com):

```sh
curl -fsSLO https://krutrimmulyankan.in/speedtest/speedtest-ai.cjs
gh attestation verify speedtest-ai.cjs --repo piyushbodaa/speedtest-ai
```

A pass means this exact file was produced by this repository's release workflow, not edited
afterwards. The same files and a `checksums.txt` are attached to each
[GitHub release](https://github.com/piyushbodaa/speedtest-ai/releases).

**Build it yourself.**

```sh
git clone https://github.com/piyushbodaa/speedtest-ai && cd speedtest-ai
npm ci && npm test && npm run build
node dist/cli.cjs demo      # simulated run, calls no model
```

**See what it would run.** `speedtest detect --json` lists, for each CLI, the exact invocation and
what the lean mode switches off. `speedtest demo` exercises the whole program without starting
any agent.

## Limits you should know about

- The agent CLIs are other companies' programs. This tool cannot control what they send to their
  own vendors, and it runs them with your login.
- A real test spends tokens from your accounts.
- The installer starts a quick test after a 5-second countdown when run in a terminal. Use
  `--no-run` (or `SPEEDTEST_NO_AUTO_RUN=1`) to install only.
- The installer checks the bundle against a checksum it carries. That protects against a corrupted
  download, not against a compromised website; the attestation check above is the independent one.
- This has not had a third-party security audit.

## Reporting a problem

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/piyushbodaa/speedtest-ai/security/advisories/new)
rather than a public issue.
