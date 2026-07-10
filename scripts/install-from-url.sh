#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${1:-https://github.com/nidalJaafar/harness-session-manager.git}"
INSTALL_DIR="${HSM_INSTALL_DIR:-$HOME/.local/share/harness-session-manager}"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating existing HSM checkout..."
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "hsm install: $INSTALL_DIR exists but is not a Git checkout" >&2
  exit 1
else
  echo "Cloning HSM into $INSTALL_DIR..."
  git clone "$REPOSITORY" "$INSTALL_DIR"
fi

exec "$INSTALL_DIR/install.sh"
