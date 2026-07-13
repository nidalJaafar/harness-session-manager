#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${1:-https://github.com/nidalJaafar/harness-session-manager.git}"
INSTALL_DIR="${HSM_INSTALL_DIR:-$HOME/.local/share/harness-session-manager}"

latest_tag() {
  git -C "$INSTALL_DIR" tag --list 'v[0-9]*' --sort=-v:refname | head -n 1
}

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating existing HSM checkout..."
  if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
    echo "hsm install: $INSTALL_DIR has local changes; refusing to overwrite them" >&2
    exit 1
  fi
  git -C "$INSTALL_DIR" fetch --quiet --tags origin
  TAG="$(latest_tag)"
  if [[ -n "$TAG" ]]; then
    git -C "$INSTALL_DIR" merge --ff-only "$TAG"
  else
    git -C "$INSTALL_DIR" pull --ff-only
  fi
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "hsm install: $INSTALL_DIR exists but is not a Git checkout" >&2
  exit 1
else
  echo "Cloning HSM into $INSTALL_DIR..."
  git clone "$REPOSITORY" "$INSTALL_DIR"
  TAG="$(latest_tag)"
  if [[ -n "$TAG" ]]; then
    git -C "$INSTALL_DIR" checkout -B master "$TAG"
  fi
fi

exec "$INSTALL_DIR/install.sh"
