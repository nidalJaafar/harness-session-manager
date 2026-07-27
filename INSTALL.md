# Installing Harness Session Manager

## Instructions for coding agents

If the user asks you to install HSM using this document, perform the installation instead of only summarizing these instructions.

1. Confirm that the host is Linux and inspect the required commands listed below.
2. Run the one-command installer.
3. Add `~/.local/bin` to the active shell's `PATH` when necessary.
4. Run `hsm doctor` and report any failed checks with their exact remediation.
5. Run `hsm --preview` to verify session discovery without opening the interactive TUI.
6. Report the installed executable path and verification result.

Do not launch the interactive `hsm` TUI from a non-interactive agent terminal. Do not merely repeat the commands unless execution is blocked by permissions or a missing prerequisite.

Recommended user prompt:

```text
Install Harness Session Manager by following this document, execute the commands, and verify the installation:
https://github.com/nidalJaafar/harness-session-manager/blob/master/INSTALL.md
```

## One-command installation

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/nidalJaafar/harness-session-manager/master/scripts/install-from-url.sh)"
```

This clones HSM to `~/.local/share/harness-session-manager`, installs production dependencies, and links `hsm` and `sessions` into `~/.local/bin`.

## Requirements

- Linux
- Node.js 20 or newer
- npm
- Bun, or mise with Bun available
- `sqlite3` for OpenCode support
- Optional: SQLite compiled with FTS5 for ranked transcript search (HSM falls back automatically)
- Optional: `notify-send` for daemon alerts
- Optional: systemd user services for the background daemon
- Any combination of Claude Code, OpenCode, and Pi

On first interactive launch, HSM installs lifecycle integrations for detected harnesses. Existing configuration files are backed up before modification.

## Install from a clone

```bash
git clone https://github.com/nidalJaafar/harness-session-manager.git
cd harness-session-manager
./install.sh
```

## Verify

```bash
hsm doctor
hsm --preview
hsm
```

If `hsm` is not found, add `~/.local/bin` to your shell path:

```fish
fish_add_path --universal ~/.local/bin
```

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Update

Run:

```bash
hsm update
```

HSM checks stable `vMAJOR.MINOR.PATCH` tags for a new version in the background and shows an update notice in the TUI footer. The updater requires a clean checkout and only fast-forwards to a published release tag. The one-command installer remains a fallback, or update manually with:

```bash
git -C ~/.local/share/harness-session-manager fetch --tags origin
TAG="$(git -C ~/.local/share/harness-session-manager tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)"
git -C ~/.local/share/harness-session-manager merge --ff-only "$TAG"
~/.local/share/harness-session-manager/install.sh
```

## Uninstall

```bash
hsm hooks remove
rm -f ~/.local/bin/hsm ~/.local/bin/sessions
rm -rf ~/.local/share/harness-session-manager
```

HSM state is intentionally retained at `~/.local/state/hsm`. Remove it separately if you also want to delete pins, aliases, notes, events, and undo records.
