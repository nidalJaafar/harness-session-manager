# Agent installation instructions

Use these steps when a user asks to install Harness Session Manager from this repository.

## Install

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/nidalJaafar/harness-session-manager/master/scripts/install-from-url.sh)"
```

If `curl` is unavailable:

```bash
git clone https://github.com/nidalJaafar/harness-session-manager.git "$HOME/.local/share/harness-session-manager"
cd "$HOME/.local/share/harness-session-manager"
./install.sh
```

For an existing checkout:

```bash
git -C "$HOME/.local/share/harness-session-manager" pull --ff-only
"$HOME/.local/share/harness-session-manager/install.sh"
```

## Verify

Run both commands and report their output:

```bash
"$HOME/.local/bin/hsm" doctor
"$HOME/.local/bin/hsm" --preview --width 100 --height 24
```

Do not manually edit Claude Code, OpenCode, or Pi configuration. HSM installs and backs up its lifecycle integrations automatically on first interactive launch.

Tell the user to launch:

```bash
hsm
```
