#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HSM_BIN_DIR:-$HOME/.local/bin}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "hsm install: missing required command: $1" >&2
    exit 1
  fi
}

require node
require npm
require sqlite3

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 20 )); then
  echo "hsm install: Node.js 20 or newer is required (found $(node --version))" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1 && ! command -v mise >/dev/null 2>&1; then
  echo "hsm install: Bun is required for the interactive TUI." >&2
  echo "Install Bun from https://bun.sh or install mise, then retry." >&2
  exit 1
fi

echo "Installing HSM dependencies..."
npm --prefix "$ROOT_DIR" install --omit=dev

mkdir -p "$BIN_DIR"
ln -sfn "$ROOT_DIR/src/index.mjs" "$BIN_DIR/hsm"
ln -sfn "$ROOT_DIR/src/index.mjs" "$BIN_DIR/sessions"

echo "Installed HSM:"
echo "  $BIN_DIR/hsm"
echo "  $BIN_DIR/sessions"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "Add $BIN_DIR to your PATH:"
    echo "  Fish: fish_add_path --universal $BIN_DIR"
    echo "  Bash/Zsh: export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo
echo "Verify with: $BIN_DIR/hsm doctor"
echo "Launch with: $BIN_DIR/hsm"
