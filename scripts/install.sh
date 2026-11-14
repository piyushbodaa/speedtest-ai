#!/bin/sh
# speedtest-ai installer.
#
#   curl -fsSL https://krutrimmulyankan.in/speedtest/install.sh | sh
#
# Environment:
#   INSTALL_DIR               where to install (default: ~/.local/bin)
#   SPEEDTEST_NO_AUTO_RUN=1   do not start a speed test after installing (same as: sh -s -- --no-run)
#   SPEEDTEST_AI_BASE_URL     download from another location
#   SPEEDTEST_SKIP_CHECKSUM=1 install even when the download cannot be verified
#
# The whole script is wrapped in functions and only started on its last line, so a download that
# is cut off half way does nothing.
set -eu

BUNDLE_NAME="speedtest-ai.cjs"
# Filled in by scripts/release.mjs. While it is still a placeholder the checksum is read from
# checksums.txt next to the bundle instead.
PINNED_SHA256="__SPEEDTEST_AI_SHA256__"
MIN_NODE_MAJOR=20
COUNTDOWN_SECONDS=5

TMP_DIR=""
NODE_FROM_FALLBACK=0

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() {
  warn "Error: $*"
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

find_node() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi
  # Non-interactive shells often miss the directory a version manager adds in the user's profile.
  # Deliberately not the mise shims directory: running a shim can trigger an install.
  for dir in \
    "$HOME/.local/share/mise/installs/node/latest/bin" \
    "$HOME/.volta/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"; do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      export PATH
      NODE_FROM_FALLBACK=1
      return 0
    fi
  done
  return 1
}

require_node() {
  if ! find_node; then
    warn "Error: Node.js $MIN_NODE_MAJOR or newer is required to run speedtest-ai."
    warn "Install Node.js first:"
    warn "  Omarchy / Arch Linux: sudo pacman -S nodejs   (or: mise use -g node)"
    warn "  Debian / Ubuntu:      sudo apt install nodejs"
    warn "  macOS:                brew install node"
    exit 1
  fi
  node_major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  case "$node_major" in
    '' | *[!0-9]*) node_major=0 ;;
  esac
  if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
    die "Node.js $MIN_NODE_MAJOR or newer is required (found $(node -v 2>/dev/null || echo unknown))."
  fi
}

download() {
  # download <url> <destination>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "curl or wget is required."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    return 1
  fi
}

verify_checksum() {
  # verify_checksum <file> <base url>
  if [ "${SPEEDTEST_SKIP_CHECKSUM:-0}" = "1" ]; then
    warn "Warning: SPEEDTEST_SKIP_CHECKSUM=1, installing without verifying the download."
    return 0
  fi

  actual=$(sha256_of "$1") || die "no SHA-256 tool found (sha256sum, shasum or openssl), cannot verify the download. Set SPEEDTEST_SKIP_CHECKSUM=1 to install anyway."

  case "$PINNED_SHA256" in
    __*__)
      download "$2/checksums.txt" "$TMP_DIR/checksums.txt" || die "could not download checksums.txt to verify the bundle."
      expected=$(awk -v name="$BUNDLE_NAME" '$2 == name || $2 == "*" name {print $1; exit}' "$TMP_DIR/checksums.txt")
      [ -n "$expected" ] || die "checksums.txt has no entry for $BUNDLE_NAME."
      ;;
    *)
      expected="$PINNED_SHA256"
      ;;
  esac

  if [ "$actual" != "$expected" ]; then
    warn "Error: SHA-256 checksum mismatch, nothing was installed."
    warn "  Expected: $expected"
    warn "  Actual:   $actual"
    exit 1
  fi
}

install_bundle() {
  # install_bundle <verified file> <install dir>
  mkdir -p "$2"
  staged="$2/.speedtest-ai.$$"
  cp "$1" "$staged"
  chmod 0755 "$staged"
  # Rename within the directory so a running copy is never seen half written.
  mv -f "$staged" "$2/speedtest-ai"
  ln -sf "speedtest-ai" "$2/aispeed"
  ln -sf "speedtest-ai" "$2/kmspeed"
}

has_terminal() {
  [ -t 1 ] && [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null
}

# Prints the ids `speedtest-ai all` would benchmark, comma separated. Fails when they cannot be listed.
list_targets() {
  "$1" detect --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      try {
        const targets = JSON.parse(raw);
        const ids = targets
          .filter((t) => (t.category === "harness" || t.category === "local") && t.runnable && t.authState !== "logged_out")
          .map((t) => t.id);
        process.stdout.write(ids.join(", "));
      } catch {
        process.exit(1);
      }
    });
  '
}

