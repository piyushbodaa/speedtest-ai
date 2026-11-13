#!/bin/sh
set -eu

BASE_URL="${SPEEDTEST_AI_BASE_URL:-https://krutrimmulyankan.in/speedtest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
EXPECTED_SHA256="378b6cd27b5b1893d26b11be32168c43b1c50ff79af5c787ec543b8ab5d66155"

# Ensure mise-managed Node is discoverable in non-interactive shells (e.g. Omarchy Linux)
if ! command -v node >/dev/null 2>&1; then
  for dir in \
    "$HOME/.local/share/mise/installs/node/latest/bin" \
    "$HOME/.local/share/mise/shims" \
    "/usr/local/bin"
  do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20 or newer is required to run speedtest-ai." >&2
  echo "Install Node.js first:" >&2
  echo "  Omarchy / Arch Linux: sudo pacman -S nodejs   (or: mise use -g node)" >&2
  echo "  Debian / Ubuntu:      sudo apt install nodejs" >&2
  echo "  macOS:                brew install node" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  echo "Error: Node.js >= 20 is required (found v$(node -v))." >&2
  exit 1
fi

TMP_FILE=$(mktemp "${TMPDIR:-/tmp}/speedtest-ai.XXXXXX")
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT INT TERM

BUNDLE_URL="${BASE_URL%/}/speedtest-ai.mjs"
echo "Downloading speedtest-ai from $BUNDLE_URL..."

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BUNDLE_URL" -o "$TMP_FILE"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_FILE" "$BUNDLE_URL"
else
  echo "Error: curl or wget is required." >&2
  exit 1
fi

if [ "$EXPECTED_SHA256" != "PLACEHOLDER_SHA256" ]; then
  ACTUAL_SHA256=""
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA256=$(sha256sum "$TMP_FILE" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA256=$(shasum -a 256 "$TMP_FILE" | awk '{print $1}')
  fi

  if [ -n "$ACTUAL_SHA256" ] && [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
    echo "Error: SHA-256 checksum mismatch!" >&2
    echo "  Expected: $EXPECTED_SHA256" >&2
    echo "  Actual:   $ACTUAL_SHA256" >&2
    exit 1
  fi
fi

mkdir -p "$INSTALL_DIR"
cp "$TMP_FILE" "$INSTALL_DIR/speedtest-ai"
chmod 0755 "$INSTALL_DIR/speedtest-ai"
ln -sf "speedtest-ai" "$INSTALL_DIR/aispeed"

echo ""
echo "Installed speedtest-ai (and aispeed alias) to $INSTALL_DIR"
echo ""
echo "Quick start:"
echo "  speedtest-ai              # Interactive target picker"
echo "  speedtest-ai detect       # Check installed AI harnesses & APIs"
echo "  speedtest-ai demo         # Zero-cost simulated speedometer"
echo "  speedtest-ai run -t claude"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Note: $INSTALL_DIR is not in your PATH. Add it with:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
