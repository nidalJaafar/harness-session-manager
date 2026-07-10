# Installing Harness Session Manager

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

Run the one-command installer again, or:

```bash
git -C ~/.local/share/harness-session-manager pull --ff-only
~/.local/share/harness-session-manager/install.sh
```

## Uninstall

```bash
hsm hooks remove
rm -f ~/.local/bin/hsm ~/.local/bin/sessions
rm -rf ~/.local/share/harness-session-manager
```

HSM state is intentionally retained at `~/.local/state/hsm`. Remove it separately if you also want to delete pins, aliases, notes, events, and undo records.
