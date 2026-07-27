# Harness Session Manager

HSM is a local command center for Claude Code, OpenCode, Pi, Codex, and external harness plugins. It combines live attention state, project/worktree orchestration, private transcript search, persistent organization, and safe session management in one TUI.

## Install

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/nidalJaafar/harness-session-manager/master/scripts/install-from-url.sh)"
hsm doctor
hsm
```

See [INSTALL.md](INSTALL.md) for requirements, updates, uninstalling, and agent-oriented installation.

## Updates

HSM checks stable Git tags in the background at most once every six hours. When a newer semantic version exists, the bottom status bar shows `HSM 1.2.0 is available · run hsm update`. The check never blocks startup; disable it with `HSM_DISABLE_UPDATE_CHECK=1`.

```bash
hsm update check   # check immediately
hsm update         # clean fast-forward, reinstall, and restart the daemon if active
```

Release tags use `vMAJOR.MINOR.PATCH`, for example `v1.1.0`. Updates refuse to overwrite local modifications or divergent Git history and never install unreleased `master` commits. Installations created through `INSTALL.md` are ordinary Git checkouts, so no privileged system package operation is required.

Installations older than 1.1.0 do not contain the updater and must run the URL installer once. Every release from 1.1.0 onward can use `hsm update`.

## What HSM does

| Area | Features |
| --- | --- |
| Unified sessions | Claude Code, OpenCode, Pi, Codex CLI/Desktop, and external adapters in one normalized queue |
| Live attention | Running/waiting/failed/stale detection, snoozing, pins, and optional notifications |
| Project cockpit | Collapsible project trees, Git context, branches, worktrees, and harness counts |
| Session control | Start, resume, preview, rename, tag, note, alias, archive, move, hide, and undo where supported |
| Local intelligence | Private transcript indexing, faceted search, highlighted matches, related sessions, and optional AI retrieval |
| Orchestration | Confirmed Git worktree creation and safe cleanup |
| Extensibility | Capability-driven harness plugins without dashboard or TUI changes |

Unsupported native actions remain visible but disabled with an explanation. HSM uses local aliases, tags, and notes when a harness has no equivalent native feature.

## Command Center

- `1 Dashboard` shows Waiting, Running, Pinned, Snoozed, and Recent lanes.
- `2 Projects` groups sessions into collapsible project cockpits with active-session, branch, worktree, and dirty-worktree signals.
- `/ Session Finder` searches locally indexed transcripts from either view. Press `Tab` to enter Project, Harness, and Branch filters, then type directly into the selected field. Typed filter syntax also works: `project:api`, `harness:claude`, and `branch:main`. Project matching is case-insensitive and also recognizes the session's working-directory path. Once Finder displays local results, `Shift+A` becomes available for AI ranking.

Search is progressive and globally accessible. Press `/` from either view, then type directly in Finder while results update underneath. Press `Tab` repeatedly to move through the query, each visible filter field, and the results. Type filter values directly; up/down optionally cycles values already present in the index. If the local results are insufficient, press `Shift+A` while results are focused to rank the same query with AI. `Shift+A` is intentionally inactive outside Finder.

Session status glyphs are consistent across views:

| Glyph | Meaning |
| --- | --- |
| `●` | Harness is running work |
| `◆` | Session is waiting for input |
| `✓` | Session completed or stopped |
| `!` | Session failed or its working directory is missing |
| `○` | Session is offline or stale |
| `★` | Session is pinned |

Project rows use readable counters such as `2 active · 3 branches · 4 worktrees`. Select a project to see the same data with its full path and harness breakdown.

Press `Ctrl+K` for every supported action or `?` for the complete keyboard reference.

| Key | Action |
| --- | --- |
| `1` / `2` | Dashboard and Projects |
| `j` / `k` | Move selection |
| `/` | Open the global Finder with local transcript retrieval |
| `Enter` / `v` | Expand a project or preview a session |
| `n` / `o` | Start a new session or resume the selected session |
| `z` / `w` | Snooze for one hour or wake a session |
| `l` | Go to the latest session resumed through HSM |
| `A` in Finder | Toggle AI ranking and local retrieval; inactive elsewhere |
| `Esc` in Finder | Return to the previous Dashboard or Projects view |
| `p` / `s` | Pin a session or show hidden subagent threads |
| `f` / `Tab` | Cycle harness filters |
| `u` | Undo the latest supported management action |
| `r` / `q` | Rescan or quit |

The palette is contextual: global commands are always available, while session commands appear only when a session is selected and the harness supports them. Unsupported and desktop-only actions are omitted rather than displayed disabled.

On the first interactive launch, HSM presents a centered guided-tour card over the real application. Each step explains one part of the interface, blocks unrelated input, waits for the key it is teaching, and then advances through Dashboard, Projects, Finder, contextual actions, resume behavior, new sessions, and organization controls. Press `Esc` to skip when it is not the key being taught; restart the tour later from `?` Help or `Ctrl+K` → `Start the guided tour`.

### Opening sessions locally and over SSH

Pressing `o` always resumes the selected session in the current terminal. HSM suspends its interface, runs the harness with normal terminal input, and returns with refreshed session data when the harness exits.

- `Ctrl+K` offers `Resume in a new terminal window` only in a local graphical session.
- Over SSH or without a graphical display, that action is omitted because the new window would not be usable.
- Starting a new session uses a new terminal window locally and the current terminal over SSH or on a headless machine.


Subagent and child threads are hidden by default. Press `s`, use the palette, set `HSM_SHOW_SUBAGENTS=1`, or pass `--show-subagents` to include them; the TUI preference is persisted.

### Codex support

HSM discovers the newest local `$CODEX_HOME/state_*.sqlite` store and reads transcript previews from rollout JSONL files. Both Codex CLI and Codex Desktop threads appear as `[CX]`; spawned child threads follow the existing hidden-subagent preference. Resume uses `codex resume <thread-id>`, while `n` can launch a new `codex` session. Recent thread-scoped entries in the newest `$CODEX_HOME/logs_*.sqlite` provide exact live-running state without installing hooks or changing Codex configuration.

## Live state and lifecycle integrations

On the first interactive launch, HSM installs lifecycle integrations for detected harnesses:

- Claude Code hooks for session start/end, prompts, tools, failures, notifications, and stop events.
- An OpenCode plugin for session, idle, error, and tool events.
- A Pi extension for session and agent lifecycle events.

HSM combines these events with process detection every two seconds. New sessions created while HSM is already open are discovered automatically. A missing process or heartbeat makes an active session stale instead of incorrectly marking it complete.

```bash
hsm hooks status
hsm hooks install
hsm hooks remove
```

Set `HSM_DISABLE_AUTO_HOOKS=1` when hook installation should remain manual. Existing harness configuration is backed up before HSM modifies it.

## Background attention monitor

The TUI works without a daemon. Optionally install a systemd user service that records/indexes sessions and sends deduplicated desktop notifications when a session is waiting or failed:

```bash
hsm daemon install
hsm daemon status
```

Snooze state suppresses notifications for the selected session for one hour. The daemon is optional: hooks continue recording events and the TUI remains fully functional without it. Remove it with `hsm daemon remove`.

## Worktrees

Worktree inspection reports branch, HEAD, detached, missing, merged, and dirty state. Mutation commands return a preview unless `--yes` is supplied. Dirty or actively used worktrees are never removed:

```bash
hsm worktree inspect --root "$PWD"
hsm worktree create --root "$PWD" --target ../feature --branch feature
hsm worktree create --root "$PWD" --target ../feature --branch feature --yes
hsm worktree cleanup --root "$PWD" --target ../feature
```

## Private local search

HSM stores normalized metadata, events, undo records, notification state, and indexed messages in `~/.local/state/hsm/hsm.db`. Existing JSON/JSONL state is migrated once and backed up before import.

```bash
hsm search 'token refresh harness:claude branch:main'
hsm index status
hsm index pause
hsm index resume
hsm index exclude /path/to/private/project
hsm index delete claude:session-id
hsm index rebuild
```

FTS5 is used when the system SQLite provides it; otherwise HSM uses a compatible local lexical-search backend. Results include highlighted snippets and referenced paths, and session details suggest related threads using project, branch, working-directory, and lexical signals.

### AI-assisted session retrieval

When local results are not enough, `A` runs an explicit RAG fallback:

1. HSM scores indexed messages locally and groups the best evidence by session.
2. Obvious API keys, tokens, passwords, and secrets are redacted.
3. Only the top 20 candidate sessions and short evidence excerpts are sent to the provider.
4. The provider must select existing session keys; invented IDs are discarded.
5. HSM displays confidence, reasoning, evidence, project context, and a direct resume action. Press `A` again to return to local results.

Claude Code is selected automatically when available, followed by Pi. Both run ephemerally without tools or session persistence. Claude also runs without user/project setting sources and with empty hooks, so retrieval does not create a Claude session or HSM lifecycle events. OpenCode is not selected automatically because its non-interactive mode persists a session.

```bash
hsm ai status
hsm ai provider claude   # or: pi
hsm ai find 'where did we fix the token refresh race?'
```

Local search never invokes AI. Transcript content leaves the machine only when you explicitly press `A` or run `hsm ai find`; provider usage may incur its normal cost. Excluded projects are never candidates.

Claude retrieval calls default to a `$0.25` maximum budget. Override it when needed:

```bash
HSM_AI_MAX_BUDGET_USD=0.50 hsm
```

Excluded projects are removed from the existing index as well as skipped during future indexing. `hsm index delete` removes only HSM's indexed copy; it does not delete the native harness session.

## State, migration, and safety

HSM 1.0 consolidates its state in `~/.local/state/hsm/hsm.db` using SQLite WAL mode. It stores:

- Pins, aliases, tags, notes, hidden state, and snooze deadlines.
- UI selections, folder expansion, filters, and the latest resumed session.
- Normalized lifecycle events, notification deduplication, transcript indexes, and undo records.

Legacy `state.json`, `events.jsonl`, and undo records are imported once. HSM retains `.pre-sqlite-backup` copies so an interrupted or unwanted migration is recoverable.

Archive and move operations create native backups when the adapter supports them. Destructive actions require confirmation, and `u` restores the latest supported rename, move, archive, or hide action. Native delete stays disabled unless an adapter can provide session-scoped recovery.

## Harness plugins

Drop an `.mjs` adapter into `~/.config/hsm/plugins/` or use `HSM_PLUGINS`. Existing adapters remain compatible. Optional `messagesSince`, `projectIdentity`, `prepareLaunch`, process, cost, Git, mutation, and lifecycle capabilities progressively enhance the command center. See [Harness plugins](docs/harness-plugins.md).

## Diagnostics and development

```bash
hsm doctor
hsm --preview
npm install
npm test
npm start
```

Doctor checks harness executables, Bun, SQLite and the OpenCode database, HSM database integrity/search backend, lifecycle integrations, the optional daemon, notifications, and process state.

## CLI

```text
hsm [--preview] [--db path] [--only claude|opencode|pi|codex]
hsm event --harness <id> --session <id> --type <type>
hsm hooks install|remove|status
hsm daemon install|remove|start|stop|status
hsm worktree inspect|create|cleanup
hsm index status|rebuild|pause|resume|exclude|delete
hsm search <query>
hsm ai status|provider <claude|pi>|find <query>
hsm doctor
```
