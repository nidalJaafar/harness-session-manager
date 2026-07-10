# Harness Session Manager

One terminal command center for Claude Code, OpenCode, Pi, and external harness plugins. HSM combines live session status, a unified workspace tree, new-session launching, persistent organization, rich session context, and safe management actions.

## Install

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/nidalJaafar/harness-session-manager/master/scripts/install-from-url.sh)"
```

Then run:

```bash
hsm doctor
hsm
```

See [INSTALL.md](INSTALL.md) for requirements, updates, uninstalling, and agent-oriented installation.

## Development

Requirements: Node 20+, Bun (OpenTUI runtime), and `sqlite3` for OpenCode discovery.

```bash
npm install
npm start
```

For a non-interactive snapshot:

```bash
npm run preview
```

Alternatively, install the `sessions` and `hsm` commands globally from a development checkout:

```bash
npm install -g .
sessions
```

## Controls

| Key | Action |
| --- | --- |
| `?` | Show the complete keyboard reference |
| `1` / `2` | Dashboard and Browser views |
| `Ctrl+K` | Fuzzy command palette for sessions and actions |
| `n` | Launch a new harness session in a selected working folder |
| `f` / `Tab` | Cycle All, Claude Code, OpenCode, and Pi filters |
| `j` / `k` | Move selection |
| `/` | Search every normalized field across harnesses |
| `g` | Toggle folder-grouped queue and global recent activity |
| `Enter` | Expand/collapse a folder, or preview a selected session |
| `←` / `→` | Collapse or expand the selected folder |
| `v` | Load a lightweight transcript preview for a session |
| `o` | Resume using the selected harness’s native command |
| `p` | Pin or unpin the selected session |
| `s` | Show or hide subagent/child threads; hidden by default |
| `u` | Undo the latest supported management action |
| `h` | Show the exact native resume command |
| `r` | Rescan every source |
| `q` | Quit |

Set `HSM_OPEN_MODE=tty` to replace the current TUI with the selected harness. By default a new terminal is launched using `$TERMINAL` or `xdg-terminal-exec`.

## Architecture

The interface follows the two-pane pattern of the original managers: the folder/session browser owns the wide left pane, while stable folder or session details appear on the right. The queue is grouped by working folder by default, and every folder begins collapsed. Expand a folder to reveal a tree of sessions from any registered harness. Folders are ordered by their latest session activity, while sessions inside each folder remain newest-first. The TUI consumes only the normalized harness contract. Each adapter owns discovery, preview, capabilities, and its native resume command.

Claude Code is read and managed through `@anthropic-ai/claude-agent-sdk`. OpenCode is read from `~/.local/share/opencode/opencode.db`; use `--db path` to override it. Adapter capabilities ensure unsupported actions are disabled with an explanation.

Pi sessions are discovered from `PI_CODING_AGENT_SESSION_DIR`, the configured Pi `sessionDir`, or `~/.pi/agent/sessions`. HSM supports Pi previews, names, models, usage/cost, forks, resume commands, Git context, process state, and lifecycle events.

Harness integrations are registry plugins. Drop an external `.mjs` adapter into `~/.config/hsm/plugins/` or use `HSM_PLUGINS`; see [Harness plugins](docs/harness-plugins.md). Adding a built-in harness requires one adapter module and one registry descriptor, without changes to the dashboard, browser, search, palette, persistence, or status engine. Adapters opt into the new-session launcher by declaring their executable and arguments.

HSM-owned pins, aliases, tags, notes, hidden state, UI state, lifecycle events, and undo records live under `~/.local/state/hsm/`. OpenCode archive and move operations create a database backup before mutation. Delete remains disabled unless an adapter can provide session-scoped recovery.

Subagent threads are hidden throughout Dashboard, Browser, search, and the command palette by default. Press `s`, use the palette action, set `HSM_SHOW_SUBAGENTS=1`, or launch with `--show-subagents` to include them. The preference changed with `s` is persisted.

## Live status

HSM automatically installs its lifecycle integrations on the first interactive launch. Existing Claude settings, the OpenCode plugin, and the Pi extension are backed up before modification.

Check or repair the integrations manually with:

```bash
hsm hooks status
hsm hooks install
```

Claude hooks, the OpenCode plugin, and the Pi extension report normalized Running, Waiting, Completed, and Failed events. HSM combines those events with process detection every two seconds. If a running session loses its process or heartbeat, it becomes Stale instead of being marked complete.

Remove integrations without deleting HSM state:

```bash
hsm hooks remove
```

If you intentionally do not want automatic hook installation, launch with `HSM_DISABLE_AUTO_HOOKS=1`.

## Management

Open `Ctrl+K` to resume, continue the last session, pin, alias, tag, add notes, copy the resume command, open the folder/editor, rename, move an OpenCode session, archive, or hide. Destructive actions require typing `yes`; unsupported native operations are visibly disabled. `u` restores the latest supported rename, move, archive, or hide operation.

## Diagnostics

```bash
hsm doctor
```

Doctor checks harness executables, Bun, SQLite, the OpenCode database and integrity, hook/plugin/extension installation, running harness processes, and the local event store.

## CLI

```text
hsm [--preview] [--db path] [--only claude|opencode|pi]
hsm event --harness <id> --session <id> --type <type>
hsm hooks install|remove|status
hsm doctor
```