maybe_run_speedtest() {
  # maybe_run_speedtest <installed binary> <no-run flag>
  if [ "$2" = "1" ]; then
    return 0
  fi
  if ! has_terminal; then
    say ""
    say "No interactive terminal, so no speed test was started. Run it yourself with:"
    say "  speedtest-ai all"
    return 0
  fi

  targets_known=1
  targets=$(list_targets "$1") || targets_known=0
  say ""
  if [ "$targets_known" = "1" ] && [ -z "$targets" ]; then
    say "No AI agent CLI was detected, so there is nothing to speed test yet."
    say "Install and log in to one (claude, codex, ...), then run: speedtest-ai all"
    return 0
  fi
  if [ "$targets_known" = "1" ]; then
    say "Next: a quick speed test of the AI agent CLIs found here: $targets"
  else
    say "Next: a quick speed test of every AI agent CLI found on this machine."
  fi
  say "It sends a short prompt to each one, which uses real model tokens from your accounts."

  skip=0
  trap 'skip=1' INT
  printf 'Starting in %s seconds, press Ctrl-C to skip: ' "$COUNTDOWN_SECONDS"
  remaining=$COUNTDOWN_SECONDS
  while [ "$remaining" -gt 0 ] && [ "$skip" = "0" ]; do
    printf '%s ' "$remaining"
    sleep 1 || true
    remaining=$((remaining - 1))
  done
  say ""
  if [ "$skip" = "1" ]; then
    trap 'cleanup; exit 130' INT
    say "Skipped. Run it any time with: speedtest-ai all"
    return 0
  fi

  # A plain handler (not "ignore"), so Ctrl-C reaches speedtest-ai, which prints its partial
  # results, and the installer still finishes with its summary.
  trap ':' INT
  status=0
  "$1" all </dev/tty || status=$?
  trap 'cleanup; exit 130' INT
  case "$status" in
    0) ;;
    130) say "Speed test interrupted. Run it again with: speedtest-ai all" ;;
    2) say "Nothing could be benchmarked. See: speedtest-ai detect" ;;
    *) say "The speed test did not complete (exit code $status). Details: speedtest-ai detect" ;;
  esac
}

main() {
  no_run=0
  if [ "${SPEEDTEST_NO_AUTO_RUN:-0}" = "1" ]; then
    no_run=1
  fi
  for arg in "$@"; do
    case "$arg" in
      --no-run) no_run=1 ;;
      *) die "unknown option: $arg (supported: --no-run)" ;;
    esac
  done

  base_url="${SPEEDTEST_AI_BASE_URL:-https://krutrimmulyankan.in/speedtest}"
  base_url="${base_url%/}"
  install_dir="${INSTALL_DIR:-$HOME/.local/bin}"

  require_node

  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/speedtest-ai.XXXXXX")
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM

  # Kept without an extension, exactly as it will be installed, for the test run below.
  bundle="$TMP_DIR/speedtest-ai"
  say "Downloading speedtest-ai from $base_url/$BUNDLE_NAME ..."
  download "$base_url/$BUNDLE_NAME" "$bundle" || die "download failed."
  [ -s "$bundle" ] || die "the download is empty."

  verify_checksum "$bundle" "$base_url"

  version=$(node "$bundle" --version 2>/dev/null) || die "the downloaded program does not run on this Node.js ($(node -v)). Nothing was installed."

  install_bundle "$bundle" "$install_dir"
  say ""
  say "Installed KM AI Speed Test ($version) to $install_dir/speedtest-ai (aliases: kmspeed, aispeed)"

  # The same file can still fail from its final place: a package.json with "type": "module" in a
  # parent directory makes Node read an extensionless script as an ES module.
  if ! node "$install_dir/speedtest-ai" --version >/dev/null 2>&1; then
    warn "Warning: speedtest-ai was installed but does not start from $install_dir."
    warn "If a package.json in a parent directory sets \"type\": \"module\", install elsewhere:"
    warn "  curl -fsSL $base_url/install.sh | INSTALL_DIR=/some/other/bin sh"
    no_run=1
  fi

  on_path=1
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) on_path=0 ;;
  esac

  maybe_run_speedtest "$install_dir/speedtest-ai" "$no_run"

  say ""
  say "Commands:"
  say "  speedtest-ai all          speed test every installed AI agent CLI and compare"
  say "  speedtest-ai detect       list which CLIs and APIs were found"
  say "  speedtest-ai run -t ID    test one target (for example: -t claude)"
  say "  speedtest-ai demo         simulated run, no model is called"
  say "  speedtest-ai --help       everything else"

  if [ "$on_path" = "0" ]; then
    say ""
    say "Note: $install_dir is not on your PATH. Add this line to your shell profile:"
    say "  export PATH=\"$install_dir:\$PATH\""
  fi
  if [ "$NODE_FROM_FALLBACK" = "1" ]; then
    say ""
    say "Note: node is not on your PATH (found it at $(command -v node))."
    say "speedtest-ai needs node on PATH to start. Add this line to your shell profile:"
    say "  export PATH=\"$(dirname "$(command -v node)"):\$PATH\""
  fi
}

main "$@"
